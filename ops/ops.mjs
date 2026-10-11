// The live-sessions ops screen: a full-screen console of the workspaces, their agents and what the relay does,
// drawn from the snapshot every Claude Code session with this plugin keeps, and the relay's event log. A click on
// a node, an agent or an event opens what it is about: the workspace's window at that agent, or a session's tab.
//   node ops/ops.mjs [--account <env>]     live, full screen, one account's or every one's (a accounts, t theme, q quit)
//   node ops/ops.mjs --frame [--plain]     one frame, printed (COLS, ROWS, TICK); --targets prints what each row opens
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

/** Said, and left on screen until a key (the window it runs in closes with it). */
async function fail(text) {
  process.stdout.write(`${text}\nPress return to close.\n`)
  await new Promise(res => process.stdin.once('data', res))
  process.exit(1)
}
// it runs the plugin's own TypeScript as it is: Node 22.18 or later (type stripping on, module hooks there)
if (typeof nodeModule.registerHooks !== 'function') await fail(`The ops screen needs Node 22.18 or later; this is Node ${process.versions.node}.`)
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
let c, w, r
try {
  c = await import(new URL('../hooks/collect.ts', import.meta.url).href)
  w = await import(new URL('../hooks/workspaces.ts', import.meta.url).href)
  r = await import(new URL('../hooks/relay.ts', import.meta.url).href)
} catch (error) {
  await fail(`The ops screen needs Node 22.18 or later, which runs TypeScript as it is; this is Node ${process.versions.node} (${String(error).split('\n')[0]}).`)
}

