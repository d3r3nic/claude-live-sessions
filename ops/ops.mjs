// The live-sessions ops screen: a full-screen console of the workspaces, their agents and what the relay does,
// drawn from the snapshot every Claude Code session with this plugin keeps, and the relay's event log. A click on
// a workspace's OPEN button, or on an event, opens what it is about: the workspace's window, or a session's tab.
//   node ops/ops.mjs [--account <env>]     live, full screen, one account's or every one's (a accounts, t theme, g grid,
//                                          e events, n names hidden or shown, v compact or detailed view, h HISTORY
//                                          opened or folded, esc closes a workspace's details, q quit)
//   node ops/ops.mjs --frame [--plain]     one frame, printed (COLS, ROWS, TICK; MODAL: a workspace's details open);
//                                          --targets prints what each row opens
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

/** Said, and left on screen until a key (the window it runs in closes with it); asked whether it loads, said alone. */
async function fail(text, reason = text) {
  if (process.argv.includes('--loads')) {
    process.stdout.write(`${reason}\n`)
    process.exit(1)
  }
  process.stdout.write(`${text}\nPress return to close.\n`)
  await new Promise(res => process.stdin.once('data', res))
  process.exit(1)
}
// it runs the plugin's own TypeScript as it is: Node 22.18 or later (type stripping on, module hooks there)
if (typeof nodeModule.registerHooks !== 'function') await fail(`The ops screen needs Node 22.18 or later; this is Node ${process.versions.node}.`, `it needs Node 22.18 or later; this is Node ${process.versions.node}`)
// the plugin imports its own files without an extension, as its engine resolves them; Node needs `.ts`
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
let c, w, r, nm
try {
  c = await import(new URL('../hooks/collect.ts', import.meta.url).href)
  w = await import(new URL('../hooks/workspaces.ts', import.meta.url).href)
  r = await import(new URL('../hooks/relay.ts', import.meta.url).href)
  nm = await import(new URL('../hooks/names.ts', import.meta.url).href)
} catch (error) {
  await fail(`The ops screen could not load its code (${String(error).split('\n')[0]}). It needs Node 22.18 or later, which runs TypeScript as it is; this is Node ${process.versions.node}.`, String(error).split('\n')[0])
}
// asked only whether its code loads with this Node (before a screen starts again in place with it): it does
if (process.argv.includes('--loads')) {
  process.stdout.write('loads\n')
  process.exit(0)
}

const HOME = process.env.HOME
/**
 * The Node to start the screen again with: `node` on the PATH it was started with (a Node updated there meanwhile is the
 * new one), else the one running; the path it was started with, if it was started by a path; none when there is none,
 * or this Node cannot replace itself. Checked first: a Node that replaces itself with a program not there ends then and
 * there.
 */
function nodeToRestart() {
  if (typeof process.execve !== 'function' || !existsSync(process.argv[1])) return undefined
  const named = process.argv0
  const candidates = named.includes('/') ? [named] : [...(process.env.PATH ?? '').split(':').filter(Boolean).map(dir => `${dir}/${named}`), process.execPath]
  return candidates.find(file => {
    try {
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  })
}
/**
 * When its code (this folder's and the plugin's hooks' code files) last changed; 0 when it cannot tell. Other files there
 * (an editor's swap file, Finder's .DS_Store) are no change.
 */
function codeAt() {
  try {
    return Math.max(0, ...['.', '../hooks'].flatMap(dir => {
      const path = fileURLToPath(new URL(`${dir}/`, import.meta.url))
      return readdirSync(path, { withFileTypes: true }).filter(e => e.isFile() && /\.(m?js|tsx?|pl)$/.test(e.name)).map(e => statSync(path + e.name).mtimeMs)
    }))
  } catch {
    return 0
  }
}
const SNAPSHOT = process.env.LIVE_SESSIONS_SNAPSHOT ?? `${HOME}/Library/Caches/live-sessions/snapshot.json`
const EVENTS = process.env.LIVE_SESSIONS_EVENTS ?? `${HOME}/Library/Caches/live-sessions/events.jsonl`
const ESC = '\x1b['
const rgb = (hex, text) => `${ESC}38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${text}${ESC}39m`
const bold = text => `${ESC}1m${text}${ESC}22m`
// themes: each paints its own background, so the screen looks the same whatever the terminal's profile
// (`note`: a workspace's main problem, in a colour none of the others is)
const THEMES = {
  MATRIX: { bg: '#020a05', hi: '#39ff14', mid: '#00d26a', lo: '#0f7a35', dim: '#0a4a22', amber: '#ffb000', red: '#ff3b3b', cyan: '#36f9f6', note: '#f4ecd0' },
  AMBER: { bg: '#0d0800', hi: '#ffcc33', mid: '#ffb000', lo: '#8a5a00', dim: '#4a3000', amber: '#fff1b8', red: '#ff5533', cyan: '#ffe08a', note: '#f2f2f2' },
  CYBER: { bg: '#0a0014', hi: '#ff2bd6', mid: '#36f9f6', lo: '#6b3fa0', dim: '#2a1446', amber: '#fdf500', red: '#ff3b6b', cyan: '#00fff0', note: '#f2f2f2' },
  ICE: { bg: '#03101c', hi: '#9be7ff', mid: '#4fc3f7', lo: '#1f5f86', dim: '#0f3350', amber: '#ffd166', red: '#ef476f', cyan: '#e0fbfc', note: '#ffe8a3' },
  PAPER: { bg: '#f4f1e8', hi: '#0b3d20', mid: '#14532d', lo: '#6b8f71', dim: '#c8d5c3', amber: '#b45309', red: '#b91c1c', cyan: '#0e7490', note: '#5b21b6' },
}
const NAMES = Object.keys(THEMES)
// what the person chose here, kept for the next screen: the theme, whether the grid and the event log are shown, and
// how the workspaces are drawn: `compact`, tiles several a row (the default), or `detailed`, each in full
const PREFS = `${HOME}/Library/Application Support/live-sessions/ops.json`
const prefs = (() => {
  try {
    const kept = JSON.parse(readFileSync(PREFS, 'utf8'))
    return { theme: NAMES.includes(kept.theme) ? kept.theme : 'MATRIX', grid: kept.grid !== false, events: kept.events !== false, view: kept.view === 'detailed' ? 'detailed' : 'compact', history: kept.history === true }
  } catch {
    return { theme: 'MATRIX', grid: true, events: true, view: 'compact', history: false }
  }
})()
let themeName = prefs.theme
let G = THEMES[themeName]
const bgOn = () => `${ESC}48;2;${parseInt(G.bg.slice(1, 3), 16)};${parseInt(G.bg.slice(3, 5), 16)};${parseInt(G.bg.slice(5, 7), 16)}m`
function savePrefs() {
  try {
    mkdirSync(PREFS.slice(0, PREFS.lastIndexOf('/')), { recursive: true })
    writeFileSync(PREFS, JSON.stringify({ ...prefs, theme: themeName }))
  } catch {}
}
function nextTheme() {
  themeName = NAMES[(NAMES.indexOf(themeName) + 1) % NAMES.length]
  G = THEMES[themeName]
  savePrefs()
}

// the names kept off the screens (ABC-XYZ), as every screen reads them: out of every row drawn while hidden
const NAMES_FILE = nm.namesPath(HOME)
// as the bottom line says it, short enough to be read there
const NAMES_SAID = NAMES_FILE.startsWith(`${HOME}/`) ? `~${NAMES_FILE.slice(HOME.length)}` : NAMES_FILE
/**
 * The names and their switch as the file says now: none when there is no file; as they were when it cannot be read or
 * is half written, so a name never shows by mistake.
 */
function readHiding(before) {
  if (!existsSync(NAMES_FILE)) return nm.NO_HIDING
  try {
    const raw = JSON.parse(readFileSync(NAMES_FILE, 'utf8'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? nm.hidingFrom(raw) : before
  } catch {
    return before
  }
}
let hiding = readHiding(nm.NO_HIDING)
const hide = s => nm.hideNames(s, nm.hiddenNames(hiding))
/** Whether the names are out of sight now: ABC-XYZ lit. */
const isHiding = () => nm.hiddenNames(hiding).length > 0
/**
 * The names hidden on every screen, or shown again, the other way from how this screen shows them; said why not when
 * the file cannot be read, is not a list of names (never written over) or cannot be written.
 */
function toggleHiding() {
  let raw
  let problem
  if (existsSync(NAMES_FILE)) {
    try {
      raw = JSON.parse(readFileSync(NAMES_FILE, 'utf8'))
    } catch {
      raw = null
    }
    problem = nm.namesProblem(raw)
    if (problem?.isList === false) return `not turned: names.json ${problem.said}`
  }
  const wasHiding = isHiding()
  const written = nm.turned(raw, !wasHiding)
  try {
    mkdirSync(NAMES_FILE.slice(0, NAMES_FILE.lastIndexOf('/')), { recursive: true })
    // whole or not at all: another screen reading it meanwhile never finds half a file
    writeFileSync(`${NAMES_FILE}.${process.pid}`, written)
    renameSync(`${NAMES_FILE}.${process.pid}`, NAMES_FILE)
  } catch (error) {
    return `not turned: names.json cannot be written (${String(error?.code ?? error)})`
  }
  hiding = nm.hidingFrom(JSON.parse(written))
  if (wasHiding) return 'names shown'
  if (hiding.names.length === 0) return `no names to hide yet: list them in ${NAMES_SAID}, as {"names": ["…"]}`
  return problem === undefined ? 'names hidden' : `names hidden; names.json ${problem.said}`
}
/** The grid or the event log shown, or not; kept for the next screen. */
function toggleShown(what) {
  prefs[what] = !prefs[what]
  savePrefs()
  return `${what === 'grid' ? 'grid' : what === 'history' ? 'history' : 'event log'} ${prefs[what] ? 'shown' : 'hidden'}`
}
/** The workspaces as tiles or in full; kept for the next screen. */
function toggleView() {
  prefs.view = prefs.view === 'compact' ? 'detailed' : 'compact'
  savePrefs()
  return `${prefs.view} view`
}
/** A toolbar button pressed: what it turned, as said on the bottom line. */
const press = what => (what === 'names' ? toggleHiding() : what === 'view' ? toggleView() : toggleShown(what))
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })
const isWideCode = n => (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) ||
  (n >= 0xfe30 && n <= 0xfe4f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x20000 && n <= 0x3fffd)
/** Cells a grapheme takes: two for a wide one (CJK, full-width forms, an emoji shown as one, a joined one too), none for marks alone, else one. */
const cells = g => {
  if (/^[\p{M}\u200b-\u200d\u2060\ufe00-\ufe0f]+$/u.test(g)) return 0
  if (/\p{Emoji_Presentation}|\ufe0f/u.test(g) || isWideCode(g.codePointAt(0))) return 2
  return 1
}
const width = s => [...graphemes.segment(strip(s))].reduce((n, { segment }) => n + cells(segment), 0)
/** A drawn line cut to `n` cells, its colour codes kept, so nothing ever wraps onto the next row. */
function clip(line, n) {
  let used = 0
  let out = ''
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) {
      out += part
      continue
    }
    for (const { segment } of graphemes.segment(part)) {
      if (used + cells(segment) > n) return out
      used += cells(segment)
      out += segment
    }
  }
  return out
}
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
// the names out of sight before it is cut, so no part of one is left before the …
const cut = (s, n) => {
  const shown = hide(s)
  return width(shown) > n ? clip(shown, Math.max(0, n - 1)) + '…' : shown
}
/** The cells `from` to `to` of a line without colour codes, exactly that wide: half of a wide character at an end is a space. */
function cellsOf(plain, from, to) {
  let at = 0
  let out = ''
  for (const { segment } of graphemes.segment(plain)) {
    if (at >= to) break
    const n = cells(segment)
    if (at >= from && at + n <= to) out += segment
    else if (at + n > from) out += ' '.repeat(Math.min(at + n, to) - Math.max(at, from))
    at += n
  }
  return out + ' '.repeat(Math.max(0, to - from - width(out)))
}
// text from the records, one line: no control characters (C0, C1), no invisible direction or joining controls
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
/** Text in lines of at most `n` cells, broken between words (a word longer than a line, cut). */
function wrap(text, n) {
  const lines = []
  let line = ''
  for (const word of text.split(' ').filter(w => w !== '')) {
    const longer = line === '' ? word : `${line} ${word}`
    if (width(longer) <= n) {
      line = longer
      continue
    }
    if (line !== '') lines.push(line)
    line = width(word) <= n ? word : cut(word, n)
  }
  if (line !== '') lines.push(line)
  return lines
}
const RAIN = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ01234567890ABCDEF<>/\\|=+*'
/** The compact view's tiles: at least this many cells wide, and at most this many. */
const TILE_MIN = 34
const TILE_MAX = 46
/** Room around tiles: cells between two side by side, and inside a tile between its sides and what it says. */
const TILE_GAP = 3
const TILE_PAD = 2
/**
 * A tile's buttons, on its bottom border at the right: while it runs, >_ brings up its terminal and ■ (red) stops it;
 * stopped, ► starts it again (its agents going on with their conversations). A click anywhere else on it shows its
 * details.
 */
