// End to end with the real `codex`, on a private tmux server (never the person's own, and reading no tmux.conf): a
// Codex terminal started as the person starts one (`codex`, no options), which runs its conversation in Codex's shared
// background server while that server runs, takes one turn. The plugin's own collection must match it to its
// conversation through what that server holds open, for certain (`loaded`); closed where it runs (STOP_SCRIPT), the
// workspace's pane is made at once by the plugin's own command line, while the server still holds the conversation:
// its Codex must wait, saying so, until the server lets it go (HOLDERS_SCRIPT), then go on in the same conversation, run
// it itself (--no-daemon: it holds the rollout) and be matched `held`; never two Codex processes holding it. The prompts ask only for one fixed line back; the conversation is archived at the end.
// Needs Codex's shared server for ~/.codex running (any Codex terminal started without options starts it), and no other
// Codex terminal of that server working in the same folder (two in one folder are, rightly, not certain); run from,
// or point E2E_TRUSTED_DIR at, a folder Codex already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-daemon.mjs
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
const b = await import('../hooks/bring.ts')

const HOME = process.env.HOME
const CODEX_HOME = join(HOME, '.codex')
const TRUSTED = realpathSync(process.env.E2E_TRUSTED_DIR ?? process.cwd())
const scratch = mkdtempSync(join(TRUSTED, 'live-sessions-daemon-'))
const socket = `live-sessions-e2e-daemon-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
const sh = (script, ...args) => spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { encoding: 'utf8', timeout: 150_000 }).stdout
const sleep = ms => new Promise(res => setTimeout(res, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const turnOf = file => (file === undefined ? undefined : r.parseTurns(sh(r.TURN_SCRIPT, file)).get(file))
const waitFor = async (what, ms, test) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2_000)) {
    const value = test()
    if (value) return value
  }
  console.log(`  (gave up waiting for ${what})`)
  return undefined
}
// the Codex terminals as the plugin's own collection matches them: processes, environments, the rollouts each terminal
// and each shared server holds open, each Codex home's threads
const PS_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
const collected = () => {
  const now = Date.now()
  const pids = new Set(spawnSync('/usr/bin/pgrep', ['-x', 'codex'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number))
  const procs = c.parsePs(spawnSync('/bin/ps', ['-ww', '-o', c.PS_COLUMNS, '-p', [...pids].join(',') || '1'], { encoding: 'utf8', env: PS_ENV }).stdout)
  const open = c.codexTerminals(procs, pids)
  const serving = c.codexServers(procs, pids)
  const all = [...open, ...serving].map(p => p.pid)
  const envBy = all.length ? c.parseEnv(spawnSync('/bin/sh', ['-c', c.ENV_SCRIPT, 'sh', all.join(',')], { encoding: 'utf8', env: PS_ENV }).stdout) : new Map()
  const heldBy = all.length ? c.parseRollouts(spawnSync('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', all.join(','), '-Fpn'], { encoding: 'utf8' }).stdout) : new Map()
  const terminals = open.map(p => c.codexProcFrom(p, envBy.get(p.pid), heldBy.get(p.pid) ?? [], HOME))
  const servers = new Map()
  for (const p of serving) {
    const home = envBy.get(p.pid)?.codexHome || CODEX_HOME
    servers.set(home, [...(servers.get(home) ?? []), { pid: p.pid, held: heldBy.get(p.pid) ?? [] }])
  }
  const threads = new Map()
  for (const dir of readdirSync(HOME).filter(n => /^\.codex(-[\w.-]+)?$/.test(n))) {
    const codexHome = join(HOME, dir)
    const db = readdirSync(codexHome).map(n => /^state_(\d+)\.sqlite$/.exec(n)).filter(Boolean).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (!db) continue
    const mine = terminals.filter(t => t.codexHome === codexHome)
    const ids = [...mine.flatMap(t => [...t.held, ...(t.resumeId ? [t.resumeId] : [])]), ...(servers.get(codexHome) ?? []).flatMap(s => s.held)]
    const sql = c.threadQuery(Math.min(now - c.ACTIVE_MS, ...mine.map(t => t.startedAt - 5000)), now - c.AGENT_MS, ids)
    const path = join(codexHome, db)
    threads.set(codexHome, c.parseThreads(spawnSync('sqlite3', ['-json', '-cmd', '.timeout 2000', ...c.readOnlyArgs(path, existsSync(`${path}-shm`)), sql], { encoding: 'utf8' }).stdout))
  }
  return { rows: c.codexSessions({ terminals, threads, now, servers }), servers }
}
const exactly = line => `This is a test of moving a conversation. Reply with exactly this one line and nothing else, and do nothing more: ${line}`
const FIRST = 'READY FOR CLAUDE · e2e-daemon · first@4444444'
const AGAIN = 'READY FOR CLAUDE · e2e-daemon · again@5555555'
const ws = { id: `e2e-daemon-${process.pid}`, name: 'e2e daemon', env: '', dir: TRUSTED, createdAt: Date.now(), checkout: scratch, only: 'codex' }
const ttyOf = target => tmux('display-message', '-p', '-t', target, '#{pane_tty}').stdout.trim().slice(5)
let codexId

// (how many Codex processes held the conversation at once, watched from the workspace's making)
let most = 0
let watching = false
try {
  const server = collected().servers.get(CODEX_HOME)?.[0]
  check('Codex\'s shared server for ~/.codex runs (a Codex terminal started without options started it)', server !== undefined)
  if (server === undefined) throw new Error('no shared server to test with')

  // where it runs first: a session of the private server, started as the person starts Codex
  const started = Date.now()
  tmux('new-session', '-d', '-s', 'origin', '-n', 'codex', '-c', TRUSTED, `${w.agentStart('codex', '', HOME)} ${w.shellQuote(exactly(FIRST))}; exec /bin/sh`)
  const codexTty = ttyOf('=origin:codex')
  const rollout = await waitFor('Codex\'s rollout', 120_000, () => {
    const day = new Date()
    const dir = join(CODEX_HOME, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) return undefined
    return readdirSync(dir).map(f => join(dir, f)).filter(f => f.endsWith('.jsonl') && statSync(f).birthtimeMs >= started - 1_000)
      .find(f => readFileSync(f, 'utf8').split('\n')[0]?.includes(`"cwd":"${TRUSTED}"`))
  })
  codexId = rollout === undefined ? undefined : JSON.parse(readFileSync(rollout, 'utf8').split('\n')[0]).payload.id
  const first = await waitFor('Codex\'s first turn', 180_000, () => {
    const t = turnOf(rollout)
    return t?.state === 'done' && t.cue?.line === FIRST ? t : undefined
  })
  check('where it ran: Codex took its prompt and finished a turn', first !== undefined, first?.cue?.line)

  // the terminal holds no rollout itself: the shared server does, and the plugin matches it through that, for certain
  const { rows } = collected()
  const row = rows.find(s => s.surface === 'terminal' && s.tty === codexTty)
  check('the terminal runs its conversation in the shared server, which holds it open', row?.pid !== undefined && sh(b.HOLDERS_SCRIPT, codexId ?? 'none', '1').trim() === `held ${server.pid}`, `${row?.pid} ${sh(b.HOLDERS_SCRIPT, codexId ?? 'none', '1').trim()}`)
  check('the plugin matches it to its conversation through the server, for certain', row?.key === codexId && row?.match === 'loaded' && row?.loadedBy === server.pid && b.isKnownCodex({ codex: rows }, row), `${row?.key} ${row?.match} ${row?.loadedBy}`)

  // closed where it runs: the server still holds the conversation
  const stopped = sh(b.STOP_SCRIPT, codexTty, b.JOB_COMMANDS.codex, String(row?.pid)).trim()
  const at = Date.now()
  const stillHeld = sh(b.HOLDERS_SCRIPT, codexId ?? 'none', '0').trim()
  check('closed where it ran; the shared server holds its conversation still', stopped === 'stopped' && stillHeld === `held ${server.pid}`, `${stopped} ${stillHeld}`)

  // the workspace made at once by the plugin's own command line, with its first prompt there: its Codex waits, saying
  // so, while the server holds the conversation, and goes on once it is let go; never two Codex processes holding it
  mkdirSync(dirname(w.promptPath(HOME, ws.id, 'codex')), { recursive: true })
  writeFileSync(w.promptPath(HOME, ws.id, 'codex'), exactly(AGAIN))
  const threads = { codex: { id: codexId, dir: b.codexDir(sh(b.CODEX_FOLDER_SCRIPT, rollout ?? '/none')) ?? TRUSTED } }
  spawnSync('/bin/sh', ['-c', w.openCommand({ ...ws, threads }, HOME, { socket, attach: false })], { encoding: 'utf8' })
  const paneId = () => Object.values(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).find(p => p.session === w.tmuxName(ws))?.pane ?? ''
  const holdersOf = () => {
    const pids = spawnSync('/usr/bin/pgrep', ['-x', 'codex'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).join(',')
    return pids === '' ? 0 : new Set(c.parseRollouts(spawnSync('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', pids, '-Fpn'], { encoding: 'utf8' }).stdout).entries().filter(([, held]) => held.includes(codexId)).map(([pid]) => pid)).size
  }
  watching = true
  void (async () => {
    while (watching) {
      most = Math.max(most, holdersOf())
      await sleep(500)
    }
  })()
  const waiting = await waitFor('the wait line', 20_000, () => tmux('capture-pane', '-p', '-t', paneId()).stdout.includes(w.CODEX_WAIT_LINE.slice(0, 40)))
  check('workspace: opened at once, its Codex waiting while the server holds the conversation', waiting === true && Date.now() - at < 30_000, `${Date.now() - at} ms after the close`)
  const again = await waitFor('Codex\'s turn in the workspace', 240_000, () => {
    const t = turnOf(rollout)
    return t?.state === 'done' && t.cue?.line === AGAIN ? t : undefined
  })
  const pane = Object.entries(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).find(([, p]) => p.session === w.tmuxName(ws))
  check('workspace: Codex went on in the same conversation, its first turn kept', again !== undefined && readFileSync(rollout, 'utf8').includes(FIRST),
    again?.cue?.line ?? tmux('capture-pane', '-p', '-t', pane?.[1].pane ?? '').stdout.split('\n').filter(l => l.trim() !== '').slice(-8).join(' | '))
  const args = pane === undefined ? '' : spawnSync('/bin/ps', ['-t', pane[0], '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').filter(l => !l.startsWith('/bin/sh ')).join('\n')
  const inWorkspace = collected().rows.find(s => s.surface === 'terminal' && s.tty === pane?.[0])
  check('workspace: it runs the conversation itself (--no-daemon), holding it open: matched for certain as held',
    /codex .*resume .*--no-daemon/.test(args) && inWorkspace?.key === codexId && inWorkspace?.match === 'held', `${inWorkspace?.key} ${inWorkspace?.match}`)
  watching = false
  await sleep(600)
  check('never two Codex processes holding the conversation', most === 1, `at most ${most}`)
} finally {
  watching = false
  // the agents end with their panes: a hang-up first (as closing them would), then a kill for one that stays
  const ttys = tmux('list-panes', '-a', '-F', '#{pane_tty}').stdout.trim().split('\n').filter(t => t.startsWith('/dev/'))
  const agents = ttys.flatMap(t => spawnSync('/bin/ps', ['-t', t.slice(5), '-o', 'pid=,comm='], { encoding: 'utf8' }).stdout.trim().split('\n'))
    .filter(l => /(codex|node)$/.test(l.trim())).map(l => Number(l.trim().split(/\s+/)[0]))
  for (const pid of agents) try { process.kill(pid, 'SIGHUP') } catch {}
  await sleep(3_000)
  for (const pid of agents) try { process.kill(pid, 'SIGKILL') } catch {}
  tmux('kill-server')
  rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
  rmSync(w.promptPath(HOME, ws.id, 'codex'), { force: true })
  rmSync(scratch, { recursive: true, force: true })
  rmSync(`${scratch}-worktrees`, { recursive: true, force: true })
  // the test's conversation leaves the person's list
  if (codexId !== undefined) {
    const { CODEX_HOME: _, ...env } = process.env
    const archived = spawnSync('codex', ['archive', codexId], { encoding: 'utf8', timeout: 60_000, env })
    check('cleaned up: the test conversation archived', archived.status === 0, `${archived.status} ${(archived.stderr || archived.stdout).trim().split('\n')[0]}`)
  }
  await sleep(2_000)
  const left = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes(socket) || l.includes(scratch))
  check('cleaned up: no tmux server, process or folder left', left.length === 0 && !existsSync(scratch), left.join(' | '))
}
process.exitCode = failures > 0 ? 1 : 0
