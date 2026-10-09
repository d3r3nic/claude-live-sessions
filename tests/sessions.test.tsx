import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  BACKGROUND_SCRIPT,
  ENV_SCRIPT,
  FOCUS_SCRIPT,
  HAS_TAB_SCRIPT,
  MODE_SCRIPT,
  MOVE_SCRIPT,
  PS_COLUMNS,
  OPEN_SCRIPT,
  TYPE_SCRIPT,
  attachCommand,
  backgroundCommand,
  resumeCommand,
  isShell,
  isClaudeProcess,
  isForeground,
  modeFlags,
  PLACE_SCRIPT,
  RECENT_SCRIPT,
  claudeFromRegistry,
  arrange,
  itemsScope,
  moved,
  orderFrom,
  parsePlaces,
  parseRecent,
  remoteName,
  workDir,
  claudeState,
  statusSummary,
  parseBackground,
  placeFrom,
  sortClaude,
  viewOf,
  windowFrom,
  windowLabel,
  codexProcFrom,
  codexSessions,
  codexTerminals,
  decodePs,
  parseEnv,
  parsePs,
  parseRollouts,
  parseThreads,
  readOnlyArgs,
  threadQuery,
} from '../hooks/collect'
import type { CodexProc, ThreadRow } from '../hooks/collect'
import {
  agentStart,
  envsFrom,
  findWorkspace,
  openCommand,
  parseClients,
  parsePanes,
  parseWorkspaceArgs,
  slugOf,
  words,
  workspacesFrom,
} from '../hooks/workspaces'
import {
  ENV_LINES,
  GIT,
  HELD,
  HOME,
  RECENT,
  LISTINGS,
  LSOF,
  NOW,
  PGREP,
  PS_LINES,
  REGISTRY,
  RESUMED,
  RESUMED_A,
  THREADS,
} from './fixtures'

const SHARED = '/Users/u/Library/Caches/live-sessions/snapshot.json'
const PANE = { component: 'Pane', requestId: 'live-sessions' } as const
const paneProps = (bodyColumns: number) => ({
  title: 'Sessions',
  isFocused: false,
  bodyColumns,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
})
const SESSIONS = {
  command: 'sessions',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}
const START = { cwd: HOME, surface: 'terminal' as const, isInteractive: true }

type Run = { exitCode: number; stdout: string; stderr: string }
const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const isUtcEnglish = (env: unknown) => JSON.stringify(env) === JSON.stringify({ LC_ALL: 'C', TZ: 'UTC' })
/** What `ps` prints in this machine's own zone (UTC-7): what the registry's UTC times never match. */
const local = (line: string) =>
  line.replace(/ (\d\d):(\d\d):(\d\d) /, (_, h: string, m: string, s: string) => ` ${String((Number(h) + 17) % 24).padStart(2, '0')}:${m}:${s} `)

/** What a test changes about the machine; engine() resets it. */
const world = {
  /** A process's `ps` state or command, changed from the fixture. */
  stat: new Map<number, string>(),
  args: new Map<number, string>(),
  /** ttys no Terminal.app tab has any more. */
  noTab: new Set<string>(),
  /** What MODE_SCRIPT prints for every transcript. */
  mode: '"permissionMode":"bypassPermissions"\n',
  /** How MOVE_SCRIPT ends: its exit code, or `reject` for a run that times out. */
  move: 0 as number | 'reject',
  /** Every session's parent, as `ps -o stat=,comm=` prints it. */
  parent: 'Ss -zsh',
  /** PLACE_SCRIPT fails (exit 1, nothing printed). */
  placeFails: false,
  /** What `tmux list-panes -a` and `tmux list-clients` print; empty: no tmux server. */
  tmuxPanes: '',
  tmuxClients: '',
  /** The owner option tmux reports for a running ws- session. */
  tmuxOwner: '',
  /** OPEN_SCRIPT fails (Terminal automation not allowed). */
  openFails: false,
  /** A file that turns unreadable right after it is read once (another writer). */
  spoilsAfterRead: '',
}
const resetWorld = () => {
  world.stat.clear()
  world.args.clear()
  world.noTab.clear()
  world.mode = '"permissionMode":"bypassPermissions"\n'
  world.move = 0
  world.parent = 'Ss -zsh'
  world.placeFails = false
  world.tmuxPanes = ''
  world.tmuxClients = ''
  world.tmuxOwner = ''
  world.openFails = false
  world.spoilsAfterRead = ''
}
const changed = (pid: number, line: string) => {
  const stat = world.stat.get(pid)
  const args = world.args.get(pid)
  const withStat = stat === undefined ? line : line.replace(/^(\s*\d+\s+\S+\s+)\S+/, `$1${stat}`)
  return args === undefined ? withStat : withStat.replace(/(\d{4}\s+).*$/, `$1${args}`)
}

/** The fixture machine: each command line the mod runs, answered as macOS would. */
function machine(argv: readonly string[], env: unknown): Run {
  const pidsAfter = (flag: string) => (argv[argv.indexOf(flag) + 1] ?? '').split(',').map(Number)
  switch (argv[0]) {
    case '/usr/bin/pgrep':
      return ok(PGREP)
    case '/bin/ps': {
      if (argv.includes('ppid=')) return ok(`${9000 + Number(argv[argv.length - 1])}\n`)
      if (argv.includes('stat=,comm=')) return ok(`${world.parent}\n`)
      const pids = pidsAfter('-p')
      const lines = pids.flatMap(pid => (PS_LINES[pid] === undefined ? [] : [changed(pid, PS_LINES[pid]!)]))
      const text = lines.map(line => (isUtcEnglish(env) ? line : local(line))).join('\n')
      // ps exits 1 when a listed pid has gone, saying nothing on stderr
      return { exitCode: lines.length === pids.length ? 0 : 1, stdout: `${text}\n`, stderr: '' }
    }
    case '/bin/sh': {
      const args = argv.slice(4)
      if (argv[2] === PLACE_SCRIPT && world.placeFails) return { exitCode: 1, stdout: '', stderr: 'fatal: timed out\n' }
      if (argv[2] === PLACE_SCRIPT) {
        return ok(args.map(d => `==> ${d}\n${GIT[d]?.rev ?? ''}--\n${(GIT[d]?.remotes ?? []).map(r => `${r}\n`).join('')}`).join(''))
      }
      if (argv[2]?.startsWith('tmux has-session')) return ok('')
      if (argv[2] === MOVE_SCRIPT) return world.move === 0 ? ok('typed') : { exitCode: Number(world.move), stdout: '', stderr: '' }
      if (argv[2] === MODE_SCRIPT) return ok(world.mode)
      if (argv[2] === RECENT_SCRIPT) return ok(args.map(f => `==> ${f}\n${(RECENT[f] ?? []).map(l => `${l}\n`).join('')}`).join(''))
      if (argv[2] !== ENV_SCRIPT) return { exitCode: 2, stdout: '', stderr: 'unexpected script' }
      const pids = (args[0] ?? '').split(',').map(Number)
      return ok(`${pids.flatMap(pid => (ENV_LINES[pid] === undefined ? [] : [ENV_LINES[pid]!])).join('\n')}\n`)
    }
    case 'tmux':
      if (argv[1] === 'list-panes') return world.tmuxPanes === '' ? { exitCode: 1, stdout: '', stderr: 'no server running\n' } : ok(world.tmuxPanes)
      if (argv[1] === 'list-clients') return ok(world.tmuxClients)
      if (argv[1] === 'select-window' || argv[1] === 'switch-client') return ok('')
      if (argv[1] === 'has-session') return world.tmuxPanes.includes(`${(argv[3] ?? '').slice(1)}\t`) ? ok('') : { exitCode: 1, stdout: '', stderr: '' }
      if (argv[1] === 'show-options') return ok(`${world.tmuxOwner}\n`)
      return { exitCode: 1, stdout: '', stderr: `unexpected tmux ${argv.join(' ')}` }
    case '/usr/sbin/lsof':
      return { exitCode: 1, stdout: LSOF, stderr: '' }
    case '/usr/bin/osascript':
      if (argv[4] === FOCUS_SCRIPT) return ok(TABS.has(argv[5] ?? '') ? 'shown\n' : '\n')
      if (argv[4] === OPEN_SCRIPT) return world.openFails ? { exitCode: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)\n' } : ok('opened\n')
      if (argv[4] === HAS_TAB_SCRIPT) return ok(TABS.has(argv[5] ?? '') && !world.noTab.has(argv[5] ?? '') ? 'yes\n' : '\n')
      if (argv[4] !== BACKGROUND_SCRIPT) return { exitCode: 1, stdout: '', stderr: 'unexpected script' }
      // Terminal.app's tab on ttys022 has the Novel profile's background; the others another
      return ok(argv[5] === 'ttys022' ? 'dfdbc3\n' : argv[5]?.startsWith('ttys') ? '1e1e1e\n' : '\n')
    case 'sqlite3': {
      const db = dbOf(argv)
      return ok(JSON.stringify(THREADS[db.slice(0, db.lastIndexOf('/'))] ?? []))
    }
    default:
      return { exitCode: 127, stdout: '', stderr: `unexpected ${argv.join(' ')}` }
  }
}

