// The live-sessions ops screen: a full-screen console of the workspaces, their agents and what the relay does,
// drawn from the snapshot every Claude Code session with this plugin keeps, and the relay's event log. A click on
// a node, an agent or an event opens what it is about: the workspace's window at that agent, or a session's tab.
//   node ops/ops.mjs                       live, full screen (t theme, q quit)
//   node ops/ops.mjs --frame [--plain]     one frame, printed (COLS, ROWS, TICK); --targets prints what each row opens
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
// the plugin imports its own files without an extension, as its engine resolves them; Node needs `.ts`
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const c = await import(new URL('../hooks/collect.ts', import.meta.url).href)
const w = await import(new URL('../hooks/workspaces.ts', import.meta.url).href)

const HOME = process.env.HOME
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
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
// cells a character takes: two for wide ones (CJK, full-width forms, most emoji), one otherwise
const cells = ch => {
  const n = ch.codePointAt(0)
  return (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) ||
    (n >= 0xfe30 && n <= 0xfe4f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x1f300 && n <= 0x1faff) ? 2 : 1
}
const width = s => [...strip(s)].reduce((n, ch) => n + cells(ch), 0)
/** A drawn line cut to `n` cells, its colour codes kept, so nothing ever wraps onto the next row. */
function clip(line, n) {
  let used = 0
  let out = ''
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part
      continue
    }
    for (const ch of part) {
      if (used + cells(ch) > n) return out
      used += cells(ch)
      out += ch
    }
  }
  return out
}
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, Math.max(0, n - 1)).join('') + '…' : s)
// text from the records, one line, no control characters
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
const RAIN = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ01234567890ABCDEF<>/\\|=+*'

function load() {
  try {
    const raw = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    return { snap: raw.snapshot ?? raw, mtime: statSync(SNAPSHOT).mtimeMs }
  } catch {
    return undefined
  }
}