const HOME = process.env.HOME
/**
 * The Node to start the screen again with: `node` as it was started, found where a new window would find it now (a Node
 * updated meanwhile is the new one), else the one running; none when there is none, or this Node cannot replace
 * itself. Checked first: a Node that replaces itself with a program not there ends then and there.
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
/** When its code (this folder's files and the plugin's hooks it loads) last changed; 0 when it cannot tell. */
function codeAt() {
  try {
    return Math.max(0, ...['.', '../hooks'].flatMap(dir => {
      const path = fileURLToPath(new URL(`${dir}/`, import.meta.url))
      return readdirSync(path, { withFileTypes: true }).filter(e => e.isFile()).map(e => statSync(path + e.name).mtimeMs)
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
const THEMES = {
  MATRIX: { bg: '#020a05', hi: '#39ff14', mid: '#00d26a', lo: '#0f7a35', dim: '#0a4a22', amber: '#ffb000', red: '#ff3b3b', cyan: '#36f9f6' },
  AMBER: { bg: '#0d0800', hi: '#ffcc33', mid: '#ffb000', lo: '#8a5a00', dim: '#4a3000', amber: '#fff1b8', red: '#ff5533', cyan: '#ffe08a' },
  CYBER: { bg: '#0a0014', hi: '#ff2bd6', mid: '#36f9f6', lo: '#6b3fa0', dim: '#2a1446', amber: '#fdf500', red: '#ff3b6b', cyan: '#00fff0' },
  ICE: { bg: '#03101c', hi: '#9be7ff', mid: '#4fc3f7', lo: '#1f5f86', dim: '#0f3350', amber: '#ffd166', red: '#ef476f', cyan: '#e0fbfc' },
  PAPER: { bg: '#f4f1e8', hi: '#0b3d20', mid: '#14532d', lo: '#6b8f71', dim: '#c8d5c3', amber: '#b45309', red: '#b91c1c', cyan: '#0e7490' },
}
const NAMES = Object.keys(THEMES)
const PREFS = `${HOME}/Library/Application Support/live-sessions/ops.json`
let themeName = (() => {
  try {
    const name = JSON.parse(readFileSync(PREFS, 'utf8')).theme
    return NAMES.includes(name) ? name : 'MATRIX'
  } catch {
    return 'MATRIX'
  }
})()
let G = THEMES[themeName]
const bgOn = () => `${ESC}48;2;${parseInt(G.bg.slice(1, 3), 16)};${parseInt(G.bg.slice(3, 5), 16)};${parseInt(G.bg.slice(5, 7), 16)}m`
function nextTheme() {
  themeName = NAMES[(NAMES.indexOf(themeName) + 1) % NAMES.length]
  G = THEMES[themeName]
  try {
    mkdirSync(PREFS.slice(0, PREFS.lastIndexOf('/')), { recursive: true })
    writeFileSync(PREFS, JSON.stringify({ theme: themeName }))
  } catch {}
}
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
const cut = (s, n) => (width(s) > n ? clip(s, Math.max(0, n - 1)) + '…' : s)
// text from the records, one line: no control characters (C0, C1), no invisible direction or joining controls
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
const RAIN = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ01234567890ABCDEF<>/\\|=+*'

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
      if (before === undefined) said('SPAWN', item)
      else if (before.state !== item.state && item.state === 'working') said('WORKING', item)
      else if (before.state !== item.state && before.state === 'working') said('IDLE', item)
    }
    for (const [key, item] of previous.state) if (!state.has(key)) said('EXIT', item)
  }
  seen.length = Math.min(seen.length, 100)
  previous = { state }
}
/** Every event, newest first: the relay's own log, and what the snapshots showed. */
const allEvents = () => [...relayEvents(), ...seen].sort((a, b) => b.at - a.at)

/** One frame: its lines, and what a click on each row opens. */
function frame(snap, now, cols, rows, tick, note = '') {
  const view = c.viewOf(snap, { home: HOME, now, windowMs: 0, selfId: '' })
  const all = [...view.workspaces.flatMap(ws => ws.items), ...view.repos.flatMap(r => r.trees.flatMap(t => t.items))]
  const working = all.filter(i => i.state === 'working').length
  const age = Math.round((now - snap.checkedAt) / 1000)
  const inner = cols - 2
  const out = []
  const targets = []
  const line = (s = '', target) => {
    // cut inside the border, so a long row never takes the border off the window's edge
    out.push(rgb(G.lo, '║') + pad(clip(s, inner), inner) + rgb(G.lo, '║'))
    targets.push(target)
  }
  const rule = (title, left = '╠', right = '╣') => {
    out.push(rgb(G.lo, left + '══ ') + rgb(G.hi, bold(title)) + rgb(G.lo, ' ' + '═'.repeat(Math.max(0, inner - width(title) - 4)) + right))
    targets.push(undefined)
  }
  const clock = new Date(now).toTimeString().slice(0, 8)
  const blink = tick % 10 < 5 ? '●' : '○'
  rule('LIVE//SESSIONS :: OPS', '╔', '╗')
  line(` ${rgb(G.hi, clock)}   ${rgb(G.lo, account === c.ALL_ACCOUNTS ? 'ALL ACCOUNTS' : `ACCOUNT ${clean(account) || 'default'}`)}   ${rgb(G.mid, `CLAUDE ${snap.claude.length}`)}  ${rgb(G.mid, `CODEX ${snap.codex.length}`)}  ${rgb(working > 0 ? G.amber : G.lo, `WORKING ${working}`)}   ${rgb(age < 40 ? G.hi : G.red, `SIGNAL ${blink} ${age}s`)}`)
  // workspaces: nodes, each its agents and the link the relay passes hand-offs over
  rule(`NODES ${view.workspaces.length}`)
  for (const ws of view.workspaces) {
    const raw = snap.workspaces.find(x => x.id === ws.key)
    const relay = raw?.relay
    const claude = ws.items.find(i => i.tool === 'claude')
    const codex = ws.items.find(i => i.tool === 'codex')
    // one agent the owner chose: its row alone, no relay (it has no one to pass to)
    const only = raw?.only === 'claude' || raw?.only === 'codex' ? raw.only : undefined
    // as the pane says it: a cue, a pass it could not make or a pane left scrolled back, until the owner types
    const needs = only === undefined && ws.relay.needsOwner
    const node = WORKSPACE_ID.test(ws.key) ? { kind: 'workspace', id: ws.key } : undefined
    // the account is the screen's, in its header; each workspace's only when every account is shown
    const tags = [...(account === c.ALL_ACCOUNTS ? [clean(ws.env) || 'default'] : []), ...(ws.isRunning ? [] : ['stopped'])]
    line(` ${rgb(needs && tick % 6 < 3 ? G.red : G.hi, bold(`▓▒░ ${clean(ws.name)} ░▒▓`))}${tags.length === 0 ? '' : `  ${rgb(G.lo, tags.join(' · '))}`}`, node)
    // an agent a line: what it does, how large its context is, its conversation's title
    const agent = (tool, item) => {
      const label = rgb(G.hi, pad(`[${tool.toUpperCase()}]`, 8))
      const target = node === undefined ? undefined : { ...node, agent: tool }
      if (item === undefined) {
        line(`   ${label} ${rgb(G.dim, 'offline')}`, target)
        return
      }
      const isWorking = item.state === 'working'
      const state = isWorking ? `${rgb(G.amber, '● working')} ${rgb(G.amber, '▁▂▃▅▇▅▃▂'.slice(tick % 8, (tick % 8) + 3).padEnd(3, '▁'))}` : rgb(G.mid, pad('○ idle', 13))
      const context = item.context === undefined ? pad('', 14) : `${rgb(G.lo, 'ctx')} ${rgb(G.mid, pad(clean(item.context), 10))}`
      line(`   ${label} ${state}  ${context} ${rgb(G.mid, cut(clean(item.title), Math.max(8, inner - 45)))}`, target)
    }
    if (only !== undefined) agent(only, only === 'claude' ? claude : codex)
    else {
      agent('claude', claude)
      agent('codex', codex)
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
      const last = status === '' ? '' : `  ${flight}${rgb(needs ? G.red : isFlying ? G.cyan : G.mid, status)}${relay?.at === undefined ? '' : rgb(G.lo, ` ${c.ago(sinceRelay)} ago`)}${answered}`
      line(`   ${rgb(G.lo, pad('relay', 8))} ${rgb(mode === 'auto' ? G.hi : G.lo, mode)}${last}${streak}`, node)
    }
    if (needs) line(`   ${rgb(tick % 6 < 3 ? G.red : G.amber, bold('⚠ OPERATOR INPUT REQUIRED ⚠'))}  ${rgb(G.mid, 'click to open')}`, node)
    line()
  }
  if (view.workspaces.length === 0) line(rgb(G.lo, '  no nodes: + New workspace in /sessions'))
  // the repositories, each agent a cell
  rule(`GRID ${view.repos.length}`)
  for (const repo of view.repos.slice(0, 8)) {
    const items = repo.trees.flatMap(t => t.items)
    const busy = items.filter(i => i.state === 'working').length
    const row = items.map(i => (i.state === 'working' ? rgb(G.amber, '▮') : rgb(G.lo, '▮'))).join('')
    line(` ${rgb(G.mid, pad(cut(clean(repo.label), 34), 34))} ${row}${' '.repeat(Math.max(0, 14 - items.length))} ${rgb(G.lo, `${items.length} agents`)}${busy > 0 ? rgb(G.amber, ` · ${busy} working`) : ''}`)
  }
  rule('EVENT LOG · click one to open it')
  const room = Math.max(3, rows - out.length - 2)
  // the relay's events of the workspaces shown (one account's: its own; every account: all of them)
  const shownIds = new Set(snap.workspaces.map(x => x.id))
  const events = allEvents().filter(e => account === c.ALL_ACCOUNTS || e.target?.kind !== 'workspace' || shownIds.has(e.target.id))
  for (const e of events.slice(0, room)) {
    const color = /ALERT|NEEDS|WAITS|DRIFT|FAILED/.test(e.kind) ? G.red : /RELAY|PASS|NOTIFY/.test(e.kind) ? G.cyan : /WORKING|COMPACT/.test(e.kind) ? G.amber : G.mid
    line(` ${rgb(G.lo, new Date(e.at).toTimeString().slice(0, 8))}  ${rgb(color, pad(e.kind, 7))} ${rgb(G.mid, cut(e.text, inner - 22))}${e.target !== undefined ? rgb(G.lo, ' ›') : ''}`, e.target)
  }
  // never more than the screen holds: the rest is cut, never scrolled
  out.length = Math.min(out.length, rows - 1)
  targets.length = out.length
  // the rest of the screen: rain
  while (out.length < rows - 1) {
    const r = out.length
    const rain = [...Array(inner)].map((_, x) => {
      const head = (tick + x * 7) % (rows + 9)
      const d = r - head
      return x % 30 === 7 && d >= -4 && d <= 0 ? rgb(d === 0 ? G.hi : G.dim, RAIN[(x * 13 + r + tick) % RAIN.length]) : ' '
    }).join('')
    out.push(rgb(G.lo, '║') + rain + rgb(G.lo, '║'))
    targets.push(undefined)
  }
  const keys = ` ${note === '' ? '' : `${clean(note)} · `}click opens · ${OWN === c.ALL_ACCOUNTS ? '' : `a ${account === c.ALL_ACCOUNTS ? 'this account' : 'all accounts'} · `}t theme: ${themeName} · q quit `
  out.push(rgb(G.lo, '╚' + '═'.repeat(Math.max(0, inner - width(keys) - 2))) + rgb(note === '' ? G.mid : G.amber, keys) + rgb(G.lo, '══╝'))
  targets.push(undefined)
  // the theme's background under every cell, to the line's end
  return { lines: out.map(l => bgOn() + clip(l, cols) + ' '.repeat(Math.max(0, cols - width(l))) + `${ESC}49m`), targets }
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
 * Opens what a row is about: a session's own Terminal tab; or a running workspace's window (its tmux session, marked
 * as this workspace's), at its agent's pane when the row is one agent's: the terminal attached to it brought up, else
 * a new window attached to it, where its window last was. A workspace not running is opened from /sessions, which
 * checks it first. Says what it did.
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
  if (tmux('has-session', '-t', `=${name}`).status !== 0) return `${clean(ws.name)} is not running: open it from /sessions`
  if (tmux('show-options', '-t', name, '-qv', w.OWNER_OPTION).stdout.trim() !== String(ws.createdAt)) return `tmux session ${name} was not started for ${clean(ws.name)}: see /sessions`
  const pane = Object.values(snap.tmux.panes).find(p => p.session === name && p.window === target.agent)?.pane
  if (pane !== undefined && /^%\d+$/.test(pane)) {
    tmux('select-window', '-t', pane)
    tmux('select-pane', '-t', pane)
  }
  const attached = tmux('list-clients', '-t', `=${name}`, '-F', '#{client_tty}').stdout.split('\n').filter(t => /^\/dev\/ttys\d+$/.test(t))
  for (const tty of attached) {
    if (run([OSASCRIPT, '-l', 'JavaScript', '-e', c.FOCUS_SCRIPT, tty.slice(5)]).stdout.trim() === 'shown') return `brought up ${clean(ws.name)}`
  }
  // a new window at Terminal's own place and size (where it last was may be on a screen no longer there)
  const attach = `tmux ${SOCKET === undefined ? '' : `-L ${w.shellQuote(SOCKET)} -f /dev/null `}attach -t ${w.shellQuote(`=${name}`)}`
  const opened = run([OSASCRIPT, '-l', 'JavaScript', '-e', c.OPEN_SCRIPT, attach])
  return opened.stdout.trim() === 'opened' ? `opened ${clean(ws.name)}` : `${clean(ws.name)} did not open`
}

if (process.argv.includes('--frame')) {
  const loaded = load()
  const now = Number(process.env.NOW ?? Date.now())
  diff(seenAs(loaded.snap), now)
  const { lines, targets } = frame(seenAs(loaded.snap), now, Number(process.env.COLS ?? 110), Number(process.env.ROWS ?? 34), Number(process.env.TICK ?? 3))
  if (process.argv.includes('--targets')) process.stdout.write(`${JSON.stringify(targets)}\n`)
  else process.stdout.write((process.argv.includes('--plain') ? lines.map(strip) : lines).join('\n') + '\n')
} else {
  // its code as it started: changed since (an update of the plugin), the screen starts again in place, the same process,
  // window and command line, so an open window never shows an older screen than the plugin's
  const startedCode = codeAt()
  let codeCheckedAt = Date.now()
  /** Whether its code changed since it started, the change settled for 2 s (an update writes several files); every 2 s. */
  const isCodeChanged = () => {
    if (Date.now() - codeCheckedAt < 2_000) return false
    codeCheckedAt = Date.now()
    const code = codeAt()
    return code > startedCode && Date.now() - code >= 2_000
  }
  const startAgain = node => process.execve(node, [process.argv0, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, LIVE_SESSIONS_OPS_VIEW: account })
  let loaded = load()
  if (loaded === undefined) {
    // none of this version yet (an update: sessions not reloaded still write the one before): said, and waited for
    process.stdout.write(`No snapshot of this version at ${SNAPSHOT} yet: open /sessions in Claude Code once (with this plugin's version). Waiting for it; Ctrl-C closes.\n`)
    while ((loaded = load()) === undefined) {
      await new Promise(res => setTimeout(res, 1_000))
      const node = isCodeChanged() ? nodeToRestart() : undefined
      if (node !== undefined) startAgain(node)
    }
  }
  let tick = 0
  let note = ''
  let isRestartable = true
  // said while the screen is older than the plugin's and cannot start again
  let stale = ''
  let noteUntil = 0
  let shown = { targets: [] }
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
  // its terminal gone (the window closed): nothing to give back or say, it just ends
  const isGone = error => ['EIO', 'EPIPE', 'ENXIO', 'EBADF'].includes(error?.code)
  process.stdout.on('error', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, error => {
      if (isGone(error)) process.exit(0)
      try {
        restore()
        // written straight to the descriptor: a stream opened now on a terminal that hung up would never return
        writeSync(2, `The ops screen stopped: ${String(error?.stack ?? error)}\n`)
      } catch {}
      process.exit(1)
    })
  }
  process.stdin.setRawMode?.(true)
  process.stdin.on('data', d => {
    const text = d.toString()
    // a left click (SGR mouse: button 0, pressed) on a row that opens something
    for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      if (m[1] !== '0' || m[4] !== 'M') continue
      const target = shown.targets[Number(m[3]) - 1]
      if (target !== undefined) {
        try {
          note = open(target, loaded.snap)
        } catch (error) {
          note = `could not open it (${String(error).split('\n')[0]})`
        }
        noteUntil = Date.now() + 4_000
      }
    }
    const keys = text.replace(/\x1b\[<[0-9;]*[Mm]/g, '')
    if (keys.includes('q') || d.includes(3)) quit()
    if (keys.includes('t')) {
      nextTheme()
      process.stdout.write(bgOn() + '\x1b[2J')
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
    if (isRestartable && isCodeChanged()) {
      const node = nodeToRestart()
      if (node === undefined) {
        // nothing to start again with (its Node or this file gone): it goes on as it is, and says so
        isRestartable = false
        stale = 'the plugin changed: q, then Ops screen in /sessions, shows it'
      } else {
        restore()
        process.stdin.setRawMode?.(false)
        startAgain(node)
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
    if (Date.now() > noteUntil) note = stale
    const cols = process.stdout.columns ?? 80
    const rows = process.stdout.rows ?? 24
    try {
      // too small a window: said, nothing else drawn
      shown = cols < 40 || rows < 8
        ? { lines: [...Array(rows)].map((_, r) => bgOn() + clip(r === 0 ? rgb(G.mid, ' window too small for ops') : '', cols) + `${ESC}49m`), targets: [] }
        : frame(seenAs(loaded.snap), Date.now(), cols, rows, tick, note)
    } catch (error) {
      shown = { lines: [bgOn() + clip(rgb(G.red, ` cannot draw: ${clean(String(error).split('\n')[0])}`), cols) + `${ESC}49m`], targets: [] }
    }
    // each row at its place, erased first (nothing of an earlier frame stays where a row came out short); no
    // newline, so the screen never scrolls
    process.stdout.write(shown.lines.map((l, r) => `\x1b[${r + 1};1H${bgOn()}\x1b[2K${l}`).join(''))
  }, 150)
}
