// What `claude plugin test` cannot run, checked on this Mac: the environment
// pipeline, the SQL against Codex's real schema, and one full collection.
// Run: node --experimental-strip-types tests/host-check.mjs
// It opens Codex databases read-only, and prints no environment values.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  } finally {
    // a check that throws still ends the private server
    spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'kill-server'])
    // kill-server leaves its socket file behind
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
  const out = spawnSync('/bin/sh', ['-c', r.TURN_SCRIPT, 'sh', claudeDone, claudeBusy, codexDone, codexBusy, join(scratch, 'none.jsonl'), afterCommands, interrupted, midTurn, split, codexAborted, skillBusy, skillDone, apiError], { encoding: 'utf8' })
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
  check('turns: nothing more of what was said leaves the pipeline', !out.stdout.includes('Ready.') && !out.stdout.includes('Confirmed.') && !out.stdout.includes('set it up'))
  // on this Mac's own records, read only: each answers in the expected form
  const real = readdirSync(join(home, '.claude', 'projects'), { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 3)
    .flatMap(d => readdirSync(join(home, '.claude', 'projects', d.name)).filter(f => f.endsWith('.jsonl')).slice(0, 2).map(f => join(home, '.claude', 'projects', d.name, f)))
  const realOut = spawnSync('/bin/sh', ['-c', r.TURN_SCRIPT, 'sh', ...real], { encoding: 'utf8' }).stdout
  check('turns: this Mac\'s own transcripts read in that form', realOut.split('\n').filter(l => l !== '').every(l => l.startsWith('==> ') || /^(done|busy)\t[A-Za-z0-9-]+\t\S+\t/.test(l)), `${real.length} files`)

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

process.exitCode = failures > 0 ? 1 : 0
