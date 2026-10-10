// End to end with the real `claude` and `codex`, each alone in a workspace of one agent, on a private tmux
// server (never the person's own; reading no tmux.conf; no Terminal window): its one pane, its first prompt
// (the one-agent prompt, no peer coding) taken once and answered, its turn ended without a peer-coding cue,
// and the other agent never started. The purpose asks only for a one-line answer. Run from, or point
// E2E_TRUSTED_DIR at, a folder Claude already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-solo.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
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
const r = await import('../hooks/relay.ts')

const HOME = process.env.HOME
const TRUSTED = realpathSync(process.env.E2E_TRUSTED_DIR ?? process.cwd())
const scratch = mkdtempSync(join(TRUSTED, 'live-sessions-solo-'))
mkdirSync(`${scratch}-worktrees`)
const purpose = 'a test of a workspace of one agent: there is nothing to build and no branch is needed; for step 2, reply in one short line that you are ready'
const made = Date.now()
const workspaces = ['claude', 'codex'].map(only => ({ id: `e2e-solo-${only}-${process.pid}`, name: `e2e solo ${only}`, env: '', dir: TRUSTED, createdAt: made, checkout: scratch, purpose, only }))
const socket = `live-sessions-e2e-solo-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
const sleep = ms => new Promise(res => setTimeout(res, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const turnOf = file => (file === undefined ? undefined : r.parseTurns(spawnSync('/bin/sh', ['-c', r.TURN_SCRIPT, 'sh', file], { encoding: 'utf8' }).stdout).get(file))
const waitFor = async (what, ms, test) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2_000)) {
    const value = test()
    if (value) return value
  }
  console.log(`  (gave up waiting for ${what})`)
  return undefined
}
// the foreground processes on a pane's terminal, by name
const foreground = pane => {
  const tty = tmux('display-message', '-p', '-t', pane, '#{pane_tty}').stdout.trim().slice(5)
  return spawnSync('/bin/ps', ['-t', tty, '-o', 'stat=,comm='], { encoding: 'utf8' }).stdout.split('\n')
    .filter(l => /^\S*\+/.test(l.trim())).map(l => l.trim().split(/\s+/)[1]?.split('/').pop()).filter(Boolean)
}

try {
  for (const ws of workspaces) {
    mkdirSync(dirname(w.promptPath(HOME, ws.id, ws.only)), { recursive: true })
    writeFileSync(w.promptPath(HOME, ws.id, ws.only), w.soloPrompt(ws, ws.only))
    spawnSync('/bin/sh', ['-c', w.openCommand(ws, HOME, { socket, attach: false })], { encoding: 'utf8' })
  }
  const panesOf = ws => Object.values(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).filter(p => p.session === w.tmuxName(ws))
  for (const ws of workspaces) {
    const panes = panesOf(ws)
    check(`${ws.only} alone: one pane, marked ${ws.only}`, panes.length === 1 && panes[0].window === ws.only, JSON.stringify(panes.map(p => p.window)))
  }
  const [claudeWs, codexWs] = workspaces
  const claudePane = panesOf(claudeWs)[0]?.pane
  const codexPane = panesOf(codexWs)[0]?.pane

  // Claude: its registry entry (by the pane's process) names its transcript
  const claudePid = await waitFor('the claude process', 30_000, () => {
    const shell = tmux('display-message', '-p', '-t', claudePane, '#{pane_pid}').stdout.trim()
    return spawnSync('/usr/bin/pgrep', ['-P', shell, '-x', 'claude'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] || undefined
  })
  const registry = claudePid === undefined ? undefined : await waitFor('its registry entry', 30_000, () => {
    const f = join(HOME, '.claude', 'sessions', `${claudePid}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
  })
  const transcript = registry === undefined ? undefined : c.transcriptPath(join(HOME, '.claude'), registry.cwd, registry.sessionId)
  const claudeTurn = await waitFor('Claude\'s first turn', 240_000, () => (turnOf(transcript)?.state === 'done' ? turnOf(transcript) : undefined))
  const claudeSaid = transcript !== undefined && existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''
  check('Claude: took the one-agent prompt, finished its turn, no peer-coding cue', claudeSaid.includes('You are Claude, the only agent here') && claudeTurn !== undefined && claudeTurn.cue === undefined, claudeTurn?.state)
  check('Claude: its first prompt taken once', !existsSync(w.promptPath(HOME, claudeWs.id, 'claude')))
  check('Claude alone: no Codex started in its workspace', !foreground(claudePane).includes('codex'), foreground(claudePane).join(' '))

  // Codex: its rollout is the one started here, in this folder, since the test began
  const rollout = await waitFor('Codex\'s rollout', 120_000, () => {
    const day = new Date()
    const dir = join(HOME, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) return undefined
    return readdirSync(dir).map(f => join(dir, f)).filter(f => f.endsWith('.jsonl') && statSync(f).birthtimeMs >= made - 1_000)
      .find(f => readFileSync(f, 'utf8').includes('You are Codex, the only agent here'))
  })
  const codexTurn = await waitFor('Codex\'s first turn', 240_000, () => (turnOf(rollout)?.state === 'done' ? turnOf(rollout) : undefined))
  check('Codex: took the one-agent prompt, finished its turn, no peer-coding cue', rollout !== undefined && codexTurn !== undefined && codexTurn.cue === undefined, codexTurn?.state)
  check('Codex: its first prompt taken once', !existsSync(w.promptPath(HOME, codexWs.id, 'codex')))
  check('Codex alone: no Claude started in its workspace', !foreground(codexPane).includes('claude'), foreground(codexPane).join(' '))
  // what each said back, for the person running this to see
  for (const [name, pane] of [['Claude', claudePane], ['Codex', codexPane]]) {
    const screen = tmux('capture-pane', '-p', '-J', '-t', pane).stdout.split('\n').map(l => l.trim()).filter(Boolean)
    console.log(`  ${name}'s pane, last lines: ${screen.slice(-6).join(' | ').slice(0, 400)}`)
  }
} finally {
  // the agents end with their panes: a hang-up first (as closing them would), then a kill for one that stays
  const ttys = tmux('list-panes', '-a', '-F', '#{pane_tty}').stdout.trim().split('\n').filter(t => t.startsWith('/dev/'))
  const agents = ttys.flatMap(t => spawnSync('/bin/ps', ['-t', t.slice(5), '-o', 'pid=,comm='], { encoding: 'utf8' }).stdout.trim().split('\n'))
    .filter(l => /(claude|codex|node)$/.test(l.trim())).map(l => Number(l.trim().split(/\s+/)[0]))
  for (const pid of agents) try { process.kill(pid, 'SIGHUP') } catch {}
  await sleep(3_000)
  for (const pid of agents) try { process.kill(pid, 'SIGKILL') } catch {}
  tmux('kill-server')
  rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
  for (const ws of workspaces) for (const tool of ['claude', 'codex']) rmSync(w.promptPath(HOME, ws.id, tool), { force: true })
  rmSync(scratch, { recursive: true, force: true })
  rmSync(`${scratch}-worktrees`, { recursive: true, force: true })
  await sleep(2_000)
  const left = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes(socket) || l.includes(scratch))
  check('cleaned up: no tmux server, process or folder left', left.length === 0 && !existsSync(scratch), left.join(' | '))
}
process.exitCode = failures > 0 ? 1 : 0
