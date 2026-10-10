// End to end on a real Terminal.app window and a private tmux server (never the person's own, which a
// session-saving plugin would save this one into; reading no tmux.conf): open a throwaway workspace
// (the real `claude` and `codex` in its folder), check both run and the window is attached, close the
// window, check both keep running, then remove it all. Run from, or point E2E_TRUSTED_DIR at, a
// folder Claude already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-workspace.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
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
const c = await import('../hooks/collect.ts')
const w = await import('../hooks/workspaces.ts')

const HOME = process.env.HOME
const WORK = mkdtempSync(join(process.env.E2E_TRUSTED_DIR ?? process.cwd(), 'live-sessions-ws-'))
const ws = { id: `e2e-${process.pid}`, env: '', dir: WORK, createdAt: Date.now() }
const session = w.tmuxName(ws)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const socket = `live-sessions-e2e-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
const argsOn = tty => spawnSync('/bin/ps', ['-t', tty, '-o', 'args='], { encoding: 'utf8' }).stdout
const agents = () => {
  const panes = Object.entries(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).filter(([, p]) => p.session === session)
  return Object.fromEntries(panes.map(([tty, p]) => [p.window, argsOn(tty)]))
}
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures++ }

try {
  // as the mod opens it: the window's shell is given only `/bin/sh <file>` (a long line typed while a new
  // shell starts would be cut at 1024 bytes); the file holds the command line
  const openFile = join(WORK, 'open.sh')
  writeFileSync(openFile, `${w.openCommand(ws, HOME, { socket })}\n`)
  // placed as the mod places it
  const place = { x: 60, y: 80, width: 1100, height: 700, fontSize: 11 }
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', c.OPEN_SCRIPT, `/bin/sh '${openFile}'`, JSON.stringify(place)])
  let running = {}
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    running = agents()
    if (/\bclaude\b/.test(running.claude ?? '') && /\bcodex\b/.test(running.codex ?? '')) break
  }
  check('opened: claude and codex run in its tmux session', /\bclaude\b/.test(running.claude ?? '') && /\bcodex\b/.test(running.codex ?? ''), Object.keys(running).join(','))
  const clients = w.parseClients(tmux('list-clients', '-F', w.CLIENTS_FORMAT).stdout)[session] ?? []
  check('a Terminal window is attached to it', clients.length === 1, clients.join(','))
  check('its tmux session is marked as this workspace\'s', tmux('show-options', '-t', session, '-qv', w.OWNER_OPTION).stdout.trim() === String(ws.createdAt))
  const seen = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `function run(a) { const t = Application('Terminal'); for (const x of t.windows()) for (const y of x.tabs()) if (y.tty() === '/dev/' + a[0]) { const b = x.bounds(); return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, fontSize: y.fontSize() }) } return '' }`, clients[0] ?? 'none'], { encoding: 'utf8' }).stdout.trim()
  check('placed: where it was asked, in the font it was asked', seen === JSON.stringify(place), seen)
  // Hide: the mod's own hide.sh, as a click on the bar runs it inside this tmux server (TMUX names the server)
  const hideFile = join(WORK, 'hide.sh')
  writeFileSync(hideFile, w.HIDE_SCRIPT)
  const server = join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket)
  const hidden = spawnSync('/bin/sh', [hideFile, `/dev/${clients[0] ?? 'none'}`], { encoding: 'utf8', env: { ...process.env, TMUX: `${server},0,0` } }).stdout.trim()
  await sleep(1000)
  const after = agents()
  const stillAttached = w.parseClients(tmux('list-clients', '-F', w.CLIENTS_FORMAT).stdout)[session] ?? []
  const tabLeft = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', c.HAS_TAB_SCRIPT, clients[0] ?? 'none'], { encoding: 'utf8' }).stdout.trim()
  check('hidden: its window closed, the terminal detached', hidden === 'closed' && stillAttached.length === 0 && tabLeft === '', `${hidden}, tab left: ${tabLeft || 'none'}`)
  const keptFile = join(WORK, 'windows', `${session}.json`)
  const keptPlace = existsSync(keptFile) ? readFileSync(keptFile, 'utf8').trim() : ''
  check('hidden: where its window was is kept for its next opening', keptPlace === JSON.stringify(place), keptPlace)
  check('hidden: both agents keep running', /\bclaude\b/.test(after.claude ?? '') && /\bcodex\b/.test(after.codex ?? ''))
  // a window that did not close is closed here, after its client is detached
  if (tabLeft !== '') execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `function run(a) { const t = Application('Terminal'); for (const x of t.windows()) if (x.tabs().some(y => y.tty() === '/dev/' + a[0])) x.close() }`, clients[0]])
} finally {
  tmux('kill-server')
  rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
  rmSync(`${HOME}/.claude/projects/${WORK.replace(/[^A-Za-z0-9]/g, '-')}`, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
  console.log(`cleaned up: its private tmux server ended, its folder deleted`)
}
process.exitCode = failures > 0 ? 1 : 0
