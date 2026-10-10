// What `claude plugin test` cannot run, checked on this Mac: the environment
// pipeline, the SQL against Codex's real schema, and one full collection.
// Run: node --experimental-strip-types tests/host-check.mjs
// It opens Codex databases read-only, and prints no environment values.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const c = await import('../hooks/collect.ts')
const w = await import('../hooks/workspaces.ts')
const r = await import('../hooks/relay.ts')
const dr = await import('../hooks/drift.ts')
const b = await import('../hooks/bring.ts')


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
  const noExec = c.parseThreads(run(['sqlite3', '-json', '-cmd', '.timeout 2000', ...c.readOnlyArgs(path, existsSync(`${path}-shm`)), c.threadQuery(now - 30 * 86_400_000, now, [], { noExec: true })]))
  check(`the query without exec runs leaves them out on ${dir}`, noExec.every(t => t.source !== 'exec'), `${noExec.length} threads`)
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
const workspaces = w.workspacesFrom((() => { try { return JSON.parse(readFileSync(`${home}/Library/Application Support/live-sessions/workspaces.json`, 'utf8')) } catch { return null } })())
const tmux = {
  panes: w.parsePanes(runOk(['tmux', 'list-panes', '-a', '-F', w.PANES_FORMAT])),
  clients: w.parseClients(runOk(['tmux', 'list-clients', '-F', w.CLIENTS_FORMAT])),
}
const snap = { claude: placedClaude, codex: placedCodex, places, workspaces, envs: [], tmux, checkedAt: now, problems: [] }
const windowMs = c.windowFrom(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'all') ?? 0
const view = c.viewOf(snap, { home, now, windowMs, selfId: '' })
check('every session lands in exactly one tree or workspace', view.repos.flatMap(r => r.trees.flatMap(t => t.items)).length + view.workspaces.flatMap(x => x.items).length === view.shown)
for (const x of view.workspaces) console.log(`workspace ${x.name} (${x.env || 'default'}) ${x.isRunning ? 'running' : 'stopped'}: ${x.items.map(i => `${i.tool}:${i.title}`).join(', ')}`)
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