/** The relay's event log: one JSON event a line (`{ at, kind, text, workspace?, agent? }`), the newest last; the last 200 read. */
function relayEvents() {
  try {
    return readFileSync(EVENTS, 'utf8').trim().split('\n').slice(-200).flatMap(line => {
      try {
        const e = JSON.parse(line)
        if (typeof e.at !== 'number' || typeof e.kind !== 'string' || typeof e.text !== 'string') return []
        const target = typeof e.workspace === 'string' && /^[a-z0-9-]{1,40}$/.test(e.workspace)
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

/** What a session's row opens: its own tab, or the workspace window it runs in, at its pane. */
const targetOf = item => {
  const t = item.target
  if (t === undefined) return undefined
  if ('tty' in t) return { kind: 'tty', tty: t.tty }
  if ('workspace' in t) return { kind: 'workspace', id: t.workspace.replace(/^ws-/, ''), agent: t.window === 'codex' ? 'codex' : 'claude' }
  return undefined
}

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
      else if (before.state !== item.state && item.state === 'working') said('EXEC', item)
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
    out.push(rgb(G.lo, '║') + pad(s, inner) + rgb(G.lo, '║'))
    targets.push(target)
  }
  const rule = (title, left = '╠', right = '╣') => {
    out.push(rgb(G.lo, left + '══ ') + rgb(G.hi, bold(title)) + rgb(G.lo, ' ' + '═'.repeat(Math.max(0, inner - width(title) - 4)) + right))
    targets.push(undefined)
  }
  const clock = new Date(now).toTimeString().slice(0, 8)
  const blink = tick % 10 < 5 ? '●' : '○'
  rule('LIVE//SESSIONS :: OPS', '╔', '╗')
  line(` ${rgb(G.hi, clock)}   ${rgb(G.mid, `CLAUDE ${snap.claude.length}`)}  ${rgb(G.mid, `CODEX ${snap.codex.length}`)}  ${rgb(working > 0 ? G.amber : G.lo, `WORKING ${working}`)}   ${rgb(age < 40 ? G.hi : G.red, `SIGNAL ${blink} ${age}s`)}`)
  // workspaces: nodes, each its agents and the link the relay passes hand-offs over
  rule(`NODES ${view.workspaces.length}`)
  for (const ws of view.workspaces) {
    const raw = snap.workspaces.find(x => x.id === ws.key)
    const relay = raw?.relay
    const claude = ws.items.find(i => i.tool === 'claude')
    const codex = ws.items.find(i => i.tool === 'codex')
    const needs = relay?.status === 'needs you' || relay?.status === 'waits for you'
    const node = { kind: 'workspace', id: ws.key }
    line(` ${rgb(needs && tick % 6 < 3 ? G.red : G.hi, bold(`▓▒░ ${clean(ws.name)} ░▒▓`))}  ${rgb(G.lo, `env ${ws.env || 'default'} · ${ws.isAttached ? '● window open' : ws.isRunning ? '◐ hidden, running' : '○ stopped'}`)}`, node)
    const agent = (label, item) => {
      if (item === undefined) return rgb(G.dim, `[${label}] offline`)
      const bar = item.state === 'working' ? rgb(G.amber, '▁▂▃▅▇▅▃▂'.slice(tick % 8, (tick % 8) + 5).padEnd(5, '▁')) : rgb(G.dim, '·····')
      return `${rgb(G.hi, `[${label}]`)} ${item.state === 'working' ? rgb(G.amber, '● EXEC') : rgb(G.mid, '○ idle')} ${bar} ${rgb(G.mid, cut(clean(item.title), 18))}`
    }
    // a packet in flight for 20 s after a hand-off, toward who got it
    const linkWidth = 16
    const sinceRelay = relay?.at === undefined ? Infinity : now - relay.at
    let link = rgb(G.dim, '─'.repeat(linkWidth))
    if (sinceRelay < 20_000 && /Codex|Claude/.test(relay.status ?? '')) {
      const toCodex = /Codex/.test(relay.status)
      const pos = tick % linkWidth
      link = rgb(G.cyan, [...'─'.repeat(linkWidth)].map((ch, k) => (k === (toCodex ? pos : linkWidth - 1 - pos) ? (toCodex ? '▸' : '◂') : ch)).join(''))
    }
    // a click left of Codex's part opens Claude's pane; on it, Codex's
    const left = `   ${agent('CLAUDE', claude)}  ${link}  `
    line(`${left}${agent('CODEX', codex)}`, { ...node, agent: 'claude', codexFrom: 1 + width(left) })
    const mode = relay?.mode ?? 'off'
    const combo = relay?.streak ?? 0
    line(`   ${rgb(G.lo, 'relay')} ${rgb(mode === 'auto' ? G.hi : G.lo, mode.toUpperCase())}  ${rgb(G.lo, 'combo')} ${rgb(combo > 0 ? G.amber : G.lo, `x${combo}`)}  ${rgb(G.lo, 'last')} ${rgb(needs ? G.red : G.mid, clean(relay?.status) || '—')}${relay?.at !== undefined ? rgb(G.lo, ` ${c.ago(now - relay.at)} ago`) : ''}`, node)
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
    line(` ${rgb(G.mid, pad(cut(clean(repo.label), 34), 34))} ${row}${' '.repeat(Math.max(0, 14 - items.length))} ${rgb(G.lo, `${items.length} agents`)}${busy > 0 ? rgb(G.amber, ` · ${busy} exec`) : ''}`)
  }
  rule('EVENT LOG · click one to open it')
  const room = Math.max(3, rows - out.length - 2)
  for (const e of allEvents().slice(0, room)) {
    const color = /ALERT|NEEDS|WAITS|DRIFT|FAILED/.test(e.kind) ? G.red : /RELAY|PASS|NOTIFY/.test(e.kind) ? G.cyan : /EXEC|COMPACT/.test(e.kind) ? G.amber : G.mid
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
  const keys = ` ${note === '' ? '' : `${clean(note)} · `}click opens · t theme: ${themeName} · q quit `
  out.push(rgb(G.lo, '╚' + '═'.repeat(Math.max(0, inner - width(keys) - 2))) + rgb(note === '' ? G.mid : G.amber, keys) + rgb(G.lo, '══╝'))
  targets.push(undefined)
  // the theme's background under every cell, to the line's end
  return { lines: out.map(l => bgOn() + clip(l, cols) + ' '.repeat(Math.max(0, cols - width(l))) + `${ESC}49m`), targets }
}

const run = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
// tests: a private tmux server that reads no tmux.conf, never the person's own
const SOCKET = process.env.LIVE_SESSIONS_TMUX_SOCKET
const tmux = (...args) => run(['tmux', ...(SOCKET === undefined ? [] : ['-L', SOCKET, '-f', '/dev/null']), ...args])
/**
 * Opens what a row is about: a session's own Terminal tab; or a workspace's window, at its agent's pane when the
 * row is one agent's: the terminal attached to it brought up, else a new window from the file the plugin last
 * opened it with, where its window last was. Says what it did.
 */
function open(target, snap) {
  if (target.kind === 'tty') {
    return run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', c.FOCUS_SCRIPT, target.tty]).stdout.trim() === 'shown' ? `brought up ${target.tty}` : `${target.tty} is not a Terminal tab`
  }
  const name = `ws-${target.id}`
  const ws = snap.workspaces.find(x => x.id === target.id)
  if (ws === undefined) return 'that workspace is gone'
  const pane = Object.values(snap.tmux.panes).find(p => p.session === name && p.window === target.agent)?.pane
  if (pane !== undefined && /^%\d+$/.test(pane)) {
    tmux('select-window', '-t', pane)
    tmux('select-pane', '-t', pane)
  }
  const attached = tmux('list-clients', '-t', `=${name}`, '-F', '#{client_tty}').stdout.split('\n').filter(t => t.startsWith('/dev/'))
  for (const tty of attached) {
    if (run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', c.FOCUS_SCRIPT, tty.slice(5)]).stdout.trim() === 'shown') return `brought up ${clean(ws.name)}`
  }
  const file = w.openScriptPath(HOME, target.id)
  if (!existsSync(file)) return `open ${clean(ws.name)} once from /sessions first`
  let place
  try {
    place = w.placementFrom(JSON.parse(readFileSync(w.placementPath(HOME, name), 'utf8')))
  } catch {}
  const opened = run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', c.OPEN_SCRIPT, `/bin/sh ${w.shellQuote(file)}`, ...(place === undefined ? [] : [JSON.stringify(place)])])
  return opened.stdout.trim() === 'opened' ? `opened ${clean(ws.name)}` : `${clean(ws.name)} did not open`
}

if (process.argv.includes('--frame')) {
  const loaded = load()
  const now = Number(process.env.NOW ?? Date.now())
  diff(loaded.snap, now)
  const { lines, targets } = frame(loaded.snap, now, Number(process.env.COLS ?? 110), Number(process.env.ROWS ?? 34), Number(process.env.TICK ?? 3))
  if (process.argv.includes('--targets')) process.stdout.write(`${JSON.stringify(targets)}\n`)
  else process.stdout.write((process.argv.includes('--plain') ? lines.map(strip) : lines).join('\n') + '\n')
} else {
  let loaded = load()
  if (loaded === undefined) {
    process.stdout.write(`No snapshot at ${SNAPSHOT} yet: open /sessions in Claude Code once.\n`)
    process.exit(1)
  }
  let tick = 0
  let note = ''
  let noteUntil = 0
  let shown = { targets: [] }
  // its own screen, no cursor, no wrapping (a long line is cut, never pushed onto the next), and the mouse taken,
  // so the wheel never scrolls the terminal's history and a click comes here
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h' + bgOn() + '\x1b[2J')
  process.stdout.on('resize', () => process.stdout.write(bgOn() + '\x1b[2J'))
  const quit = () => {
    process.stdout.write('\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l')
    process.exit(0)
  }
  process.on('SIGHUP', quit)
  process.on('SIGTERM', quit)
  process.stdin.setRawMode?.(true)
  process.stdin.on('data', d => {
    const text = d.toString()
    // a left click (SGR mouse: button 0, pressed) on a row that opens something
    for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      if (m[1] !== '0' || m[4] !== 'M') continue
      const row = shown.targets[Number(m[3]) - 1]
      const target = row?.codexFrom !== undefined && Number(m[2]) > row.codexFrom ? { ...row, agent: 'codex' } : row
      if (target !== undefined) {
        note = open(target, loaded.snap)
        noteUntil = Date.now() + 4_000
      }
    }
    const keys = text.replace(/\x1b\[<[0-9;]*[Mm]/g, '')
    if (keys === 'q' || d[0] === 3) quit()
    if (keys === 't') {
      nextTheme()
      process.stdout.write(bgOn() + '\x1b[2J')
    }
  })
  diff(loaded.snap, Date.now())
  setInterval(() => {
    const again = load()
    if (again !== undefined && again.mtime !== loaded.mtime) {
      loaded = again
      diff(loaded.snap, Date.now())
    }
    tick++
    if (Date.now() > noteUntil) note = ''
    shown = frame(loaded.snap, Date.now(), process.stdout.columns, process.stdout.rows, tick, note)
    // each row at its place: no newline, so the screen never scrolls
    process.stdout.write(shown.lines.map((l, r) => `\x1b[${r + 1};1H${l}`).join(''))
  }, 150)
}