/** The ttys Terminal.app has tabs on. */
const TABS = new Set(['ttys004', 'ttys022', 'ttys000', 'ttys001', 'ttys045'])

/** The database a sqlite3 command line opens, by path or by URI. */
const dbOf = (argv: readonly string[]) =>
  (argv.find(a => a.includes('.sqlite')) ?? '').replace(/^file:/, '').replace(/\?.*$/, '')

/**
 * Beneath the plugin, what a session's engine answers: the session, commands,
 * panes, status line, files and clock; `run` answers each command line.
 */
function engine(
  on: On,
  run: (argv: readonly string[], env: unknown) => Run = machine,
  {
    canWrite = true,
    selfId = 'session-elsewhere',
    termProgram,
    moveTakesMs = 0,
  }: { canWrite?: boolean; selfId?: string; termProgram?: string; moveTakesMs?: number } = {},
) {
  resetWorld()
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: selfId }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  const panes = new Map<string, { isShown: boolean; isPlaced: boolean }>()
  on('ui.open', async ($, e) => {
    panes.set(e.id, { isShown: true, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [...panes].map(([id, pane]) => ({
      id, title: 'Sessions', isShown: pane.isShown, isFocused: false, isPlaced: pane.isPlaced, plugin: 'live-sessions',
    })),
  }))
  const store = new Map<string, unknown>()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const status: (string | undefined)[] = []
  on('ui.status', async ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  mock.env(on, termProgram === undefined ? { HOME } : { HOME, TERM_PROGRAM: termProgram })
  const clock = mock.clock(on, { now: NOW })
  const runs: string[][] = []
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    const isMove = e.argv[0] === '/bin/sh' && e.argv[2] === MOVE_SCRIPT
    if (isMove && moveTakesMs > 0) await clock.sleep(moveTakesMs)
    if (isMove && world.move === 'reject') return { deny: 'timed out after 40000 ms' }
    return { value: { ...run(e.argv, e.init?.env), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const files = new Map<string, string>(Object.entries(REGISTRY))
  on('fs.list', async ($, e) => {
    const entries = LISTINGS[e.path]
    return entries === undefined ? { deny: `ENOENT ${e.path}` } : { value: entries }
  })
  on('fs.exists', async ($, e) => {
    const at = e.path.lastIndexOf('/')
    const isListed = LISTINGS[e.path.slice(0, at)]?.some(entry => entry.name === e.path.slice(at + 1)) ?? false
    return { value: LISTINGS[e.path] !== undefined || isListed || files.has(e.path) }
  })
  on('fs.stat', async ($, e) => {
    const isDir = LISTINGS[e.path] !== undefined || GIT[e.path] !== undefined
    return isDir ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', async ($, e) => {
    const text = files.get(e.path)
    if (text !== undefined && e.path === world.spoilsAfterRead) {
      files.set(e.path, '{ broken')
      world.spoilsAfterRead = ''
    }
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    if (!canWrite) return { deny: 'EACCES: permission denied' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const collections = () => runs.filter(r => r[0] === '/usr/bin/pgrep').length
  return { clock, runs, panes, status, toasts, files, store, collections }
}

const shownOn = async ($: Engine, surface: 'terminal' | 'desktop', columns: number) => {
  const ui = await $.ui.mount({ plugin: 'live-sessions', surface, ...PANE, props: paneProps(columns) })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

const procsOf = () => parsePs(Object.values(PS_LINES).join('\n'))
/** The fixture machine's snapshot, put together from the parsers. */
const snapshotOf = () => {
  const procs = procsOf()
  const claude = sortClaude(Object.entries(REGISTRY).flatMap(([path, text]) => {
    const row = claudeFromRegistry(JSON.parse(text), path.includes('.claude-work') ? 'claude-work' : 'claude', procs, HOME)
    return row === undefined ? [] : [row]
  }))
  const codex = codexSessions({ terminals: terminalsOf(), threads: threadsOf(), now: NOW })
  const places = Object.fromEntries([...claude.map(s => s.cwd), ...codex.map(s => s.cwd)].map(cwd => [cwd, placeFrom(cwd, GIT[cwd]?.rev ?? '', GIT[cwd]?.remotes)]))
  return { claude, codex, places, workspaces: [], envs: ['', 'work'], tmux: { panes: {}, clients: {} }, checkedAt: NOW, problems: [] }
}
const codexPids = () => new Set(PGREP.split('\n').filter(Boolean).map(Number))
const threadsOf = () =>
  new Map(Object.entries(THREADS).map(([home, rows]) => [home, parseThreads(JSON.stringify(rows))] as const))
const terminalsOf = (): CodexProc[] => {
  const env = parseEnv(Object.values(ENV_LINES).join('\n'))
  const held = parseRollouts(LSOF)
  return codexTerminals(procsOf(), codexPids()).map(p => codexProcFrom(p, env.get(p.pid), held.get(p.pid) ?? [], HOME))
}

describe('collect', () => {
  test('a registry entry is live only while its pid runs the process it recorded', async () => {
    const live = Object.entries(REGISTRY).flatMap(([path, text]) => {
      const row = claudeFromRegistry(JSON.parse(text), 'claude', procsOf(), HOME)
      return row === undefined ? [] : [`${path.split('/').pop()}:${row.name}:${row.tty}`]
    })
    expect(live).toEqual(['101.json:WEB CONSOLE:ttys004', '102.json:NIGHTLY:??', '104.json:WORKER:ttys022'])
  })

  test('codex terminals: named codex, on a terminal, not a server, helper or login', async () => {
    expect(codexTerminals(procsOf(), codexPids()).map(p => p.pid)).toEqual([201, 202, 207, 208, 210, 211])
  })

  test('a terminal knows its home, folder, resumed thread and the threads it holds', async () => {
    expect(terminalsOf().map(t => [t.pid, t.codexHome, t.cwd, t.resumeId, t.isExec, t.held])).toEqual([
      [201, '/Users/u/.codex', '/Users/u/dev/web-app', undefined, false, [HELD]],
      [202, '/Users/u/.codex-work', '/Users/u/dev/api', RESUMED, false, []],
      [207, '/Users/u/.codex', '/Users/u/dev/web-app', RESUMED_A, false, []],
      // --cd=.. resolved against PWD, past an executable path with a space in it
      [208, '/Users/u/.codex', '/Users/u/projects', undefined, false, []],
      [210, '/Users/u/.codex', '/Users/u/dev/build', undefined, true, []],
      [211, '/Users/u/.codex', '/Users/u/dev/résumé', undefined, false, []],
    ])
  })

  test('each terminal gets its own thread, and recent threads elsewhere are listed', async () => {
    const rows = codexSessions({ terminals: terminalsOf(), threads: threadsOf(), now: NOW })
    expect(rows.map(r => [r.title, r.surface, r.tty, r.profile, r.agents])).toEqual([
      ['Find the report writer', 'terminal', 'ttys045', 'codex', 2],
      ['Audit GitHub usage', 'app', '', 'codex', 0],
      ['Fix the build', 'terminal', 'ttys040', 'codex', 0],
      ['API REVIEW', 'terminal', 'ttys001', 'codex-work', 0],
      ['Ship the console', 'terminal', 'ttys033', 'codex', 0],
      // 201 holds this rollout open: that beats the newer web-app thread 207 resumed
      ['Execute research', 'terminal', 'ttys000', 'codex', 0],
      ['session (thread not found)', 'terminal', 'ttys041', 'codex', 0],
    ])
  })

  test('in one folder, a thread born before the newer terminal started stays with the older', async () => {
    const term = (pid: number, minutesAgo: number): CodexProc => ({
      pid, tty: `ttys00${pid}`, startedAt: NOW - minutesAgo * 60_000, codexHome: '/h', cwd: '/x', isExec: false, held: [],
    })
    const row = (id: string, createdAgo: number, writtenAgo: number): ThreadRow => ({
      id, title: id, name: '', cwd: '/x', source: 'cli', originator: 'codex-tui', rollout_path: '',
      created_at_ms: NOW - createdAgo * 60_000, updated_at_ms: NOW - writtenAgo * 60_000, agents: 0,
    })
    const match = (threads: ThreadRow[]) =>
      codexSessions({ terminals: [term(1, 120), term(2, 60)], threads: new Map([['/h', threads]]), now: NOW })
        .filter(r => r.surface === 'terminal')
        .map(r => `${r.tty}=${r.title}`)
        .sort()
    expect(match([row('A', 115, 90), row('B', 55, 10)])).toEqual(['ttys001=A', 'ttys002=B'])
    expect(match([row('A', 115, 5), row('B', 55, 30)])).toEqual(['ttys001=A', 'ttys002=B'])
    // an old thread resumed from inside the terminal: matched by when it was written
    expect(match([row('A', 7 * 1440, 1)])).toEqual(['ttys001=session (thread not found)', 'ttys002=A'])
  })

  test('ps escapes, environment lines and lsof output parse', async () => {
    expect(decodePs('/Users/u/r\\303\\251sum\\303\\251 x')).toBe('/Users/u/résumé x')
    expect(parseEnv('7\t/h/.codex-work\t/a b\n8\t\t\n')).toEqual(
      new Map([[7, { codexHome: '/h/.codex-work', pwd: '/a b' }], [8, { codexHome: '', pwd: '' }]]),
    )
    expect(parseRollouts(LSOF)).toEqual(new Map([[201, [HELD]]]))
  })

  test('the environment pipeline prints the pid and two variables, nothing else', async () => {
    // what it prints is checked against ps -E on a Mac by tests/host-check.mjs
    expect(ENV_SCRIPT.match(/print/g)).toHaveLength(1)
    expect(ENV_SCRIPT).toContain('{ print $1 "\\t" last($0, "CODEX_HOME") "\\t" last($0, "PWD") }')
  })

  test("Terminal's answer is a color only when it is six hex digits", async () => {
    expect(parseBackground('DFDBC3\n')).toBe('#dfdbc3')
    for (const bad of ['', '\n', 'dfdbc', 'dfdbc3x', 'execution error']) expect(parseBackground(bad)).toBeUndefined()
  })

  test('git places a directory: repository by its remote, worktree, branch', async () => {
    const origin = ['remote.origin.url git@github.com:Org/app.git']
    expect(placeFrom('/r/sub', '/r\n/r/.git\nmain\n', origin)).toEqual({ repo: 'github.com/org/app', name: 'Org/app', tree: '/r', branch: 'main' })
    // a worktree, or another clone of the same remote, groups with it
    expect(placeFrom('/w', '/w\n/r/.git\nfeat/x\n', origin).repo).toBe('github.com/org/app')
    expect(placeFrom('/clone', '/clone\n/clone/.git\nmain\n', ['remote.origin.url https://github.com/org/app']).repo).toBe('github.com/org/app')
    // origin before any other remote; with none, the main checkout's folder
    expect(placeFrom('/r', '/r\n/r/.git\nmain\n', ['remote.fork.url git@github.com:me/app.git', 'remote.origin.url git@github.com:Org/app.git']).name).toBe('Org/app')
    expect(placeFrom('/r', '/r\n/r/.git\nmain\n', ['remote.fork.url git@github.com:me/app.git']).name).toBe('me/app')
    expect(placeFrom('/w', '/w\n/home/r/.git\nfeat/x\n')).toEqual({ repo: '/home/r', name: 'r', tree: '/w', branch: 'feat/x' })
    // detached, or no commit yet: no branch
    expect(placeFrom('/r', '/r\n/r/.git\nHEAD\n').branch).toBe('')
    expect(placeFrom('/s', '/s\n/r/.git/modules/s\nmain\n').repo).toBe('/s')
    expect(placeFrom('/b-wt', '/b-wt\n/srv/b.git\nmain\n')).toEqual({ repo: '/srv/b.git', name: 'b', tree: '/b-wt', branch: 'main' })
    expect(placeFrom('/tmp/x', '')).toEqual({ repo: '', name: '', tree: '/tmp/x', branch: '' })
  })

  test('remote URLs of every form name owner/repo; a user or token is never kept', async () => {
    expect(remoteName('git@github.com:Acme-llc/backend.git')).toEqual({ key: 'github.com/acme-llc/backend', name: 'Acme-llc/backend' })
    expect(remoteName('https://x-access-token:SECRET@github.com/Org/app.git/')).toEqual({ key: 'github.com/org/app', name: 'Org/app' })
    expect(remoteName('ssh://git@gitlab.example.com:2222/group/sub/app.git')).toEqual({ key: 'gitlab.example.com/group/sub/app', name: 'sub/app' })
    expect(remoteName('/srv/git/app.git')).toEqual({ key: '/srv/git/app', name: 'app' })
    expect(remoteName('')).toBeUndefined()
    expect(JSON.stringify(remoteName('https://me:SECRET@host/o/r'))).not.toContain('SECRET')
  })

  test('the place and recent-folder pipelines parse', async () => {
    const places = parsePlaces('==> /a\n/a\n/a/.git\nmain\n--\nremote.origin.url git@h:o/a.git\n==> /tmp\n--\n')
    expect(places.get('/a')).toEqual({ repo: 'h/o/a', name: 'o/a', tree: '/a', branch: 'main' })
    expect(places.get('/tmp')).toEqual({ repo: '', name: '', tree: '/tmp', branch: '' })
    const recent = parseRecent('==> /t.jsonl\n"cwd":"/a/b"\n"cwd":"file:///a/my%20dir/"\n"cwd":"/cut\\\n==> /empty.jsonl\n')
    expect(recent).toEqual(new Map([['/t.jsonl', ['/a/b', '/a/my dir']], ['/empty.jsonl', []]]))
  })

  test('a session works where it has used a repository most, not where it passed through', async () => {
    const place = (repo: string, tree: string) => ({ repo, name: repo, tree, branch: 'main' })
    const places = {
      '/u': { repo: '', name: '', tree: '/u', branch: '' },
      '/scratch': { repo: '', name: '', tree: '/scratch', branch: '' },
      '/a': place('a', '/a'), '/a/src': place('a', '/a'), '/b': place('b', '/b'),
    }
    expect(workDir('/u', ['/a', '/a/src', '/b', '/scratch', '/scratch', '/scratch'], places)).toBe('/a/src')
    // a tie goes to the one used last
    expect(workDir('/u', ['/a', '/b'], places)).toBe('/b')
    // nothing in a repository: where it started
    expect(workDir('/u', ['/scratch', '/scratch'], places)).toBe('/u')
    expect(workDir('/u', [], places)).toBe('/u')
  })

  test('activity windows: days by default, hours, all', async () => {
    expect(windowFrom('2d')).toBe(2 * 86_400_000)
    expect(windowFrom(' 3 ')).toBe(3 * 86_400_000)
    expect(windowFrom('12h')).toBe(12 * 3_600_000)
    expect(windowFrom('1.5 days')).toBe(1.5 * 86_400_000)
    expect(windowFrom('ALL')).toBe(0)
    for (const bad of ['', '0d', '-2d', 'two', '2w']) expect(windowFrom(bad)).toBeUndefined()
    expect([0, 86_400_000, 4 * 86_400_000, 12 * 3_600_000].map(windowLabel)).toEqual(['all', '1d', '4d', '12h'])
  })

  test('the view: repositories, then worktrees, then sessions, the busiest first; plain folders last', async () => {
    const snap = snapshotOf()
    const outline = (windowMs: number) =>
      viewOf(snap, { home: HOME, now: NOW, windowMs, selfId: 'session-104' }).repos.map(r => [
        r.label, r.trees.map(t => [t.label, t.path, t.items.map(i => `${i.tool}:${i.title}`)]),
      ])
    expect(outline(0)).toEqual([
      ['Acme/web-app', [
        ['main', '~/dev/web-app', ['claude:WEB CONSOLE', 'codex:Find the report writer', 'codex:Execute research']],
        ['fix/build', '~/dev/build', ['codex:Fix the build']],
      ]],
      ['Acme/api', [['main', '~/dev/api', ['codex:API REVIEW']]]],
      ['Other folders', [
        ['~', '', ['claude:NIGHTLY', 'claude:WORKER']],
        ['~/projects', '', ['codex:Audit GitHub usage', 'codex:Ship the console']],
        ['~/dev/résumé', '', ['codex:session (thread not found)']],
      ]],
    ])
    // one day: the thread last written nine days ago, the terminal open a day ago go; working ones stay
    const day = viewOf(snap, { home: HOME, now: NOW, windowMs: 86_400_000, selfId: '' })
    expect([day.shown, day.total]).toEqual([9, 10])
    const hour = viewOf(snap, { home: HOME, now: NOW, windowMs: 3_600_000, selfId: '' })
    expect(hour.repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => i.title)))).toEqual([
      'WEB CONSOLE', 'Find the report writer', 'Fix the build', 'NIGHTLY', 'WORKER', 'Audit GitHub usage', 'session (thread not found)',
    ])
  })

  test('a turn busy for over 12 hours is stalled: not working, filtered like an idle one', async () => {
    const base = snapshotOf()
    const stuck = { ...base.claude[0]!, pid: 7006, sessionId: 's7006', name: 'STUCK', since: NOW - 38 * 86_400_000 }
    const snap = { ...base, claude: [...base.claude, stuck] }
    expect(claudeState(stuck, NOW)).toBe('stalled')
    expect(claudeState({ ...stuck, since: NOW - 11 * 3_600_000 }, NOW)).toBe('working')
    expect(statusSummary(snap)).toBe('Claude 4 (1 working) · Codex 7 (1 working) · /sessions')
    const titles = (windowMs: number) =>
      viewOf(snap, { home: HOME, now: NOW, windowMs, selfId: '' }).repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => `${i.title}:${i.state}`)))
    expect(titles(0)).toContain('STUCK:stalled')
    expect(titles(7 * 86_400_000).some(t => t.startsWith('STUCK'))).toBe(false)
    // a turn two hours long is still working: an hour's window keeps it
    const long = { ...stuck, name: 'LONG TURN', since: NOW - 2 * 3_600_000 }
    const withLong = { ...base, claude: [...base.claude, long] }
    expect(viewOf(withLong, { home: HOME, now: NOW, windowMs: 3_600_000, selfId: '' }).repos
      .flatMap(r => r.trees.flatMap(t => t.items.map(i => `${i.title}:${i.state}`)))).toContain('LONG TURN:working')
  })

  test('a manual order: placed keys first in that order, the rest after by the automatic one', async () => {
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(arrange(['a', 'b', 'c', 'd'], k => k, ['c', 'a'], byName)).toEqual(['c', 'a', 'b', 'd'])
    expect(arrange(['a', 'b'], k => k, undefined, (a, b) => byName(b, a))).toEqual(['b', 'a'])
    // a move swaps with the neighbour as listed now; what is not listed now keeps its rank after
    expect(moved(undefined, ['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(moved(['x', 'b', 'a'], ['a', 'b'], 'b', -1)).toEqual(['b', 'a', 'x'])
    expect(moved(['b', 'a'], ['b', 'a'], 'b', -1)).toEqual(['b', 'a'])
    expect(moved(undefined, ['a', 'b'], 'b', 1)).toEqual([])
    expect(moved(undefined, ['a'], 'zzz', 1)).toEqual([])
    expect(orderFrom({ repos: ['a'], bad: 'x', mixed: ['a', 1] })).toEqual({ repos: ['a'] })
    expect(orderFrom(['a'])).toBeUndefined()
  })

  test('the view follows the manual order at every level', async () => {
    const snap = snapshotOf()
    const order = {
      repos: ['', 'github.com/acme/api'],
      'trees:github.com/acme/web-app': ['/Users/u/dev/build'],
      [itemsScope('/Users/u/dev/web-app')]: ['codex-7c6d3e24-0285-4409-9d55-1d32aa33f6d0'],
    }
    const view = viewOf(snap, { home: HOME, now: NOW, windowMs: 0, selfId: '', order })
    expect(view.repos.map(r => r.label)).toEqual(['Other folders', 'Acme/api', 'Acme/web-app'])
    const webApp = view.repos[2]!
    expect(webApp.trees.map(t => t.label)).toEqual(['fix/build', 'main'])
    // placed first; the working ones not placed follow, busiest first
    expect(webApp.trees[1]!.items.map(i => i.title)).toEqual(['Execute research', 'WEB CONSOLE', 'Find the report writer'])
  })

  test('what a press opens: a terminal tab, or a background session to attach; never this one', async () => {
    const view = viewOf(snapshotOf(), { home: HOME, now: NOW, windowMs: 0, selfId: 'session-104' })
    const targets = Object.fromEntries(view.repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => [i.title, i.target]))))
    expect(targets['WEB CONSOLE']).toEqual({ tty: 'ttys004' })
    expect(targets['NIGHTLY']).toEqual({ attach: 'a1b2c3d4', profile: 'claude' })
    expect(targets['WORKER']).toBeUndefined()
    expect(targets['Find the report writer']).toEqual({ tty: 'ttys045' })
    expect(targets['Audit GitHub usage']).toBeUndefined()
    expect(attachCommand('a1b2c3d4', 'claude', '/Users/u')).toBe('claude attach a1b2c3d4')
    expect(attachCommand('a1b2c3d4', 'claude-work', "/Users/o'k")).toBe("CLAUDE_CONFIG_DIR='/Users/o'\\''k/.claude-work' claude attach a1b2c3d4")
    for (const bad of ['x; rm -rf ~', '$(id)', '']) expect(attachCommand(bad, 'claude', '/Users/u')).toBeUndefined()
    expect(attachCommand('a1b2c3d4', 'claude; id', '/Users/u')).toBeUndefined()
  })

  test('moving to the background: the command that resumes it there and attaches its tab', async () => {
    // the permission mode comes from the transcript's own record, never from words on a command line
    expect(modeFlags('"permissionMode":"bypassPermissions"')).toEqual(['--dangerously-skip-permissions'])
    expect(modeFlags('"permissionMode":"auto"\n')).toEqual(['--permission-mode', 'auto'])
    expect(modeFlags('')).toEqual([])
    expect(modeFlags('"permissionMode":"default"')).toEqual([])
    expect(modeFlags('"permissionMode":"somethingNew"')).toBeUndefined()
    // every mode the CLI takes, as itself; only bypassPermissions becomes the skip flag
    for (const mode of ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']) {
      expect(modeFlags(`"permissionMode":"${mode}"`)).toEqual(['--permission-mode', mode])
    }
    expect(isShell('-zsh')).toBe(true)
    expect(isShell('/bin/bash')).toBe(true)
    for (const comm of ['node', 'claude', 'python3', 'tmux']) expect(isShell(comm)).toBe(false)
    expect(resumeCommand({ sessionId: 'abc-123', startCwd: "/Users/u/it's", profile: 'claude-work' }, '/Users/u')).toBe(
      "cd '/Users/u/it'\\''s' && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude --resume abc-123",
    )
    expect(isForeground('S+')).toBe(true)
    expect(isForeground('Ss+')).toBe(true)
    for (const stat of ['T+', 'T', 'S', 'Ss', 'Z+']) expect(isForeground(stat)).toBe(false)
    expect(isClaudeProcess('claude --dangerously-skip-permissions')).toBe(true)
    expect(isClaudeProcess('/Users/u/.local/share/claude/versions/2.1.283 --resume x')).toBe(true)
    for (const args of ['/usr/bin/vim notes.txt', 'zsh', 'node claude.js']) expect(isClaudeProcess(args)).toBe(false)
    const s = { sessionId: 'abc-123', startCwd: '/Users/u/dev', profile: 'claude' }
    expect(backgroundCommand(s, '/Users/u', [])).toBe("cd '/Users/u/dev' && claude --bg --resume abc-123 && claude attach abc-123")
    expect(backgroundCommand(s, '/Users/u', ['--model', 'opus'])).toBeUndefined()
    expect(backgroundCommand({ ...s, startCwd: '/Users/u/a\nrm -rf ~' }, '/Users/u', [])).toBeUndefined()
    expect(backgroundCommand({ ...s, profile: 'claude-work', startCwd: "/Users/u/it's" }, '/Users/u', ['--dangerously-skip-permissions'])).toBe(
      "cd '/Users/u/it'\\''s' && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude --bg --resume abc-123 --dangerously-skip-permissions && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude attach abc-123",
    )
    expect(backgroundCommand({ ...s, sessionId: 'a;b' }, '/Users/u', [])).toBeUndefined()
    expect(backgroundCommand({ ...s, startCwd: 'dev' }, '/Users/u', [])).toBeUndefined()
    // offered only for an idle session in a terminal tab, not this one, not one already in the background
    const view = viewOf(snapshotOf(), { home: HOME, now: NOW, windowMs: 0, selfId: 'session-elsewhere' })
    const moves = Object.fromEntries(view.repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => [i.title, i.move]))))
    expect(moves['WORKER']).toEqual({ pid: 104, tty: 'ttys022', profile: 'claude-work', sessionId: 'session-104', startCwd: '/Users/u' })
    expect(moves['WEB CONSOLE']).toBeUndefined()
    expect(moves['NIGHTLY']).toBeUndefined()
    expect(moves['Find the report writer']).toBeUndefined()
    const asSelf = viewOf(snapshotOf(), { home: HOME, now: NOW, windowMs: 0, selfId: 'session-104' })
    expect(asSelf.repos.flatMap(r => r.trees.flatMap(t => t.items)).find(i => i.title === 'WORKER')?.move).toBeUndefined()
  })

  test('an immutable URI escapes what would end the path', async () => {
    expect(readOnlyArgs('/a/b?c#d%e.sqlite', false)).toEqual(['file:/a/b%3Fc%23d%25e.sqlite?immutable=1'])
    expect(readOnlyArgs('/a/b.sqlite', true)).toEqual(['-readonly', '/a/b.sqlite'])
  })

  test('the thread query: unarchived top-level threads, well-formed ids only', async () => {
    const sql = threadQuery(1, 2, [RESUMED, RESUMED, "x') or 1=1 --"])
    expect(sql).toContain(`or t.id in ('${RESUMED}')`)
    expect(sql).toContain('t.archived = 0')
    expect(sql).toContain("coalesce(nullif(t.thread_source, ''), 'user') = 'user'")
    expect(sql).not.toContain('1=1')
  })
})