// 6. A workspace's tmux session, on a private tmux server (never the person's own): one window, Claude
// on the left and Codex on the right, each pane marked, both in its folder, each agent started under the
// workspace's environment without Claude Code's session markers, able to work in the worktrees folder,
// Claude given the first prompt once. Stand-ins record their environment and arguments.
{
  const socket = `live-sessions-check-${process.pid}`
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-ws-')))
  // a home of its own, so the first prompt's file is never in the person's own folders
  const fakeHome = join(scratch, 'home')
  const record = (tool, tag = '') => `sh -c 'env > "${scratch}/${tag}${tool}.env"; pwd > "${scratch}/${tag}${tool}.pwd"; printf "%s\\n" "$@" > "${scratch}/${tag}${tool}.args"; sleep 30' rec`
  const ws = { id: 'check', env: 'checkenv', dir: scratch, createdAt: 1234, checkout: '/x/app' }
  const prompt = `It's "quoted" $(touch ${scratch}/RAN) \`touch ${scratch}/RAN\` ; touch ${scratch}/RAN`
  try {
    mkdirSync(dirname(w.promptPath(fakeHome, 'check', 'claude')), { recursive: true })
    writeFileSync(w.promptPath(fakeHome, 'check', 'claude'), prompt)
    writeFileSync(w.promptPath(fakeHome, 'check', 'codex'), 'Say you are ready.')
    const line = w.openCommand(ws, fakeHome, { socket, attach: false, bins: { claude: record('claude'), codex: record('codex') } })
    // run as a terminal would: by the person's shell, here carrying this session's own markers and
    // another account's config directories on purpose, which the tmux server then holds for every pane
    spawnSync(process.env.SHELL ?? '/bin/zsh', ['-c', line], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CONFIG_DIR: '/wrong/claude', CODEX_HOME: '/wrong/codex' },
    })
    for (let i = 0; i < 30 && !(existsSync(`${scratch}/claude.args`) && existsSync(`${scratch}/codex.args`)); i++) await new Promise(r => setTimeout(r, 200))
    const panes = w.parsePanes(spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'list-panes', '-a', '-F', w.PANES_FORMAT], { encoding: 'utf8' }).stdout)
    const agents = Object.values(panes).filter(p => p.session === 'ws-check').map(p => p.window).sort()
    const windows = spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'list-panes', '-t', '=ws-check', '-s', '-F', '#{window_name}'], { encoding: 'utf8' }).stdout.trim().split('\n')
    check('workspace: Claude and Codex side by side, each pane marked', JSON.stringify(agents) === '["claude","codex"]' && JSON.stringify(windows) === '["peers","peers"]', `${agents} in ${windows}`)
    const file = name => (existsSync(`${scratch}/${name}`) ? readFileSync(`${scratch}/${name}`, 'utf8') : '')
    check('workspace: both start in its folder', file('claude.pwd').trim() === scratch && file('codex.pwd').trim() === scratch)
    check('workspace: Claude under its environment\'s config directory', file('claude.env').includes(`CLAUDE_CONFIG_DIR=${fakeHome}/.claude-checkenv`))
    check('workspace: Codex under its environment\'s home', file('codex.env').includes(`CODEX_HOME=${fakeHome}/.codex-checkenv`))
    check('workspace: no Claude Code session markers reach the agents', !/^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION)=/m.test(file('claude.env') + file('codex.env')))
    check('workspace: both may work in the worktrees folder; Codex without its update offer, in workspace-write', file('codex.args') === '-c\ncheck_for_update_on_startup=false\n--sandbox\nworkspace-write\n--add-dir\n/x/app-worktrees\n--\nSay you are ready.\n', JSON.stringify(file('codex.args')))
    check('workspace: Claude takes the first prompt as it is, as one argument after --, running nothing in it', file('claude.args') === `--add-dir\n/x/app-worktrees\n--\n${prompt}\n` && !existsSync(`${scratch}/RAN`), JSON.stringify(file('claude.args').slice(0, 60)))
    check('workspace: each first prompt is taken once', !existsSync(w.promptPath(fakeHome, 'check', 'claude')) && !existsSync(w.promptPath(fakeHome, 'check', 'codex')))
    check('workspace: marked as started for this workspace', spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'show-options', '-t', 'ws-check', '-qv', w.OWNER_OPTION], { encoding: 'utf8' }).stdout.trim() === '1234')
    // used by hand: the mouse on in this session, and each side's border naming its agent
    const t6 = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' }).stdout.trim()
    check('workspace: the mouse on in its session; borders shown', t6('show-options', '-t', 'ws-check', '-v', 'mouse') === 'on' && t6('show-window-options', '-t', 'ws-check:', '-v', 'pane-border-status') === 'top')
    const sides = Object.fromEntries(Object.values(w.parsePanes(t6('list-panes', '-a', '-F', w.PANES_FORMAT))).filter(p => p.session === 'ws-check').map(p => [p.window, p.pane]))
    const border = pane => t6('display-message', '-p', '-t', pane, '#{E:pane-border-format}')
    check('workspace: each side\'s border names its agent; the side with the keys says so', border(sides.claude).startsWith('Claude') && border(sides.codex).startsWith('Codex') &&
      [border(sides.claude), border(sides.codex)].filter(b => b.includes('your keys go here')).length === 1, `${border(sides.claude)}|${border(sides.codex)}`)
    // real mouse events, from a terminal attached to it: a click on the left side gives Claude the keys; the
    // wheel over the right side scrolls Codex's side alone
    const mouse = spawnSync('python3', ['-c', `
  import os, pty, select, subprocess, time, struct, fcntl, termios, sys
  S = sys.argv[1]
  t = lambda *a: subprocess.run(['tmux', '-L', S, '-f', '/dev/null', *a], capture_output=True, text=True).stdout.strip()
  pid, fd = pty.fork()
  if pid == 0:
      os.environ['TERM'] = 'xterm-256color'
      os.execvp('tmux', ['tmux', '-L', S, '-f', '/dev/null', 'attach', '-t', '=ws-check'])
  fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
  def pump(s):
      end = time.time() + s
      while time.time() < end:
          r, _, _ = select.select([fd], [], [], 0.1)
          if r:
              try: os.read(fd, 65536)
              except OSError: return
  pump(1.5)
  before = t('display-message', '-p', '-t', 'ws-check:peers', '#{pane_id}')
  os.write(fd, b'\\x1b[<0;10;12M\\x1b[<0;10;12m'); pump(0.8)
  after = t('display-message', '-p', '-t', 'ws-check:peers', '#{pane_id}')
  os.write(fd, b'\\x1b[<64;85;12M'); pump(0.8)
  modes = t('list-panes', '-t', 'ws-check:peers', '-F', '#{pane_id}=#{pane_in_mode}')
  print(before, after, modes.replace(chr(10), ' '))
  t('send-keys', '-t', 'ws-check:peers.1', '-X', 'cancel')
  os.write(fd, b'\\x02d'); pump(0.5)
  os.close(fd)
  os.waitpid(pid, 0)
  `, socket], { encoding: 'utf8' }).stdout.trim().split(' ')
    check('workspace: a click picks the side that takes the keys', mouse[0] === sides.codex && mouse[1] === sides.claude, mouse.slice(0, 2).join(' → '))
    check('workspace: the wheel scrolls the side under it alone', mouse.includes(`${sides.codex}=1`) && mouse.includes(`${sides.claude}=0`), mouse.slice(2).join(' '))
  // Hide on the status bar, bound as the mod binds it over tmux's own, with a stand-in for hide.sh that
  // records the terminal and detaches it: a click there detaches that terminal; the session keeps running
  const standIn = join(scratch, 'hide-stand-in.sh')
  // it prints, as hide.sh does ("closed"): nothing of it may show in a pane
  writeFileSync(standIn, `#!/bin/sh\necho "$1" > "${scratch}/hidden"\ntmux detach-client -t "$1"\necho closed\n`)
  check('hide: the click is tmux\'s own before the mod binds it', w.mayBindHide(t6('list-keys', '-T', 'root', 'MouseDown1Status')))
  t6(...w.hideBinding(standIn))
  for (const args of w.sessionSetup('ws-check', [], true)) t6(...args)
  const hid = spawnSync('python3', ['-c', `
import os, pty, select, subprocess, time, struct, fcntl, termios, sys
S = sys.argv[1]
t = lambda *a: subprocess.run(['tmux', '-L', S, '-f', '/dev/null', *a], capture_output=True, text=True).stdout.strip()
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('tmux', ['tmux', '-L', S, '-f', '/dev/null', 'attach', '-t', '=ws-check'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
def pump(s):
    end = time.time() + s
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: os.read(fd, 65536)
            except OSError: return
pump(1.5)
before = t('list-clients', '-t', '=ws-check', '-F', '#{client_tty}')
os.write(fd, b'\\x1b[<0;90;30M\\x1b[<0;90;30m'); pump(1.5)
after = t('list-clients', '-t', '=ws-check', '-F', '#{client_tty}')
print(before or '-', after or '-')
os.close(fd)
try: os.waitpid(pid, 0)
except ChildProcessError: pass
`, socket], { encoding: 'utf8' }).stdout.trim().split(' ')
  const hiddenTty = existsSync(join(scratch, 'hidden')) ? readFileSync(join(scratch, 'hidden'), 'utf8').trim() : ''
  check('hide: a click on the bar\'s Hide detaches that terminal; the session keeps running', hid[0].startsWith('/dev/') && hid[1] === '-' && hiddenTty === hid[0] &&
    spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'has-session', '-t', '=ws-check']).status === 0, `${hid.join(' → ')} (${hiddenTty})`)
  check('hide: other clicks on the bar stay tmux\'s own', t6('list-keys', '-T', 'root', 'MouseDown1Status').includes(w.STATUS_CLICK))
  check('hide: what the hide prints never shows in a pane (over the agent, in a view the relay waits on)', t6('list-panes', '-s', '-t', '=ws-check', '-F', '#{pane_in_mode}').split('\n').every(m => m === '0'), t6('list-panes', '-s', '-t', '=ws-check', '-F', '#{pane_id}=#{pane_in_mode}').replace(/\n/g, ' '))
  // hide.sh, the mod's own, run by the bar's click: a terminal switched here from another session goes back to
  // it, attached, its window untouched (Terminal is never asked)
  const hideFile = join(scratch, 'hide.sh')
  writeFileSync(hideFile, w.HIDE_SCRIPT)
  t6(...w.hideBinding(hideFile))
  t6('new-session', '-d', '-s', 'home', 'sleep 30')
  const back = spawnSync('python3', ['-c', `
import os, pty, select, subprocess, time, struct, fcntl, termios, sys
S = sys.argv[1]
t = lambda *a: subprocess.run(['tmux', '-L', S, '-f', '/dev/null', *a], capture_output=True, text=True).stdout.strip()
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('tmux', ['tmux', '-L', S, '-f', '/dev/null', 'attach', '-t', '=home'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
def pump(s):
    end = time.time() + s
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: os.read(fd, 65536)
            except OSError: return
pump(1.5)
tty = t('list-clients', '-F', '#{client_tty}')
t('switch-client', '-c', tty, '-t', '=ws-check'); pump(1)
on = t('list-clients', '-F', '#{client_session}')
os.write(fd, b'\\x1b[<0;90;30M\\x1b[<0;90;30m'); pump(1.5)
print(on, t('list-clients', '-F', '#{client_session}') or '-')
t('detach-client', '-t', tty); pump(0.5)
os.close(fd)
try: os.waitpid(pid, 0)
except ChildProcessError: pass
`, socket], { encoding: 'utf8' }).stdout.trim().split(' ')
  check('hide: a terminal switched here from another tmux session goes back to it, still attached', back[0] === 'ws-check' && back[1] === 'home', back.join(' → '))
  t6('kill-session', '-t', '=home')
  // a terminal tmux does not have attached (its number may be another window's by now): nothing is closed,
  // Terminal never asked; the private server's socket named so the person's own is never reached
  const server = join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket)
  const notAttached = spawnSync('/bin/sh', [hideFile, '/dev/ttys999'], { encoding: 'utf8', env: { ...process.env, TMUX: `${server},0,0` } })
  check('hide: a terminal tmux could not detach is left as it is', notAttached.status === 0 && notAttached.stdout === '', notAttached.stdout.trim())
  check('hide: hide.sh refuses what is not a terminal', spawnSync('/bin/sh', [hideFile, '/etc/passwd'], { encoding: 'utf8' }).stdout === '')
  // the window-closing script, run as written against a stand-in Terminal: it closes only a window of that one
  // tab once the tab is back at its shell; never one with other tabs, never one still at work, never starts Terminal
  const closeWith = (running, windows) => {
    const closed = []
    const app = () => ({ running: () => running, windows: () => windows.map(w => ({ bounds: () => ({ x: 1, y: 2, width: 1300, height: 900 }), tabs: () => w.tabs.map(t => ({ tty: () => t.tty, busy: () => t.busy(), fontSize: () => 13 })), close: () => closed.push(w.name) })) })
    const result = new Function('Application', 'delay', `${w.CLOSE_SCRIPT}\nreturn run(['ttys050'])`)(app, () => undefined)
    return [result, closed.join(',')]
  }
  let polls = 0
  const cases = [
    closeWith(false, [{ name: 'w', tabs: [{ tty: '/dev/ttys050', busy: () => false }] }]),
    closeWith(true, [{ name: 'w', tabs: [{ tty: '/dev/ttys051', busy: () => false }] }]),
    closeWith(true, [{ name: 'w', tabs: [{ tty: '/dev/ttys050', busy: () => false }, { tty: '/dev/ttys052', busy: () => false }] }]),
    closeWith(true, [{ name: 'w', tabs: [{ tty: '/dev/ttys050', busy: () => true }] }]),
    closeWith(true, [{ name: 'w', tabs: [{ tty: '/dev/ttys050', busy: () => ++polls < 3 }] }]),
  ]
  check('hide: the window-closing script closes only a lone tab back at its shell, saying where it was', JSON.stringify(cases) === JSON.stringify([['none', ''], ['none', ''], ['shared', ''], ['busy', ''], ['closed {"x":1,"y":2,"width":1300,"height":900,"fontSize":13}', 'w']]), JSON.stringify(cases))
  // the opening script, run as written against a stand-in Terminal: a placement sets the new tab's font, then
  // its window's place and size; none leaves them; a placement that fails leaves the window open all the same
  const openWith = (arg, failBounds = false) => {
    const did = []
    const tab = { tty: () => '/dev/ttys060', set fontSize(v) { did.push(`font ${v}`) } }
    const win = { tabs: () => [tab], set bounds(v) { if (failBounds) throw new Error('no'); did.push(`bounds ${v.x},${v.y},${v.width},${v.height}`) } }
    const terminal = { doScript: () => tab, windows: () => [{ tabs: () => [{ tty: () => '/dev/ttys001' }] }, win], activate: () => did.push('activate') }
    try {
      const result = new Function('Application', `${c.OPEN_SCRIPT}\nreturn run(${JSON.stringify(arg === undefined ? ['cmd'] : ['cmd', arg])})`)(() => terminal)
      return `${result}: ${did.join('; ')}`
    } catch (error) {
      return `threw ${error.message}: ${did.join('; ')}`
    }
  }
  const opens = [openWith(JSON.stringify({ x: 5, y: 6, width: 700, height: 500, fontSize: 11 })), openWith(undefined), openWith(JSON.stringify({ x: 5, y: 6, width: 700, height: 500, fontSize: 0 }), true), openWith('not json')]
  check('open: a placement sets the font, then the place; none leaves them; a failing one still opens', JSON.stringify(opens) === JSON.stringify(['opened: font 11; bounds 5,6,700,500; activate', 'opened: activate', 'opened: activate', 'opened: activate']), JSON.stringify(opens))
  // the screen script against stand-in screens: the menu bar's screen 2560×1440 at (0,0), an external 1920×1080
  // above its right half, in use; Terminal's places are from the menu bar screen's top left
  const nsScreen = (x, y, w, h, free) => ({ frame: { origin: { x, y }, size: { width: w, height: h } }, visibleFrame: { origin: { x: free.x, y: free.y }, size: { width: free.w, height: free.h } } })
  const menuBar = nsScreen(0, 0, 2560, 1440, { x: 0, y: 0, w: 2560, h: 1410 })
  const external = nsScreen(1280, 1440, 1920, 1080, { x: 1280, y: 1440, w: 1920, h: 1080 })
  const stand$ = { NSScreen: { screens: { count: 2, objectAtIndex: i => [menuBar, external][i] }, mainScreen: external } }
  const seenScreens = JSON.parse(new Function('Application', 'ObjC', '$', `${w.SCREEN_SCRIPT}\nreturn run(['ttys070'])`)(() => ({ running: () => false }), { import: () => undefined }, stand$))
  check('screens: every screen, the one in use first, placed from the menu bar screen\'s top left', JSON.stringify(seenScreens) === JSON.stringify({ screens: [{ x: 1280, y: -1080, width: 1920, height: 1080 }, { x: 0, y: 30, width: 2560, height: 1410 }], fontSize: 0 }), JSON.stringify(seenScreens))
  // hide.sh's end, with tmux and osascript stood in for: where the window was is kept under the workspace
  // session's name, in the windows folder beside hide.sh, and only then
  const stubs = join(scratch, 'stubs')
  mkdirSync(stubs)
  const runHide = (session, said) => {
    writeFileSync(join(stubs, 'tmux'), `#!/bin/sh\ncase "$1" in display-message) case "$*" in *client_session*) printf '%s\\n' '${session}';; esac;; esac\nexit 0\n`, { mode: 0o755 })
    writeFileSync(join(stubs, 'osa'), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${said}'\n`, { mode: 0o755 })
    const dir = mkdtempSync(join(scratch, 'hide-'))
    writeFileSync(join(dir, 'hide.sh'), w.HIDE_SCRIPT.replace('/usr/bin/osascript', join(stubs, 'osa')))
    const out = spawnSync('/bin/sh', [join(dir, 'hide.sh'), '/dev/ttys080'], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } }).stdout.trim()
    const kept = existsSync(join(dir, 'windows')) ? readdirSync(join(dir, 'windows')).map(f => `${f}=${readFileSync(join(dir, 'windows', f), 'utf8').trim()}`) : []
    return `${out} | ${kept.join(',') || '-'}`
  }
  const placed = '{"x":1,"y":2,"width":1300,"height":900,"fontSize":13}'
  const hides = [runHide('ws-check', `closed ${placed}`), runHide('ws-check', 'busy'), runHide('ws-../x', `closed ${placed}`), runHide('ws-ä', `closed ${placed}`), runHide('mine', `closed ${placed}`)]
  check('hide: where it was kept under the workspace session only, and only once it closed', JSON.stringify(hides) === JSON.stringify([`closed | ws-check.json=${placed}`, 'busy | -', 'closed | -', 'closed | -', 'closed | -']), JSON.stringify(hides))
    // a workspace made before the marks (a window per agent), with a window of the owner's own now current:
    // set up at Open, each window gets the borders, the agents' named by their windows
    t6('new-session', '-d', '-s', 'ws-old', '-n', 'claude', 'sleep 30')
    t6('new-window', '-t', '=ws-old:', '-n', 'codex', 'sleep 30')
    t6('new-window', '-t', '=ws-old:', '-n', 'notes', 'sleep 30')
    const oldWindows = t6('list-windows', '-t', '=ws-old', '-F', '#{window_id}').split('\n')
    for (const args of w.sessionSetup('ws-old', oldWindows)) t6(...args)
    const oldBorders = Object.fromEntries(t6('list-panes', '-s', '-t', '=ws-old', '-F', '#{window_name}=#{pane_id}').split('\n').map(l => l.split('=')))
    check('workspace: an older one, set up at Open, has borders in each window, the agents named by their windows',
      oldWindows.every(id => t6('show-window-options', '-t', id, '-v', 'pane-border-status') === 'top') &&
      border(oldBorders.claude).startsWith('Claude') && border(oldBorders.codex).startsWith('Codex') && border(oldBorders.notes).startsWith('sleep'),
      `${border(oldBorders.claude)}|${border(oldBorders.codex)}|${border(oldBorders.notes)}`)
    t6('kill-session', '-t', '=ws-old')
    // a default workspace on the same server, whose global environment holds another account, in a folder with # in its name
    const hashed = join(scratch, 'C#{session_name}')
    mkdirSync(hashed)
    spawnSync(process.env.SHELL ?? '/bin/zsh', ['-c', w.openCommand({ id: 'check2', env: '', dir: hashed, createdAt: 5 }, fakeHome, { socket, attach: false, bins: { claude: record('claude', 'd-'), codex: record('codex', 'd-') } })], { encoding: 'utf8' })
    for (let i = 0; i < 30 && !(existsSync(`${scratch}/d-claude.args`) && existsSync(`${scratch}/d-codex.args`)); i++) await new Promise(r => setTimeout(r, 200))
    check('workspace: a default one runs under no other account, whatever the tmux server holds', !/^(CLAUDE_CONFIG_DIR|CODEX_HOME)=/m.test(file('d-claude.env') + file('d-codex.env')) && file('d-claude.env') !== '')
    check('workspace: a folder with # in its name is the folder it starts in', file('d-claude.pwd').trim().endsWith('C#{session_name}'), file('d-claude.pwd').trim().split('/').pop())
    check('workspace: no checkout, no first prompt: nothing more on the command line', file('d-claude.args').trim() === '' && file('d-codex.args') === '-c\ncheck_for_update_on_startup=false\n--sandbox\nworkspace-write\n')
    // opened again while it runs: nothing new is created
    spawnSync(process.env.SHELL ?? '/bin/zsh', ['-c', line], { encoding: 'utf8' })
    const again = Object.values(w.parsePanes(spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'list-panes', '-a', '-F', w.PANES_FORMAT], { encoding: 'utf8' }).stdout)).length
    check('workspace: opening it again creates nothing more', again === 4, `${again} panes in two workspaces`)
    // a workspace that resumes Claude's conversation: never while a live Claude session (its registry entry, its
    // process) has it open; resumed, from its folder, when none has
    mkdirSync(join(fakeHome, '.claude', 'sessions'), { recursive: true })
    writeFileSync(join(fakeHome, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'held-conv' }))
    writeFileSync(join(fakeHome, '.claude', 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'free-conv' }))
    const resumes = (id, n) => w.openCommand({ id: `check-${n}`, env: '', dir: scratch, createdAt: n, threads: { claude: { id, dir: hashed } } }, fakeHome, { socket, attach: false, bins: { claude: record('claude', `${n}-`), codex: record('codex', `${n}-`) } })
    spawnSync(process.env.SHELL ?? '/bin/zsh', ['-c', resumes('held-conv', 3)], { encoding: 'utf8' })
    spawnSync(process.env.SHELL ?? '/bin/zsh', ['-c', resumes('free-conv', 4)], { encoding: 'utf8' })
    for (let i = 0; i < 30 && !existsSync(`${scratch}/4-claude.args`); i++) await new Promise(r => setTimeout(r, 200))
    await new Promise(r => setTimeout(r, 500))
    const said = spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'capture-pane', '-p', '-J', '-t', '=ws-check-3:peers.0'], { encoding: 'utf8' }).stdout
    check('workspace: Claude\'s conversation open in a live session is not resumed again; it says so', !existsSync(`${scratch}/3-claude.args`) && said.includes('This conversation is open in another Claude session'), said.trim().split('\n')[0])
    check('workspace: a conversation no live session has is resumed, from where it started', file('4-claude.args').startsWith('--resume\nfree-conv\n') && file('4-claude.pwd').trim().endsWith('C#{session_name}'), file('4-claude.args').split('\n').slice(0, 2).join(' '))
  } finally {
    // a check that throws still ends the private server
    spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'kill-server'])
    // kill-server leaves its socket file behind
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// 6b. A workspace of one agent, on a private tmux server: that agent alone in its one pane, marked, given its
// first prompt; the other agent never started. Stand-ins record their arguments.
{
  const socket = `live-sessions-solo-${process.pid}`
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-solo-')))
  const fakeHome = join(scratch, 'home')
  const record = tool => `sh -c 'printf "%s\\n" "$@" > "${scratch}/${tool}.args"; sleep 30' rec`
  const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' }).stdout.trim()
  try {
    for (const only of ['codex', 'claude']) {
      const ws = { id: `solo-${only}`, env: '', dir: scratch, createdAt: 1, checkout: '/x/app', only }
      mkdirSync(dirname(w.promptPath(fakeHome, ws.id, only)), { recursive: true })
      writeFileSync(w.promptPath(fakeHome, ws.id, only), `Get ready, ${only}.`)
      spawnSync('/bin/sh', ['-c', w.openCommand(ws, fakeHome, { socket, attach: false, bins: { claude: record(`${only}-claude`), codex: record(`${only}-codex`) } })], { encoding: 'utf8' })
      for (let i = 0; i < 30 && !existsSync(`${scratch}/${only}-${only}.args`); i++) await new Promise(r => setTimeout(r, 200))
      // a moment more: a second pane, had one been made, would have started its stand-in by now
      await new Promise(r => setTimeout(r, 600))
      const panes = Object.values(w.parsePanes(tmux('list-panes', '-a', '-F', w.PANES_FORMAT))).filter(p => p.session === `ws-${ws.id}`)
      const other = only === 'codex' ? 'claude' : 'codex'
      const args = existsSync(`${scratch}/${only}-${only}.args`) ? readFileSync(`${scratch}/${only}-${only}.args`, 'utf8') : ''
      check(`workspace of one agent (${only}): its one pane, marked; given its first prompt once; ${other} never started`,
        JSON.stringify(panes.map(p => p.window)) === JSON.stringify([only]) && args.endsWith(`--\nGet ready, ${only}.\n`) &&
        !existsSync(`${scratch}/${only}-${other}.args`) && !existsSync(w.promptPath(fakeHome, ws.id, only)),
        `${panes.map(p => p.window)} ${JSON.stringify(args.slice(-40))}`)
    }
  } finally {
    spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'kill-server'])
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// 7. The main checkout a workspace's agents put worktrees beside: CHECKOUT_SCRIPT on throwaway repositories
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-git-')))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.invalid', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.invalid' }
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8', env })
  const find = dir => w.checkoutResult(spawnSync('/bin/sh', ['-c', w.CHECKOUT_SCRIPT, 'sh', dir], { encoding: 'utf8', env }).stdout)
  const newRepo = path => {
    mkdirSync(path, { recursive: true })
    git('-C', path, 'init', '-q', '-b', 'main')
    git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'base')
    return path
  }
  const repo = newRepo(join(scratch, 'app'))
  mkdirSync(join(repo, 'sub'))
  check('checkout: from a subfolder, the main checkout, its worktrees folder made beside it', find(join(repo, 'sub')).checkout === repo && existsSync(`${repo}-worktrees`))
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat/a', `${repo}-worktrees/feat-a`)
  check('checkout: from a linked worktree, the main checkout', find(`${repo}-worktrees/feat-a`).checkout === repo)
  check('checkout: a folder outside git, refused', find(scratch).error?.includes('not in a git checkout') === true)
  const parent = newRepo(join(scratch, 'parent'))
  const lib = newRepo(join(scratch, 'lib'))
  git('-C', parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
  check('checkout: in a submodule, its own checkout', find(join(parent, 'vendor/lib')).checkout === join(parent, 'vendor/lib'))
  const apart = join(scratch, 'apart')
  mkdirSync(apart)
  git('-C', apart, 'init', '-q', '-b', 'main', '--separate-git-dir', join(scratch, 'store.git'))
  git('-C', apart, 'commit', '-q', '--allow-empty', '-m', 'base')
  check('checkout: with a separate git dir, the checkout, not the store', find(apart).checkout === apart)
  git('-C', apart, 'worktree', 'add', '-q', '-b', 'feat/s', join(scratch, 'apart-wt'))
  check('checkout: from a separate git dir\'s worktree, refused rather than guessed', find(join(scratch, 'apart-wt')).error?.includes('main checkout') === true)
  // the branches a workspace can go on with: the linked worktrees with a branch, read by real git; the branch where a
  // folder is
  git('-C', repo, 'worktree', 'add', '-q', '--detach', `${repo}-worktrees/probe`)
  const listed = w.parseWorktrees(spawnSync('/bin/sh', ['-c', w.WORKTREES_SCRIPT, 'sh', join(repo, 'sub')], { encoding: 'utf8', env }).stdout)
  check('go on: the worktrees offered are the linked ones with a branch, not the main checkout or a detached one',
    JSON.stringify(listed) === JSON.stringify([{ path: `${repo}-worktrees/feat-a`, branch: 'feat/a' }]), JSON.stringify(listed))
  const head = dir => w.headOf(spawnSync('/bin/sh', ['-c', w.BRANCH_SCRIPT, 'sh', dir], { encoding: 'utf8', env }).stdout)
  const seen = [head(`${repo}-worktrees/feat-a`), head(`${repo}-worktrees/probe`), head(repo), head(join(repo, 'sub')), head(scratch)]
  check('go on: the branch checked out where the folder is; none for a detached HEAD; the main checkout (or a folder in it) known as such; nothing outside git',
    JSON.stringify(seen) === JSON.stringify([{ isMain: false, branch: 'feat/a', isDefault: false }, { isMain: false, isDefault: false }, { isMain: true, branch: 'main', isDefault: false }, { isMain: true, branch: 'main', isDefault: false }, undefined]), JSON.stringify(seen))
  // the repository's default branch, as its origin names it, checked out in a linked worktree
  git('-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('-C', repo, 'worktree', 'add', '-q', '-f', `${repo}-worktrees/on-main`, 'main')
  const onDefault = [head(`${repo}-worktrees/on-main`), head(`${repo}-worktrees/feat-a`)]
  check('go on: a linked worktree on the default branch known as such', JSON.stringify(onDefault) === JSON.stringify([{ isMain: false, branch: 'main', isDefault: true }, { isMain: false, branch: 'feat/a', isDefault: false }]), JSON.stringify(onDefault))
  // a folder named with a newline and a field: offered only as the folder it is (the list is read NUL-separated)
  git('-C', repo, 'worktree', 'add', '-q', '--detach', `${repo}-worktrees/x\nbranch refs/heads/evil`)
  const forged = w.parseWorktrees(spawnSync('/bin/sh', ['-c', w.WORKTREES_SCRIPT, 'sh', repo], { encoding: 'utf8', env }).stdout)
  check('go on: a folder whose name forges a branch line is not offered', JSON.stringify(forged.map(x => x.branch)) === '["feat/a","main"]' && !forged.some(x => x.path.includes('\n')), JSON.stringify(forged))
  // the projects the form offers: main checkouts only; never what is inside a .git, a hidden folder or a worktrees folder
  const fakeHome = join(scratch, 'projects-home')
  for (const d of ['dev/a/.git/inner/.git', 'dev/b/.git', 'dev/b-worktrees/feat/.git', '.hidden/c/.git', 'Library/d/.git']) mkdirSync(join(fakeHome, d), { recursive: true })
  const offered = spawnSync('/bin/sh', ['-c', w.PROJECTS_SCRIPT, 'sh', fakeHome], { encoding: 'utf8' }).stdout.trim().split('\n').map(l => l.slice(fakeHome.length)).sort()
  check('projects: the main checkouts, nothing inside a .git, hidden, Library or worktrees folder', JSON.stringify(offered) === '["/dev/a","/dev/b"]', offered.join(','))
  rmSync(scratch, { recursive: true, force: true })
}

// 8. The relay: how a turn stands, read from records of both kinds; a cue typed into a pane, once, and
// never into a shell. On a private tmux server; a pane running `cat` stands in for the agent.
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-relay-')))
  const jsonl = (name, records) => {
    writeFileSync(join(scratch, name), records.map(o => JSON.stringify(o)).join('\n') + '\n')
    return join(scratch, name)
  }
  const cue = 'READY FOR CODEX · peer-coding/feat-x ALIGN BRIEFED · feat/x@abc1234'
  const claudeDone = jsonl('c-done.jsonl', [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-09T10:00:00Z', message: { content: 'set it up' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-09T10:01:00Z', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-09T10:01:01Z', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-10-09T10:05:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `Ready.\n\n\`${cue}\`` }] } },
    { type: 'assistant', uuid: 'side', isSidechain: true, timestamp: '2026-10-09T10:06:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'NEEDS USER · x · y@1' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-09T10:05:01Z' },
  ])
  const claudeBusy = jsonl('c-busy.jsonl', [
    { type: 'assistant', uuid: 'a2', timestamp: '2026-10-09T10:05:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: cue }] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-10-09T10:07:00Z', message: { content: [{ type: 'text', text: 'and now?' }] } },
  ])
  const codexDone = jsonl('x-done.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T11:00:00Z', payload: { type: 'task_started', turn_id: 't-1' } },
    { type: 'event_msg', timestamp: '2026-10-09T11:09:00Z', payload: { type: 'task_complete', turn_id: 't-1', last_agent_message: 'Confirmed.\n\n1. READY FOR CLAUDE · peer-coding/feat-x ALIGN CONFIRMED · feat/x@def5678\n' } },
  ])
  const codexBusy = jsonl('x-busy.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T11:09:00Z', payload: { type: 'task_complete', turn_id: 't-1', last_agent_message: 'x' } },
    { type: 'event_msg', timestamp: '2026-10-09T11:10:00Z', payload: { type: 'task_started', turn_id: 't-2' } },
  ])
  // what the owner does between turns starts none: a command run in the session, its output, a compaction,
  // a meta record; an interrupt ends one; one reply over two records is read whole; a line cut by tail is skipped
  const ended = { type: 'assistant', uuid: 'e1', timestamp: '2026-10-09T10:05:00Z', message: { id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: cue }] } }
  const afterCommands = jsonl('c-commands.jsonl', [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-09T10:00:00Z', message: { content: 'go' } },
    ended,
    { type: 'user', uuid: 'm1', isMeta: true, timestamp: '2026-10-09T10:06:00Z', message: { content: 'Context a hook added for the next turn.' } },
    { type: 'user', uuid: 'm2', timestamp: '2026-10-09T10:06:00Z', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } },
    { type: 'user', uuid: 'm3', timestamp: '2026-10-09T10:06:01Z', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T10:07:00Z' },
    { type: 'user', uuid: 'm4', isCompactSummary: true, timestamp: '2026-10-09T10:07:01Z', message: { content: 'This session is being continued…' } },
    { type: 'user', uuid: 'm5', timestamp: '2026-10-09T10:08:00Z', message: { content: [{ type: 'text', text: '<bash-input>ls</bash-input>' }] } },
  ])
  const interrupted = jsonl('c-interrupted.jsonl', [
    ended,
    { type: 'user', uuid: 'u2', timestamp: '2026-10-09T10:10:00Z', message: { content: 'next' } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-10-09T10:10:05Z', message: { id: 'msg_2', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
    { type: 'user', uuid: 'i1', timestamp: '2026-10-09T10:10:09Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ])
  const midTurn = jsonl('c-mid.jsonl', [
    ended,
    { type: 'user', uuid: 'u2', timestamp: '2026-10-09T10:10:00Z', message: { content: 'next' } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-10-09T10:10:05Z', message: { id: 'msg_2', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
  ])
  writeFileSync(join(scratch, 'c-split.jsonl'), '{"cut by tail", "uuid": "x"\n' + [
    { type: 'assistant', uuid: 's1', timestamp: '2026-10-09T10:05:00Z', message: { id: 'msg_3', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done.\n${cue}` }] } },
    { type: 'assistant', uuid: 's2', timestamp: '2026-10-09T10:05:01Z', message: { id: 'msg_3', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anything else is for the next turn.' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n')
  const split = join(scratch, 'c-split.jsonl')
  const skillTurn = [
    ended,
    { type: 'user', uuid: 'k0', timestamp: '2026-10-09T10:20:00Z', message: { content: '<command-message>peer-coding</command-message>\n<command-name>/peer-coding</command-name>' } },
    { type: 'user', uuid: 'k1', isMeta: true, timestamp: '2026-10-09T10:20:00Z', message: { content: [{ type: 'text', text: 'Base directory for this skill: …' }] } },
    { type: 'assistant', uuid: 'k2t', timestamp: '2026-10-09T10:20:05Z', message: { id: 'msg_k', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
  ]
  const skillBusy = jsonl('c-skill-busy.jsonl', skillTurn)
  const skillDone = jsonl('c-skill-done.jsonl', [...skillTurn,
    { type: 'user', uuid: 'k3', timestamp: '2026-10-09T10:20:06Z', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', uuid: 'k2', timestamp: '2026-10-09T10:21:00Z', message: { id: 'msg_k2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Set up.' }] } },
  ])
  const apiError = jsonl('c-error.jsonl', [
    ended,
    { type: 'user', uuid: 'u5', timestamp: '2026-10-09T10:30:00Z', message: { content: 'again' } },
    { type: 'assistant', uuid: 'err1', isApiErrorMessage: true, timestamp: '2026-10-09T10:30:02Z', message: { id: 'msg_e', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: overloaded' }] } },
  ])
  const codexAborted = jsonl('x-aborted.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T11:00:00Z', payload: { type: 'task_started', turn_id: 't-1' } },
    { type: 'event_msg', timestamp: '2026-10-09T11:00:09Z', payload: { type: 'turn_aborted', turn_id: 't-1', reason: 'interrupted' } },
  ])
  // when the owner last typed: a prompt, a command or a paste, never the relay's cue line, a background
  // task's notice, an interrupt, a skill the agent ran, a command's output, a meta record or a summary
  const typedClaude = jsonl('c-typed.jsonl', [
    { type: 'user', uuid: 'p1', timestamp: '2026-10-09T09:00:00Z', message: { content: 'build the login' } },
    // a skill or prompt command the owner typed (an agent's own skill run is a meta record)
    { type: 'user', uuid: 'p0', timestamp: '2026-10-09T09:30:00Z', message: { content: '<command-message>peer-coding</command-message>\n<command-name>/peer-coding</command-name>\n<command-args>continue</command-args>' } },
    ended,
    { type: 'user', uuid: 'p2', timestamp: '2026-10-09T10:06:00Z', message: { content: 'READY FOR CLAUDE · peer-coding/feat-x R1 · feat/x@abc1234' } },
    { type: 'user', uuid: 'p3', timestamp: '2026-10-09T10:07:00Z', message: { content: '<task-notification>\n<task-id>b1</task-id>\n<summary>done</summary>\n</task-notification>' } },
    { type: 'user', uuid: 'p4', timestamp: '2026-10-09T10:08:00Z', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } },
    { type: 'user', uuid: 'p5', isMeta: true, timestamp: '2026-10-09T10:08:30Z', message: { content: [{ type: 'text', text: 'Base directory for this skill: …' }] } },
    { type: 'user', uuid: 'p6', isMeta: true, timestamp: '2026-10-09T10:09:00Z', message: { content: 'Context a hook added.' } },
    { type: 'user', uuid: 'p7', timestamp: '2026-10-09T10:09:30Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: 'p8', isCompactSummary: true, timestamp: '2026-10-09T10:10:00Z', message: { content: 'This session is being continued…' } },
    { type: 'user', uuid: 'p9', timestamp: '2026-10-09T10:11:00Z', message: { content: [{ type: 'tool_result', content: 'build it' }] } },
    { type: 'user', uuid: 'p10', isSidechain: true, timestamp: '2026-10-09T10:12:00Z', message: { content: 'a subagent\'s prompt' } },
    { type: 'user', uuid: 'p11', timestamp: '2026-10-09T10:13:00Z', message: { content: [{ type: 'image' }] } },
  ])
  const typedCommand = jsonl('c-typed-command.jsonl', [
    { type: 'user', uuid: 'p1', timestamp: '2026-10-09T09:00:00Z', message: { content: 'go' } }, ended,
    { type: 'user', uuid: 'p2', timestamp: '2026-10-09T10:06:00Z', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } },
  ])
  const typedBash = jsonl('c-typed-bash.jsonl', [ended, { type: 'user', uuid: 'p1', timestamp: '2026-10-09T10:07:00Z', message: { content: [{ type: 'text', text: '<bash-input>ls</bash-input>' }] } }])
  // a cue line the owner pasted with words of their own is theirs
  const typedCue = jsonl('c-typed-cue.jsonl', [ended, { type: 'user', uuid: 'p1', timestamp: '2026-10-09T10:08:00Z', message: { content: 'READY FOR CLAUDE · peer-coding/feat-x R1 · feat/x@abc1234\nand check the login too' } }])
  // records marked by who made them: the owner's prompt, one queued while the agent worked; not a task's
  // notice, a queued notice, the relay's cue (pasted, wrapped or not)
  const human = { kind: 'human' }
  const typedMarked = jsonl('c-typed-marked.jsonl', [
    { type: 'user', uuid: 'q1', origin: human, timestamp: '2026-10-09T11:00:00Z', message: { content: 'go on' } },
    ended,
    { type: 'attachment', uuid: 'q3', timestamp: '2026-10-09T11:10:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', origin: human, prompt: 'and check the tests too' } },
    { type: 'user', uuid: 'q2', origin: { kind: 'task-notification' }, timestamp: '2026-10-09T11:12:00Z', message: { content: 'a notice in plain words' } },
    // a queued notice from an engine that marks no origin, in plain words
    { type: 'attachment', uuid: 'q4', timestamp: '2026-10-09T11:15:00Z', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'The person enabled something for this session' } },
    { type: 'attachment', uuid: 'q5', timestamp: '2026-10-09T11:16:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', origin: human, prompt: 'READY FOR CLAUDE · peer-coding/feat-x R2 · feat/x@abc1234' } },
    { type: 'user', uuid: 'q6', origin: human, timestamp: '2026-10-09T11:20:00Z', message: { content: 'READY FOR CLAUDE · peer-coding/feat-x R2 · feat/x@abc1234' } },
    { type: 'user', uuid: 'q7', origin: human, timestamp: '2026-10-09T11:25:00Z', message: { content: '<pasted_content id="p1">\nREADY FOR CLAUDE · peer-coding/feat-x R3 · feat/x@abc1234\n</pasted_content>' } },
    { type: 'attachment', uuid: 'q8', isSidechain: true, timestamp: '2026-10-09T11:30:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'a subagent\'s' } },
  ])
  // a prompt queued with an image is the owner's by its text; an `origin` of another shape breaks nothing; a
  // message with a long run of spaces is read at once
  const typedOdd = jsonl('c-typed-odd.jsonl', [
    { type: 'user', uuid: 'o1', origin: 'human', timestamp: '2026-10-09T13:00:00Z', message: { content: 'go' } },
    ended,
    { type: 'attachment', uuid: 'o2', timestamp: '2026-10-09T13:10:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', origin: human, prompt: [{ type: 'image' }, { type: 'text', text: 'and this screen' }] } },
    { type: 'user', uuid: 'o3', origin: human, timestamp: '2026-10-09T13:20:00Z', message: { content: `READY FOR CLAUDE · x ·${' '.repeat(80_000)}y@1` } },
  ])
  // a compaction, as Claude Code records `/compact <instructions>` (a prompt of that line, then its command):
  // no turn, and not the owner's presence (the relay sends it too); one queued neither
  const compacted = jsonl('c-compacted.jsonl', [
    { type: 'user', uuid: 'k1', origin: human, timestamp: '2026-10-09T14:00:00Z', message: { content: 'build it' } },
    { ...ended, uuid: 'k2', timestamp: '2026-10-09T14:05:00Z' },
    { type: 'user', uuid: 'k3', timestamp: '2026-10-09T14:06:00Z', message: { content: '/compact keep the peer-coding state' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T14:06:30Z' },
    { type: 'user', uuid: 'k4', isCompactSummary: true, timestamp: '2026-10-09T14:06:30Z', message: { content: 'This session is being continued…' } },
    { type: 'user', uuid: 'k5', isMeta: true, timestamp: '2026-10-09T14:06:30Z', message: { content: '<local-command-caveat>…</local-command-caveat>' } },
    { type: 'user', uuid: 'k6', timestamp: '2026-10-09T14:06:31Z', message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the peer-coding state</command-args>' } },
    { type: 'user', uuid: 'k7', timestamp: '2026-10-09T14:06:31Z', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } },
    { type: 'attachment', uuid: 'k8', timestamp: '2026-10-09T14:07:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', origin: human, prompt: '/compact' } },
  ])
  // a prompt that only quotes such a record is the owner's, and a turn
  const quotesCompact = jsonl('c-quotes-compact.jsonl', [ended, { type: 'user', uuid: 'q1', origin: human, timestamp: '2026-10-09T14:10:00Z', message: { content: 'Audit this: a <command-name>/compact</command-name> record and /compactness' } }])
  // how full Codex's context is: its last count against its window; a count with no figures leaves it
  const codexFilled = jsonl('x-filled.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T15:00:00Z', payload: { type: 'task_started', turn_id: 't-9' } },
    { type: 'event_msg', timestamp: '2026-10-09T15:00:05Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 64_600 }, model_context_window: 258_400 } } },
    { type: 'event_msg', timestamp: '2026-10-09T15:01:00Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 163_563 }, model_context_window: 258_400 } } },
    { type: 'event_msg', timestamp: '2026-10-09T15:01:01Z', payload: { type: 'token_count', info: null } },
    { type: 'event_msg', timestamp: '2026-10-09T15:01:01Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 'many' }, model_context_window: '258k' } } },
    { type: 'event_msg', timestamp: '2026-10-09T15:01:01Z', payload: { type: 'token_count', info: { model_context_window: 258_400 } } },
    { type: 'event_msg', timestamp: '2026-10-09T15:01:02Z', payload: { type: 'task_complete', turn_id: 't-9', last_agent_message: 'READY FOR CLAUDE · x · y@1' } },
  ])
  const typedPaste = jsonl('c-typed-paste.jsonl', [ended, { type: 'user', uuid: 'r1', origin: human, timestamp: '2026-10-09T12:00:00Z', message: { content: '<pasted_content id="p2">\nREADY FOR CLAUDE · peer-coding/feat-x R3 · feat/x@abc1234\n</pasted_content>\nand mind the login' } }])
  const typedCodex = jsonl('x-typed.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T11:00:00Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'fix the bug' }] } } },
    { type: 'event_msg', timestamp: '2026-10-09T11:00:01Z', payload: { type: 'task_started', turn_id: 't-1' } },
    { type: 'event_msg', timestamp: '2026-10-09T11:05:00Z', payload: { type: 'task_complete', turn_id: 't-1', last_agent_message: 'x' } },
    { type: 'response_item', timestamp: '2026-10-09T11:06:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { type: 'event_msg', timestamp: '2026-10-09T11:07:00Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'READY FOR CODEX · peer-coding/feat-x R1 · feat/x@abc1234' }] } } },
    { type: 'event_msg', timestamp: '2026-10-09T11:07:01Z', payload: { type: 'task_started', turn_id: 't-2' } },
    // a compaction, should Codex log it as a message: never counted as the owner's typing
    { type: 'event_msg', timestamp: '2026-10-09T11:08:00Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '/compact' }] } } },
  ])
  // an earlier Codex writes the prompt as a user_message event
  const typedCodexOld = jsonl('x-typed-old.jsonl', [
    { type: 'event_msg', timestamp: '2026-10-09T12:00:00Z', payload: { type: 'user_message', message: 'and the tests' } },
    { type: 'event_msg', timestamp: '2026-10-09T12:00:01Z', payload: { type: 'task_started', turn_id: 't-3' } },
    { type: 'event_msg', timestamp: '2026-10-09T12:01:00Z', payload: { type: 'user_message', message: 'NEEDS USER · peer-coding/feat-x · feat/x@abc1234' } },
  ])
  const out = spawnSync('/bin/sh', ['-c', r.TURN_SCRIPT, 'sh', claudeDone, claudeBusy, codexDone, codexBusy, join(scratch, 'none.jsonl'), afterCommands, interrupted, midTurn, split, codexAborted, skillBusy, skillDone, apiError, typedClaude, typedCommand, typedBash, typedCue, typedCodex, typedCodexOld, typedMarked, typedPaste, typedOdd, compacted, quotesCompact, codexFilled], { encoding: 'utf8', timeout: 15_000 })
  const turns = r.parseTurns(out.stdout)
  check('turns: a command run in the session, its output, a compaction or a meta record starts no turn', turns.get(afterCommands)?.state === 'done' && turns.get(afterCommands)?.id === 'e1' && turns.get(afterCommands)?.cue?.line === cue, JSON.stringify(turns.get(afterCommands)))
  check('turns: an interrupt ends a turn, with no cue', turns.get(interrupted)?.state === 'done' && turns.get(interrupted)?.id === 'i1' && turns.get(interrupted)?.cue === undefined)
  check('turns: a reply that stopped for a tool is a turn under way', turns.get(midTurn)?.state === 'busy' && turns.get(midTurn)?.id === 'a3')
  check('turns: a skill starts a turn: under way while it calls tools, finished with its reply', turns.get(skillBusy)?.state === 'busy' && turns.get(skillDone)?.state === 'done' && turns.get(skillDone)?.id === 'k2' && turns.get(skillDone)?.cue === undefined, `${turns.get(skillBusy)?.state} ${turns.get(skillDone)?.id}`)
  check('turns: an error that ends the reply ends the turn', turns.get(apiError)?.state === 'done' && turns.get(apiError)?.id === 'err1')
  check('turns: one reply over two records is read whole, its first record\'s id; a line cut by tail skipped', turns.get(split)?.id === 's1' && turns.get(split)?.cue?.line === cue, JSON.stringify(turns.get(split)))
  check('turns: an aborted Codex task ends its turn, with no cue', turns.get(codexAborted)?.state === 'done' && turns.get(codexAborted)?.id === 't-1' && turns.get(codexAborted)?.cue === undefined)
  check('turns: Claude\'s last turn done, its cue without the code marks; a subagent\'s turn not counted', turns.get(claudeDone)?.id === 'a2' && turns.get(claudeDone)?.cue?.line === cue, JSON.stringify(turns.get(claudeDone)?.cue?.line))
  check('turns: a prompt after it is a turn under way', turns.get(claudeBusy)?.state === 'busy' && turns.get(claudeBusy)?.id === 'u3')
  check('turns: Codex\'s last turn done, its cue from a numbered line', turns.get(codexDone)?.state === 'done' && turns.get(codexDone)?.cue?.kind === 'ready' && turns.get(codexDone)?.cue?.to === 'claude')
  check('turns: a Codex task started after it is under way', turns.get(codexBusy)?.state === 'busy' && turns.get(codexBusy)?.id === 't-2')
  check('turns: nothing more of what was said leaves the pipeline', !out.stdout.includes('Ready.') && !out.stdout.includes('Confirmed.') && !out.stdout.includes('set it up') && !out.stdout.includes('build the login') && !out.stdout.includes('fix the bug'))
  const typedAt = file => turns.get(file)?.typedAt
  check('typed: the owner\'s prompt or skill command, not the relay\'s cue, a task notice, an interrupt, a skill\'s text, output, meta, summary, tool result, subagent or image alone', typedAt(typedClaude) === Date.parse('2026-10-09T09:30:00Z'), new Date(typedAt(typedClaude)).toISOString())
  check('typed: marked records: the owner\'s prompt queued while the agent worked; no notice, queued notice, cue (pasted or not) or subagent\'s', typedAt(typedMarked) === Date.parse('2026-10-09T11:10:00Z'), new Date(typedAt(typedMarked)).toISOString())
  check('typed: a pasted cue with words of the owner\'s own is theirs', typedAt(typedPaste) === Date.parse('2026-10-09T12:00:00Z'))
  check('turns: a prompt quoting a /compact record is the owner\'s, and starts a turn', turns.get(quotesCompact)?.state === 'busy' && typedAt(quotesCompact) === Date.parse('2026-10-09T14:10:00Z'), JSON.stringify(turns.get(quotesCompact)))
  check('turns: how full Codex\'s context is, from its last count with figures (one with none, or not numbers, breaks nothing); none for Claude\'s records', turns.get(codexFilled)?.filled === 63 && turns.get(codexFilled)?.cue?.to === 'claude' && turns.get(claudeDone)?.filled === undefined, String(turns.get(codexFilled)?.filled))
  check('turns: a compaction (/compact, as Claude Code records it) starts no turn and is not the owner\'s typing; the cue before it stands', turns.get(compacted)?.state === 'done' && turns.get(compacted)?.id === 'k2' && turns.get(compacted)?.cue?.line === cue && typedAt(compacted) === Date.parse('2026-10-09T14:00:00Z'), JSON.stringify(turns.get(compacted)))
  check('typed: a prompt queued with an image counts by its text; a cue with a long run of spaces stays the relay\'s, read at once; an odd origin breaks nothing', typedAt(typedOdd) === Date.parse('2026-10-09T13:10:00Z') && turns.get(typedOdd)?.state === 'busy', `${typedAt(typedOdd)} ${out.error ?? ''}`)
  check('typed: a command and a shell command typed in the session are the owner\'s', typedAt(typedCommand) === Date.parse('2026-10-09T10:06:00Z') && typedAt(typedBash) === Date.parse('2026-10-09T10:07:00Z'))
  check('typed: a cue pasted with words of the owner\'s own is theirs', typedAt(typedCue) === Date.parse('2026-10-09T10:08:00Z'))
  check('typed: Codex\'s prompt (item_completed, or user_message before), not the relay\'s cue nor injected context', typedAt(typedCodex) === Date.parse('2026-10-09T11:00:00Z') && typedAt(typedCodexOld) === Date.parse('2026-10-09T12:00:00Z'), `${typedAt(typedCodex)} ${typedAt(typedCodexOld)}`)
  check('typed: the skill command the owner typed; none where the owner never typed', typedAt(claudeDone) === Date.parse('2026-10-09T10:00:00Z') && typedAt(skillDone) === Date.parse('2026-10-09T10:20:00Z') && typedAt(codexDone) === undefined && typedAt(codexAborted) === undefined)
  // on this Mac's own records, read only: each answers in the expected form
  const real = readdirSync(join(home, '.claude', 'projects'), { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 3)
    .flatMap(d => readdirSync(join(home, '.claude', 'projects', d.name)).filter(f => f.endsWith('.jsonl')).slice(0, 2).map(f => join(home, '.claude', 'projects', d.name, f)))
  const realOut = spawnSync('/bin/sh', ['-c', r.TURN_SCRIPT, 'sh', ...real], { encoding: 'utf8' }).stdout
  check('turns: this Mac\'s own transcripts read in that form', realOut.split('\n').filter(l => l !== '').every(l => l.startsWith('==> ') || /^(done|busy)\t[A-Za-z0-9-]+\t\S+\t[^\t]*\t\S*\t(\d{1,3})?$/.test(l)), `${real.length} files`)

  const socket = `live-sessions-relay-${process.pid}`
  // a private server that reads no tmux.conf: the person's plugins (a session restore) never run in it
  const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
  // as a workspace's pane: a shell that starts the agent (`cat` here) and is the group's leader, which tmux
  // names as the pane's command; and a pane where the agent has exited, back at the shell
  try {
    tmux('new-session', '-d', '-s', 'ws-relay', '-n', 'peers', "/bin/sh -c 'cat; exec /bin/sh'")
    tmux('split-window', '-h', '-t', '=ws-relay:peers', '/bin/sh')
    const [agentPane, shellPane] = tmux('list-panes', '-t', '=ws-relay:peers', '-F', '#{pane_id}').stdout.trim().split('\n')
    await new Promise(res => setTimeout(res, 500))
    const ledger = join(scratch, 'ledger')
    const line = `READY FOR CODEX · it's "x" $(touch ${scratch}/RAN) ; touch ${scratch}/RAN`
    const relay = (key, pane, allow) => spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', ledger, key, pane, allow, line, socket, 'check'], { encoding: 'utf8' }).stdout.trim()
    const first = relay('pass-t1', agentPane, 'cat')
    await new Promise(res => setTimeout(res, 300))
    // -J: the narrow pane wraps the line; joined, it is the line as typed
    const typed = tmux('capture-pane', '-p', '-J', '-t', agentPane).stdout
    check('relay: the cue typed into the agent\'s pane and entered', first === 'passed' && typed.split('\n').filter(l => l === line).length === 2, first)
    check('relay: taken once, whichever session tries again', relay('pass-t1', agentPane, 'cat') === 'taken' && tmux('capture-pane', '-p', '-J', '-t', agentPane).stdout.split('\n').filter(l => l === line).length === 2)
    const refused = relay('pass-t2', shellPane, 'claude')
    await new Promise(res => setTimeout(res, 300))
    check('relay: never into a pane that runs a shell', /^not-agent (sh|bash)$/.test(refused) && !tmux('capture-pane', '-p', '-J', '-t', shellPane).stdout.includes('READY FOR') && !existsSync(`${scratch}/RAN`), refused)
    check('relay: a pane that is gone, said', relay('pass-t3', '%999', 'cat') === 'gone')
    // at the cap, a cue passed already is never held (no notification): its step is taken
    const held = spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'tell', ledger, 'cap-t1', '', '', 'held', socket, 'check'], { encoding: 'utf8' }).stdout.trim()
    check('relay: at the cap, a cue passed already is taken, not held', held === 'taken' && !existsSync(join(ledger, 'cap-t1')), held)
    // scrolled back: the keys would go to tmux, so nothing is typed, and the step stays for later
    tmux('copy-mode', '-t', agentPane)
    const scrolled = relay('pass-t4', agentPane, 'cat')
    check('relay: a pane in copy mode is left alone; the step stays untaken', scrolled === 'in-mode' && !existsSync(join(ledger, 'pass-t4')) && tmux('display-message', '-p', '-t', agentPane, '#{pane_in_mode}').stdout.trim() === '1', scrolled)
    tmux('send-keys', '-t', agentPane, '-X', 'cancel')
    check('relay: passed once the pane leaves copy mode', relay('pass-t4', agentPane, 'cat') === 'passed')
    // copy mode entered while the line is typed: the Enter would go to tmux, so it is not sent, and said so
    const racing = spawn('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', ledger, 'pass-t7', agentPane, 'cat', 'READY FOR CODEX · raced', socket, 'check'])
    let raced = ''
    racing.stdout.on('data', d => { raced += d })
    // listened for at once: a relay that ends early must not leave this waiting (node would exit without cleaning up)
    const racingEnded = new Promise(res => racing.on('close', res))
    await new Promise(res => setTimeout(res, 250))
    tmux('copy-mode', '-t', agentPane)
    await racingEnded
    tmux('send-keys', '-t', agentPane, '-X', 'cancel')
    check('relay: copy mode entered as the line is typed: not sent, said so', raced.trim() === 'unsent', raced.trim())
    // the unsent line waits in the stand-in's input: cleared, as the owner would before going on
    tmux('send-keys', '-t', agentPane, 'C-u')
    // a line that ends in ; (tmux reads a trailing ; as the end of a command)
    const semis = `READY FOR CODEX · ends in semicolons;;`
    spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', ledger, 'pass-t5', agentPane, 'cat', semis, socket, 'check'], { encoding: 'utf8' })
    await new Promise(res => setTimeout(res, 300))
    check('relay: a trailing ; typed as it is', tmux('capture-pane', '-p', '-J', '-t', agentPane).stdout.split('\n').filter(l => l === semis).length === 2)
    // the agent in the pane but not in its foreground (a stopped background job of an interactive shell)
    tmux('new-window', '-t', '=ws-relay:', '-n', 'bg', '/bin/sh -i')
    const bgPane = tmux('list-panes', '-t', '=ws-relay:bg', '-F', '#{pane_id}').stdout.trim()
    await new Promise(res => setTimeout(res, 300))
    tmux('send-keys', '-t', bgPane, 'cat &', 'Enter')
    await new Promise(res => setTimeout(res, 500))
    const background = relay('pass-t6', bgPane, 'cat')
    check('relay: an agent in the pane but not in its foreground is not typed into', /^not-agent /.test(background) && !background.includes('cat'), background)

  } finally {
    // a check that throws still ends the private server
    tmux('kill-server')
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// bringing a session into a workspace: its agent closed in front of its terminal, as a closing terminal does;
// Codex's rollout found by its conversation's id, and how it last ran read from it
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-bring-')))
  const socket = `live-sessions-bring-${process.pid}`
  // a private server that reads no tmux.conf: the person's plugins (a session restore) never run in it
  const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
  try {
    // stand-ins named as the agents' commands, in a folder whose name has a space (a copied system binary is
    // killed by macOS, so they are built): `codex` in front of its terminal with a `node` beside it in the same
    // job, as Codex runs
    const bin = join(scratch, 'My Tools')
    mkdirSync(bin)
    writeFileSync(join(scratch, 'wait.c'), '#include <unistd.h>\n#include <stdlib.h>\nint main(int c, char **v) { sleep(c > 1 ? atoi(v[1]) : 600); return 0; }\n')
    for (const name of ['codex', 'node', 'my claude']) execFileSync('/usr/bin/cc', ['-o', join(bin, name), join(scratch, 'wait.c')])
    writeFileSync(join(scratch, 'job.sh'), `#!/bin/sh\n'${bin}/node' 600 &\nexec '${bin}/codex' 600\n`)
    tmux('new-session', '-d', '-s', 'agent', `/bin/sh '${scratch}/job.sh'`)
    tmux('new-session', '-d', '-s', 'shell', '/bin/sh')
    tmux('new-session', '-d', '-s', 'lookalike', `'${bin}/my claude' 600`)
    await new Promise(res => setTimeout(res, 500))
    const ttyOf = name => tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_tty}').stdout.trim().replace('/dev/', '')
    const front = tty => spawnSync('/bin/ps', ['-t', tty, '-o', 'pid=,stat=,comm='], { encoding: 'utf8' }).stdout
    const agentTty = ttyOf('agent')
    const before = front(agentTty)
    const stop = (tty, agent, pid) => spawnSync('/bin/sh', ['-c', b.STOP_SCRIPT, 'sh', tty, b.JOB_COMMANDS[agent], String(pid)], { encoding: 'utf8', timeout: 30_000 }).stdout.trim()
    const codexPid = Number(before.split('\n').find(l => l.trim().endsWith('/codex'))?.trim().split(/\s+/)[0])
    check('bring: nothing is hung up unless that very process is in front of its terminal, under the agent\'s name',
      stop(ttyOf('shell'), 'codex', codexPid) === 'not-running' && stop(agentTty, 'claude', codexPid) === 'not-running' && stop(agentTty, 'codex', process.pid) === 'not-running' && stop('console', 'codex', codexPid) === 'not-running' && /codex/.test(front(agentTty)), String(codexPid))
    // the relay too knows the agent by its command's whole name, its folder's space and all
    const typedIn = spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', join(scratch, 'ledger'), 'pass-b1', tmux('display-message', '-p', '-t', '=agent:', '#{pane_id}').stdout.trim(), 'codex', 'READY FOR CODEX · x', socket, 'check'], { encoding: 'utf8' }).stdout.trim()
    check('relay: an agent run from a folder with a space in its name is the agent', typedIn === 'passed', typedIn)
    // a command whose name only holds the agent's among other words is not the agent
    const lookalike = spawnSync('/bin/sh', ['-c', r.RELAY_SCRIPT, 'sh', 'pass', join(scratch, 'ledger'), 'pass-b2', tmux('display-message', '-p', '-t', '=lookalike:', '#{pane_id}').stdout.trim(), 'claude', 'READY FOR CLAUDE · x', socket, 'check'], { encoding: 'utf8' }).stdout.trim()
    check('relay: a command named "my claude" is not Claude', lookalike === 'not-agent my claude', lookalike)
    const stopped = stop(agentTty, 'codex', codexPid)
    const after = front(agentTty)
    check('bring: the agent\'s job in front of its terminal hung up, waited for until it has exited', stopped === 'stopped' && /codex/.test(before) && /node/.test(before) && !/codex|node/.test(after), `${stopped} | ${before.trim()} | ${after.trim()}`)
    // a Codex home with a rollout: found by its id; how it last ran read from its last turn_context
    const id = '01a1245d-224b-7f11-8b69-8cd540d257d9'
    const day = join(scratch, 'codex-home', 'sessions', '2026', '10', '09')
    mkdirSync(day, { recursive: true })
    const rollout = join(day, `rollout-2026-10-09T22-50-45-${id}.jsonl`)
    writeFileSync(rollout, [
      { type: 'session_meta', payload: { id, cwd: '/Users/u/dev/old' } },
      { type: 'turn_context', payload: { cwd: '/Users/u/dev/old', approval_policy: 'never', sandbox_policy: { type: 'read-only' } } },
      { type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: '"type":"turn_context" quoted in a prompt' }] } },
      { type: 'turn_context', payload: { cwd: '/Users/u/dev/web-app', approval_policy: 'on-request', sandbox_policy: { type: 'danger-full-access' } } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')
    const found = spawnSync('/bin/sh', ['-c', b.ROLLOUT_SCRIPT, 'sh', join(scratch, 'codex-home'), id], { encoding: 'utf8' }).stdout.trim()
    const none = spawnSync('/bin/sh', ['-c', b.ROLLOUT_SCRIPT, 'sh', join(scratch, 'codex-home'), 'not-there'], { encoding: 'utf8' }).stdout.trim()
    check('bring: Codex\'s rollout found by its conversation\'s id; none for another', found === rollout && none === '', found)
    const mode = spawnSync('/bin/sh', ['-c', b.CODEX_MODE_SCRIPT, 'sh', rollout], { encoding: 'utf8' }).stdout
    check('bring: how Codex last ran, from its own last turn_context', JSON.stringify(b.codexFlags(mode)) === JSON.stringify(['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']) && b.codexDir(mode) === '/Users/u/dev/web-app', JSON.stringify(mode))
  } finally {
    // a check that throws still ends the private server
    tmux('kill-server')
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Claude's prompt cache, read with the real jq from transcripts of each kind: its life from the last reply that wrote
// to the cache (one that only read says nothing); when the last reply's request was sent, from the record just before
// that reply began (a reply written over several records counts from its first); a line cut by tail and a subagent's
// records skipped
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-cache-')))
  try {
    const t = s => `2026-10-10T20:${s}.000Z`
    const reply = (id, at, creation, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: t(at), ...extra, message: { id, usage: { input_tokens: 2, cache_read_input_tokens: 9000, ...(creation === undefined ? {} : { cache_creation: creation }) } } })
    const said = (at, extra = {}) => JSON.stringify({ type: 'user', timestamp: t(at), ...extra, message: { content: 'x' } })
    const read = (name, lines) => {
      const file = join(scratch, name)
      writeFileSync(file, `${lines.join('\n')}\n`)
      return spawnSync('/bin/sh', ['-c', r.CACHE_SCRIPT, 'sh', file], { encoding: 'utf8' }).stdout
    }
    const hour = r.cacheOf(read('hour.jsonl', [
      '{"type":"assistant","message":{"usage":{"cache_creation":{"ephemeral_5m_input_t',
      said('00:00'),
      reply('m1', '00:30', { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }),
      said('01:00'),
      reply('m2', '01:40', { ephemeral_1h_input_tokens: 1582, ephemeral_5m_input_tokens: 0 }),
      said('02:00', { isSidechain: true }),
      reply('s1', '02:10', { ephemeral_5m_input_tokens: 99 }, { isSidechain: true }),
      // the final reply, written over two records; nothing written to the cache by it
      reply('m3', '03:30', { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
      reply('m3', '03:50', undefined),
      JSON.stringify({ type: 'system', timestamp: t('03:51'), subtype: 'turn_duration' }),
    ]))
    const five = r.cacheOf(read('five.jsonl', [said('00:00'), reply('a', '00:10', { ephemeral_1h_input_tokens: 7 }), said('05:00'), reply('b', '05:20', { ephemeral_5m_input_tokens: 4 })]))
    const none = r.cacheOf(read('none.jsonl', [reply('a', '00:10', undefined)]))
    const missing = r.cacheOf(spawnSync('/bin/sh', ['-c', r.CACHE_SCRIPT, 'sh', join(scratch, 'gone.jsonl')], { encoding: 'utf8' }).stdout)
    // the final reply m3 began after the last record before it: m2 (01:40), the sidechain's skipped
    check('compaction: a prompt cache\'s life from the last reply that wrote to it, timed from the request of the last reply; nothing when none says or there is no transcript',
      JSON.stringify([hour, five, none, missing]) === JSON.stringify([{ lifeMs: 3_600_000, sentAt: Date.parse(t('01:40')) }, { lifeMs: 300_000, sentAt: Date.parse(t('05:00')) }, {}, {}]),
      JSON.stringify([hour, five, none, missing]))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// the ops screen, from a snapshot and event log of its own: every frame exactly the window's size (widths measured
// apart from the screen's own code), each row knowing what a click opens; real clicks in a pty on a private tmux
// server; the terminal given back however it ends; a snapshot of another version waited on, never drawn; the
// relay's event log taking lines from many sessions at once
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-ops-')))
  const opsFile = join(import.meta.dirname, '..', 'ops', 'ops.mjs')
  const socket = `live-sessions-ops-${process.pid}`
  const t = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
  try {
    t('new-session', '-d', '-s', 'ws-opsx', '-n', 'peers', 'sleep 60')
    t('split-window', '-h', '-t', '=ws-opsx:peers', 'sleep 60')
    t('set-option', '-t', 'ws-opsx', '@live-sessions-workspace', '1')
    const [left, right] = t('list-panes', '-t', '=ws-opsx:peers', '-F', '#{pane_id}').stdout.trim().split('\n')
    const now = Date.now()
    const snapshot = (fields = {}) => JSON.stringify({ version: c.SHARED_VERSION, snapshot: {
      claude: [], codex: [], places: {}, envs: [''], problems: [], checkedAt: now,
      workspaces: [
        { id: 'opsx', name: 'Ops X 要確認 ✅ é', env: '', dir: scratch, createdAt: 1 },
        { id: 'stopped', name: 'Stopped one', env: '', dir: scratch, createdAt: 2 },
        { id: '../..', name: 'Forged', env: '', dir: scratch, createdAt: 3 },
        { id: 'solox', name: 'Solo X', env: '', dir: scratch, createdAt: 4, only: 'codex' },
      ],
      tmux: { panes: { ttys990: { session: 'ws-opsx', window: 'claude', pane: left }, ttys991: { session: 'ws-opsx', window: 'codex', pane: right } }, clients: {} },
      ...fields,
    } })
    const snapFile = join(scratch, 'snapshot.json')
    writeFileSync(snapFile, snapshot())
    const events = join(scratch, 'events.jsonl')
    writeFileSync(events, [
      JSON.stringify({ at: now - 60_000, kind: 'relay', text: 'Ops X: Codex → Claude: READY FOR CLAUDE · x · y@1', workspace: 'opsx', agent: 'claude' }),
      'not json',
      JSON.stringify({ at: now - 30_000, kind: 'needs', text: '要確認 ✅ é \u009b31m ‮evil', workspace: '../etc' }),
      // a combining mark right after a colour code: a cluster of its own, no width
      JSON.stringify({ at: now - 20_000, kind: 'relay', text: '\u0301\u0301 marks first', workspace: 'opsx' }),
      JSON.stringify({ at: 'later', kind: 'x', text: 'no time' }),
    ].join('\n') + '\n')
    // osascript stood in for: what it is asked is recorded, and no Terminal window is opened or brought up
    const asked = join(scratch, 'osascript.log')
    const stub = join(scratch, 'osascript')
    writeFileSync(stub, `#!/bin/sh\nscript=$4\nshift 4\ncase $script in *doScript*) printf 'OPEN %s\\n' "$1" >> '${asked}'; echo opened;; *) printf 'FOCUS %s\\n' "$1" >> '${asked}';; esac\n`)
    execFileSync('/bin/chmod', ['+x', stub])
    const env = { ...process.env, LIVE_SESSIONS_SNAPSHOT: snapFile, LIVE_SESSIONS_EVENTS: events, LIVE_SESSIONS_TMUX_SOCKET: socket, LIVE_SESSIONS_OSASCRIPT: stub, HOME: scratch }
    const draw = (cols, rows, extra = []) => spawnSync(process.execPath, ['--no-warnings', opsFile, '--frame', ...extra], { encoding: 'utf8', env: { ...env, COLS: String(cols), ROWS: String(rows) } }).stdout
    // widths as Python's own Unicode data gives them: wide (W, F) two, combining marks and format characters none
    const widths = spawnSync('python3', ['-c', [
      'import sys, unicodedata, re, json',
      'def w(s):',
      '    s = re.sub(r"\\x1b\\[[0-9;?]*[A-Za-z]", "", s)',
      '    return sum(0 if unicodedata.category(c) in ("Mn", "Me", "Cf") else 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)',
      'print(json.dumps([w(l) for l in sys.stdin.read().rstrip("\\n").split("\\n")]))',
    ].join('\n')], { input: draw(120, 30), encoding: 'utf8' }).stdout
    const measured = JSON.parse(widths || '[]')
    check('ops: a frame is the window\'s size exactly, wide and combining characters too, by Unicode\'s own widths', measured.length === 30 && measured.every(n => n === 120), JSON.stringify([...new Set(measured)]))
    const plain = draw(120, 30, ['--plain'])
    check('ops: control characters (C1, direction overrides) from what agents wrote never reach the terminal', !/[\u0080-\u009f‪-‮]/.test(plain))
    const small = draw(30, 6).replace(/\n$/, '').split('\n').length
    check('ops: a window too small still gets a frame its size', small === 6, String(small))
    const targets = JSON.parse(draw(120, 30, ['--targets']))
    const rows = plain.split('\n')
    const at = text => rows.findIndex(l => l.includes(text))
    check('ops: rows open what they are about; a forged workspace id and an event naming none open nothing; bad lines left out',
      JSON.stringify(targets[at('READY FOR CLAUDE · x')]) === JSON.stringify({ kind: 'workspace', id: 'opsx', agent: 'claude' }) && targets[at('Forged')] === null && targets[at('evil')] === null && at('no time') < 0,
      `${at('READY FOR CLAUDE · x')} ${at('Forged')}`)
    // a workspace of one agent: that agent alone on its row, no relay line; a click anywhere on the row opens it
    const solo = at('Solo X')
    check('ops: a workspace of one agent shows that agent alone, with no relay, and its row opens that agent',
      solo > 0 && rows[solo + 1].includes('[CODEX]') && rows[solo + 1].includes('alone') && !rows[solo + 1].includes('[CLAUDE]') && !rows[solo + 2].includes('relay') &&
      JSON.stringify(targets[solo + 1]) === JSON.stringify({ kind: 'workspace', id: 'solox', agent: 'codex' }),
      `${JSON.stringify(rows[solo + 1])} ${JSON.stringify(targets[solo + 1])}`)
    // the screen, live in a terminal: clicks, keys, signals
    const live = (script, extraEnv = {}) => spawnSync('python3', ['-c', [
      'import os, pty, sys, time, select, struct, fcntl, termios, signal',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
      'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))',
      'out = b""',
      'def drain(s):',
      '    global out',
      '    end = time.time() + s',
      '    while time.time() < end:',
      '        r, _, _ = select.select([fd], [], [], 0.1)',
      '        if r:',
      '            try: out += os.read(fd, 65536)',
      '            except OSError: return',
      'drain(1.5)',
      script,
      'drain(1.0)',
      'try:',
      '    _, status = os.waitpid(pid, os.WNOHANG)',
      'except ChildProcessError:',
      '    status = 0',
      'sys.stdout.write(json.dumps({"out": out.decode("utf8", "replace"), "status": status}) if False else out.decode("utf8", "replace"))',
    ].join('\n'), process.execPath, '--no-warnings', opsFile], { encoding: 'utf8', timeout: 30_000, env: { ...env, ...extraEnv } }).stdout
    const rowOf = text => at(text) + 1
    // Claude's side of the agent row, then Codex's: each pane gets the keys; a stopped workspace: said, nothing done
    t('select-pane', '-t', right)
    const agentRow = rowOf('[CLAUDE]')
    const outA = live(`os.write(fd, b"\\x1b[<0;6;${agentRow}M\\x1b[<0;6;${agentRow}m")`)
    const activeA = t('display-message', '-p', '-t', '=ws-opsx:peers', '#{pane_id}').stdout.trim()
    const outB = live(`os.write(fd, b"\\x1b[<0;100;${agentRow}M\\x1b[<0;100;${agentRow}m")`)
    const activeB = t('display-message', '-p', '-t', '=ws-opsx:peers', '#{pane_id}').stdout.trim()
    const outC = live(`os.write(fd, b"\\x1b[<0;10;${rowOf('Stopped one')}M")`)
    const opens = existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []
    check('ops: a click on either side of an agent row gives that agent\'s pane the keys and opens a window attached to it; a stopped workspace is left to /sessions',
      activeA === left && activeB === right && outC.includes('Stopped one is not running: open it from /sessions') &&
      opens.length === 2 && opens.every(l => l === `OPEN tmux -L '${socket}' -f /dev/null attach -t '=ws-opsx'`),
      `${activeA}/${left} ${activeB}/${right} ${JSON.stringify(opens)}`)
    void outA; void outB
    // however it ends, the terminal is given back: q (typed twice too), Ctrl-C, a signal
    const restored = out => out.includes('\x1b[?1049l') && out.includes('\x1b[?1000l') && out.includes('\x1b[?25h') && out.includes('\x1b[?7h')
    const byKeys = live('os.write(fd, b"qq")')
    const bySignal = live('os.kill(pid, signal.SIGINT)')
    check('ops: the terminal is given back as it was, by q, qq or a signal', restored(byKeys) && restored(bySignal))
    // its terminal closed under it (the window shut): it ends, never left running
    const closedArgs = ['-c', [
      'import os, pty, sys, time',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
      'time.sleep(1.5)',
      'os.close(fd)',
      'end = time.time() + 5',
      'while time.time() < end:',
      '    done, _ = os.waitpid(pid, os.WNOHANG)',
      '    if done: print("ended"); sys.exit(0)',
      '    time.sleep(0.1)',
      'os.kill(pid, 9)',
      'print("left running")',
    ].join('\n'), process.execPath, '--no-warnings', opsFile]
    const runs = []
    for (let k = 0; k < 8; k++) runs.push(spawnSync('python3', closedArgs, { encoding: 'utf8', timeout: 20_000, env }).stdout.trim())
    // ...and with no hang-up signal at all (a terminal that is not its controlling one): its writes fail, and it ends
    const noSignalArgs = ['-c', [
      'import os, pty, sys, time, subprocess, fcntl, termios, struct',
      'master, slave = os.openpty()',
      'fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))',
      'p = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)',
      'end = time.time() + 1.5',
      'while time.time() < end:',
      '    try: os.read(master, 65536)',
      '    except OSError: break',
      'os.close(master)',
      'os.close(slave)',
      'try:',
      '    p.wait(timeout=5)',
      '    print("ended")',
      'except subprocess.TimeoutExpired:',
      '    p.kill()',
      '    print("left running")',
    ].join('\n'), process.execPath, '--no-warnings', opsFile]
    for (let k = 0; k < 8; k++) runs.push(spawnSync('python3', noSignalArgs, { encoding: 'utf8', timeout: 30_000, env }).stdout.trim())
    check('ops: its terminal closed under it, it ends, with a hang-up or without (sixteen times over)', runs.every(x => x === 'ended'), JSON.stringify(runs))
    // drawn live in a terminal (a private tmux pane): every row keeps its right border
    t('new-session', '-d', '-s', 'drawn', '-x', '100', '-y', '24', `env LIVE_SESSIONS_SNAPSHOT='${snapFile}' LIVE_SESSIONS_EVENTS='${events}' LIVE_SESSIONS_OSASCRIPT='${stub}' HOME='${scratch}' '${process.execPath}' --no-warnings '${opsFile}'`)
    await new Promise(res => setTimeout(res, 2_000))
    const screen = t('capture-pane', '-p', '-t', '=drawn:').stdout.replace(/\n$/, '').split('\n')
    t('send-keys', '-t', '=drawn:', 'q')
    check('ops: drawn live, every row keeps its right border', screen.length === 24 && screen.every(l => /[║╗╣╝]$/.test(l.trimEnd())), `${screen.filter(l => /[║╗╣╝]$/.test(l.trimEnd())).length}/${screen.length}`)
    // a snapshot another version wrote (an older plugin): waited on, said, never drawn
    writeFileSync(snapFile, JSON.stringify({ version: 6, snapshot: { claude: [], codex: [] } }))
    const old = live('os.write(fd, b"\\r")')
    check('ops: a snapshot of another version is said and never drawn, nothing broken', old.includes('No snapshot of this version') && !old.includes('\x1b[?1049h'))
    writeFileSync(snapFile, snapshot())
    // the relay's event log: 40 sessions writing at once, past the point where it moves to .1: every line whole, none lost
    const log = join(scratch, 'log', 'events.jsonl')
    mkdirSync(dirname(log), { recursive: true })
    writeFileSync(log, Array.from({ length: 990 }, (_, k) => JSON.stringify({ at: k })).join('\n') + '\n')
    const writers = Array.from({ length: 40 }, (_, k) => spawn('/bin/sh', ['-c', r.EVENT_SCRIPT, 'sh', log, JSON.stringify({ at: 1000 + k, kind: 'relay', text: `it's "#${k}" ${'x'.repeat(450)}` })]))
    await Promise.all(writers.map(p => new Promise(res => p.on('close', res))))
    const lines = [log + '.1', log].flatMap(f => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []))
    const parsed = lines.flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    check('ops: the event log takes lines from 40 sessions at once whole, none lost as it moves to .1', parsed.length === lines.length && parsed.filter(e => e.at >= 1000).length === 40 && existsSync(log + '.1'), `${parsed.length}/${lines.length}, ${parsed.filter(e => e.at >= 1000).length} new`)
  } finally {
    t('kill-server')
    rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// the drift check's records: the copy written last of a peer-coding folder, in the main checkout or a worktree beside
// it, its parts cut; nothing for a folder that is not there
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'live-sessions-drift-')))
  try {
    const checkout = join(scratch, 'app')
    const older = join(checkout, 'peer-coding', 'feat-x')
    const newer = join(`${checkout}-worktrees`, 'feat-x', 'peer-coding', 'feat-x')
    for (const d of [join(older, 'rounds', 'R1'), join(newer, 'rounds', 'R2'), join(newer, 'rounds', 'R10')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(older, 'CURRENT.md'), 'old copy')
    spawnSync('/usr/bin/touch', ['-t', '202601010000', join(older, 'CURRENT.md')])
    writeFileSync(join(newer, 'CURRENT.md'), `new copy ${'y'.repeat(9000)}`)
    writeFileSync(join(newer, 'rounds', 'R2', 'claude.md'), 'round two')
    writeFileSync(join(newer, 'rounds', 'R10', 'claude.md'), 'round ten from claude')
    writeFileSync(join(newer, 'rounds', 'R10', 'codex.md'), 'round ten from codex')
    writeFileSync(join(newer, 'ALIGNMENT.md'), 'aligned')
    const read = folder => spawnSync('/bin/sh', ['-c', dr.RECORDS_SCRIPT, 'sh', checkout, folder], { encoding: 'utf8' }).stdout
    const out = read('feat-x')
    check('drift: the records written last, the latest round (R10 after R2), each part cut',
      out.includes('==> CURRENT.md\nnew copy') && !out.includes('old copy') && out.includes('==> rounds/R10/claude.md\nround ten from claude') && out.includes('==> rounds/R10/codex.md') && !out.includes('round two') && out.includes('==> ALIGNMENT.md\naligned') && out.split('==> ALIGNMENT.md')[0].length < 7000,
      out.split('\n').filter(l => l.startsWith('==> ')).join(' | '))
    check('drift: no records for a folder not there, or one that would leave peer-coding/', read('feat-y') === '' && read('../app') === '' && read('a/b') === '')
    // the copy on the branch the cue names wins over the one written last; a repository's own settings run nothing:
    // the main checkout made a repository on feat/x whose settings name a signature program, with a signed commit
    const marker = join(scratch, 'ran')
    const gpg = join(scratch, 'gpg-stand-in')
    writeFileSync(gpg, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
    execFileSync('/bin/chmod', ['+x', gpg])
    const git = (...args) => spawnSync('/usr/bin/git', ['-C', checkout, ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'feat/x')
    git('config', 'log.showSignature', 'true')
    git('config', 'gpg.program', gpg)
    const tree = git('write-tree').stdout.trim()
    const signed = spawnSync('/usr/bin/git', ['-C', checkout, 'hash-object', '-t', 'commit', '-w', '--stdin'], { encoding: 'utf8', input: `tree ${tree}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned work\n` }).stdout.trim()
    git('update-ref', 'refs/heads/feat/x', signed)
    // the stand-in does run for a plain git log here (so the check below means something)
    git('log', '-n', '1')
    const ranPlain = existsSync(marker)
    rmSync(marker, { force: true })
    const onBranch = spawnSync('/bin/sh', ['-c', dr.RECORDS_SCRIPT, 'sh', checkout, 'feat-x', 'feat/x'], { encoding: 'utf8' }).stdout
    check('drift: the copy on the cue\'s branch read, though older; a program the repository\'s settings name never runs',
      ranPlain && !existsSync(marker) && onBranch.includes('==> CURRENT.md\nold copy') && onBranch.includes('signed work'), `${ranPlain} ${existsSync(marker)} ${onBranch.split('\n')[1]}`)
    // symbolic links never followed: a CURRENT.md, a round note or the folder itself pointing anywhere else
    const secret = join(scratch, 'secret.txt')
    writeFileSync(secret, 'SECRET-OUTSIDE')
    const linked = join(checkout, 'peer-coding', 'feat-l')
    mkdirSync(join(linked, 'rounds', 'R1'), { recursive: true })
    symlinkSync(secret, join(linked, 'CURRENT.md'))
    const linkedNote = join(checkout, 'peer-coding', 'feat-n')
    mkdirSync(join(linkedNote, 'rounds', 'R1'), { recursive: true })
    writeFileSync(join(linkedNote, 'CURRENT.md'), 'note copy')
    writeFileSync(join(linkedNote, 'rounds', 'R1', 'gemini.md'), 'a note by another assistant')
    symlinkSync(secret, join(linkedNote, 'rounds', 'R1', 'claude.md'))
    symlinkSync(join(checkout, 'peer-coding', 'feat-n'), join(checkout, 'peer-coding', 'feat-d'))
    const notes = read('feat-n')
    // a linked file is never read; a folder linked to another inside the repository is read as that one
    check('drift: a linked file never read; a round\'s notes read whatever the assistant is called',
      read('feat-l') === '' && read('feat-d').includes('==> CURRENT.md\nnote copy') && !read('feat-d').includes('SECRET') && !notes.includes('SECRET') && notes.includes('==> rounds/R1/gemini.md\na note by another assistant'), notes.split('\n').filter(l => l.startsWith('==> ')).join(' | '))
    // a link anywhere on the path out of the repository: a linked peer-coding/ or rounds/, a worktree that is a link
    const outside = join(scratch, 'outside')
    mkdirSync(join(outside, 'feat-o', 'rounds', 'R1'), { recursive: true })
    writeFileSync(join(outside, 'feat-o', 'CURRENT.md'), 'OUTSIDE CONTENT')
    writeFileSync(join(outside, 'feat-o', 'rounds', 'R1', 'claude.md'), 'ROUNDS OUTSIDE')
    const linkedRepo = join(scratch, 'linked')
    mkdirSync(linkedRepo)
    symlinkSync(outside, join(linkedRepo, 'peer-coding'))
    const viaTree = join(scratch, 'via')
    mkdirSync(join(`${viaTree}-worktrees`), { recursive: true })
    mkdirSync(join(outside, 'tree', 'peer-coding', 'feat-o'), { recursive: true })
    writeFileSync(join(outside, 'tree', 'peer-coding', 'feat-o', 'CURRENT.md'), 'OUTSIDE CONTENT')
    symlinkSync(join(outside, 'tree'), join(`${viaTree}-worktrees`, 'linked-tree'))
    mkdirSync(viaTree)
    const roundsOut = join(checkout, 'peer-coding', 'feat-r')
    mkdirSync(roundsOut, { recursive: true })
    writeFileSync(join(roundsOut, 'CURRENT.md'), 'rounds copy')
    symlinkSync(join(outside, 'feat-o', 'rounds'), join(roundsOut, 'rounds'))
    const reads = [
      spawnSync('/bin/sh', ['-c', dr.RECORDS_SCRIPT, 'sh', linkedRepo, 'feat-o'], { encoding: 'utf8' }).stdout,
      spawnSync('/bin/sh', ['-c', dr.RECORDS_SCRIPT, 'sh', viaTree, 'feat-o'], { encoding: 'utf8' }).stdout,
      read('feat-r'),
    ]
    check('drift: nothing read from outside the repository and its worktrees, a link anywhere on the way',
      reads[0] === '' && reads[1] === '' && reads[2].includes('rounds copy') && !reads.join('').includes('OUTSIDE'), JSON.stringify(reads.map(r => r.slice(0, 40))))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

process.exitCode = failures > 0 ? 1 : 0
