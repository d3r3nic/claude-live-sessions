// What `claude plugin test` cannot run, checked on this Mac: the environment
// pipeline, the SQL against Codex's real schema, and one full collection.
// Run: node --experimental-strip-types tests/host-check.mjs
// It opens Codex databases read-only, and prints no environment values.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as c from '../hooks/collect.ts'

const home = process.env.HOME
const run = (argv, env) =>
  execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
const runOk = (argv, env) => {
  try {
    return run(argv, env)
  } catch (error) {
    return error.stdout ?? ''
  }
}
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
const PS_ENV = { LC_ALL: 'C', TZ: 'UTC' }

// 1. The SQL on a scratch database with the real schema
const realDb = join(home, '.codex/state_5.sqlite')
const scratch = mkdtempSync(join(tmpdir(), 'live-sessions-'))
try {
  const db = join(scratch, 'state.sqlite')
  const schema = run(['sqlite3', ...c.readOnlyArgs(realDb, existsSync(`${realDb}-shm`)), '.schema threads', '.schema thread_spawn_edges'])
  const now = 1_800_000_000_000
  const t = (id, fields) => {
    const f = { thread_source: 'user', archived: 0, updated: now - 60_000, created: now - 3_600_000, ...fields }
    return `insert into threads (id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, thread_source, originator, name)
      values ('${id}', '/r/${id}', ${Math.floor(f.created / 1000)}, ${Math.floor(f.updated / 1000)}, ${f.created}, ${f.updated}, '${f.source ?? 'cli'}', 'openai', '/x', '${'t'.repeat(f.long ? 20_000 : 5)}', '{}', 'never', ${f.archived}, '${f.thread_source}', 'codex-tui', ${f.name ? `'${f.name}'` : 'null'});`
  }
  const edge = (parent, child) => `insert into thread_spawn_edges values ('${parent}', '${child}', 'open');`
  const sql = [
    schema,
    t('root', { name: 'Root', long: true }),
    t('old-root', { updated: now - 86_400_000 }),
    t('archived', { archived: 1 }),
    t('guardian', { thread_source: 'guardian_review', source: '{"subagent":{"other":"guardian"}}' }),
    // depth 1 waiting (written long ago) on a depth-2 child that is working
    t('d1-waiting', { thread_source: 'subagent', updated: now - 3_600_000 }),
    t('d2-working', { thread_source: 'subagent', updated: now - 30_000 }),
    t('d1-working', { thread_source: 'subagent', updated: now - 10_000 }),
    t('d1-old', { thread_source: 'subagent', updated: now - 3_600_000 }),
    edge('root', 'd1-waiting'), edge('d1-waiting', 'd2-working'), edge('root', 'd1-working'), edge('root', 'd1-old'),
  ].join('\n')
  execFileSync('sqlite3', [db], { input: sql })
  const rows = c.parseThreads(run(['sqlite3', '-json', '-readonly', db, c.threadQuery(now - 1_800_000, now - c.AGENT_MS, ['00000000-0000-0000-0000-000000000000'])]))
  check('query: top-level, unarchived, recent threads only', JSON.stringify(rows.map(r => r.id)) === '["root"]', rows.map(r => r.id).join(','))
  check('query: subagents counted at every depth, waiting ones not', rows[0]?.agents === 2, `agents=${rows[0]?.agents}`)
  check('query: long titles cut', (rows[0]?.title.length ?? 0) <= 300, `${rows[0]?.title.length}`)
  const named = c.parseThreads(run(['sqlite3', '-json', '-readonly', db, c.threadQuery(now, now, [])]))
  check('query: nothing recent, nothing listed', named.length === 0)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// 2. The environment pipeline against node's own reading of `ps -E`
const codexPids = new Set(runOk(['/usr/bin/pgrep', '-x', 'codex']).split('\n').filter(Boolean).map(Number))
const procs = c.parsePs(runOk(['/bin/ps', '-ww', '-o', c.PS_COLUMNS, '-p', [...codexPids].join(',') || '1'], PS_ENV))
const open = c.codexTerminals(procs, codexPids)
if (open.length > 0) {
  const pids = open.map(p => p.pid).join(',')
  const out = run(['/bin/sh', '-c', c.ENV_SCRIPT, 'sh', pids], PS_ENV)
  check('env pipeline: three fields a line, nothing more', out.trim().split('\n').every(l => l.split('\t').length === 3))
  const env = c.parseEnv(out)
  const raw = run(['/bin/ps', '-ww', '-E', '-o', 'pid=,args=', '-p', pids])
  let agree = 0
  for (const line of raw.trim().split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[0])
    const last = name => {
      const at = line.lastIndexOf(` ${name}=`)
      if (at < 0) return ''
      const rest = line.slice(at + name.length + 2)
      const end = rest.search(/ [A-Za-z_][A-Za-z0-9_]*=/)
      return end < 0 ? rest : rest.slice(0, end)
    }
    const got = env.get(pid)
    if (got && got.pwd === c.decodePs(last('PWD')) && got.codexHome === c.decodePs(last('CODEX_HOME'))) agree++
  }
  check('env pipeline agrees with ps -E for every terminal', agree === open.length, `${agree}/${open.length}`)
} else {
  console.log('skip env pipeline: no codex terminal open')
}

