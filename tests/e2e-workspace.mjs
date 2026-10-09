// End to end on a real Terminal.app window and the person's tmux server: open a throwaway workspace
// (the real `claude` and `codex` in its folder), check both run and the window is attached, close the
// window, check both keep running, then remove it all. Run from, or point E2E_TRUSTED_DIR at, a
// folder Claude already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-workspace.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
const ws = { id: `e2e-${process.pid}`, env: '', dir: WORK }
const session = w.tmuxName(ws)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmux = (...args) => spawnSync('tmux', args, { encoding: 'utf8' })
const argsOn = tty => spawnSync('/bin/ps', ['-t', tty, '-o', 'args='], { encoding: 'utf8' }).stdout
const agents = () => {
  const panes = Object.entries(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).filter(([, p]) => p.session === session)
  return Object.fromEntries(panes.map(([tty, p]) => [p.window, argsOn(tty)]))
}
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures++ }

try {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', c.OPEN_SCRIPT, w.openCommand(ws, HOME)])
  let running = {}
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    running = agents()
    if (/\bclaude\b/.test(running.claude ?? '') && /\bcodex\b/.test(running.codex ?? '')) break
  }
  check('opened: claude and codex run in its tmux session', /\bclaude\b/.test(running.claude ?? '') && /\bcodex\b/.test(running.codex ?? ''), Object.keys(running).join(','))
  const clients = w.parseClients(tmux('list-clients', '-F', w.CLIENTS_FORMAT).stdout)[session] ?? []
  check('a Terminal window is attached to it', clients.length === 1, clients.join(','))
  // closing the window hangs up its tmux client
  const client = spawnSync('/bin/ps', ['-t', clients[0] ?? 'none', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').find(l => /tmux attach/.test(l))?.trim().split(/\s+/)[0]
  if (client) process.kill(Number(client), 'SIGHUP')
  await sleep(2000)
  const after = agents()
  const stillAttached = w.parseClients(tmux('list-clients', '-F', w.CLIENTS_FORMAT).stdout)[session] ?? []
  check('window closed: detached, and both agents keep running', stillAttached.length === 0 && /\bclaude\b/.test(after.claude ?? '') && /\bcodex\b/.test(after.codex ?? ''))
  if (clients[0]) execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `function run(a) { const t = Application('Terminal'); for (const x of t.windows()) if (x.tabs().some(y => y.tty() === '/dev/' + a[0])) x.close() }`, clients[0]])
} finally {
  tmux('kill-session', '-t', `=${session}`)
  rmSync(`${HOME}/.claude/projects/${WORK.replace(/[^A-Za-z0-9]/g, '-')}`, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
  console.log(`cleaned up: tmux session ${session} ended, its folder deleted`)
}
process.exitCode = failures > 0 ? 1 : 0
