// End to end with the real `claude` and `codex`, on a private tmux server (never the person's own, and
// reading no tmux.conf): a Claude session and a Codex terminal each run a turn where they are, as the
// person's own would; then they are brought into a workspace as the plugin does it: each closed where it
// runs (STOP_SCRIPT), read for how it ran, and resumed in the workspace's panes by the plugin's own command
// line, each given its first prompt there. Each must go on in the same conversation, its first turn kept.
// The prompts ask only for one fixed line back. Run from, or point E2E_TRUSTED_DIR at, a folder Claude and
// Codex already trust:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-bring.mjs
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
const TRUSTED = realpathSync(process.env.E2E_TRUSTED_DIR ?? process.cwd())
const scratch = mkdtempSync(join(TRUSTED, 'live-sessions-bring-'))
mkdirSync(`${scratch}-worktrees`)
const socket = `live-sessions-e2e-bring-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
const sh = (script, ...args) => spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { encoding: 'utf8', timeout: 60_000 }).stdout
const sleep = ms => new Promise(res => setTimeout(res, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const turnOf = file => (file === undefined ? undefined : r.parseTurns(sh(r.TURN_SCRIPT, file)).get(file))
// the Codex terminals as the plugin's own collection matches them to their conversations (processes, environments,
// rollouts held open, each Codex home's threads)
const PS_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
const codexRows = () => {
  const now = Date.now()
  const pids = new Set(spawnSync('/usr/bin/pgrep', ['-x', 'codex'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number))
  const procs = c.parsePs(spawnSync('/bin/ps', ['-ww', '-o', c.PS_COLUMNS, '-p', [...pids].join(',') || '1'], { encoding: 'utf8', env: PS_ENV }).stdout)
  const raw = c.codexTerminals(procs, pids)
  const envBy = raw.length ? c.parseEnv(spawnSync('/bin/sh', ['-c', c.ENV_SCRIPT, 'sh', raw.map(p => p.pid).join(',')], { encoding: 'utf8', env: PS_ENV }).stdout) : new Map()
  const heldBy = raw.length ? c.parseRollouts(spawnSync('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', raw.map(p => p.pid).join(','), '-Fpn'], { encoding: 'utf8' }).stdout) : new Map()
  const terminals = raw.map(p => c.codexProcFrom(p, envBy.get(p.pid), heldBy.get(p.pid) ?? [], HOME))
  const threads = new Map()
  for (const dir of readdirSync(HOME).filter(n => /^\.codex(-[\w.-]+)?$/.test(n))) {
    const codexHome = join(HOME, dir)
    const db = readdirSync(codexHome).map(n => /^state_(\d+)\.sqlite$/.exec(n)).filter(Boolean).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (!db) continue
    const mine = terminals.filter(t => t.codexHome === codexHome)
    const sql = c.threadQuery(Math.min(now - c.ACTIVE_MS, ...mine.map(t => t.startedAt - 5000)), now - c.AGENT_MS, mine.flatMap(t => [...t.held, ...(t.resumeId ? [t.resumeId] : [])]))
    const path = join(codexHome, db)
    threads.set(codexHome, c.parseThreads(spawnSync('sqlite3', ['-json', '-cmd', '.timeout 2000', ...c.readOnlyArgs(path, existsSync(`${path}-shm`)), sql], { encoding: 'utf8' }).stdout))
  }
  return c.codexSessions({ terminals, threads, now })
}
const waitFor = async (what, ms, test) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2_000)) {
    const value = test()
    if (value) return value
  }
  console.log(`  (gave up waiting for ${what})`)
  return undefined
}
const exactly = line => `This is a test of moving a conversation. Reply with exactly this one line and nothing else, and do nothing more: ${line}`
const FIRST_CLAUDE = 'READY FOR CODEX · e2e-bring · first@0000000'
const FIRST_CODEX = 'READY FOR CLAUDE · e2e-bring · first@1111111'
const AGAIN_CLAUDE = 'READY FOR CODEX · e2e-bring · again@2222222'
const AGAIN_CODEX = 'READY FOR CLAUDE · e2e-bring · again@3333333'
const ws = { id: `e2e-bring-${process.pid}`, name: 'e2e bring', env: '', dir: TRUSTED, createdAt: Date.now(), checkout: scratch }
const ttyOf = target => tmux('display-message', '-p', '-t', target, '#{pane_tty}').stdout.trim().slice(5)

try {
  // where they run first: a session of the private server, as the person's own terminals would be
  const started = Date.now()
  const quoted = text => w.shellQuote(text)
  tmux('new-session', '-d', '-s', 'origin', '-n', 'claude', '-c', TRUSTED, `${w.agentStart('claude', '', HOME)} -- ${quoted(exactly(FIRST_CLAUDE))}; exec /bin/sh`)
  tmux('new-window', '-t', '=origin:', '-n', 'codex', '-c', TRUSTED, `${w.agentStart('codex', '', HOME)} -c check_for_update_on_startup=false --sandbox workspace-write ${quoted(exactly(FIRST_CODEX))}; exec /bin/sh`)
  const claudeTty = ttyOf('=origin:claude')
  const codexTty = ttyOf('=origin:codex')

  const claudePid = await waitFor('the claude process', 30_000, () => {
    const shell = tmux('display-message', '-p', '-t', '=origin:claude', '#{pane_pid}').stdout.trim()
    return spawnSync('/usr/bin/pgrep', ['-P', shell, '-x', 'claude'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] || undefined
  })
  const registry = claudePid === undefined ? undefined : await waitFor('its registry entry', 30_000, () => {
    const f = join(HOME, '.claude', 'sessions', `${claudePid}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
  })
  const transcript = registry === undefined ? undefined : c.transcriptPath(join(HOME, '.claude'), registry.cwd, registry.sessionId)
  const claudeFirst = await waitFor('Claude\'s first turn', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.cue?.line === FIRST_CLAUDE ? t : undefined
  })
  check('where it ran: Claude took its prompt and finished a turn', claudeFirst !== undefined, claudeFirst?.cue?.line)

  const rollout = await waitFor('Codex\'s rollout', 120_000, () => {
    const day = new Date()
    const dir = join(HOME, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) return undefined
    return readdirSync(dir).map(f => join(dir, f)).filter(f => f.endsWith('.jsonl') && statSync(f).birthtimeMs >= started - 1_000)
      .find(f => readFileSync(f, 'utf8').split('\n')[0]?.includes(`"cwd":"${TRUSTED}"`))
  })
  const codexId = rollout === undefined ? undefined : JSON.parse(readFileSync(rollout, 'utf8').split('\n')[0]).payload.id
  const codexFirst = await waitFor('Codex\'s first turn', 180_000, () => {
    const t = turnOf(rollout)
    return t?.state === 'done' && t.cue?.line === FIRST_CODEX ? t : undefined
  })
  check('where it ran: Codex took its prompt and finished a turn', codexFirst !== undefined, codexFirst?.cue?.line)
  check('Codex: its rollout found by its conversation\'s id, as the plugin looks for it', sh(b.ROLLOUT_SCRIPT, join(HOME, '.codex'), codexId ?? 'none').trim() === rollout)

  // brought in: how each ran, read as the plugin reads it; then each closed where it ran
  const claudeFlags = c.modeFlags(sh(c.MODE_SCRIPT, transcript ?? '/none'))
  const codexMode = sh(b.CODEX_MODE_SCRIPT, rollout ?? '/none')
  const threads = {
    claude: { id: registry?.sessionId, dir: registry?.cwd, ...(claudeFlags?.length ? { flags: claudeFlags } : {}) },
    codex: { id: codexId, dir: b.codexDir(codexMode) ?? TRUSTED, flags: b.codexFlags(codexMode) },
  }
  check('read: Claude\'s permission flags and Codex\'s sandbox, approvals and folder', claudeFlags !== undefined && b.codexDir(codexMode) === TRUSTED && threads.codex.flags[0] === '--sandbox', JSON.stringify(threads))
  const front = tty => spawnSync('/bin/ps', ['-t', tty, '-o', 'stat=,comm='], { encoding: 'utf8' }).stdout
  // the plugin's own match: the terminal's row, its conversation and process, known for certain (else never brought in)
  const rows = codexRows()
  const row = rows.find(s => s.surface === 'terminal' && s.tty === codexTty)
  check('the plugin matches the Codex terminal to its conversation, for certain', row?.key === codexId && row.pid !== undefined && b.isKnownCodex({ codex: rows }, row), `${row?.key} ${row?.match} ${row?.pid}`)
  const codexPid = row?.pid
  const claudeStop = sh(b.STOP_SCRIPT, claudeTty, b.JOB_COMMANDS.claude, String(claudePid)).trim()
  const codexStop = sh(b.STOP_SCRIPT, codexTty, b.JOB_COMMANDS.codex, String(codexPid)).trim()
  check('closed where they ran: each hung up and exited; the terminal keeps its shell', claudeStop === 'stopped' && codexStop === 'stopped' && !/claude|codex/.test(front(claudeTty) + front(codexTty)), `${claudeStop} ${codexStop}`)
  // what the open check sees right after: neither conversation runs anywhere (no live Claude registry entry with it,
  // no Codex terminal matched to it)
  const liveClaude = readdirSync(join(HOME, '.claude', 'sessions')).filter(f => f.endsWith('.json')).some(f => {
    const entry = JSON.parse(readFileSync(join(HOME, '.claude', 'sessions', f), 'utf8'))
    try { process.kill(entry.pid, 0); return entry.sessionId === registry?.sessionId } catch { return false }
  })
  check('after closing: the open check finds neither conversation running', !liveClaude && !codexRows().some(s => s.key === codexId && s.surface === 'terminal'))

  // resumed in the workspace by the plugin's own command line, each with its first prompt there
  mkdirSync(dirname(w.promptPath(HOME, ws.id, 'claude')), { recursive: true })
  writeFileSync(w.promptPath(HOME, ws.id, 'claude'), exactly(AGAIN_CLAUDE))
  writeFileSync(w.promptPath(HOME, ws.id, 'codex'), exactly(AGAIN_CODEX))
  spawnSync('/bin/sh', ['-c', w.openCommand({ ...ws, threads }, HOME, { socket, attach: false })], { encoding: 'utf8' })
  const claudeAgain = await waitFor('Claude\'s turn in the workspace', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.cue?.line === AGAIN_CLAUDE ? t : undefined
  })
  const codexAgain = await waitFor('Codex\'s turn in the workspace', 180_000, () => {
    const t = turnOf(rollout)
    return t?.state === 'done' && t.cue?.line === AGAIN_CODEX ? t : undefined
  })
  check('workspace: Claude went on in the same conversation, its first turn kept', claudeAgain !== undefined && readFileSync(transcript, 'utf8').includes(FIRST_CLAUDE), claudeAgain?.cue?.line)
  check('workspace: Codex went on in the same conversation, its first turn kept', codexAgain !== undefined && readFileSync(rollout, 'utf8').includes(FIRST_CODEX), codexAgain?.cue?.line)
  const panes = Object.values(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT).stdout)).filter(p => p.session === w.tmuxName(ws)).map(p => p.window).sort()
  check('workspace: Claude and Codex side by side in its tmux session, marked', JSON.stringify(panes) === '["claude","codex"]', JSON.stringify(panes))
  check('workspace: each first prompt taken once', !existsSync(w.promptPath(HOME, ws.id, 'claude')) && !existsSync(w.promptPath(HOME, ws.id, 'codex')))
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