describe('pane', () => {
  test('lists the live sessions on every surface', async ($, on) => {
    const { runs, status, files } = engine(on)
    await $.session.start(START)
    expect((await $.command.run(SESSIONS)).text).toBe('Sessions pane opened (all sessions).')

    // ps reads only the registry's pids and pgrep's codex processes
    expect(runs.find(r => r[0] === '/bin/ps')).toEqual([
      '/bin/ps', '-ww', '-o', PS_COLUMNS, '-p', '101,102,103,999,104,201,202,204,206,207,208,209,210,211',
    ])
    // environments are read for the codex terminals alone, filtered in the pipeline
    expect(runs.find(r => r[0] === '/bin/sh')?.[4]).toBe('201,202,207,208,210,211')
    // open files of the terminals, with no host or port lookups to stall on
    expect(runs.find(r => r[0] === '/usr/sbin/lsof')).toEqual([
      '/usr/sbin/lsof', '-n', '-P', '-a', '-p', '201,202,207,208,210,211', '-Fpn',
    ])
    // never opened for writing: read-only beside Codex, immutable when nobody holds it
    const sqlite = runs.filter(r => r[0] === 'sqlite3')
    expect(sqlite.map(dbOf)).toEqual(['/Users/u/.codex/state_5.sqlite', '/Users/u/.codex-work/state_5.sqlite'])
    expect(sqlite[0]).toContain('-readonly')
    expect(sqlite[1]).toContain('file:/Users/u/.codex-work/state_5.sqlite?immutable=1')
    expect(sqlite[1]).not.toContain('-readonly')
    expect(status.at(-1)).toBe('Claude 3 (1 working) · Codex 7 (1 working) · /sessions')

    // each session is listed where it has been working: WORKER started in ~ but works in api,
    // the desktop thread ran its commands in the web-app worktree
    const placedAt = (title: string) => {
      const snap = JSON.parse(files.get(SHARED) ?? '{}').snapshot as { claude: { name: string; cwd: string }[]; codex: { title: string; cwd: string }[]; places: Record<string, { name: string }> }
      const row = [...snap.claude.map(s => ({ title: s.name, cwd: s.cwd })), ...snap.codex].find(s => s.title === title)
      return row === undefined ? undefined : `${snap.places[row.cwd]?.name}:${row.cwd}`
    }
    expect(placedAt('WORKER')).toBe('Acme/api:/Users/u/dev/api/src')
    expect(placedAt('Audit GitHub usage')).toBe('Acme/web-app:/Users/u/dev/build')
    expect(placedAt('NIGHTLY')).toBe(':/Users/u')
    // the shared snapshot holds what is shown and nothing of the processes' arguments
    const shared = files.get(SHARED) ?? ''
    expect(JSON.parse(shared).version).toBe(6)
    for (const leak of ['opt/homebrew', 'dangerously', '--cd', 'CODEX_HOME']) expect(shared).not.toContain(leak)

    for (const surface of ['terminal', 'desktop'] as const) {
      const texts = await shownOn($, surface, 90)
      const shown = texts.join('\n')
      for (const name of ['WEB CONSOLE', 'NIGHTLY (bg)', 'WORKER (work)', 'Find the report writer (+2 agents)',
        'API REVIEW (work)', 'Audit GitHub usage', 'Ship the console', 'Execute research', 'Fix the build']) {
        expect(shown).toContain(name)
      }
      for (const hidden of ['REUSED PID', 'GONE', 'old exec run', '! ']) expect(shown).not.toContain(hidden)
      for (const cell of ['ttys004', 'detached', 'app', 'claude', 'codex', 'Acme/web-app', 'Acme/api', 'Other folders']) expect(texts).toContain(cell)
      expect(shown).toContain('~/dev/résumé')
    }
  })

  test('Claude is orange, Codex blue; an idle row is white', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(t => t.text === 'claude').every(t => t.props.color === '#c15f3c')).toBe(true)
    expect(texts.filter(t => t.text === 'codex').every(t => t.props.color === '#1f5fd0')).toBe(true)
    expect(texts.filter(t => t.text === 'claude').length).toBeGreaterThan(0)
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => typeof b.key === 'string' && /^(claude|codex)-/.test(b.key))
    const idle = rows.filter(b => b.text.includes('idle'))
    const working = rows.filter(b => b.text.includes('working'))
    expect(idle.length).toBeGreaterThan(0)
    expect(idle.every(b => b.props.backgroundColor === '#ffffff')).toBe(true)
    expect(working.every(b => b.props.backgroundColor === undefined)).toBe(true)
    await ui.unmount()
  })

  test('in Terminal.app a press brings the session up: its tab to the front, a background one attached', async ($, on) => {
    const { runs } = engine(on, machine, { selfId: 'session-104', termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    const osa = () => runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] !== BACKGROUND_SCRIPT).map(r => [r[4] === FOCUS_SCRIPT ? 'focus' : 'open', r[5]])
    await ui.press({ key: 'open claude-101' })
    await ui.press({ key: 'open claude-102' })
    await ui.press({ key: 'open codex-1cdaec1d-0ec7-4f0a-811f-5c29c9bcb3b7' })
    expect(osa()).toEqual([['focus', 'ttys004'], ['open', 'claude attach a1b2c3d4'], ['focus', 'ttys045']])
    // this session, and a thread with no terminal, are not pressed to open
    expect(await ui.find({ key: 'open claude-104' })).toBeUndefined()
    expect(await ui.find({ key: 'open codex-b' })).toBeUndefined()
    await ui.unmount()
  })

  test('[to bg] pressed twice moves the session: checked again, hung up, resumed and attached in its own tab', async ($, on) => {
    const { runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT)
    expect(await ui.find({ key: 'bg claude-101' })).toBeUndefined()
    await ui.press({ key: 'bg claude-104' })
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('sure?')
    expect(moves()).toEqual([])
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([[
      '/bin/sh', '-c', MOVE_SCRIPT, 'sh', '104', 'ttys022',
      "cd '/Users/u' && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude --bg --resume session-104 --dangerously-skip-permissions && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude attach session-",
      TYPE_SCRIPT,
    ]])
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('to bg')
    await ui.unmount()
  })

  test('a first press goes stale; a session that turned busy meanwhile is not moved', async ($, on) => {
    const { runs, clock, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT)
    await ui.press({ key: 'bg claude-104' })
    await clock.advance(7_000)
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([])
    // asked again, then the session starts a turn before the second press
    const path = '/Users/u/.claude-work/sessions/104.json'
    files.set(path, JSON.stringify({ ...JSON.parse(files.get(path)!), status: 'busy', statusUpdatedAt: NOW }))
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([])
    await ui.unmount()
  })

  test('nothing is touched unless the move can finish: each refusal leaves the session alone and says why', async ($, on) => {
    const { runs, files, toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT).length
    const path = '/Users/u/.claude-work/sessions/104.json'
    const entry = JSON.parse(files.get(path)!) as Record<string, unknown>
    const attempt = async (change: () => void, why: RegExp) => {
      change()
      await ui.press({ key: 'bg claude-104' })
      await ui.press({ key: 'bg claude-104' })
      expect(moves()).toBe(0)
      expect(toasts.at(-1)).toMatch(why)
      resetWorld()
      files.set(path, JSON.stringify(entry))
    }
    await attempt(() => world.stat.set(104, 'T+'), /suspended/)
    await attempt(() => world.noTab.add('ttys022'), /not a Terminal\.app tab/)
    await attempt(() => world.args.set(104, '/usr/bin/vim notes.txt'), /ended or its process changed/)
    await attempt(() => files.set(path, JSON.stringify({ ...entry, sessionId: 'session-other' })), /ended or its process changed/)
    await attempt(() => files.set(path, JSON.stringify({ ...entry, kind: 'bg' })), /no longer idle/)
    await attempt(() => files.set(path, JSON.stringify({ ...entry, procStart: undefined })), /no start time/)
    await attempt(() => { world.mode = '"permissionMode":"somethingNew"' }, /permission mode/)
    await attempt(() => { world.parent = 'Ss node' }, /not started directly by an interactive shell/)
    // a launcher script's interpreter is a shell, but in the foreground job with claude
    await attempt(() => { world.parent = 'S+ /bin/zsh' }, /not started directly by an interactive shell/)
    // and with nothing in the way, it moves
    await ui.press({ key: 'bg claude-104' })
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toBe(1)
    expect(toasts.at(-1)).toMatch(/closing that tab now leaves it running/)
    await ui.unmount()
  })

  test('a suspended session is not offered the move at all', async ($, on) => {
    engine(on, machine, { termProgram: 'Apple_Terminal' })
    world.stat.set(104, 'T+')
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    expect(await ui.find({ key: 'bg claude-104' })).toBeUndefined()
    await ui.unmount()
  })

  test('a first press on one row is not confirmed by a press on another', async ($, on) => {
    const { runs, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // WEB CONSOLE idle too, so two rows offer the move
    const path = '/Users/u/.claude/sessions/101.json'
    files.set(path, JSON.stringify({ ...JSON.parse(files.get(path)!), status: 'idle' }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT).map(r => r[4])
    await ui.press({ key: 'bg claude-101' })
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([])
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('sure?')
    expect((await ui.find({ key: 'bg claude-101' }))?.props.label).toBe('to bg')
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual(['104'])
    await ui.unmount()
  })

  test('when the move fails after the hang-up, the toast says how to resume it', async ($, on) => {
    const { toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const twice = async () => {
      await ui.press({ key: 'bg claude-104' })
      await ui.press({ key: 'bg claude-104' })
    }
    world.move = 4
    await twice()
    expect(toasts.at(-1)).toMatch(/has not exited after 20 s.*cd '\/Users\/u' && CLAUDE_CONFIG_DIR='\/Users\/u\/\.claude-work' claude --resume session-104/)
    world.move = 5
    await twice()
    expect(toasts.at(-1)).toMatch(/could not be typed into ttys022.*claude --bg --resume session-104/)
    world.move = 'reject'
    await twice()
    expect(toasts.at(-1)).toMatch(/resume could not be typed|timed out/)
    await ui.unmount()
  })

  test('a second move of the same session while the first runs is refused', { timeoutMs: 4_000 }, async ($, on) => {
    const { runs, toasts, clock } = engine(on, machine, { termProgram: 'Apple_Terminal', moveTakesMs: 10_000 })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT).length
    await ui.press({ key: 'bg claude-104' })
    const first = ui.press({ key: 'bg claude-104' })
    await clock.settle()
    await ui.press({ key: 'bg claude-104' })
    await ui.press({ key: 'bg claude-104' })
    expect(toasts).toContain('That session is already being moved.')
    await clock.advance(10_000)
    await first
    expect(moves()).toBe(1)
    await ui.unmount()
  })

  test('outside Terminal.app nothing is pressed to open', async ($, on) => {
    engine(on, machine, { selfId: 'session-104' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    expect(await ui.find({ key: 'open claude-101' })).toBeUndefined()
    expect(await ui.find({ key: 'bg claude-104' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'WEB CONSOLE')).toBe(true)
    await ui.unmount()
  })

  test("in Terminal.app the pane is painted in its own tab's background, top to bottom", async ($, on) => {
    // this session is WORKER, not the first row listed
    const { runs } = engine(on, machine, { selfId: 'session-104', termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    // asked about this session's own tab, found by its tty
    expect(runs.find(r => r[0] === '/usr/bin/osascript')?.slice(0, 3)).toEqual(['/usr/bin/osascript', '-l', 'JavaScript'])
    expect(runs.find(r => r[0] === '/usr/bin/osascript')?.[5]).toBe('ttys022')
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { backgroundColor: '#dfdbc3', minHeight: 60 } })
    await ui.unmount()
  })

  test('a pane already open is painted once the session starts, before any /sessions', async ($, on) => {
    const { clock } = engine(on, machine, { selfId: 'session-104', termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { backgroundColor: '#dfdbc3' } })
    await ui.unmount()
  })

  test('elsewhere the pane keeps the engine\'s own fill and Terminal is not asked', async ($, on) => {
    const { runs } = engine(on, machine, { selfId: 'session-101' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(runs.some(r => r[0] === '/usr/bin/osascript')).toBe(false)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    const drawn = (await ui.drawn()) as { props: { backgroundColor?: string } }
    expect(drawn.props.backgroundColor).toBeUndefined()
    await ui.unmount()
  })

  test('the window buttons filter by last activity, and the choice is kept', async ($, on) => {
    const { store } = engine(on)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(await shown()).toContain('Execute research')
    await ui.press({ key: 'window-1d' })
    expect(await shown()).not.toContain('Execute research')
    expect(await shown()).toContain('1 idle longer, hidden')
    expect(store.get('windowMs')).toBe(86_400_000)
    await ui.press({ key: 'window-all' })
    expect(await shown()).toContain('Execute research')
    expect(store.get('windowMs')).toBe(0)
    await ui.unmount()
  })

  test('↑ ↓ reorder repositories and sessions; the order is kept and can be reset', async ($, on) => {
    const { store } = engine(on)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(90) })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const above = async (a: string, b: string) => {
      const list = await texts()
      return list.findIndex(t => t.includes(a)) < list.findIndex(t => t.includes(b))
    }
    expect(await above('Acme/web-app', 'Acme/api')).toBe(true)
    expect(await ui.find({ key: 'reset-order' })).toBeUndefined()

    await ui.press({ key: 'up repos github.com/acme/api' })
    expect(await above('Acme/api', 'Acme/web-app')).toBe(true)
    expect((store.get('order') as Record<string, string[]>).repos?.slice(0, 2)).toEqual(['github.com/acme/api', 'github.com/acme/web-app'])

    // within web-app's main checkout: the working WEB CONSOLE goes below Find the report writer
    await ui.press({ key: 'down items:/Users/u/dev/web-app claude-101' })
    expect(await above('Find the report writer', 'WEB CONSOLE')).toBe(true)

    await ui.press({ key: 'reset-order' })
    expect(store.get('order')).toEqual({})
    expect(await above('Acme/web-app', 'Acme/api')).toBe(true)
    expect(await above('WEB CONSOLE', 'Find the report writer')).toBe(true)
    await ui.unmount()
  })

  test('a kept order holds in the next session; /sessions reset clears it', async ($, on) => {
    const { store } = engine(on)
    store.set('order', { repos: ['', 'github.com/acme/api'] })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const first = (await shownOn($, 'terminal', 90)).find(t => ['Other folders', 'Acme/api', 'Acme/web-app'].includes(t))
    expect(first).toBe('Other folders')
    expect((await $.command.run({ ...SESSIONS, args: 'reset' })).text).toBe('Sessions pane opened (all sessions).')
    expect(store.get('order')).toEqual({})
  })

  test('/sessions 2d sets the window and opens the pane; a kept window holds in the next session', async ($, on) => {
    const { store, panes } = engine(on)
    store.set('windowMs', 3_600_000)
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, args: '2d' })).text).toBe('Sessions pane opened (active in the last 2d).')
    expect(store.get('windowMs')).toBe(2 * 86_400_000)
    // with a window given, an open pane stays open
    expect((await $.command.run({ ...SESSIONS, args: '12h' })).text).toBe('Sessions pane opened (active in the last 12h).')
    expect(panes.size).toBe(1)
    expect((await $.command.run({ ...SESSIONS, args: 'soon' })).text).toContain('Usage: /sessions')
    expect(store.get('windowMs')).toBe(12 * 3_600_000)
  })

  test('a window kept from before is the one a new session shows', async ($, on) => {
    const { store } = engine(on)
    store.set('windowMs', 3_600_000)
    await $.session.start(START)
    expect((await $.command.run(SESSIONS)).text).toBe('Sessions pane opened (active in the last 1h).')
    const shown = (await shownOn($, 'terminal', 90)).join('\n')
    expect(shown).not.toContain('API REVIEW')
    expect(shown).toContain('WEB CONSOLE')
  })

  test('a narrow pane drops the folder and terminal columns', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const texts = await shownOn($, 'terminal', 40)
    expect(texts.join('\n')).toContain('WEB CONSOLE')
    expect(texts).not.toContain('ttys004')
  })

  test('/sessions closes a pane in view, and opens one that is not', async ($, on) => {
    const { panes } = engine(on)
    await $.session.start(START)
    // the tab in front, but opened unasked earlier and still waiting for room
    panes.set('live-sessions', { isShown: true, isPlaced: false })
    expect((await $.command.run(SESSIONS)).text).toBe('Sessions pane opened (all sessions).')
    expect(panes.get('live-sessions')).toEqual({ isShown: true, isPlaced: true })
    expect((await $.command.run(SESSIONS)).text).toBe('Sessions pane closed.')
    expect(panes.size).toBe(0)
  })

  test('nothing reopens the pane in a new session', async ($, on) => {
    const { panes, clock } = engine(on)
    await $.session.start(START)
    await clock.advance(60_000)
    expect(panes.size).toBe(0)
  })

  test('the status line refreshes every 30s, the pane in view every 4s, a headless session never', async ($, on) => {
    const { clock, collections } = engine(on)
    await $.session.start(START)
    await clock.settle()
    expect(collections()).toBe(1)
    await clock.advance(28_000)
    expect(collections()).toBe(1)
    await clock.advance(4_000)
    expect(collections()).toBe(2)
    // just collected: the command takes that snapshot rather than collecting again
    await $.command.run(SESSIONS)
    expect(collections()).toBe(2)
    await clock.advance(8_000)
    expect(collections()).toBe(4)
  })

  test("a pane behind another tab is kept at the status line's pace", async ($, on) => {
    const { clock, collections, panes } = engine(on)
    await $.session.start(START)
    await clock.settle()
    panes.set('live-sessions', { isShown: false, isPlaced: true })
    await clock.advance(28_000)
    expect(collections()).toBe(1)
    // and /sessions brings it forward rather than closing it
    expect((await $.command.run(SESSIONS)).text).toBe('Sessions pane opened (all sessions).')
  })

  test('a headless session collects nothing until its pane is opened', async ($, on) => {
    const { clock, collections } = engine(on)
    await $.session.start({ ...START, surface: null, isInteractive: false })
    await clock.advance(60_000)
    expect(collections()).toBe(0)
    await $.command.run(SESSIONS)
    expect(collections()).toBe(1)
  })

  test("another session's fresh snapshot is taken instead of collecting", async ($, on) => {
    const { clock, collections, files, status } = engine(on)
    const theirs = {
      claude: [{ pid: 5, sessionId: 's5', name: 'FROM ANOTHER SESSION', cwd: '/Users/u', status: 'busy', kind: 'interactive', profile: 'claude', tty: 'ttys009', since: NOW - 1_000 }],
      codex: [],
      places: {},
      workspaces: [],
      envs: [''],
      tmux: { panes: {}, clients: {} },
      checkedAt: NOW - 10_000,
      problems: [],
    }
    files.set(SHARED, JSON.stringify({ version: 6, snapshot: theirs }))
    await $.session.start(START)
    await clock.settle()
    expect(collections()).toBe(0)
    expect(status.at(-1)).toBe('Claude 1 (1 working) · Codex 0 (0 working) · /sessions')
    // the pane wants fresher than 10s: it collects
    await $.command.run(SESSIONS)
    expect(collections()).toBe(1)
  })

  test('an unreadable or older-format snapshot is collected over', async ($, on) => {
    const { clock, collections, files } = engine(on)
    files.set(SHARED, '{"version": 1, "snapshot": ')
    await $.session.start(START)
    await clock.settle()
    expect(collections()).toBe(1)
  })

  test('a snapshot that cannot be shared is still shown here', async ($, on) => {
    engine(on, machine, { canWrite: false })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const shown = (await shownOn($, 'terminal', 90)).join('\n')
    expect(shown).toContain('WEB CONSOLE')
    expect(shown).toContain('Find the report writer')
    expect(shown).not.toContain('! ')
  })

  test('a failed git run is shown, and asked again after 30 s rather than on every refresh', async ($, on) => {
    const { runs, clock } = engine(on)
    world.placeFails = true
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const places = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === PLACE_SCRIPT).length
    const ran = places()
    expect((await shownOn($, 'terminal', 90)).join('\n')).toContain('! git: fatal: timed out')
    // the pane in view refreshes every 4 s: no git run until the 30 s are up
    await clock.advance(24_000)
    expect(places()).toBe(ran)
    await clock.advance(12_000)
    expect(places()).toBeGreaterThan(ran)
  })

  test('a failing sqlite3 is reported in the pane, Claude sessions still shown', async ($, on) => {
    engine(on, (argv, env) =>
      argv[0] === 'sqlite3' ? { exitCode: 1, stdout: '', stderr: 'Error: database is locked\n' } : machine(argv, env),
    )
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const shown = (await shownOn($, 'terminal', 90)).join('\n')
    expect(shown).toContain('! codex: Error: database is locked')
    expect(shown).toContain('! codex-work: Error: database is locked')
    expect(shown).toContain('WEB CONSOLE')
  })

  test('a ps that fails says so', async ($, on) => {
    engine(on, (argv, env) =>
      argv[0] === '/bin/ps' ? { exitCode: 1, stdout: '', stderr: 'ps: illegal option -- w\n' } : machine(argv, env),
    )
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect((await shownOn($, 'terminal', 90)).join('\n')).toContain('! ps: ps: illegal option -- w')
  })
})