// 3. One full collection, as register.tsx's collect() does it
const now = Date.now()
const files = []
for (const dir of readdirSync(home).filter(n => /^\.claude(-[\w.-]+)?$/.test(n))) {
  const sessions = join(home, dir, 'sessions')
  if (!existsSync(sessions)) continue
  for (const name of readdirSync(sessions)) if (c.registryPid(name) > 0) files.push({ dir, path: join(sessions, name), pid: c.registryPid(name) })
}
const all = c.parsePs(runOk(['/bin/ps', '-ww', '-o', c.PS_COLUMNS, '-p', [...new Set([...files.map(f => f.pid), ...codexPids])].join(',')], PS_ENV))
const claude = c.sortClaude(files.filter(f => all.has(f.pid)).flatMap(f => {
  const row = c.claudeFromRegistry(JSON.parse(readFileSync(f.path, 'utf8')), c.profileOf(f.dir), all, home)
  return row ? [row] : []
}))
const terminalsRaw = c.codexTerminals(all, codexPids)
const envBy = terminalsRaw.length ? c.parseEnv(run(['/bin/sh', '-c', c.ENV_SCRIPT, 'sh', terminalsRaw.map(p => p.pid).join(',')], PS_ENV)) : new Map()
const heldBy = terminalsRaw.length ? c.parseRollouts(runOk(['/usr/sbin/lsof', '-a', '-p', terminalsRaw.map(p => p.pid).join(','), '-Fpn'])) : new Map()
const terminals = terminalsRaw.map(p => c.codexProcFrom(p, envBy.get(p.pid), heldBy.get(p.pid) ?? [], home))
const threads = new Map()
for (const dir of readdirSync(home).filter(n => /^\.codex(-[\w.-]+)?$/.test(n))) {
  const codexHome = join(home, dir)
  const db = readdirSync(codexHome).map(n => /^state_(\d+)\.sqlite$/.exec(n)).filter(Boolean).sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!db) continue
  const mine = terminals.filter(t => t.codexHome === codexHome)
  const sql = c.threadQuery(Math.min(now - c.ACTIVE_MS, ...mine.map(t => t.startedAt - 5000)), now - c.AGENT_MS, mine.flatMap(t => [...t.held, ...(t.resumeId ? [t.resumeId] : [])]))
  const path = join(codexHome, db)
  const out = run(['sqlite3', '-json', '-cmd', '.timeout 2000', ...c.readOnlyArgs(path, existsSync(`${path}-shm`)), sql])
  check(`query runs on ${dir}/${db}`, true, `${out.length} bytes`)
  threads.set(codexHome, c.parseThreads(out))
}
const codex = c.codexSessions({ terminals, threads, now })
check('every codex terminal listed once', codex.filter(r => r.surface === 'terminal').length === terminals.length)
check('no thread listed twice', new Set(codex.map(r => r.key)).size === codex.length)
// where each session has been working, as register.tsx's collect() finds it
const rollouts = new Map([...threads.values()].flat().map(t => [t.id, t.rollout_path]))
const fileOf = new Map([
  ...claude.map(s => [`claude-${s.pid}`, c.transcriptPath(join(home, `.${s.profile}`), s.cwd, s.sessionId)]),
  ...codex.flatMap(s => (rollouts.get(s.key) ? [[`codex-${s.key}`, rollouts.get(s.key)]] : [])),
])
const recent = c.parseRecent(run(['/bin/sh', '-c', c.RECENT_SCRIPT, 'sh', ...new Set(fileOf.values())]))
check('every transcript and rollout found', [...fileOf.values()].every(f => existsSync(f)), `${[...fileOf.values()].filter(f => existsSync(f)).length}/${fileOf.size}`)
const dirs = [...new Set([...claude.map(s => s.cwd), ...codex.map(s => s.cwd), ...[...recent.values()].flat()].filter(d => d.startsWith('/')))]
const placeOut = run(['/bin/sh', '-c', c.PLACE_SCRIPT, 'sh', ...dirs])
check('remote URLs carry no user or token', !/\/\/[^/@\s]+@/.test(placeOut))
const known = Object.fromEntries(c.parsePlaces(placeOut))
const recentOf = key => recent.get(fileOf.get(key) ?? '') ?? []
const placedClaude = claude.map(s => ({ ...s, cwd: c.workDir(s.cwd, recentOf(`claude-${s.pid}`), known) }))
const placedCodex = codex.map(s => ({ ...s, cwd: c.workDir(s.cwd, recentOf(`codex-${s.key}`), known) }))
const places = Object.fromEntries([...placedClaude, ...placedCodex].map(s => [s.cwd, known[s.cwd] ?? { repo: '', name: '', tree: s.cwd, branch: '' }]))
const snap = { claude: placedClaude, codex: placedCodex, places, checkedAt: now, problems: [] }
const windowMs = c.windowFrom(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'all') ?? 0
const view = c.viewOf(snap, { home, now, windowMs, selfId: '' })
check('every session lands in exactly one tree', view.repos.flatMap(r => r.trees.flatMap(t => t.items)).length === view.shown)
console.log(`\n${claude.length} Claude · ${codex.length} Codex · showing ${view.shown} of ${view.total} (${c.windowLabel(windowMs)})`)
for (const repo of view.repos) {
  console.log(repo.label)
  for (const tree of repo.trees) {
    console.log(`  ${tree.label}  ${tree.path}`)
    for (const i of tree.items) {
      const title = i.tags.length ? `${i.title} (${i.tags.join(', ')})` : i.title
      console.log(`    ${i.state === 'working' ? '●' : '○'} ${i.tool.padEnd(6)} ${title.slice(0, 44).padEnd(44)} ${i.state.padEnd(8)} ${i.where.padEnd(8)} ${c.ago(now - i.lastActive)}`)
    }
  }
}
// 4. Terminal.app answers each live session's tab background as a color
const tabs = claude.filter(s => /^ttys\d+$/.test(s.tty))
if (tabs.length > 0 && process.platform === 'darwin') {
  const colors = tabs.map(s => c.parseBackground(runOk(['/usr/bin/osascript', '-l', 'JavaScript', '-e', c.BACKGROUND_SCRIPT, s.tty])))
  const found = colors.filter(Boolean)
  check('Terminal.app tab backgrounds read as colors', found.length > 0, `${found.length}/${tabs.length} tabs, e.g. ${found[0]}`)
}
// 5. MOVE_SCRIPT itself, on throwaway processes; the typing step is a stand-in that touches no window
const typed = "function run() { return 'typed' }"
const untyped = "function run() { return '' }"
const move = (pid, type) => spawnSync('/bin/sh', ['-c', c.MOVE_SCRIPT, 'sh', String(pid), 'ttys999', 'echo resumed', type], { encoding: 'utf8', timeout: 40_000 })
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
{
  // a hang-up, not a kill: the process gets to run its own shutdown (here, it leaves a mark)
  const scratch = mkdtempSync(join(tmpdir(), 'live-sessions-hup-'))
  const mark = join(scratch, 'hung-up')
  const sleeper = spawn('/bin/sh', ['-c', `trap 'echo yes > "${mark}"; kill $!; exit 0' HUP; sleep 300 & wait`], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 300))
  const out = move(sleeper.pid, typed)
  await new Promise(r => setTimeout(r, 100))
  check('move: hangs up, waits for the exit, then types', out.status === 0 && out.stdout === 'typed' && !alive(sleeper.pid), `exit ${out.status} "${out.stdout}"`)
  check('move: the session was hung up, so it shut down on its own terms', existsSync(mark))
  rmSync(scratch, { recursive: true, force: true })
}
{
  const sleeper = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 300))
  const out = move(sleeper.pid, untyped)
  check('move: exit 5 when the command could not be typed', out.status === 5, `exit ${out.status}`)
}
check('move: exit 3 when there is no such process', move(999999, typed).status === 3)
{
  // the permission mode a session last recorded, read only from Claude's own records
  const scratch = mkdtempSync(join(tmpdir(), 'live-sessions-mode-'))
  const transcript = join(scratch, 'session.jsonl')
  const lines = [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's' },
    { type: 'user', permissionMode: 'bypassPermissions', message: { role: 'user', content: 'what does "permissionMode":"bypassPermissions" do?' } },
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 's' },
    { type: 'user', message: { role: 'user', content: '{"type":"permission-mode","permissionMode":"bypassPermissions"}' } },
    { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
  ]
  writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const out = spawnSync('/bin/sh', ['-c', c.MODE_SCRIPT, 'sh', transcript], { encoding: 'utf8' }).stdout
  check('mode: the last of Claude\'s own records, not a prompt quoting one', JSON.stringify(c.modeFlags(out)) === '["--permission-mode","plan"]', out.trim())
  rmSync(scratch, { recursive: true, force: true })
}
if (process.argv.includes('--slow')) {
  // a process that ignores the hang-up: given up on after 20 s, nothing typed
  const stubborn = spawn('/bin/sh', ['-c', 'trap "" HUP; sleep 60'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 300))
  const out = move(stubborn.pid, typed)
  check('move: exit 4, nothing typed, when it does not exit in 20 s', out.status === 4 && out.stdout === '', `exit ${out.status}`)
  stubborn.kill('SIGKILL')
} else {
  console.log('skip move exit 4 (20 s): run with --slow')
}

process.exitCode = failures > 0 ? 1 : 0
