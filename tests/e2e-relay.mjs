// End to end with the real `claude` and `codex`, on a private tmux server (never the person's own, and
// reading no tmux.conf): a throwaway workspace opened by the plugin's own command line, each agent given
// its first prompt; then the relay's own pieces on what the agents really write: a finished turn and
// its cue read from each one's records, and a line typed into each one's pane and taken as a prompt.
// The prompts ask only for one fixed line back. Run from, or point E2E_TRUSTED_DIR at, a folder Claude
// already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-relay.mjs
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
const scratch = mkdtempSync(join(TRUSTED, 'live-sessions-relay-'))
const ws = { id: `e2e-relay-${process.pid}`, name: 'e2e relay', env: '', dir: TRUSTED, createdAt: Date.now(), checkout: scratch }
mkdirSync(`${scratch}-worktrees`)
const socket = `live-sessions-e2e-${process.pid}`
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

const CUE_TO_CODEX = 'READY FOR CODEX · e2e · e2e@0000000'
const CUE_TO_CLAUDE = 'READY FOR CLAUDE · e2e · e2e@1111111'
const NEEDS = 'NEEDS USER · e2e · e2e@2222222'
const exactly = line => `This is a test of a terminal relay. Reply with exactly this one line and nothing else, and do nothing more: ${line}`
try {
  mkdirSync(dirname(w.promptPath(HOME, ws.id, 'claude')), { recursive: true })
  writeFileSync(w.promptPath(HOME, ws.id, 'claude'), exactly(CUE_TO_CODEX))
  writeFileSync(w.promptPath(HOME, ws.id, 'codex'), 'This is a test of a terminal relay. Reply with exactly: Ready.')
  const started = Date.now()
  spawnSync('/bin/sh', ['-c', w.openCommand(ws, HOME, { socket, attach: false })], { encoding: 'utf8' })
  const panes = Object.fromEntries(Object.values(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).map(p => [p.window, p.pane]))
  check('opened: Claude and Codex panes, marked', panes.claude !== undefined && panes.codex !== undefined, JSON.stringify(panes))
  // the pane's foreground processes, by name: tmux's own pane_current_command names only the shell that leads them
  const command = pane => {
    const tty = tmux('display-message', '-p', '-t', pane, '#{pane_tty}').stdout.trim().slice(5)
    return spawnSync('/bin/ps', ['-t', tty, '-o', 'stat=,comm='], { encoding: 'utf8' }).stdout.split('\n')
      .filter(l => /^\S*\+/.test(l.trim())).map(l => l.trim().split(/\s+/)[1]?.split('/').pop()).filter(Boolean).join(' ')
  }
  const isAgent = (pane, tool) => command(pane).split(' ').some(name => r.AGENT_COMMANDS[tool].split('|').includes(name))

  // Claude: its registry entry (by the pane's process) names its transcript
  const claudePid = await waitFor('the claude process', 30_000, () => {
    const shell = tmux('display-message', '-p', '-t', panes.claude, '#{pane_pid}').stdout.trim()
    return spawnSync('/usr/bin/pgrep', ['-P', shell, '-x', 'claude'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] || undefined
  })
  const registry = claudePid === undefined ? undefined : await waitFor('its registry entry', 30_000, () => {
    const f = join(HOME, '.claude', 'sessions', `${claudePid}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
  })
  const transcript = registry === undefined ? undefined : c.transcriptPath(join(HOME, '.claude'), registry.cwd, registry.sessionId)
  check('Claude: in its pane\'s foreground, where the relay may type', isAgent(panes.claude, 'claude'), command(panes.claude))
  const claudeFirst = await waitFor('Claude\'s first turn', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.cue !== undefined ? t : undefined
  })
  check('Claude: its first prompt taken, its turn read as finished with the cue for Codex', claudeFirst?.cue?.kind === 'ready' && claudeFirst.cue.to === 'codex' && claudeFirst.cue.line === CUE_TO_CODEX, claudeFirst?.cue?.line)
  check('Claude: its first prompt taken once', !existsSync(w.promptPath(HOME, ws.id, 'claude')))

  // Codex: its rollout is the one started here, in this folder, since the test began
  const rollout = await waitFor('Codex\'s rollout', 120_000, () => {
    const day = new Date()
    const dir = join(HOME, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) return undefined
    return readdirSync(dir).map(f => join(dir, f)).filter(f => f.endsWith('.jsonl') && statSync(f).birthtimeMs >= started - 1_000)
      .find(f => readFileSync(f, 'utf8').split('\n')[0]?.includes(`"cwd":"${TRUSTED}"`))
  })
  check('Codex: in its pane\'s foreground, where the relay may type', isAgent(panes.codex, 'codex'), command(panes.codex))
  const codexFirst = await waitFor('Codex\'s first turn', 180_000, () => (turnOf(rollout)?.state === 'done' ? turnOf(rollout) : undefined))
  check('Codex: its first prompt taken, its turn read as finished, no cue', codexFirst !== undefined && codexFirst.cue === undefined)

  // the relay types into Codex's pane; Codex takes it as a prompt and ends its turn with the cue for Claude
  const ledger = join(scratch, 'ledger')
  const pass = (key, pane, tool, line) =>
    spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', ledger, key, pane, r.AGENT_COMMANDS[tool], line, socket, 'e2e'], { encoding: 'utf8' }).stdout.trim()
  check('relay: typed into Codex\'s pane', pass('pass-e2e-1', panes.codex, 'codex', exactly(CUE_TO_CLAUDE)) === 'passed')
  const codexSecond = await waitFor('Codex\'s turn on the typed line', 180_000, () => {
    const t = turnOf(rollout)
    return t?.state === 'done' && t.id !== codexFirst?.id ? t : undefined
  })
  check('Codex: took the typed line as a prompt; its turn ends with the cue for Claude', codexSecond?.cue?.kind === 'ready' && codexSecond.cue.to === 'claude', codexSecond?.cue?.line)

  // and into Claude's pane: its turn ends with NEEDS USER, which is the owner's
  check('relay: typed into Claude\'s pane', pass('pass-e2e-2', panes.claude, 'claude', exactly(NEEDS)) === 'passed')
  const claudeSecond = await waitFor('Claude\'s turn on the typed line', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.id !== claudeFirst?.id ? t : undefined
  })
  check('Claude: took the typed line as a prompt; its turn ends with NEEDS USER', claudeSecond?.cue?.kind === 'needs-user', claudeSecond?.cue?.line)
  check('relay: a step taken once', pass('pass-e2e-2', panes.claude, 'claude', exactly(NEEDS)) === 'taken')
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
  for (const tool of ['claude', 'codex']) rmSync(w.promptPath(HOME, ws.id, tool), { force: true })
  rmSync(scratch, { recursive: true, force: true })
  rmSync(`${scratch}-worktrees`, { recursive: true, force: true })
  await sleep(2_000)
  const left = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes(socket) || l.includes(scratch))
  check('cleaned up: no tmux server, process or folder left', left.length === 0 && !existsSync(scratch), left.join(' | '))
}
process.exitCode = failures > 0 ? 1 : 0