const tileButtons = n =>
  !n.isOpenable ? [] : n.ws.isRunning ? [{ label: '[>_]', kind: 'workspace', color: 'hi' }, { label: '[■]', kind: 'shut', color: 'red' }] : [{ label: '[►]', kind: 'workspace', color: 'hi' }]
/** A tile's rows: its top border (its name), a row for each agent, its bottom border (its buttons). */
const TILE_ROWS = 4
/** An agent's background work listed under it: the oldest this many, then how many more. */
const TASKS_SHOWN = 3

/** The shared snapshot, when it is one of this version (an older plugin writes another shape): else undefined. */
function load() {
  try {
    const raw = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    return raw.version === c.SHARED_VERSION && c.isSnapshot(raw.snapshot) ? { snap: raw.snapshot, mtime: statSync(SNAPSHOT).mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/** The relay's event log: one JSON event a line (`{ at, kind, text, workspace?, agent? }`), the newest last; the last 200 read. */
function relayEvents() {
  try {
    const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '')
    return `${read(`${EVENTS}.1`)}\n${read(EVENTS)}`.trim().split('\n').slice(-200).flatMap(line => {
      try {
        const e = JSON.parse(line)
        if (typeof e.at !== 'number' || typeof e.kind !== 'string' || typeof e.text !== 'string') return []
        const target = typeof e.workspace === 'string' && WORKSPACE_ID.test(e.workspace)
          ? { kind: 'workspace', id: e.workspace, ...(e.agent === 'claude' || e.agent === 'codex' ? { agent: e.agent } : {}) }
          : undefined
        return [{ at: e.at, kind: clean(e.kind).slice(0, 7).toUpperCase(), text: clean(e.text), target }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** A workspace id as the plugin makes them: anything else names no workspace. */
const WORKSPACE_ID = /^[a-z0-9-]{1,40}$/

/** What a session's row opens: its own tab, or the workspace window it runs in, at its pane. */
const targetOf = item => {
  const t = item.target
  if (t === undefined) return undefined
  if ('tty' in t) return { kind: 'tty', tty: t.tty }
  if ('workspace' in t) {
    const id = t.workspace.replace(/^ws-/, '')
    return WORKSPACE_ID.test(id) ? { kind: 'workspace', id, agent: t.window === 'codex' ? 'codex' : 'claude' } : undefined
  }
  return undefined
}

// the account it shows: the one it was opened for (--account, as the pane that opened it showed; every account when
// none is given, or a word that cannot be an account's name), or, by `a`, every account; an account's name with no
// sessions shows an empty screen
const OWN = (() => {
  const named = process.argv[process.argv.indexOf('--account') + 1]
  return process.argv.includes('--account') && typeof named === 'string' && /^([a-z0-9][a-z0-9_.-]*)?$/i.test(named) ? named : c.ALL_ACCOUNTS
})()
// as it was before it started again in place (`a` pressed), else its own
let account = process.env.LIVE_SESSIONS_OPS_VIEW === OWN || (OWN !== c.ALL_ACCOUNTS && process.env.LIVE_SESSIONS_OPS_VIEW === c.ALL_ACCOUNTS) ? process.env.LIVE_SESSIONS_OPS_VIEW : OWN
/** What the account shown sees of a snapshot. */
const seenAs = snap => c.forAccount(snap, account)

const seen = []
let previous
/** What changed between two snapshots (sessions coming, going, at work, idle), each with what it opens. */
function diff(snap, now) {
  const state = new Map()
  const view = c.viewOf(snap, { home: HOME, now, windowMs: 0, selfId: '' })
  for (const i of [...view.workspaces.flatMap(ws => ws.items), ...view.repos.flatMap(r => r.trees.flatMap(t => t.items))]) state.set(i.key, i)
  if (previous !== undefined) {
    const said = (kind, item) => seen.unshift({ at: now, kind, text: `${item.tool.toUpperCase()} ${clean(item.title)}`, target: targetOf(item) })
    for (const [key, item] of state) {
      const before = previous.state.get(key)
      // at work: its own turn, or background work it started (a Claude session whose turn is over, not done)
      const isAtWork = state => state === 'working' || state === 'background'
      if (before === undefined) said('SPAWN', item)
      else if (before.state !== item.state && item.state === 'working') said('WORKING', item)
      else if (before.state !== item.state && item.state === 'background') said('BG WORK', item)
      else if (before.state !== item.state && isAtWork(before.state) && !isAtWork(item.state)) said('IDLE', item)
    }
    for (const [key, item] of previous.state) if (!state.has(key)) said('EXIT', item)
  }
  seen.length = Math.min(seen.length, 100)
  previous = { state }
}
/** Every event, newest first: the relay's own log, and what the snapshots showed. */
const allEvents = () => [...relayEvents(), ...seen].sort((a, b) => b.at - a.at)

/**
 * One frame: its lines, what a click on each row opens, and the workspace whose details it shows over the rest (`modal`,
 * the one asked for while it is there).
 */
function frame(snap, now, cols, rows, tick, note = '', modal = undefined) {
  const view = c.viewOf(snap, { home: HOME, now, windowMs: 0, selfId: '' })
  const all = [...view.workspaces.flatMap(ws => ws.items), ...view.repos.flatMap(r => r.trees.flatMap(t => t.items))]
  const working = all.filter(i => i.state === 'working').length
  const inBackground = all.filter(i => i.state === 'background').length
  const age = Math.round((now - snap.checkedAt) / 1000)
  const inner = cols - 2
  const out = []
  const targets = []
  const line = (s = '', target) => {
    // cut inside the border, so a long row never takes the border off the window's edge; the names out of sight first
    out.push(rgb(G.lo, '║') + pad(clip(hide(s), inner), inner) + rgb(G.lo, '║'))
    targets.push(target)
  }
  const rule = (title, left = '╠', right = '╣') => {
    const shown = hide(title)
    out.push(rgb(G.lo, left + '══ ') + rgb(G.hi, bold(shown)) + rgb(G.lo, ' ' + '═'.repeat(Math.max(0, inner - width(shown) - 4)) + right))
    targets.push(undefined)
  }
  const clock = new Date(now).toTimeString().slice(0, 8)
  rule('LIVE//SESSIONS :: OPS', '╔', '╗')
  line(` ${rgb(G.hi, clock)}   ${rgb(G.lo, account === c.ALL_ACCOUNTS ? 'ALL ACCOUNTS' : `ACCOUNT ${clean(account) || 'default'}`)}   ${rgb(G.mid, `CLAUDE ${snap.claude.length}`)}  ${rgb(G.mid, `CODEX ${snap.codex.length}`)}  ${rgb(working > 0 ? G.amber : G.lo, `WORKING ${working}`)}${inBackground > 0 ? `  ${rgb(G.cyan, `BACKGROUND ${inBackground}`)}` : ''}   ${rgb(age < 40 ? G.lo : G.red, `updated ${age}s ago`)}`)
  // what the screen shows, a button each (its key beside it), lit while on: the grid, the event log, ABC-XYZ (the names
  // kept out of sight on every screen), and the compact view (the workspaces as tiles; off, each in full)
  let toolbar = ''
  const presses = []
  for (const [what, label, key, isOn] of [['grid', 'GRID', 'g', prefs.grid], ['events', 'EVENTS', 'e', prefs.events], ['names', 'ABC-XYZ', 'n', isHiding()], ['view', 'COMPACT', 'v', prefs.view === 'compact']]) {
    const button = `[${isOn ? '▣' : '□'} ${label}]`
    toolbar += toolbar === '' ? ' ' : '   '
    // its cells on the screen: the row starts after the border, in the second
    const from = 2 + width(toolbar)
    presses.push({ kind: 'toggle', what, cols: [from, from + width(button) - 1] })
    toolbar += `${isOn ? rgb(G.hi, bold(button)) : rgb(G.lo, button)} ${rgb(G.lo, key)}`
  }
  line(toolbar, presses)
  // workspaces: nodes, each its agents and the link the relay passes hand-offs over; as tiles, several a row (the
  // compact view), or each in full (the detailed view)
  rule(`FOCUS ${view.workspaces.filter(ws => ws.isRunning).length}`)
  // a session's context as its records say it: its size, against the line where it should compact (Claude: the
  // workspace's line; Codex: its window); amber from two thirds of it, red from it
  const contextOf = item => (item.tool === 'claude' ? snap.claude.find(s => `claude-${s.pid}` === item.key) : snap.codex.find(s => `codex-${s.key}` === item.key))?.context
  /** What a workspace shows, worked out once for every way it is drawn. */
  const nodeOf = ws => {
    const raw = snap.workspaces.find(x => x.id === ws.key)
    // one agent the owner chose: its row alone, no relay (it has no one to pass to)
    const only = raw?.only === 'claude' || raw?.only === 'codex' ? raw.only : undefined
    // as the pane says it: a cue, a pass it could not make or a pane left scrolled back, until the owner types
    const needs = only === undefined && ws.relay.needsOwner
    // at work while any agent of it works, or waits on background work it started; idle, it is drawn lighter, with
    // when its agents last finished
    const isWorking = ws.items.some(i => i.state === 'working')
    const isBackground = ws.items.some(i => i.state === 'background')
    // an agent of it waits on the owner (a permission prompt, a dialog): Claude Code's own `waiting`
    const isWaiting = ws.items.some(i => i.state === 'waiting')
    // the main problem its Claude last said, and when
    const problem = typeof raw?.problem?.text === 'string' && Number.isFinite(raw.problem.at) ? raw.problem : undefined
    return {
      ws,
      relay: raw?.relay,
      problem,
      only,
      needs,
      isWorking,
      isBackground,
      isWaiting,
      // every agent of it idle: then, and only then, done
      isQuiet: ws.items.every(i => i.state === 'idle'),
      isBright: isWorking || isBackground || isWaiting || needs,
      claude: ws.items.find(i => i.tool === 'claude'),
      codex: ws.items.find(i => i.tool === 'codex'),
      doneAt: Math.max(0, ...ws.items.map(i => (Number.isFinite(i.lastActive) ? i.lastActive : 0))),
      // only an id as the plugin makes them names a workspace to open
      isOpenable: WORKSPACE_ID.test(ws.key),
    }
  }
  const nodes = view.workspaces.map(nodeOf)
  const contextShown = (n, item) => {
    const context = contextOf(item)
    if (context === undefined) return undefined
    const limit = item.tool === 'claude' ? (n.ws.compactFrom > 0 ? n.ws.compactFrom : context.window) : context.window
    const share = context.isCompacted === true || !(limit > 0) ? 0 : context.tokens / limit
    const color = share >= 1 ? G.red : share >= 2 / 3 ? G.amber : n.isBright ? G.mid : G.lo
    return rgb(color, context.isCompacted === true ? 'compacted' : r.tokensSaid(context.tokens))
  }
  // an agent's background work, a row each under its own: what it is, what its call said it does, for how long (the
  // oldest few, then how many more)
  const taskRows = item => {
    const tasks = Array.isArray(item?.tasks) ? item.tasks : []
    const shown = tasks.slice(0, TASKS_SHOWN)
    return [
      ...shown.map(t => `${' '.repeat(9)}${rgb(G.lo, '↳')} ${rgb(G.cyan, clean(t.kind))}${clean(t.what) === '' ? '' : `  ${rgb(G.mid, cut(clean(t.what), 72))}`} ${rgb(G.lo, `· ${c.ago(now - t.since)}`)}`),
      ...(tasks.length > shown.length ? [`${' '.repeat(9)}${rgb(G.lo, `↳ ${tasks.length - shown.length} more`)}`] : []),
    ]
  }
  /**
   * How an agent's state is drawn: its mark, its word and its colour. Working, background work it started, waiting on
   * the owner (red: a permission prompt or a dialog), idle; any other state the registry says (stalled) as its word.
   */
  // an agent idle beside one at work says nothing (its mark dim, for the rows to line up): the workspace is at work
  const stateLook = (n, state) =>
    state === 'working'
      ? ['●', 'working', G.amber]
      : state === 'background'
        ? ['◐', 'background', G.cyan]
        : state === 'idle'
          ? n.isWorking ? ['○', '', G.dim] : ['○', 'idle', n.isBright ? G.mid : G.lo]
          : ['◆', clean(state).slice(0, 10), state === 'waiting' ? G.red : G.mid]
  /** A workspace in full: its name and tags, a row for each agent (and its background work), the relay, the alert. */
  const nodeRows = n => {
    const { ws, relay, only, needs, isWorking, isBackground, isWaiting, isBright } = n
    const rows = []
    const name = bold(`▓▒░ ${clean(ws.name)} ░▒▓`)
    const head = needs
      ? rgb(tick % 6 < 3 ? G.red : G.hi, name)
      : isWorking
        ? `${rgb(G.amber, bold('● WORKING'))}  ${rgb(G.amber, name)}`
        : isWaiting
          ? `${rgb(G.red, bold('◆ WAITING'))}  ${rgb(G.red, name)}`
          : isBackground
            ? `${rgb(G.cyan, bold('◐ BACKGROUND'))}  ${rgb(G.cyan, name)}`
            : rgb(G.mid, name)
    // the account is the screen's, in its header; each workspace's only when every account is shown
    const tags = [
      ...(account === c.ALL_ACCOUNTS ? [clean(ws.env) || 'default'] : []),
      ...(ws.isRunning ? [] : ['stopped']),
      ...(ws.isRunning && n.isQuiet && n.doneAt > 0 ? [`done ${c.ago(now - n.doneAt)} ago`] : []),
    ]
    rows.push(`${head}${tags.length === 0 ? '' : `  ${rgb(G.lo, tags.join(' · '))}`}`)
    // an agent a line: what it does, and how large its context is; under it, its background work
    const agent = (tool, item) => {
      const label = rgb(isBright ? G.hi : G.lo, pad(`[${tool.toUpperCase()}]`, 8))
      if (item === undefined) return [`${label} ${rgb(G.dim, 'offline')}`]
      const [mark, word, color] = stateLook(n, item.state)
      const state = item.state === 'working'
        ? `${rgb(G.amber, '● working')} ${rgb(G.amber, '▁▂▃▅▇▅▃▂'.slice(tick % 8, (tick % 8) + 3).padEnd(3, '▁'))}`
        : rgb(color, pad(`${mark} ${word}`, 13))
      const context = contextShown(n, item)
      return [context === undefined ? `${label} ${state}` : `${label} ${state}  ${rgb(G.lo, 'context')} ${context}`, ...taskRows(item)]
    }
    if (only !== undefined) rows.push(...agent(only, only === 'claude' ? n.claude : n.codex))
    else {
      rows.push(...agent('claude', n.claude))
      rows.push(...agent('codex', n.codex))
      // what it last did: a hand-off in flight for 20 s after it passed, toward who got it
      const sinceRelay = relay?.at === undefined ? Infinity : now - relay.at
      const status = clean(relay?.status)
      const passed = /^passed to (Codex|Claude)/.exec(status)
      const isFlying = sinceRelay < 20_000 && passed !== null
      const arrow = passed?.[1] === 'Codex' ? '▸' : '◂'
      const flight = isFlying ? `${rgb(G.cyan, [0, 1, 2].map(k => (k === tick % 3 ? arrow : '·')).join(''))} ` : ''
      // a cue for the owner they have typed since: answered, as far as the relay can tell
      const answered = relay?.typedAt !== undefined && relay?.at !== undefined && relay.typedAt > relay.at && /^(needs you|could not pass|waits: )/.test(status)
        ? rgb(G.lo, ` · you typed ${c.ago(now - relay.typedAt)} ago`)
        : ''
      // hand-offs in a row: at the limit the relay holds the next one for the owner
      const streak = Number.isFinite(relay?.streak) && relay.streak > 0 ? rgb(relay.streak >= r.RELAY_CAP ? G.amber : G.lo, ` · ${relay.streak} of ${r.RELAY_CAP} hand-offs in a row`) : ''
      const mode = clean(relay?.mode ?? 'off')
      const last = status === '' ? '' : `  ${flight}${rgb(needs ? G.red : isFlying ? G.cyan : isBright ? G.mid : G.lo, status)}${relay?.at === undefined ? '' : rgb(G.lo, ` ${c.ago(sinceRelay)} ago`)}${answered}`
      rows.push(`${rgb(G.lo, pad('relay', 8))} ${rgb(mode === 'auto' && isBright ? G.hi : G.lo, mode)}${last}${streak}`)
    }
    if (needs) rows.push(`${rgb(tick % 6 < 3 ? G.red : G.amber, bold('⚠ OPERATOR INPUT REQUIRED ⚠'))}`)
    return rows
  }
  /**
   * A workspace as a tile `w` cells wide, four rows (TILE_ROWS): its name in its top border, coloured by what it does
   * (red, blinking: the relay needs the owner; amber: working; red: an agent waits on the owner; cyan: background
   * work; dim: stopped) and marked at its right (⚠ ● ◆ ◐ ■, or since when it is idle); a row for each agent, what it
   * does and its context; its buttons on its bottom border (tileButtons). Square corners: every monospace font has
   * them (Andale Mono has no rounded ones).
   */
  const tileOf = (n, w) => {
    const blink = tick % 6 < 3
    const edge = n.needs ? (blink ? G.red : G.hi) : n.isWorking ? G.amber : n.isWaiting ? G.red : n.isBackground ? G.cyan : n.ws.isRunning ? G.lo : G.dim
    const mark = n.needs
      ? rgb(blink ? G.red : G.hi, '⚠')
      : n.isWorking
        ? rgb(G.amber, '●')
        : n.isWaiting
          ? rgb(G.red, '◆')
          : n.isBackground
            ? rgb(G.cyan, '◐')
            : !n.ws.isRunning ? rgb(G.dim, '■') : !n.isQuiet ? rgb(G.mid, '◆') : n.doneAt > 0 ? rgb(G.lo, c.ago(now - n.doneAt)) : ''
    const markCells = mark === '' ? 0 : width(mark) + 2
    const name = cut(clean(n.ws.name), Math.max(1, w - 7 - markCells))
    // its name in amber while an agent works, as its border
    const top = `${rgb(edge, '┌─ ')}${rgb(n.needs ? edge : n.isWorking ? G.amber : n.isBright ? G.hi : G.mid, bold(name))}${rgb(edge, ` ${'─'.repeat(Math.max(1, w - 6 - width(name) - markCells))}`)}${mark === '' ? '' : ` ${mark} `}${rgb(edge, '─┐')}`
    // a row inside the border: what it says at its left, and at its right, TILE_PAD cells in from each side
    const room = w - 2 - 2 * TILE_PAD
    const inside = (left, right = '') => {
      // what is at its right (a context, the buttons) kept whole: its left is cut to the room left
      const shown = clip(left, Math.max(0, room - width(right) - (right === '' ? 0 : 1)))
      const text = `${shown}${' '.repeat(Math.max(0, room - width(shown) - width(right)))}${right}`
      return `${rgb(edge, '│')}${' '.repeat(TILE_PAD)}${text}${' '.repeat(TILE_PAD)}${rgb(edge, '│')}`
    }
    const agent = (tool, item) => {
      if (item === undefined) return inside(`${rgb(G.dim, '·')} ${rgb(G.dim, pad(tool, 6))} ${rgb(G.dim, 'offline')}`)
      const [icon, word, color] = stateLook(n, item.state)
      return inside(`${rgb(color, icon)} ${rgb(n.isBright ? G.hi : G.mid, pad(tool, 6))} ${rgb(color, word)}`, contextShown(n, item) ?? '')
    }
    const first = n.only === 'codex' ? agent('CODEX', n.codex) : agent('CLAUDE', n.claude)
    const second = n.only !== undefined ? inside('') : agent('CODEX', n.codex)
    // its buttons on its bottom border, at the right: └────[>_]─[■]─┘ (stopped: [►])
    const buttons = tileButtons(n)
    const shown = buttons.map(b => rgb(b.color === 'red' ? G.red : G.hi, b.label)).join(rgb(edge, '─'))
    const fill = Math.max(1, w - 3 - buttons.reduce((sum, b) => sum + width(b.label), Math.max(0, buttons.length - 1)))
    const bottom = `${rgb(edge, `└${'─'.repeat(fill)}`)}${shown}${rgb(edge, buttons.length === 0 ? '─'.repeat(w - 2 - fill) + '┘' : '─┘')}`
    return [top, first, second, bottom]
  }
  /** Workspaces drawn under a rule: as tiles, several a row (the compact view), or each in full (the detailed view). */
  const drawNodes = list => {
    if (prefs.view === 'compact') {
      // as many tiles a row as the window holds, at least TILE_MIN cells each and TILE_GAP apart, sharing the row's
      // width; a blank line between rows
      // (a cell's margin at each end of the row, inside the screen's border)
      const across = Math.max(1, Math.floor((inner - 2 + TILE_GAP) / (TILE_MIN + TILE_GAP)))
      const w = Math.min(TILE_MAX, Math.floor((inner - 2 - (across - 1) * TILE_GAP) / across))
      for (let k = 0; k < list.length; k += across) {
        if (k > 0) line()
        const row = list.slice(k, k + across)
        const drawn = row.map(n => tileOf(n, w))
        for (let y = 0; y < TILE_ROWS; y++) {
          // a click on a tile shows its details; on a button on its bottom border, does what it says (the row starts
          // after the border, in the second cell, then a space)
          const presses = row.flatMap((n, j) => {
            if (!n.isOpenable) return []
            const left = 3 + j * (w + TILE_GAP)
            // its buttons end two cells in from its right edge (`─┘`), one `─` between them
            const buttons = tileButtons(n)
            let at = left + w - 2 - buttons.reduce((sum, b) => sum + width(b.label), Math.max(0, buttons.length - 1))
            const pressed = buttons.map(b => {
              const cols = [at, at + width(b.label) - 1]
              at += width(b.label) + 1
              return { kind: b.kind, id: n.ws.key, cols }
            })
            return [...(y === TILE_ROWS - 1 ? pressed : []), { kind: 'details', id: n.ws.key, cols: [left, left + w - 1] }]
          })
          line(` ${drawn.map(t => t[y]).join(' '.repeat(TILE_GAP))}`, presses.length === 0 ? undefined : presses)
        }
      }
    } else {
      for (const n of list) {
        const rows = nodeRows(n)
        // the one thing a click opens here: the button down its left side (its window, as /sessions opens one)
        while (rows.length < 4) rows.push('')
        const node = n.isOpenable ? { kind: 'workspace', id: n.ws.key, cols: [3, 5] } : undefined
        rows.forEach((row, k) => line(` ${rgb(n.needs ? G.red : n.isBright ? G.cyan : G.lo, `|${'OPEN'[k] ?? ' '}|`)} ${row}`, node))
        line()
      }
    }
  }
  // FOCUS: the workspaces running; HISTORY: the stopped ones, its line kept at the bottom of the screen, folded away
  // until it is opened (a click on it, or h), where each can be started again
  const focus = nodes.filter(n => n.ws.isRunning)
  const history = nodes.filter(n => !n.ws.isRunning)
  drawNodes(focus)
  if (focus.length === 0 && history.length > 0) line(rgb(G.lo, prefs.history ? '  nothing running: ► one in HISTORY below' : '  nothing running: open HISTORY below (h) and ► one'))
  // what FOCUS takes, header included: never given up to HISTORY
  const focusEnd = out.length
  const historyAt = out.length
  // (with no workspace at all, nothing of it)
  if (nodes.length > 0) {
    const label = `HISTORY ${history.length} ${prefs.history ? '▼' : '▲'} h`
    const shown = hide(label)
    out.push(rgb(G.lo, '╠══ ') + rgb(G.hi, bold(shown)) + rgb(G.lo, ' ' + '═'.repeat(Math.max(0, inner - width(shown) - 4)) + '╣'))
    targets.push({ kind: 'toggle', what: 'history' })
    if (prefs.history && history.length === 0) line(rgb(G.lo, '  nothing stopped: ■ on a tile stops it for now, its agents going on with their conversations when ► starts it'))
    else if (prefs.history) drawNodes(history)
  }
  const historyLines = out.splice(historyAt)
  const historyTargets = targets.splice(historyAt)
  // one workspace's details over the screen, the rest dimmed behind it: all the detailed view says of it, its folder,
  // and its buttons; a click anywhere else, or esc, closes it
  const details = modal === undefined ? undefined : nodes.find(n => n.isOpenable && n.ws.key === modal)
  const overlay = n => {
    const dir = clean(n.ws.dir)
    // what it does, then its folder
    const about = [...nodeRows(n), '', rgb(G.lo, HOME !== '' && dir.startsWith(`${HOME}/`) ? `~${dir.slice(HOME.length)}` : dir)]
    // first, the main problem it works on, in plain words, in a colour of its own, as wide as the box (on a small window
    // what is cut is its folder, then what its agents do)
    const said = n.problem === undefined
      ? [rgb(G.lo, n.only === 'codex' ? 'MAIN PROBLEM · none: Codex alone does not say one' : 'MAIN PROBLEM · not said yet: its Claude says it when you next give it something')]
      : [`${rgb(G.note, bold('MAIN PROBLEM'))} ${rgb(G.lo, `· said ${c.ago(now - n.problem.at)} ago`)}`, ...wrap(hide(clean(n.problem.text)), Math.min(inner - 2, Math.max(64, ...about.map(l => width(l) + 4))) - 4).map(l => rgb(G.note, l))]
    const content = [...said, '', ...about]
    // its window brought up (stopped: started again), and stopped while it runs; the details themselves go back
    const open = n.ws.isRunning ? '[>_ open window]' : '[► start]'
    const shut = n.ws.isRunning ? '[■ stop]' : ''
    const close = '[✕ back]'
    const buttons = `${rgb(G.hi, bold(open))}   ${shut === '' ? '' : `${rgb(G.red, shut)}   `}${rgb(G.hi, close)}`
    const bw = Math.min(inner - 2, Math.max(64, ...content.map(l => width(l) + 4)))
    // its rows: as many as the screen holds below the header (below the first row, on a small window), the rest cut
    const below = rows >= 24 ? 3 : 1
    const fits = Math.max(0, rows - 1 - below - 4)
    const body = content.slice(0, fits)
    const boxRow = s => `${rgb(G.hi, '║')} ${pad(clip(hide(s), bw - 4), bw - 4)} ${rgb(G.hi, '║')}`
    const title = cut(clean(n.ws.name), bw - 7)
    const box = [
      rgb(G.hi, `╔═ ${bold(title)} ${'═'.repeat(Math.max(1, bw - 5 - width(title)))}╗`),
      ...body.map(boxRow),
      boxRow(''),
      boxRow(buttons),
      rgb(G.hi, `╚${'═'.repeat(bw - 2)}╝`),
    ]
    const x = Math.floor((cols - bw) / 2)
    const top = Math.max(below, Math.min(Math.floor((rows - box.length) / 2), rows - 1 - box.length))
    // behind it, everything dimmed, and a click there closes it
    for (let y = 0; y < out.length; y++) {
      const plain = strip(out[y])
      const inBox = y >= top && y < top + box.length
      // (the bottom line, which says esc closes it, as it is)
      if (y < out.length - 1) out[y] = inBox ? `${rgb(G.dim, cellsOf(plain, 0, x))}${box[y - top]}${rgb(G.dim, cellsOf(plain, x + bw, cols))}` : rgb(G.dim, plain)
      // (screen columns count from 1)
      const span = { kind: 'none', cols: [x + 1, x + bw] }
      const at = x + 3
      const shutAt = at + width(open) + 3
      const backAt = shut === '' ? shutAt : shutAt + width(shut) + 3
      targets[y] = !inBox
        ? { kind: 'close' }
        : y === top + box.length - 2
          ? [
              { kind: 'workspace', id: n.ws.key, cols: [at, at + width(open) - 1] },
              ...(shut === '' ? [] : [{ kind: 'shut', id: n.ws.key, cols: [shutAt, shutAt + width(shut) - 1] }]),
              { kind: 'close', cols: [backAt, backAt + width(close) - 1] },
              span,
              { kind: 'close' },
            ]
          : [span, { kind: 'close' }]
    }
  }
  if (view.workspaces.length === 0) line(rgb(G.lo, '  no nodes: + New workspace in /sessions'))
  // the repositories, each agent a cell (while shown)
  if (prefs.grid) {
    rule(`GRID ${view.repos.length}`)
    for (const repo of view.repos.slice(0, 8)) {
      const items = repo.trees.flatMap(t => t.items)
      const busy = items.filter(i => i.state === 'working').length
      const waits = items.filter(i => i.state === 'background').length
      const row = items.map(i => rgb(i.state === 'working' ? G.amber : i.state === 'background' ? G.cyan : G.lo, '▮')).join('')
      line(` ${rgb(G.mid, pad(cut(clean(repo.label), 34), 34))} ${row}${' '.repeat(Math.max(0, 14 - items.length))} ${rgb(G.lo, `${items.length} agent${items.length === 1 ? '' : 's'}`)}${busy > 0 ? rgb(G.amber, ` · ${busy} working`) : ''}${waits > 0 ? rgb(G.cyan, ` · ${waits} background`) : ''}`)
    }
  }
  // what happened, newest first (while shown)
  if (prefs.events) {
    rule('EVENT LOG · click one to open it')
    const room = Math.max(3, rows - out.length - 2)
    // the relay's events of the workspaces shown (one account's: its own; every account: all of them)
    const shownIds = new Set(snap.workspaces.map(x => x.id))
    const events = allEvents().filter(e => account === c.ALL_ACCOUNTS || e.target?.kind !== 'workspace' || shownIds.has(e.target.id))
    for (const e of events.slice(0, room)) {
      const color = /ALERT|NEEDS|WAITS|DRIFT|FAILED/.test(e.kind) ? G.red : /RELAY|PASS|NOTIFY|BG WORK|CHECKIN/.test(e.kind) ? G.cyan : /WORKING|COMPACT/.test(e.kind) ? G.amber : G.mid
      line(` ${rgb(G.lo, new Date(e.at).toTimeString().slice(0, 8))}  ${rgb(color, pad(e.kind, 7))} ${rgb(G.mid, cut(e.text, inner - 22))}${e.target !== undefined ? rgb(G.lo, ' ›') : ''}`, e.target)
    }
  }
  // HISTORY at the bottom, above the keys: what of it the screen holds below the header (its line at least); above it,
  // never more than the screen holds: the rest is cut, never scrolled
  // FOCUS first: HISTORY gets what is left below it (its line at least); what of it does not fit, said in one line
  const historyRoom = Math.min(historyLines.length, Math.max(historyLines.length === 0 ? 0 : 1, rows - 1 - focusEnd))
  if (historyRoom < historyLines.length && historyRoom >= 2) {
    const cut = history.length
    historyLines.length = historyRoom - 1
    historyTargets.length = historyRoom - 1
    historyLines.push(rgb(G.lo, '║') + pad(clip(rgb(G.lo, `  … more of HISTORY (${cut}) than the window holds below FOCUS`), inner), inner) + rgb(G.lo, '║'))
    historyTargets.push(undefined)
  }
  historyLines.length = historyRoom
  historyTargets.length = historyRoom
  out.length = Math.min(out.length, rows - 1 - historyRoom)
  targets.length = out.length
  // the rest of the screen: rain
  while (out.length < rows - 1 - historyRoom) {
    const r = out.length
    const rain = [...Array(inner)].map((_, x) => {
      const head = (tick + x * 7) % (rows + 9)
      const d = r - head
      return x % 30 === 7 && d >= -4 && d <= 0 ? rgb(d === 0 ? G.hi : G.dim, RAIN[(x * 13 + r + tick) % RAIN.length]) : ' '
    }).join('')
    out.push(rgb(G.lo, '║') + rain + rgb(G.lo, '║'))
    targets.push(undefined)
  }
  out.push(...historyLines)
  targets.push(...historyTargets)
  const keys = hide(` ${note === '' ? '' : `${clean(note)} · `}${details === undefined ? '' : 'esc closes · '}click opens · ${OWN === c.ALL_ACCOUNTS ? '' : `a ${account === c.ALL_ACCOUNTS ? 'this account' : 'all accounts'} · `}t theme: ${themeName} · q quit `)
  out.push(rgb(G.lo, '╚' + '═'.repeat(Math.max(0, inner - width(keys) - 2))) + rgb(note === '' ? G.mid : G.amber, keys) + rgb(G.lo, '══╝'))
  targets.push(undefined)
  if (details !== undefined) overlay(details)
  // the theme's background under every cell, to the line's end
  return { lines: out.map(l => bgOn() + clip(l, cols) + ' '.repeat(Math.max(0, cols - width(l))) + `${ESC}49m`), targets, modal: details?.ws.key }
}

const run = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
  return { status: r.status, stdout: r.stdout ?? '' }
}
// tests: a private tmux server that reads no tmux.conf, never the person's own; and a stand-in for osascript that
// records what it is asked, so no test opens or brings up a Terminal window
const SOCKET = process.env.LIVE_SESSIONS_TMUX_SOCKET
const OSASCRIPT = process.env.LIVE_SESSIONS_OSASCRIPT ?? '/usr/bin/osascript'
const tmux = (...args) => run(['tmux', ...(SOCKET === undefined ? [] : ['-L', SOCKET, '-f', '/dev/null']), ...args])
/**
 * What this screen asks of a Claude session (w.requestsDir): open a workspace that is not running, or close one. A
 * session running this plugin in a Terminal tab takes it and does it as /sessions does, with the same checks, and
 * answers; what it answers is said here. One at a time; one nobody takes in UNTAKEN_MS is taken back.
 */
const REQUESTS = w.requestsDir(HOME)
const UNTAKEN_MS = 12_000
/** How long a taken request is waited on (closing waits for each agent to exit, 20 s at most; opening, for Codex to let a conversation go, 90 s at most). */
const ANSWER_MAX_MS = 120_000
let pending
function ask(action, ws) {
  const said = `${action === 'open' ? 'starting' : 'stopping'} ${clean(ws.name)}`
  if (pending !== undefined) return `still ${pending.said}: one at a time`
  const nonce = randomBytes(8).toString('hex')
  try {
    mkdirSync(REQUESTS, { recursive: true })
    writeFileSync(`${REQUESTS}/${nonce}.tmp`, JSON.stringify({ action, id: ws.id, at: Date.now() }))
    renameSync(`${REQUESTS}/${nonce}.tmp`, `${REQUESTS}/${nonce}.json`)
  } catch (error) {
    return `${said}: could not ask (${String(error).split('\n')[0]})`
  }
  pending = { nonce, said, at: Date.now() }
  return `${said}: asked a Claude session…`
}
/** The answer to what was asked, once there is one: said, for a while; undefined meanwhile. */
function answered() {
  if (pending === undefined) return undefined
  const base = `${REQUESTS}/${pending.nonce}`
  const { said } = pending
  try {
    const answer = w.answerFrom(JSON.parse(readFileSync(`${base}.done`, 'utf8')))
    rmSync(`${base}.done`, { force: true })
    pending = undefined
    return answer?.text ?? `${said}: its answer could not be read`
  } catch {}
  const waited = Date.now() - pending.at
  if (existsSync(`${base}.json`)) {
    if (waited < UNTAKEN_MS) return undefined
    try {
      // taken back (a session taking it meanwhile has it: then it is waited on)
      renameSync(`${base}.json`, `${base}.dropped`)
      rmSync(`${base}.dropped`, { force: true })
      pending = undefined
      return `${said}: no Claude session running this plugin in a Terminal tab took it; open one, or use /sessions`
    } catch {
      return undefined
    }
  }
  if (waited < ANSWER_MAX_MS) return undefined
  pending = undefined
  return `${said}: no answer after ${ANSWER_MAX_MS / 60_000} minutes; see /sessions`
}
/** What earlier screens left there (asked and never answered, answers never read) once it is 10 minutes old. */
function clearRequests() {
  try {
    for (const name of readdirSync(REQUESTS)) {
      if (!/^[a-z0-9]{8,40}\.(json|tmp|done|dropped|taken-[A-Za-z0-9-]+)$/.test(name)) continue
      const file = `${REQUESTS}/${name}`
      if (Date.now() - statSync(file).mtimeMs > 600_000) rmSync(file, { force: true })
    }
  } catch {}
}
/** A workspace's ■: closed at a second press within CONFIRM_MS. */
const CONFIRM_MS = 6_000
let armed
function shut(id, snap) {
  const ws = snap.workspaces.find(x => x.id === id)
  if (ws === undefined) return 'that workspace is gone'
  if (armed?.id === id && Date.now() - armed.at < CONFIRM_MS) {
    armed = undefined
    return ask('close', ws)
  }
  armed = { id, at: Date.now() }
  return `■ again stops ${clean(ws.name)}: its agents end between turns; ► starts it again, going on with their conversations`
}

/**
 * Opens what a row is about: a session's own Terminal tab; or a running workspace's window (its tmux session, marked
 * as this workspace's), at its agent's pane when the row is one agent's: the terminal attached to it brought up, else
 * a new window attached to it, placed as /sessions opens one (60% of the screen it was on when last hidden, in this
 * screen's font). A workspace not running (or one only a session restore brought back) is asked of a Claude session,
 * which opens it as /sessions does. Says what it did.
 */
function open(target, snap) {
  if (target.kind === 'tty') {
    if (!/^ttys\d+$/.test(target.tty)) return 'not a terminal tab'
    return run([OSASCRIPT, '-l', 'JavaScript', '-e', c.FOCUS_SCRIPT, target.tty]).stdout.trim() === 'shown' ? `brought up ${target.tty}` : `${target.tty} is not a Terminal tab`
  }
  if (!WORKSPACE_ID.test(target.id)) return 'not a workspace'
  const ws = snap.workspaces.find(x => x.id === target.id)
  if (ws === undefined) return 'that workspace is gone'
  const name = `ws-${target.id}`
  // not running, or what runs under its name is not its own (a session restore's empty shells, which /sessions ends)
  if (tmux('has-session', '-t', `=${name}`).status !== 0) return ask('open', ws)
  if (tmux('show-options', '-t', name, '-qv', w.OWNER_OPTION).stdout.trim() !== String(ws.createdAt)) return ask('open', ws)
  // its panes in the colours of a window of agents (Terminal's default profile's, which a window opened here takes), or
  // none when they cannot be read, as /sessions sets them
  const listed = tmux('list-windows', '-t', `=${name}`, '-F', '#{window_id}').stdout
  for (const args of w.windowColors(listed, w.paneStyle(c.parseColors(run([OSASCRIPT, '-l', 'JavaScript', '-e', c.DEFAULT_COLORS_SCRIPT]).stdout)))) tmux(...args)
  const pane = Object.values(snap.tmux.panes).find(p => p.session === name && p.window === target.agent)?.pane
  if (pane !== undefined && /^%\d+$/.test(pane)) {
    tmux('select-window', '-t', pane)
    tmux('select-pane', '-t', pane)
  }
  const attached = tmux('list-clients', '-t', `=${name}`, '-F', '#{client_tty}').stdout.split('\n').filter(t => /^\/dev\/ttys\d+$/.test(t))
  for (const tty of attached) {
    if (run([OSASCRIPT, '-l', 'JavaScript', '-e', c.FOCUS_SCRIPT, tty.slice(5)]).stdout.trim() === 'shown') return `brought up ${clean(ws.name)}`
  }
  // a new window, placed as /sessions places one; at Terminal's own place and size when the screens cannot be read
  const attach = `tmux ${SOCKET === undefined ? '' : `-L ${w.shellQuote(SOCKET)} -f /dev/null `}attach -t ${w.shellQuote(`=${name}`)}`
  const ownTty = run(['/bin/ps', '-o', 'tty=', '-p', String(process.pid)]).stdout.trim()
  const seen = w.screensFrom(run([OSASCRIPT, '-l', 'JavaScript', '-e', w.SCREEN_SCRIPT, /^ttys\d+$/.test(ownTty) ? ownTty : 'none']).stdout)
  const kept = (() => {
    try {
      return w.placementFrom(JSON.parse(readFileSync(w.placementPath(HOME, name), 'utf8')))
    } catch {
      return undefined
    }
  })()
  const place = seen === undefined ? undefined : w.workspacePlacement(seen, kept)
  const opened = run([OSASCRIPT, '-l', 'JavaScript', '-e', c.OPEN_SCRIPT, attach, ...(place === undefined ? [] : [JSON.stringify(place)])])
  return opened.stdout.trim() === 'opened' ? `opened ${clean(ws.name)}` : `${clean(ws.name)} did not open`
}

if (process.argv.includes('--frame')) {
  const loaded = load()
  const now = Number(process.env.NOW ?? Date.now())
  diff(seenAs(loaded.snap), now)
  const { lines, targets } = frame(seenAs(loaded.snap), now, Number(process.env.COLS ?? 110), Number(process.env.ROWS ?? 34), Number(process.env.TICK ?? 3), '', process.env.MODAL)
  if (process.argv.includes('--targets')) process.stdout.write(`${JSON.stringify(targets)}\n`)
  else process.stdout.write((process.argv.includes('--plain') ? lines.map(strip) : lines).join('\n') + '\n')
} else {
  // its code as it started: changed since (an update of the plugin), the screen starts again in place, the same process,
  // window and command line, so an open window never shows an older screen than the plugin's
  const startedCode = codeAt()
  let codeCheckedAt = Date.now()
  // code it found it could not start again with: tried again only once it changes again
  let refusedCode = 0
  /** Its code's time when it changed since it started (or was last refused), settled for 2 s (an update writes several files); else 0. Looked at every 2 s. */
  const changedCode = () => {
    if (Date.now() - codeCheckedAt < 2_000) return 0
    codeCheckedAt = Date.now()
    const code = codeAt()
    return code > Math.max(startedCode, refusedCode) && Date.now() - code >= 2_000 ? code : 0
  }
  /**
   * The Node to start again with, once the new code is seen to load there (a pull stopped on a conflict, a Node too old
   * or one that cannot run would leave a window that only says so); else why not.
   */
  const restartWith = () => {
    const node = nodeToRestart()
    if (node === undefined) return { why: 'the plugin changed: q, then Ops screen in /sessions, shows it' }
    // `--frame` too: code from before `--loads` draws one frame and ends, never a live screen into a pipe; a probe that
    // hangs is ended (one that loads answers in well under a second)
    const tried = spawnSync(node, [...process.execArgv, process.argv[1], '--loads', '--frame', '--plain'], { encoding: 'utf8', input: '', timeout: 5_000, killSignal: 'SIGKILL' })
    if (tried.stdout === 'loads\n') return { node }
    if (tried.status === 0) return { why: 'the plugin there cannot start this screen again in place: q, then Ops screen in /sessions, shows it' }
    const said = clean(strip(`${tried.stderr ?? ''}\n${tried.stdout ?? ''}\n${tried.error?.message ?? ''}`).split('\n').find(l => l.trim() !== '') ?? `exit ${tried.status}`)
    return { why: `the plugin's new code does not load (${said.slice(0, 120)}): this screen goes on as it was` }
  }
  const startAgain = node => process.execve(node, [process.argv0, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, LIVE_SESSIONS_OPS_VIEW: account })
  // said while the screen is older than the plugin's and cannot start again
  let stale = ''
  let loaded = load()
  if (loaded === undefined) {
    // none of this version yet (an update: sessions not reloaded still write the one before): said, and waited for
    process.stdout.write(hide(`No snapshot of this version at ${SNAPSHOT} yet: open /sessions in Claude Code once (with this plugin's version). Waiting for it; q closes.\n`))
    // keys while it waits: q or Ctrl-C closes, any other is dropped, never left for the screen once it draws; its
    // terminal gone (closed, with or without a hang-up), it ends
    process.stdin.setRawMode?.(true)
    const onKey = d => {
      if (!d.includes(113) && !d.includes(3)) return
      process.stdin.setRawMode?.(false)
      process.exit(0)
    }
    const onGone = () => process.exit(0)
    process.stdin.on('data', onKey)
    process.stdin.on('end', onGone)
    process.stdin.on('error', onGone)
    while ((loaded = load()) === undefined) {
      await new Promise(res => setTimeout(res, 1_000))
      const code = changedCode()
      if (code === 0) continue
      const next = restartWith()
      if (next.node === undefined) {
        refusedCode = code
        stale = next.why
        process.stdout.write(hide(`${next.why}; still waiting.\n`))
        continue
      }
      process.stdin.setRawMode?.(false)
      startAgain(next.node)
    }
    process.stdin.off('data', onKey)
    process.stdin.off('end', onGone)
    process.stdin.off('error', onGone)
  }
  clearRequests()
  let tick = 0
  let note = stale
  let noteUntil = 0
  let shown = { targets: [] }
  // the workspace whose details are open over the screen, if any
  let modal
  // its own screen, no cursor, no wrapping (a long line is cut, never pushed onto the next), and the mouse taken,
  // so the wheel never scrolls the terminal's history and a click comes here
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h' + bgOn() + '\x1b[2J')
  process.stdout.on('resize', () => process.stdout.write(bgOn() + '\x1b[2J'))
  // the terminal given back as it was, however this ends: a key, a signal, an error
  let isRestored = false
  const restore = () => {
    if (isRestored) return
    isRestored = true
    try {
      writeSync(1, '\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l')
    } catch {}
  }
  process.on('exit', restore)
  const quit = () => {
    restore()
    process.exit(0)
  }
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, quit)
  // its terminal gone (the window closed, with a hang-up or without): nothing to give back or say, it just ends
  const isGone = error => ['EIO', 'EPIPE', 'ENXIO', 'EBADF'].includes(error?.code)
  process.stdout.on('error', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
  process.stdin.on('end', () => process.exit(0))
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, error => {
      if (isGone(error)) process.exit(0)
      try {
        restore()
        // written straight to the descriptor: a stream opened now on a terminal that hung up would never return
        writeSync(2, hide(`The ops screen stopped: ${String(error?.stack ?? error)}\n`))
      } catch {}
      process.exit(1)
    })
  }
  process.stdin.setRawMode?.(true)
  // a lone esc, held a moment: the start of a mouse report or key sequence read apart from its rest is joined to it;
  // alone still after that, it closes a workspace's details
  let heldEsc = false
  let escTimer
  process.stdin.on('data', d => {
    const read = d.toString()
    if (escTimer !== undefined) clearTimeout(escTimer)
    escTimer = undefined
    const text = heldEsc ? `\x1b${read}` : read
    heldEsc = false
    if (text === '\x1b') {
      heldEsc = true
      escTimer = setTimeout(() => {
        heldEsc = false
        escTimer = undefined
        modal = undefined
      }, 80)
      return
    }
    // a left click (SGR mouse: button 0, pressed) on a row that opens something
    for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      if (m[1] !== '0' || m[4] !== 'M') continue
      const at = shown.targets[Number(m[3]) - 1]
      // a row whose buttons are part of it (one, or a toolbar of several): only a click on a button
      const target = (Array.isArray(at) ? at : [at]).find(t => t != null && (t.cols === undefined || (Number(m[2]) >= t.cols[0] && Number(m[2]) <= t.cols[1])))
      if (target === undefined || target.kind === 'none') continue
      // a workspace's details shown over the screen, or closed
      if (target.kind === 'details' || target.kind === 'close') {
        modal = target.kind === 'details' ? target.id : undefined
        continue
      }
      try {
        note = target.kind === 'toggle' ? press(target.what) : target.kind === 'shut' ? shut(target.id, loaded.snap) : open(target, loaded.snap)
      } catch (error) {
        note = `could not open it (${String(error).split('\n')[0]})`
      }
      noteUntil = Date.now() + 4_000
    }
    const keys = text.replace(/\x1b\[<[0-9;]*[Mm]/g, '')
    if (keys.includes('q') || d.includes(3)) quit()
    if (keys.includes('t')) {
      nextTheme()
      process.stdout.write(bgOn() + '\x1b[2J')
    }
    // a toolbar key typed alone, never one inside pasted text
    for (const [key, what] of [['g', 'grid'], ['e', 'events'], ['n', 'names'], ['v', 'view'], ['h', 'history']]) {
      if (keys !== key) continue
      note = press(what)
      noteUntil = Date.now() + 4_000
    }
    // this account's or every one's; what came and went is counted afresh, so the switch is no news
    if (keys.includes('a') && OWN !== c.ALL_ACCOUNTS) {
      account = account === c.ALL_ACCOUNTS ? OWN : c.ALL_ACCOUNTS
      // what came and went was seen in the other view: none of it carries over
      previous = undefined
      seen.length = 0
      try {
        diff(seenAs(loaded.snap), Date.now())
      } catch {}
    }
  })
  try {
    diff(seenAs(loaded.snap), Date.now())
  } catch {}
  setInterval(() => {
    const code = changedCode()
    if (code > 0) {
      const next = restartWith()
      if (next.node === undefined) {
        // nothing to start again with: it goes on as it is, says why, and tries again once the code changes again
        refusedCode = code
        stale = next.why
      } else {
        restore()
        process.stdin.setRawMode?.(false)
        startAgain(next.node)
      }
    }
    const again = load()
    if (again !== undefined && again.mtime !== loaded.mtime) {
      loaded = again
      try {
        diff(seenAs(loaded.snap), Date.now())
      } catch {}
    }
    tick++
    // the names' switch, as another screen may have turned it: looked at about once a second
    if (tick % 7 === 0) hiding = readHiding(hiding)
    // what was asked of a Claude session: said while it is under way, and its answer for a while
    if (pending !== undefined && tick % 3 === 0) {
      const answer = answered()
      if (answer !== undefined) {
        note = answer
        noteUntil = Date.now() + 10_000
      }
    }
    if (pending !== undefined && Date.now() > noteUntil) note = `${pending.said}…`
    else if (Date.now() > noteUntil) note = stale
    const cols = process.stdout.columns ?? 80
    const rows = process.stdout.rows ?? 24
    try {
      // too small a window: said, nothing else drawn
      shown = cols < 40 || rows < 8
        ? { lines: [...Array(rows)].map((_, r) => bgOn() + clip(r === 0 ? rgb(G.mid, ' window too small for ops') : '', cols) + `${ESC}49m`), targets: [] }
        : frame(seenAs(loaded.snap), Date.now(), cols, rows, tick, note, modal)
      // details asked for a workspace no longer shown are closed (a window too small to draw keeps them for later)
      if (cols >= 40 && rows >= 8) modal = shown.modal
    } catch (error) {
      shown = { lines: [bgOn() + clip(rgb(G.red, ` cannot draw: ${hide(clean(String(error).split('\n')[0]))}`), cols) + `${ESC}49m`], targets: [] }
    }
    // each row at its place, erased first (nothing of an earlier frame stays where a row came out short); no
    // newline, so the screen never scrolls
    process.stdout.write(shown.lines.map((l, r) => `\x1b[${r + 1};1H${bgOn()}\x1b[2K${l}`).join(''))
  }, 150)
}