const WORKSPACES = '/Users/u/Library/Application Support/live-sessions/workspaces.json'
const MARKERS = '-u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_EXECPATH -u CLAUDE_PID -u CLAUDE_EFFORT -u AI_AGENT -u CLAUDE_CONFIG_DIR -u CODEX_HOME'
const practice = { id: 'practice-rbac', name: 'Practice RBAC', env: 'work', dir: '/Users/u/dev/web-app', createdAt: NOW }

describe('workspaces', () => {
  test('names, arguments, finding one', async () => {
    expect(slugOf('Practice RBAC!')).toBe('practice-rbac')
    expect(slugOf('Practice RBAC', ['practice-rbac', 'practice-rbac-2'])).toBe('practice-rbac-3')
    expect(slugOf('***')).toBe('workspace')
    expect(words(`new "~/my dir" work Practice 'R B'`)).toEqual(['new', '~/my dir', 'work', 'Practice', 'R B'])
    expect(parseWorkspaceArgs('new ~/dev/web-app work Practice RBAC', ['work'], HOME)).toEqual({ action: 'new', dir: '/Users/u/dev/web-app', env: 'work', name: 'Practice RBAC' })
    expect(parseWorkspaceArgs('new /x default Name', ['work'], HOME)).toEqual({ action: 'new', dir: '/x', env: '', name: 'Name' })
    // the environment is required: a misspelt one is an error, never the default account
    expect(parseWorkspaceArgs('new /x wrok Name', ['work'], HOME)).toEqual({ action: 'help', error: 'there is no environment "wrok"' })
    expect(parseWorkspaceArgs('new /x Name', ['work'], HOME).action).toBe('help')
    expect(parseWorkspaceArgs('', [], HOME)).toEqual({ action: 'list' })
    expect(parseWorkspaceArgs('open Practice RBAC', [], HOME)).toEqual({ action: 'open', ref: 'Practice RBAC' })
    for (const bad of ['new', 'new /x', 'new /x work', 'rm', 'launch x']) expect(parseWorkspaceArgs(bad, ['work'], HOME).action).toBe('help')
    expect(parseWorkspaceArgs('new relative/dir work Name', ['work'], HOME)).toEqual({ action: 'help', error: 'the folder must be absolute or start with ~' })
    expect(findWorkspace([practice], 'practice rbac')?.id).toBe('practice-rbac')
    expect(findWorkspace([practice], 'practice-rbac')?.id).toBe('practice-rbac')
    expect(workspacesFrom({ workspaces: [practice, { ...practice, id: 'BAD ID' }, { name: 'x' }] })).toEqual([practice])
  })

  test('the tmux command: a claude and a codex window in its folder, under its environment, then attach', async () => {
    expect(agentStart('claude', '', HOME)).toBe(`env ${MARKERS} claude`)
    expect(agentStart('claude', 'work', HOME)).toBe(`env ${MARKERS} CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude`)
    expect(agentStart('codex', 'work', HOME)).toBe(`env ${MARKERS} CODEX_HOME='/Users/u/.codex-work' codex`)
    expect(openCommand(practice, HOME)).toBe([
      "tmux has-session -t '=ws-practice-rbac' 2>/dev/null ||",
      `tmux new-session -d -s 'ws-practice-rbac' -c '/Users/u/dev/web-app' -n claude 'env ${MARKERS} CLAUDE_CONFIG_DIR='\\''/Users/u/.claude-work'\\'' claude; exec "$SHELL" -l'`,
      `\\; new-window -t '=ws-practice-rbac:' -c '/Users/u/dev/web-app' -n codex 'env ${MARKERS} CODEX_HOME='\\''/Users/u/.codex-work'\\'' codex; exec "$SHELL" -l'`,
      `\\; set-option -t 'ws-practice-rbac' @live-sessions-workspace '${NOW}';`,
      "tmux attach -t '=ws-practice-rbac'",
    ].join(' '))
    expect(openCommand({ ...practice, env: '', dir: "/Users/u/it's" }, HOME, { attach: false })).toContain(`-c '/Users/u/it'\\''s'`)
    expect(openCommand(practice, HOME, { attach: false })).not.toContain('attach')
    // tmux would expand #{...} in -c: a literal # goes in doubled
    expect(openCommand({ ...practice, dir: '/x/C#{session_name}' }, HOME)).toContain(`-c '/x/C##{session_name}'`)
  })

  test('tmux panes and clients; the environments on disk', async () => {
    expect(parsePanes('ws-a\tclaude\t/dev/ttys050\nws-a\tcodex\t/dev/ttys051\nauth\tzsh\t/dev/ttys052\n')).toEqual({
      ttys050: { session: 'ws-a', window: 'claude' }, ttys051: { session: 'ws-a', window: 'codex' }, ttys052: { session: 'auth', window: 'zsh' },
    })
    expect(parseClients('ws-a\t/dev/ttys060\n')).toEqual({ 'ws-a': ['ttys060'] })
    // an environment is offered only with both a Claude and a Codex profile
    const profiles = new Set(['.claude', '.claude-work', '.codex', '.codex-work', '.codex-only'])
    expect(envsFrom(['.claude', '.claude-profiles', '.claude-work', '.codex', '.codex-work', '.codex-only', '.codexbar'], n => profiles.has(n))).toEqual(['', 'work'])
  })

  test('sessions in a workspace tmux session group under it; clicking one goes to its window', async () => {
    const base = snapshotOf()
    // WEB CONSOLE (ttys004) and the Codex terminal on ttys045 run in the workspace's tmux panes
    const snap = {
      ...base,
      workspaces: [practice],
      tmux: {
        panes: { ttys004: { session: 'ws-practice-rbac', window: 'claude' }, ttys045: { session: 'ws-practice-rbac', window: 'codex' }, ttys022: { session: 'other', window: 'zsh' } },
        clients: { 'ws-practice-rbac': ['ttys070'] },
      },
    }
    const view = viewOf(snap, { home: HOME, now: NOW, windowMs: 0, selfId: '' })
    expect(view.workspaces.map(w => [w.name, w.env, w.dir, w.isRunning, w.isAttached, w.items.map(i => `${i.tool}:${i.title}`)])).toEqual([
      ['Practice RBAC', 'work', '~/dev/web-app', true, true, ['claude:WEB CONSOLE', 'codex:Find the report writer']],
    ])
    const inRepos = view.repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => i.title)))
    expect(inRepos).not.toContain('WEB CONSOLE')
    expect(view.workspaces[0]!.items.map(i => i.target)).toEqual([
      { workspace: 'ws-practice-rbac', window: 'claude' }, { workspace: 'ws-practice-rbac', window: 'codex' },
    ])
    // in another tmux session's pane, a session stays listed by its repository, but is not offered the move
    // to the background: tmux already keeps it running
    const worker = view.repos.flatMap(r => r.trees.flatMap(t => t.items)).find(i => i.title === 'WORKER')
    expect(worker).toBeDefined()
    expect(worker?.move).toBeUndefined()
    // the person's order applies to a workspace's agents too
    const ordered = viewOf(snap, { home: HOME, now: NOW, windowMs: 0, selfId: '', order: { 'items:ws:practice-rbac': ['codex-' + RESUMED_A] } })
    expect(ordered.workspaces[0]!.items.map(i => i.tool)).toEqual(['codex', 'claude'])
    // a workspace with nothing running is still listed
    const stopped = viewOf({ ...base, workspaces: [practice] }, { home: HOME, now: NOW, windowMs: 0, selfId: '' })
    expect(stopped.workspaces.map(w => [w.isRunning, w.items.length])).toEqual([[false, 0]])
  })

  test('/workspace new saves it and opens Claude and Codex in its tmux session', async ($, on) => {
    const { runs, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    const text = (await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Practice RBAC' })).text
    expect(text).toMatch(/^Created Practice RBAC \(work, \/Users\/u\/dev\/web-app\).*Opened ws-practice-rbac in a new Terminal window\.$/)
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces).toEqual([{ ...practice, createdAt: expect.any(Number) }])
    const opened = runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT).map(r => r[5])
    expect(opened).toEqual([openCommand({ ...practice, createdAt: JSON.parse(files.get(WORKSPACES)!).workspaces[0].createdAt }, HOME)])
    // listed in the pane, stopped until tmux reports its session
    await $.command.run(SESSIONS)
    const shown = (await shownOn($, 'terminal', 110)).join('\n')
    expect(shown).toContain('Practice RBAC')
    expect(shown).toContain('stopped')
  })

  test('/workspace open focuses the terminal already attached, else opens one; rm forgets it', async ($, on) => {
    const { runs, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.tmuxPanes = 'ws-practice-rbac\tclaude\t/dev/ttys004\nws-practice-rbac\tcodex\t/dev/ttys045\n'
    world.tmuxClients = 'ws-practice-rbac\t/dev/ttys001\n'
    world.tmuxOwner = String(NOW)
    await $.session.start(START)
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice rbac' })
    const osa = () => runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] !== BACKGROUND_SCRIPT).map(r => [r[4] === FOCUS_SCRIPT ? 'focus' : 'open', r[5]])
    expect(osa()).toEqual([['focus', 'ttys001']])
    // the pane groups its agents under it; pressing one selects its window and brings the terminal up
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(shown).toContain('Practice RBAC')
    expect(shown).toContain('open')
    await ui.press({ key: 'open codex-' + RESUMED_A })
    expect(runs.find(r => r[0] === 'tmux' && r[1] === 'select-window')).toEqual(['tmux', 'select-window', '-t', '=ws-practice-rbac:codex'])
    await ui.unmount()
    // with no terminal attached it opens one
    world.tmuxClients = ''
    await $.command.run(SESSIONS)
    await $.command.run(SESSIONS)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe('Opened ws-practice-rbac in a new Terminal window.')
    expect(osa().at(-1)).toEqual(['open', openCommand(practice, HOME)])
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'rm practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces).toEqual([])
  })

  test('/workspace refuses what it cannot make', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    const run = async (args: string) => (await $.command.run({ ...SESSIONS, command: 'workspace', args })).text
    expect(await run('new ~/nowhere work Name')).toBe('Not done: /Users/u/nowhere is not a folder.')
    expect(await run('new ~/dev/web-app')).toMatch(/^Not done: new needs a folder, an environment and a name\. Usage: \/workspace new <folder> <default \| work> <name>/)
    expect(await run('new ~/dev/web-app wrok Name')).toMatch(/^Not done: there is no environment "wrok"\./)
    expect(await run('open nothing')).toBe('No workspace named "nothing".')
    expect(files.has(WORKSPACES)).toBe(false)
    expect(await run('')).toMatch(/^No workspaces yet/)
  })

  test('a new workspace never takes over a tmux session already running under its name', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // an old ws-practice-rbac still runs (its workspace was removed)
    world.tmuxPanes = 'ws-practice-rbac\tclaude\t/dev/ttys090\n'
    await $.session.start(START)
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Practice RBAC' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: { id: string }) => w.id)).toEqual(['practice-rbac-2'])
  })

  test('open refuses a session not started for it, a folder that is gone, and says when Terminal would not open', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice, { ...practice, id: 'gone', name: 'Gone', dir: '/Users/u/dev/gone' }] }))
    world.tmuxPanes = 'ws-practice-rbac\tzsh\t/dev/ttys090\n'
    world.tmuxOwner = '12345'
    await $.session.start(START)
    const run = async (args: string) => (await $.command.run({ ...SESSIONS, command: 'workspace', args })).text
    expect(await run('open practice-rbac')).toMatch(/^Not opened: tmux session ws-practice-rbac was not started for this workspace/)
    expect(await run('open gone')).toBe('Not opened: its folder /Users/u/dev/gone is not there any more.')
    world.tmuxPanes = ''
    world.openFails = true
    expect(await run('open practice-rbac')).toMatch(/^Not opened \(execution error: Not authorized.*\)\. Run: tmux has-session/)
    expect(runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT)).toHaveLength(1)
  })

  test('inside tmux it creates the session if need be and switches this terminal to it', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'tmux' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe('Switched to ws-practice-rbac.')
    expect(runs.find(r => r[0] === '/bin/sh' && r[2]?.startsWith('tmux has-session'))?.[2]).toBe(openCommand(practice, HOME, { attach: false }))
    expect(runs.find(r => r[0] === 'tmux' && r[1] === 'switch-client')).toEqual(['tmux', 'switch-client', '-t', '=ws-practice-rbac'])
    expect(runs.some(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT)).toBe(false)
  })

  test('from another terminal app, open says the command to run there and opens nothing', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'iTerm.app' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe(`Open it in a terminal: ${openCommand(practice, HOME)}`)
    expect(runs.some(r => r[0] === '/usr/bin/osascript' && (r[4] === OPEN_SCRIPT || r[4] === FOCUS_SCRIPT))).toBe(false)
  })

  test('a workspaces file that cannot be read is shown as a problem and never overwritten', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, '{"version": 1, "workspaces": [ {"id": "kept"}, ]')
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Other' })).text).toMatch(/^Not done: its list cannot be read/)
    expect(files.get(WORKSPACES)).toBe('{"version": 1, "workspaces": [ {"id": "kept"}, ]')
    // nor does removing one, even when the list went bad after it was read
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.spoilsAfterRead = WORKSPACES
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'rm practice-rbac' })).text).toMatch(/^Not done: its list cannot be read/)
    expect(files.get(WORKSPACES)).toBe('{ broken')
    await $.command.run(SESSIONS)
    expect((await shownOn($, 'terminal', 110)).join('\n')).toContain('! workspaces: its list cannot be read')
  })

  test('the header counts working agents in workspaces too', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    // both working sessions (WEB CONSOLE, Find the report writer) run in the workspace
    world.tmuxPanes = 'ws-practice-rbac\tclaude\t/dev/ttys004\nws-practice-rbac\tcodex\t/dev/ttys045\n'
    world.tmuxOwner = String(NOW)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect((await shownOn($, 'terminal', 110)).join('\n')).toContain(' · 2 working')
  })
})
