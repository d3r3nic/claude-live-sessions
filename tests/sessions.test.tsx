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
import type { ClaudeSession, CodexSession, Snapshot, Workspace } from '../types'
import { afterOwner, afterStep, claudeKeep, compactStep, COMPACT_AT, cueOf, cutBytes, eventOf, EVENT_SCRIPT, parseTurns, passFailure, RELAY_CAP, RELAY_SCRIPT, relaySteps, TURN_MAX_AGE_MS, TURN_SCRIPT } from '../hooks/relay'
import type { Side } from '../hooks/relay'
import { bringable, codexDir, codexFlags, CODEX_MODE_SCRIPT, CODEX_TASK_SCRIPT, codexTaskState, envOfProfile, ROLLOUT_SCRIPT, seenThreads, STOP_SCRIPT, threadFrom, toggled, withThreads } from '../hooks/bring'
import {
  absoluteDir,
  agentStart,
  assigned,
  checkoutResult,
  CHECKOUT_SCRIPT,
  openScriptPath,
  promptPath,
  PROJECTS_SCRIPT,
  peerPrompt,
  rankProjects,
  sessionSetup,
  defaultPlacement,
  isOnScreen,
  hideBinding,
  hidePath,
  placementFrom,
  placementPath,
  SCREEN_SCRIPT,
  HIDE_LABEL,
  HIDE_SCRIPT,
  KEEPS_LABEL,
  mayBindHide,
  setupPrompt,
  joinPrompt,
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
  /** A file that is there but cannot be read (too large, no permission). */
  unreadable: '',
  /** What TURN_SCRIPT prints for a transcript whose path holds the key: its last turn's line. */
  turns: {} as Record<string, string>,
  /** The relay's steps already taken (its ledger), and what each tmux pane runs. */
  ledger: new Set<string>(),
  paneCommands: {} as Record<string, string>,
  /** Panes scrolled back (tmux copy mode). */
  inMode: new Set<string>(),
  /** tmux sessions a window opened by the mod made. */
  started: new Map<string, string>(),
  /** The engine's files, as the mod wrote them (the fake tmux reads what a command line the mod wrote makes). */
  files: new Map<string, string>(),
  /** What `tmux list-keys -T root MouseDown1Status` prints: tmux's own binding, or one of the person's. */
  statusClick: 'bind-key -T root MouseDown1Status switch-client -t =',
  /** What /bin/rm was given. */
  removed: [] as string[],
  /** Paths that are not there, though the fixtures have them. */
  gone: new Set<string>(),
  /** What STOP_SCRIPT answers for a terminal (default `stopped`), and what it was run for. */
  stop: {} as Record<string, string>,
  stopped: [] as string[],
  /** The relay's event log, as written. */
  events: [] as Record<string, unknown>[],
  /** This session's id, when it changed since the engine started (a /clear, a /resume). */
  sessionId: undefined as string | undefined,
  /** What lsof answers now, when not the fixture's. */
  lsof: undefined as string | undefined,
  /** Threads the Codex databases no longer have, though the fixtures do. */
  hiddenThreads: new Set<string>(),
  /** Processes that have exited (a terminal STOP_SCRIPT closed). */
  exited: new Set<number>(),
  /** What CODEX_MODE_SCRIPT prints for a rollout. */
  codexMode: 'workspace-write\ton-request\t/Users/u/dev/web-app\n',
  /** What CODEX_TASK_SCRIPT prints (the last task event), or a function answering each run. */
  codexTask: '"type":"task_complete"\n',
  codexTaskAnswer: undefined as (() => string) | undefined,
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
  world.unreadable = ''
  world.turns = {}
  world.ledger.clear()
  world.paneCommands = {}
  world.removed = []
  world.started.clear()
  world.statusClick = 'bind-key -T root MouseDown1Status switch-client -t ='
  world.inMode.clear()
  world.gone.clear()
  world.stop = {}
  world.stopped = []
  world.exited.clear()
  world.hiddenThreads.clear()
  world.lsof = undefined
  world.codexMode = 'workspace-write\ton-request\t/Users/u/dev/web-app\n'
  world.codexTask = '"type":"task_complete"\n'
  world.codexTaskAnswer = undefined
  world.sessionId = undefined
  world.events = []
}
const changed = (pid: number, line: string) => {
  const stat = world.stat.get(pid)
  const args = world.args.get(pid)
  const withStat = stat === undefined ? line : line.replace(/^(\s*\d+\s+\S+\s+)\S+/, `$1${stat}`)
  return args === undefined ? withStat : withStat.replace(/(\d{4}\s+).*$/, `$1${args}`)
}

/** Shows a row's actions, as its [ more ] does: `item:<key>`, `tree:<key>`, `repo:<key>`, `ws:<id>`. */
const reveal = (ui: { press: (target: { key: string }) => Promise<unknown> }, id: string) => ui.press({ key: `more ${id}` })

/** The fixture machine: each command line the mod runs, answered as macOS would. */
function machine(argv: readonly string[], env: unknown): Run {
  const pidsAfter = (flag: string) => (argv[argv.indexOf(flag) + 1] ?? '').split(',').map(Number)
  switch (argv[0]) {
    case '/usr/bin/pgrep':
      return ok(PGREP.split('\n').filter(pid => !world.exited.has(Number(pid))).join('\n'))
    case '/bin/ps': {
      if (argv.includes('ppid=')) return ok(`${9000 + Number(argv[argv.length - 1])}\n`)
      if (argv.includes('stat=,comm=')) return ok(`${world.parent}\n`)
      const pids = pidsAfter('-p')
      const lines = pids.flatMap(pid => (PS_LINES[pid] === undefined || world.exited.has(pid) ? [] : [changed(pid, PS_LINES[pid]!)]))
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
      if (argv[2]?.startsWith('tmux has-session')) {
        // the command line makes the session, marked with its owner
        const made = /new-session -d -s '([^']+)'[\s\S]*@live-sessions-workspace '(\d+)'/.exec(argv[2])
        if (made !== null && !world.tmuxPanes.includes(`${made[1]}\t`)) world.started.set(made[1]!, made[2]!)
        return ok('')
      }
      if (argv[2] === MOVE_SCRIPT) return world.move === 0 ? ok('typed') : { exitCode: Number(world.move), stdout: '', stderr: '' }
      if (argv[2] === MODE_SCRIPT) return ok(world.mode)
      if (argv[2] === EVENT_SCRIPT) {
        world.events.push(JSON.parse(args[1] ?? '{}'))
        return ok('')
      }
      if (argv[2] === STOP_SCRIPT) {
        world.stopped.push(`${args[0]} ${args[1]} ${args[2]}`)
        const answer = world.stop[args[0] ?? ''] ?? 'stopped'
        // closed: the processes in front of that terminal have exited
        if (answer === 'stopped') for (const [pid, line] of Object.entries(PS_LINES)) if (line.includes(` ${args[0]} `)) world.exited.add(Number(pid))
        return ok(`${answer}\n`)
      }
      if (argv[2] === ROLLOUT_SCRIPT) return ok(args[0] === '/Users/u/.codex' && (args[1] === RESUMED_A || args[1] === HELD) ? `/rollouts/${args[1]}.jsonl\n` : '')
      if (argv[2] === CODEX_TASK_SCRIPT) return ok(world.codexTaskAnswer?.() ?? world.codexTask)
      if (argv[2] === CODEX_MODE_SCRIPT) return ok(world.codexMode)
      if (argv[2] === CHECKOUT_SCRIPT) {
        // web-app and api are repositories; anything else is not
        const main = ['/Users/u/dev/web-app', '/Users/u/dev/api'].find(m => args[0] === m || args[0]?.startsWith(`${m}/`))
        return main === undefined ? { exitCode: 11, stdout: 'error: not-a-repo\n', stderr: '' } : ok(`ok ${main}\n`)
      }
      if (argv[2] === PROJECTS_SCRIPT) return ok('/Users/u/dev/web-app\n/Users/u/dev/api\n/Users/u/dev/build\n/Users/u/dev/résumé\n')
      if (argv[2] === TURN_SCRIPT) {
        return ok(args.map(f => `==> ${f}\n${Object.entries(world.turns).filter(([k]) => f.includes(k)).map(([, line]) => `${line}\n`).join('')}`).join(''))
      }
      if (argv[2] === RELAY_SCRIPT) {
        // the ledger takes each key once; a pass types only into a pane running an allowed command
        const [kind, , key = '', pane = '', allow = ''] = args
        if (world.ledger.has(key)) return ok('taken\n')
        // a cue held at the cap that was passed before is taken already (host-check holds the real script to it)
        if (key.startsWith('cap-') && world.ledger.has(`pass-${key.slice(4)}`)) return ok('taken\n')
        // scrolled back: the step is left untaken
        if (kind === 'pass' && world.inMode.has(pane)) return ok('in-mode\n')
        world.ledger.add(key)
        if (kind === 'tell') return ok('told\n')
        const cmd = world.paneCommands[pane]
        if (cmd === undefined) return ok('gone\n')
        return ok(allow.split('|').includes(cmd) ? 'passed\n' : `not-agent ${cmd}\n`)
      }
      if (argv[2] === RECENT_SCRIPT) return ok(args.map(f => `==> ${f}\n${(RECENT[f] ?? []).map(l => `${l}\n`).join('')}`).join(''))
      if (argv[2] !== ENV_SCRIPT) return { exitCode: 2, stdout: '', stderr: 'unexpected script' }
      const pids = (args[0] ?? '').split(',').map(Number)
      return ok(`${pids.flatMap(pid => (ENV_LINES[pid] === undefined ? [] : [ENV_LINES[pid]!])).join('\n')}\n`)
    }
    case '/bin/rm':
      world.removed.push(...argv.slice(2))
      return ok('')
    case 'tmux':
      if (argv[1] === 'list-panes') return world.tmuxPanes === '' ? { exitCode: 1, stdout: '', stderr: 'no server running\n' } : ok(world.tmuxPanes)
      if (argv[1] === 'list-clients') return ok(world.tmuxClients)
      if (argv[1] === 'list-windows') return ok('@1\n@2\n')
      if (argv[1] === 'select-window' || argv[1] === 'switch-client') return ok('')
      if (argv[1] === 'has-session') {
        const name = (argv[3] ?? '').slice(1)
        return world.tmuxPanes.includes(`${name}\t`) || world.started.has(name) ? ok('') : { exitCode: 1, stdout: '', stderr: '' }
      }
      if (argv[1] === 'list-keys') return ok(`${world.statusClick}\n`)
      if (argv[1] === 'bind-key' || argv[1] === 'set-option' || argv[1] === 'set-window-option') return ok('')
      if (argv[1] === 'show-options') return ok(`${world.started.get(argv[3] ?? '') ?? world.tmuxOwner}\n`)
      return { exitCode: 1, stdout: '', stderr: `unexpected tmux ${argv.join(' ')}` }
    case '/usr/sbin/lsof':
      return { exitCode: 1, stdout: world.lsof ?? LSOF, stderr: '' }
    case '/usr/bin/osascript':
      if (argv[4] === FOCUS_SCRIPT) return ok(TABS.has(argv[5] ?? '') ? 'shown\n' : '\n')
      if (argv[4] === OPEN_SCRIPT) {
        if (world.openFails) return { exitCode: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)\n' }
        // the window it opens makes the workspace's tmux session
        const id = /\/open\/([a-z0-9-]+)\.sh'$/.exec(argv[5] ?? '')?.[1]
        // the window runs the open file's command line: the session it makes, with its owner mark
        const made = /new-session -d -s '([^']+)'[\s\S]*@live-sessions-workspace '(\d+)'/.exec(world.files.get(/^\/bin\/sh '(.*)'$/.exec(argv[5] ?? '')?.[1] ?? '') ?? '')
        if (id !== undefined && made !== null) world.started.set(made[1]!, made[2]!)
        return ok('opened\n')
      }
      if (argv[4] === SCREEN_SCRIPT) return ok(JSON.stringify({ screens: [{ x: 0, y: 30, width: 2560, height: 1410 }, { x: 2560, y: 0, width: 1920, height: 1080 }], fontSize: argv[5] === 'ttys022' ? 12 : 0 }))
      if (argv[4] === HAS_TAB_SCRIPT) return ok(TABS.has(argv[5] ?? '') && !world.noTab.has(argv[5] ?? '') ? 'yes\n' : '\n')
      if (argv[4] !== BACKGROUND_SCRIPT) return { exitCode: 1, stdout: '', stderr: 'unexpected script' }
      // Terminal.app's tab on ttys022 has the Novel profile's background; the others another
      return ok(argv[5] === 'ttys022' ? 'dfdbc3\n' : argv[5]?.startsWith('ttys') ? '1e1e1e\n' : '\n')
    case 'sqlite3': {
      const db = dbOf(argv)
      const home = db.slice(0, db.lastIndexOf('/'))
      return ok(JSON.stringify((THREADS[home] ?? []).filter(t => !world.hiddenThreads.has((t as { id: string }).id))))
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
    checkoutTakesMs = 0,
  }: { canWrite?: boolean; selfId?: string; termProgram?: string; moveTakesMs?: number; checkoutTakesMs?: number } = {},
) {
  resetWorld()
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: world.sessionId ?? selfId }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  const panes = new Map<string, { isShown: boolean; isPlaced: boolean }>()
  const focusAsked: string[] = []
  on('ui.open', async ($, e) => {
    if (e.focus === true) focusAsked.push(e.id)
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
    if (e.argv[2] === CHECKOUT_SCRIPT && checkoutTakesMs > 0) await clock.sleep(checkoutTakesMs)
    if (isMove && world.move === 'reject') return { deny: 'timed out after 40000 ms' }
    return { value: { ...run(e.argv, e.init?.env), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const files = new Map<string, string>(Object.entries(REGISTRY))
  world.files = files
  on('fs.list', async ($, e) => {
    const entries = LISTINGS[e.path]
    return entries === undefined ? { deny: `ENOENT ${e.path}` } : { value: entries }
  })
  on('fs.exists', async ($, e) => {
    if (world.gone.has(e.path)) return { value: false }
    const at = e.path.lastIndexOf('/')
    const isListed = LISTINGS[e.path.slice(0, at)]?.some(entry => entry.name === e.path.slice(at + 1)) ?? false
    return { value: LISTINGS[e.path] !== undefined || isListed || files.has(e.path) }
  })
  on('fs.stat', async ($, e) => {
    const isDir = LISTINGS[e.path] !== undefined || GIT[e.path] !== undefined
    return isDir ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', async ($, e) => {
    if (e.path === world.unreadable) return { deny: 'EFBIG: file too large' }
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
  return { clock, runs, panes, status, toasts, files, store, collections, focusAsked }
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
    expect(JSON.parse(shared).version).toBe(7)
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

  test('To background pressed twice moves the session: checked again, hung up, resumed and attached in its own tab', async ($, on) => {
    const { runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT)
    // a working session's actions offer no move
    await reveal(ui, 'item:claude-101')
    expect(await ui.find({ key: 'open-bar claude-101' })).toBeDefined()
    expect(await ui.find({ key: 'bg claude-101' })).toBeUndefined()
    await reveal(ui, 'item:claude-104')
    await ui.press({ key: 'bg claude-104' })
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('Press again to move it')
    expect(moves()).toEqual([])
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([[
      '/bin/sh', '-c', MOVE_SCRIPT, 'sh', '104', 'ttys022',
      "cd '/Users/u' && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude --bg --resume session-104 --dangerously-skip-permissions && CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude attach session-",
      TYPE_SCRIPT,
    ]])
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('To background')
    await ui.unmount()
  })

  test('a first press goes stale; a session that turned busy meanwhile is not moved', async ($, on) => {
    const { runs, clock, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const moves = () => runs.filter(r => r[0] === '/bin/sh' && r[2] === MOVE_SCRIPT)
    await reveal(ui, 'item:claude-104')
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
    await reveal(ui, 'item:claude-104')
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
    await reveal(ui, 'item:claude-104')
    expect(await ui.find({ key: 'assign claude-104' })).toBeDefined()
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
    await reveal(ui, 'item:claude-101')
    await ui.press({ key: 'bg claude-101' })
    await reveal(ui, 'item:claude-104')
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual([])
    expect((await ui.find({ key: 'bg claude-104' }))?.props.label).toBe('Press again to move it')
    await reveal(ui, 'item:claude-101')
    expect((await ui.find({ key: 'bg claude-101' }))?.props.label).toBe('To background')
    await reveal(ui, 'item:claude-104')
    await ui.press({ key: 'bg claude-104' })
    expect(moves()).toEqual(['104'])
    await ui.unmount()
  })

  test('when the move fails after the hang-up, the toast says how to resume it', async ($, on) => {
    const { toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'item:claude-104')
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
    await reveal(ui, 'item:claude-104')
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
    await reveal(ui, 'item:claude-104')
    expect(await ui.find({ key: 'open-bar claude-104' })).toBeUndefined()
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

  test('Move up and Move down reorder repositories and sessions; the order is kept and can be reset', async ($, on) => {
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

    await reveal(ui, 'repo:github.com/acme/api')
    await ui.press({ key: 'up repos github.com/acme/api' })
    expect(await above('Acme/api', 'Acme/web-app')).toBe(true)
    expect((store.get('order') as Record<string, string[]>).repos?.slice(0, 2)).toEqual(['github.com/acme/api', 'github.com/acme/web-app'])

    // within web-app's main checkout: the working WEB CONSOLE goes below Find the report writer
    await reveal(ui, 'item:claude-101')
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
    files.set(SHARED, JSON.stringify({ version: 7, snapshot: theirs }))
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
    expect(parseWorkspaceArgs('new ~/dev/web-app work Practice RBAC', ['work'], HOME)).toEqual({ action: 'new', dir: '/Users/u/dev/web-app', env: 'work', name: 'Practice RBAC', purpose: '' })
    expect(parseWorkspaceArgs('new /x default Name', ['work'], HOME)).toEqual({ action: 'new', dir: '/x', env: '', name: 'Name', purpose: '' })
    // every word after --for is the purpose, -- words and all
    expect(parseWorkspaceArgs('new /x work Practice RBAC --for roles and permissions --for admins', ['work'], HOME))
      .toEqual({ action: 'new', dir: '/x', env: 'work', name: 'Practice RBAC', purpose: 'roles and permissions --for admins' })
    expect(parseWorkspaceArgs('new /x work Name --for', ['work'], HOME)).toEqual({ action: 'help', error: '--for needs what the workspace is for' })
    expect(parseWorkspaceArgs('new /x work Name --branch feat/a', ['work'], HOME)).toEqual({ action: 'help', error: '"--branch" is not an option /workspace takes' })
    // a dash word is part of a name
    expect(parseWorkspaceArgs('new /x work RBAC - phase -2', ['work'], HOME)).toMatchObject({ name: 'RBAC - phase -2', purpose: '' })
    // a folder is absolute or starts with ~/; ~name (another person's home) is neither
    for (const folder of ['dev/web-app', '~u/web-app', './web-app']) {
      expect(parseWorkspaceArgs(`new ${folder} work Name`, ['work'], HOME)).toEqual({ action: 'help', error: 'the folder must be absolute or start with ~/' })
    }
    expect([absoluteDir('~', HOME), absoluteDir(' ~/dev/x/ ', HOME), absoluteDir('/x//', HOME), absoluteDir('/', HOME)]).toEqual([HOME, '/Users/u/dev/x', '/x', '/'])
    expect([absoluteDir('~foo', HOME), absoluteDir('dev/x', HOME), absoluteDir('', HOME)]).toEqual([undefined, undefined, undefined])
    // the environment is required: a misspelt one is an error, never the default account
    expect(parseWorkspaceArgs('new /x wrok Name', ['work'], HOME)).toEqual({ action: 'help', error: 'there is no environment "wrok"' })
    expect(parseWorkspaceArgs('new /x Name', ['work'], HOME).action).toBe('help')
    expect(parseWorkspaceArgs('', [], HOME)).toEqual({ action: 'list' })
    expect(parseWorkspaceArgs('open Practice RBAC', [], HOME)).toEqual({ action: 'open', ref: 'Practice RBAC' })
    for (const bad of ['new', 'new /x', 'new /x work', 'rm', 'launch x']) expect(parseWorkspaceArgs(bad, ['work'], HOME).action).toBe('help')
    expect(parseWorkspaceArgs('new relative/dir work Name', ['work'], HOME)).toEqual({ action: 'help', error: 'the folder must be absolute or start with ~/' })
    expect(findWorkspace([practice], 'practice rbac')?.id).toBe('practice-rbac')
    expect(findWorkspace([practice], 'practice-rbac')?.id).toBe('practice-rbac')
    expect(workspacesFrom({ workspaces: [practice, { ...practice, id: 'BAD ID' }, { name: 'x' }] })).toEqual([practice])
  })

  test('the tmux command: a claude and a codex window in its folder, under its environment, then attach', async () => {
    expect(agentStart('claude', '', HOME)).toBe(`env ${MARKERS} claude`)
    expect(agentStart('claude', 'work', HOME)).toBe(`env ${MARKERS} CLAUDE_CONFIG_DIR='/Users/u/.claude-work' claude`)
    expect(agentStart('codex', 'work', HOME)).toBe(`env ${MARKERS} CODEX_HOME='/Users/u/.codex-work' codex`)
    // one window, Claude on the left and Codex on the right, each pane marked with its agent
    const cmd = openCommand(practice, HOME)
    expect(cmd.startsWith("tmux has-session -t '=ws-practice-rbac' 2>/dev/null || tmux new-session -d -s 'ws-practice-rbac' -c '/Users/u/dev/web-app' -n peers ")).toBe(true)
    expect(cmd.indexOf('\\; set-option -p @live-sessions-agent claude \\; split-window -h -c \'/Users/u/dev/web-app\' ')).toBeGreaterThan(0)
    expect(cmd.indexOf('\\; set-option -p @live-sessions-agent codex \\; set-option -t \'ws-practice-rbac\' @live-sessions-workspace')).toBeGreaterThan(cmd.indexOf('split-window'))
    expect(cmd.endsWith("; tmux attach -t '=ws-practice-rbac'")).toBe(true)
    // made with the mouse on in its session alone, and each side's border naming its agent
    expect(cmd).toContain("\\; set-option '-t' 'ws-practice-rbac' 'mouse' 'on'")
    expect(cmd).toContain("\\; set-window-option '-t' 'ws-practice-rbac:peers' 'pane-border-status' 'top'")
    expect(cmd).not.toContain('-g')
    // its agents may work in the worktrees folder beside the checkout; Claude takes the first prompt once
    const withCheckout = openCommand({ ...practice, checkout: '/Users/u/dev/web-app' }, HOME)
    expect(withCheckout.match(/--add-dir/g)).toHaveLength(2)
    expect(withCheckout).toContain('/Users/u/dev/web-app-worktrees')
    expect(withCheckout).toContain('Application Support/live-sessions/prompts/practice-rbac-claude.txt')
    expect(withCheckout).toContain('Application Support/live-sessions/prompts/practice-rbac-codex.txt')
    expect(cmd).not.toContain('--add-dir')
    // Codex starts without its update offer, whose default answer on Enter installs a new version
    expect(cmd).toContain('codex -c check_for_update_on_startup=false --sandbox workspace-write')
    expect(openCommand({ ...practice, env: '', dir: "/Users/u/it's" }, HOME, { attach: false })).toContain(`-c '/Users/u/it'\\''s'`)
    expect(openCommand(practice, HOME, { attach: false })).not.toContain('attach')
    // tmux would expand #{...} in -c: a literal # goes in doubled
    expect(openCommand({ ...practice, dir: '/x/C#{session_name}' }, HOME)).toContain(`-c '/x/C##{session_name}'`)
  })

  test('tmux panes and clients; the environments on disk', async () => {
    // a pane's mark names its agent; a workspace made before the marks had a window per agent
    expect(parsePanes('ws-a\tpeers\t/dev/ttys050\t%1\tclaude\nws-a\tpeers\t/dev/ttys051\t%2\tcodex\nws-b\tcodex\t/dev/ttys053\t%4\t\nauth\tzsh\t/dev/ttys052\t%3\t\n')).toEqual({
      ttys050: { session: 'ws-a', window: 'claude', pane: '%1' }, ttys051: { session: 'ws-a', window: 'codex', pane: '%2' },
      ttys053: { session: 'ws-b', window: 'codex', pane: '%4' }, ttys052: { session: 'auth', window: 'zsh', pane: '%3' },
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
    // its repository's main checkout is kept: the agents may work in the worktrees folder beside it
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces).toEqual([{ ...practice, checkout: '/Users/u/dev/web-app', createdAt: expect.any(Number) }])
    expect(runs.find(r => r[2] === CHECKOUT_SCRIPT)?.slice(4)).toEqual(['/Users/u/dev/web-app'])
    // Terminal's login shell is given only `/bin/sh <file>`; the file holds the command line
    const opened = runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT).map(r => r[5])
    expect(opened).toEqual([`/bin/sh '${openScriptPath(HOME, 'practice-rbac')}'`])
    expect(files.get(openScriptPath(HOME, 'practice-rbac'))).toBe(`${openCommand(JSON.parse(files.get(WORKSPACES)!).workspaces[0], HOME)}\n`)
    // no purpose: no first prompt (one a removed workspace of the same id left is removed), and no relay
    expect(files.has(promptPath(HOME, 'practice-rbac', 'claude')) || files.has(promptPath(HOME, 'practice-rbac', 'codex'))).toBe(false)
    expect(world.removed).toEqual([promptPath(HOME, 'practice-rbac', 'claude'), promptPath(HOME, 'practice-rbac', 'codex')])
    // listed in the pane, stopped until tmux reports its session
    await $.command.run(SESSIONS)
    const shown = (await shownOn($, 'terminal', 110)).join('\n')
    expect(shown).toContain('Practice RBAC')
    expect(shown).toContain('stopped')
  })

  test('/workspace open focuses the terminal already attached, else opens one; rm forgets it', async ($, on) => {
    const { runs, files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys004\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
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
    // a workspace running from before is set up for use by hand when opened: the mouse on in its session, borders named
    const setUp = runs.filter(r => r[0] === 'tmux' && (r[1] === 'set-option' || r[1] === 'set-window-option'))
    // each of its windows, by id: the agents' windows whatever window is current
    expect(runs.find(r => r[0] === 'tmux' && r[1] === 'list-windows')).toEqual(['tmux', 'list-windows', '-t', '=ws-practice-rbac', '-F', '#{window_id}'])
    expect(setUp.slice(0, 9)).toEqual(sessionSetup('ws-practice-rbac', ['@1', '@2'], true, 'Practice RBAC').map(a => ['tmux', ...a]))
    // the bar's left end names the workspace (a # doubled, as tmux reads it)
    expect(sessionSetup('x', [], false, 'A #1').find(a => a[3] === 'status-left')?.[4]).toBe(' A ##1 ')
    expect(sessionSetup('ws-practice-rbac', ['@1', '@2'], true, 'Practice RBAC').map(a => `${a[0]} ${a[2]} ${a[3]}`)).toEqual([
      'set-option ws-practice-rbac mouse', 'set-option ws-practice-rbac status-left-length', 'set-option ws-practice-rbac status-left',
      'set-option ws-practice-rbac status-right-length', 'set-option ws-practice-rbac status-right',
      'set-window-option @1 pane-border-status', 'set-window-option @1 pane-border-format',
      'set-window-option @2 pane-border-status', 'set-window-option @2 pane-border-format',
    ])
    // its pane: its window, then the pane itself
    expect(runs.filter(r => r[0] === 'tmux' && (r[1] === 'select-window' || r[1] === 'select-pane'))).toEqual([['tmux', 'select-window', '-t', '%2'], ['tmux', 'select-pane', '-t', '%2']])
    await ui.unmount()
    // with no terminal attached it opens one
    world.tmuxClients = ''
    await $.command.run(SESSIONS)
    await $.command.run(SESSIONS)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe('Opened ws-practice-rbac in a new Terminal window.')
    expect(osa().at(-1)).toEqual(['open', `/bin/sh '${openScriptPath(HOME, 'practice-rbac')}'`])
    // its panes run sessions of the default accounts, not its own environment's (work): none is kept as its own
    const kept = JSON.parse(files.get(WORKSPACES)!).workspaces[0]
    expect(kept.threads).toBeUndefined()
    expect(files.get(openScriptPath(HOME, 'practice-rbac'))).toBe(`${openCommand(kept, HOME)}\n`)
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'rm practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces).toEqual([])
    // its first prompts, window place and open file go with it: a later workspace of the same name never starts on them
    expect(world.removed).toEqual([promptPath(HOME, 'practice-rbac', 'claude'), promptPath(HOME, 'practice-rbac', 'codex'), placementPath(HOME, 'ws-practice-rbac'), openScriptPath(HOME, 'practice-rbac')])
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
    // a session not started for it is left as it is: no mouse, no borders
    expect(runs.filter(r => r[0] === 'tmux' && (r[1] === 'set-option' || r[1] === 'set-window-option' || r[1] === 'list-windows'))).toEqual([])
    expect(await run('open gone')).toBe('Not opened: its folder /Users/u/dev/gone is not there any more.')
    world.tmuxPanes = ''
    world.openFails = true
    expect(await run('open practice-rbac')).toBe(`Not opened (execution error: Not authorized to send Apple events to Terminal. (-1743)). Run: /bin/sh '${openScriptPath(HOME, 'practice-rbac')}'`)
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
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe(`Open it in a terminal: /bin/sh '${openScriptPath(HOME, 'practice-rbac')}'`)
    expect(files.get(openScriptPath(HOME, 'practice-rbac'))).toBe(`${openCommand(practice, HOME)}\n`)
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
    // a list that cannot be read is said to be so, not taken for an empty one
    files.set(WORKSPACES, '{ broken')
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'rm practice-rbac' })).text).toMatch(/^Not done: its list cannot be read/)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toMatch(/^Not done: its list cannot be read/)
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.spoilsAfterRead = WORKSPACES
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'rm practice-rbac' })).text).toMatch(/^Not done: its list cannot be read/)
    expect(files.get(WORKSPACES)).toBe('{ broken')
    await $.command.run(SESSIONS)
    expect((await shownOn($, 'terminal', 110)).join('\n')).toContain('! workspaces: its list cannot be read')
  })

  test('a workspaces file that is there but cannot be read is never overwritten', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.unreadable = WORKSPACES
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Other' })).text).toMatch(/^Not done: its list cannot be read/)
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces).toEqual([practice])
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

describe('workspaces, from the pane', () => {
  test('each row has one [ more ]; it shows the row\'s actions, worded, each with its key; one row at a time', async ($, on) => {
    const { focusAsked, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const shown = async (key: string) => (await ui.find({ key }))?.props as { label: string; hotkey?: string } | undefined
    // closed: none of a row's actions is drawn, only its [ more ]
    expect((await shown('more item:claude-104'))?.label).toBe('more')
    expect(await shown('bg claude-104')).toBeUndefined()
    await reveal(ui, 'item:claude-104')
    expect((await shown('more item:claude-104'))?.label).toBe('hide')
    // the keyboard stays where it is: keys work once the person gives the pane the keys, never by surprise
    expect(focusAsked).toEqual([])
    expect([await shown('open-bar claude-104'), await shown('bg claude-104'), await shown('assign claude-104'), await shown('close item:claude-104')].map(b => [b?.label, b?.hotkey]))
      .toEqual([['Open (o)', 'o'], ['To background', undefined], ['Assign to workspace (w)', 'w'], ['Close (x)', 'x']])
    // a chooser left open goes when the actions close: they come back as actions
    await ui.press({ key: 'assign claude-104' })
    expect(await shown('assign-cancel claude-104')).toBeDefined()
    await ui.press({ key: 'close item:claude-104' })
    await reveal(ui, 'item:claude-104')
    expect(await shown('assign-cancel claude-104')).toBeUndefined()
    expect(await shown('bg claude-104')).toBeDefined()
    // Open in the actions brings the session's tab up
    await ui.press({ key: 'open-bar claude-104' })
    expect(runs.filter(r => r[4] === FOCUS_SCRIPT).map(r => r[5])).toEqual(['ttys022'])
    // another row's [ more ] shows its actions instead
    await reveal(ui, 'item:claude-101')
    expect(await shown('bg claude-104')).toBeUndefined()
    expect((await shown('down items:/Users/u/dev/web-app claude-101'))?.label).toBe('Move down (d)')
    expect((await shown('down items:/Users/u/dev/web-app claude-101'))?.hotkey).toBe('d')
    // Close, or its [ hide ], hides them
    await ui.press({ key: 'close item:claude-101' })
    expect(await shown('down items:/Users/u/dev/web-app claude-101')).toBeUndefined()
    await reveal(ui, 'tree:/Users/u/dev/web-app')
    expect(await shown('new-from:/Users/u/dev/web-app')).toMatchObject({ label: 'New workspace here (n)', hotkey: 'n' })
    await reveal(ui, 'tree:/Users/u/dev/web-app')
    expect(await shown('new-from:/Users/u/dev/web-app')).toBeUndefined()
    expect(await shown('workspace:new')).toMatchObject({ label: '+ New workspace (n)', hotkey: 'n' })
    // opened, the form puts the keys on the name (moved there while the pane holds them; seen in a real
    // terminal: n, then `ab`, filled the name and pressed nothing), so what is typed next is the name
    await ui.press({ key: 'workspace:new' })
    expect((await ui.find({ key: 'form:name' }))?.props.autoFocus).toBe(true)
    await ui.press({ key: 'form:cancel' })
    // no single-glyph control is left to aim at
    const labels = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { label: string }).label)
    expect(labels.filter(l => [...l].length < 3)).toEqual(['1d', '2d', '3d', '7d'])
    await ui.unmount()
  })

  test('a workspace: Open and Relay on its row; its actions move, cycle the relay, and remove it on a second press', async ($, on) => {
    const { files, toasts, clock, runs, store } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice, { ...practice, id: 'other', name: 'Other' }] }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const label = async (key: string) => ((await ui.find({ key }))?.props as { label: string } | undefined)?.label
    expect([await label('wsopen practice-rbac'), await label('relay practice-rbac')]).toEqual(['Open', 'Relay: off'])
    await reveal(ui, 'ws:practice-rbac')
    const hotkey = async (key: string) => ((await ui.find({ key }))?.props as { hotkey?: string } | undefined)?.hotkey
    expect([await label('wsopen-bar practice-rbac'), await label('relay-bar practice-rbac'), await label('down workspaces practice-rbac'), await label('remove practice-rbac')])
      .toEqual(['Open (o)', 'Relay: off → auto', 'Move down (d)', 'Remove'])
    // keys on what only shows or moves; none on what types into agents or forgets a workspace
    expect([await hotkey('wsopen-bar practice-rbac'), await hotkey('down workspaces practice-rbac'), await hotkey('relay-bar practice-rbac'), await hotkey('remove practice-rbac')]).toEqual(['o', 'd', undefined, undefined])
    // only this workspace's actions are drawn
    expect(await ui.find({ key: 'wsopen-bar other' })).toBeUndefined()
    // they act: the relay goes round, the order changes, Open opens it
    await ui.press({ key: 'relay-bar practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay.mode).toBe('auto')
    await ui.press({ key: 'down workspaces practice-rbac' })
    expect((store.get('order') as Record<string, string[]>).workspaces).toEqual(['other', 'practice-rbac'])
    await ui.press({ key: 'wsopen-bar practice-rbac' })
    expect(runs.filter(r => r[4] === OPEN_SCRIPT)).toHaveLength(1)
    // a first press goes stale after a few seconds
    await ui.press({ key: 'remove practice-rbac' })
    await clock.advance(7_000)
    await ui.press({ key: 'remove practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.id)).toEqual(['practice-rbac', 'other'])
    await clock.advance(7_000)
    await ui.press({ key: 'remove practice-rbac' })
    expect(await label('remove practice-rbac')).toBe('Press again to remove it')
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.id)).toEqual(['practice-rbac', 'other'])
    await ui.press({ key: 'remove practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.id)).toEqual(['other'])
    expect(toasts.at(-1)).toMatch(/^Removed Practice RBAC \(work, \/Users\/u\/dev\/web-app\)\. Its agents keep running in tmux session ws-practice-rbac/)
    expect(world.removed).toEqual([promptPath(HOME, 'practice-rbac', 'claude'), promptPath(HOME, 'practice-rbac', 'codex'), placementPath(HOME, 'ws-practice-rbac'), openScriptPath(HOME, 'practice-rbac')])
    await ui.unmount()
  })

  test('helpers: the checkout script\'s answers; projects ranked; assigning a session to one workspace; members kept', async () => {
    expect(checkoutResult('ok /Users/u/dev/web-app\n')).toEqual({ checkout: '/Users/u/dev/web-app' })
    expect(checkoutResult('error: not-a-repo\n')).toEqual({ error: 'that folder is not in a git checkout; peer coding works on a git repository' })
    expect(checkoutResult('error: no-main\n')).toEqual({ error: 'git cannot tell where this repository\'s main checkout is; pick the main checkout' })
    expect(checkoutResult('')).toEqual({ error: 'its worktrees folder could not be made beside the repository' })
    // the projects with a session most recently first (in the checkout, under it or in its worktrees), then by path
    const paths = ['/Users/u/z', '/Users/u/dev/api', '/Users/u/dev/web-app', '/Users/u/a']
    const activity = [{ cwd: '/Users/u/dev/web-app-worktrees/feat-x', at: 5 }, { cwd: '/Users/u/dev/api/src', at: 9 }, { cwd: '/Users/u/dev/web-apps', at: 99 }]
    expect(rankProjects(paths, activity, '', HOME).map(p => p.label)).toEqual(['~/dev/api', '~/dev/web-app', '~/a', '~/z'])
    expect(rankProjects(paths, activity, 'WEB', HOME)).toEqual([{ path: '/Users/u/dev/web-app', label: '~/dev/web-app' }])
    expect(rankProjects(paths, [], '~/dev/', HOME, 1).map(p => p.label)).toEqual(['~/dev/api'])
    // Claude's first prompt: the purpose, the rules, a branch named for the purpose (never the workspace's name)
    const prompt = setupPrompt({ name: 'Practice RBAC', purpose: 'roles and permissions for admins', checkout: '/Users/u/dev/web-app' })
    expect(prompt).toContain('What it is for: roles and permissions for admins')
    expect(prompt).toContain('peer-coding skill')
    expect(prompt).toContain('never from the workspace\'s name')
    expect(prompt).toContain('/Users/u/dev/web-app-worktrees/')
    // Codex's: it is the peer, the relay will bring Claude's hand-off; it answers that it is ready
    expect(peerPrompt({ name: 'Practice RBAC', purpose: 'roles' })).toMatch(/^This is the workspace "Practice RBAC"\. What it is for: roles\n[\s\S]*You are Codex[\s\S]*reply with one short line saying you are ready\.$/)
    // a profile pair named `default` would mean two things
    expect(envsFrom(['.claude-default', '.codex-default', '.claude-work', '.codex-work'], () => true)).toEqual(['', 'work'])
    const two = [practice, { ...practice, id: 'other', name: 'Other' }]
    const once = assigned(two, 'claude:session-104', 'practice-rbac')
    expect(once.map(w => w.members ?? [])).toEqual([['claude:session-104'], []])
    // assigning moves it: never in two workspaces
    const moved = assigned(once, 'claude:session-104', 'other')
    expect(moved.map(w => w.members ?? [])).toEqual([[], ['claude:session-104']])
    expect(assigned(moved, 'claude:session-104', '')).toEqual(two)
    // a member this does not read is kept, and never costs the workspace
    const later = { tool: 'gemini', id: 'abc' }
    expect(workspacesFrom({ workspaces: [{ ...practice, members: ['claude:x', 'gemini:abc', later] }, { ...practice, id: 'empty', members: [] }] }))
      .toEqual([{ ...practice, members: ['claude:x', 'gemini:abc', later] }, { ...practice, id: 'empty' }])
    expect(assigned([{ ...practice, members: [later] }], 'claude:x', 'practice-rbac')[0]!.members).toEqual([later, 'claude:x'])
  })

  test('an assigned session groups under its workspace, tagged; running in its tmux session wins', async () => {
    const snap = { ...snapshotOf(), workspaces: [{ ...practice, members: ['claude:session-104', 'codex:' + RESUMED_A] }] }
    const view = viewOf(snap, { home: HOME, now: NOW, windowMs: 0, selfId: '' })
    expect(view.workspaces[0]!.items.map(i => `${i.title}:${i.tags.join('+')}`)).toEqual(['Find the report writer:+2 agents+assigned', 'WORKER:work+assigned'])
    expect(view.repos.flatMap(r => r.trees.flatMap(t => t.items.map(i => i.title)))).not.toContain('WORKER')
    // a session running in another workspace's tmux session is listed there, not where it is assigned
    const inTmux = viewOf({ ...snap, workspaces: [...snap.workspaces, { ...practice, id: 'other', name: 'Other' }], tmux: { panes: { ttys022: { session: 'ws-other', window: 'claude' } }, clients: {} } },
      { home: HOME, now: NOW, windowMs: 0, selfId: '' })
    expect(inTmux.workspaces.map(w => [w.key, w.items.map(i => `${i.title}:${i.tags.join('+')}`)])).toEqual([
      ['practice-rbac', ['Find the report writer:+2 agents+assigned']],
      ['other', ['WORKER:work']],
    ])
    // the terminal with no thread found has no lasting id: it cannot be assigned
    expect(view.repos.flatMap(r => r.trees.flatMap(t => t.items)).find(i => i.title === 'session (thread not found)')?.memberId).toBeUndefined()
  })

  test('+ workspace opens the form: a project searched and picked, an environment, a purpose; Claude gets it ready', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await ui.press({ key: 'workspace:new' })
    // nothing typed yet: said, nothing made
    await ui.press({ key: 'form:create' })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('Not done: a workspace needs a name.')
    await ui.input({ key: 'form:name', text: 'Practice RBAC', kind: 'change' })
    // the repositories on this Mac, searched by what is typed; those worked in lately first
    expect(runs.filter(r => r[2] === PROJECTS_SCRIPT).map(r => r[4])).toEqual([HOME])
    const offered = async () => ((await ui.find({ key: 'form:pick' }))?.props.options as { label: string }[] | undefined)?.map(o => o.label)
    expect(await offered()).toEqual(['~/dev/web-app', '~/dev/api', '~/dev/build', '~/dev/résumé'])
    await ui.input({ key: 'form:project', text: 'ap', kind: 'change' })
    expect(await offered()).toEqual(['~/dev/web-app', '~/dev/api'])
    await ui.select({ key: 'form:pick', value: '/Users/u/dev/web-app' })
    expect((await ui.find({ key: 'form:project' }))?.props.value).toBe('~/dev/web-app')
    expect(await ui.find({ key: 'form:pick' })).toBeUndefined()
    await ui.select({ key: 'form:env', value: 'work' })
    await ui.input({ key: 'form:purpose', text: 'roles and permissions for admins', kind: 'change' })
    await ui.press({ key: 'form:create' })
    const saved = JSON.parse(files.get(WORKSPACES)!).workspaces
    expect(saved.map((w: Workspace) => [w.id, w.env, w.dir, w.checkout, w.purpose, w.relay])).toEqual([
      ['practice-rbac', 'work', '/Users/u/dev/web-app', '/Users/u/dev/web-app', 'roles and permissions for admins', { mode: 'auto', since: saved[0].createdAt, streak: 0 }],
    ])
    // each agent's first prompt waits in its file; the window opens with Claude and Codex side by side
    expect(files.get(promptPath(HOME, 'practice-rbac', 'claude'))).toBe(setupPrompt(saved[0]))
    expect(files.get(promptPath(HOME, 'practice-rbac', 'codex'))).toBe(peerPrompt(saved[0]))
    expect(files.get(openScriptPath(HOME, 'practice-rbac'))).toBe(`${openCommand(saved[0], HOME)}\n`)
    // the form closes once it is made
    expect(await ui.find({ key: 'form:name' })).toBeUndefined()
    await ui.unmount()
  })

  test('New workspace here on a branch row fills in its folder; a purpose needs a git repository', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'tree:/Users/u/dev/web-app')
    await ui.press({ key: 'new-from:/Users/u/dev/web-app' })
    expect((await ui.find({ key: 'form:project' }))?.props.value).toBe('~/dev/web-app')
    await ui.input({ key: 'form:name', text: 'RBAC v2', kind: 'change' })
    await ui.press({ key: 'form:create' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].dir).toBe('/Users/u/dev/web-app')
    await ui.unmount()
    // a folder outside git takes a workspace, but not one for a purpose
    const run = async (args: string) => (await $.command.run({ ...SESSIONS, command: 'workspace', args })).text
    expect(await run('new ~ work Plain')).toMatch(/^Created Plain/)
    expect(await run('new ~ work Peers --for a thing')).toBe('Not done: that folder is not in a git checkout; peer coding works on a git repository.')
    expect(await run('new ~/dev/api work Peers --for a thing')).toMatch(/Claude gets peer coding ready for it/)
  })

  test('the form refuses a relative folder, a gone environment and an unreadable list, before any git or tmux', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const error = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => t.startsWith('Not done')) ?? ''
    const acting = () => runs.filter(r => r[2] === CHECKOUT_SCRIPT || r[0] === 'tmux' && r[1] !== 'list-panes' && r[1] !== 'list-clients' || r[4] === OPEN_SCRIPT)
    await ui.press({ key: 'workspace:new' })
    await ui.input({ key: 'form:name', text: 'Rel', kind: 'change' })
    await ui.input({ key: 'form:project', text: 'dev/web-app', kind: 'change' })
    await ui.press({ key: 'form:create' })
    expect(await error()).toBe('Not done: the folder must be absolute or start with ~/ ("dev/web-app" is neither).')
    await ui.input({ key: 'form:project', text: '~/dev/web-app', kind: 'change' })
    await ui.select({ key: 'form:env', value: 'work' })
    // the work profile went away after the form was opened
    world.gone.add('/Users/u/.codex-work/auth.json')
    await ui.press({ key: 'form:create' })
    expect(await error()).toBe('Not done: there is no environment "work".')
    world.gone.clear()
    const none = JSON.stringify({ version: 1, workspaces: [] })
    files.set(WORKSPACES, none)
    world.unreadable = WORKSPACES
    await ui.press({ key: 'form:create' })
    expect(await error()).toMatch(/^Not done: its list cannot be read/)
    expect(acting()).toEqual([])
    expect(files.get(WORKSPACES)).toBe(none)
    // picked back to default: the default accounts, ''
    world.unreadable = ''
    await ui.select({ key: 'form:env', value: 'default' })
    await ui.press({ key: 'form:create' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => [w.env, w.dir])).toEqual([['', '/Users/u/dev/web-app']])
    await ui.unmount()
  })

  test('create pressed twice while the first is being made makes one workspace and one window', { timeoutMs: 4_000 }, async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal', checkoutTakesMs: 5_000 })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await ui.press({ key: 'workspace:new' })
    await ui.input({ key: 'form:name', text: 'Twice', kind: 'change' })
    await ui.input({ key: 'form:project', text: '~/dev/web-app', kind: 'change' })
    const first = ui.press({ key: 'form:create' })
    await clock.settle()
    expect((await ui.find({ key: 'form:create' }))?.props.label).toBe('creating…')
    await ui.press({ key: 'form:create' })
    await ui.input({ key: 'form:name', text: 'Twice', kind: 'submit' })
    // the command waits its turn too
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Third' })).text).toBe('Not done: a workspace is already being made.')
    await clock.advance(5_000)
    await first
    await clock.settle()
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.id)).toEqual(['twice'])
    expect(runs.filter(r => r[2] === CHECKOUT_SCRIPT)).toHaveLength(1)
    expect(runs.filter(r => r[4] === OPEN_SCRIPT)).toHaveLength(1)
    await ui.unmount()
  })

  test('a reload of the plugin while a create is cut off never holds the next create back', { timeoutMs: 4_000 }, async ($, on) => {
    const { files, clock } = engine(on, machine, { termProgram: 'Apple_Terminal', checkoutTakesMs: 5_000 })
    await $.session.start(START)
    const run = (args: string) => $.command.run({ ...SESSIONS, command: 'workspace', args })
    const cut = run('new ~/dev/web-app work Cut')
    await clock.settle()
    expect((await run('new ~/dev/web-app work Waits')).text).toBe('Not done: a workspace is already being made.')
    // the plugin loads again (register runs, session.start fires): the flag of the cut-off create goes
    await $.session.start(START)
    const after = run('new ~/dev/web-app work After')
    await clock.advance(5_000)
    expect((await after).text).toMatch(/^Created After/)
    await cut
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.id)).toContain('after')
  })

  test('Assign to workspace on a session assigns it from the pane, and No workspace unassigns it', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'item:claude-104')
    await ui.press({ key: 'assign claude-104' })
    await ui.press({ key: 'assign-to claude-104 practice-rbac' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].members).toEqual(['claude:session-104'])
    await $.command.run(SESSIONS)
    // listed under the workspace now (its title is a button in Terminal.app), right after the workspace's row
    expect((await ui.find({ key: 'open claude-104' }))?.props.label).toBe('WORKER (work, assigned)')
    const labels = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(labels.indexOf('ttys022')).toBeLessThan(labels.indexOf('Acme/web-app'))
    await ui.press({ key: 'assign claude-104' })
    await ui.press({ key: 'assign-to claude-104 -' })
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].members).toBeUndefined()
    await ui.unmount()
  })
})

const relayOn = (fields: Partial<Workspace['relay'] & object> = {}) => ({ mode: 'auto' as const, since: NOW - 3600_000, streak: 0, ...fields })
const done = (id: string, cueLine: string, at = NOW - 60_000) => ({ state: 'done' as const, id, at, ...(cueOf(cueLine) === undefined ? {} : { cue: cueOf(cueLine)! }) })
const READY_CODEX = 'READY FOR CODEX · peer-coding/feat-rbac ALIGN BRIEFED · feat/rbac@abc1234 · worktree: /Users/u/dev/web-app-worktrees/feat-rbac'
const READY_CLAUDE = 'READY FOR CLAUDE · peer-coding/feat-rbac R1 · feat/rbac@def5678'

describe('relay', () => {
  test('cues: the rules\' three kinds, at the start of a line, marks around them dropped', async () => {
    expect(cueOf(READY_CODEX)).toEqual({ kind: 'ready', to: 'codex', line: READY_CODEX })
    expect(cueOf(`\`${READY_CLAUDE}\``)).toEqual({ kind: 'ready', to: 'claude', line: READY_CLAUDE })
    expect(cueOf('1. **NEEDS USER · peer-coding/feat-rbac · feat/rbac@abc1234**')).toEqual({ kind: 'needs-user', line: 'NEEDS USER · peer-coding/feat-rbac · feat/rbac@abc1234' })
    expect(cueOf('SCOPE CLOSED · peer-coding/x · x@1 · awaiting the owner')?.kind).toBe('scope-closed')
    for (const not of ['', 'I am READY FOR CODEX · x', 'READY FOR CODEX now', 'READY FOR GEMINI · x']) expect(cueOf(not)).toBeUndefined()
    // one line, never a control character, at most 1000 characters
    expect(cueOf(`READY FOR CODEX · a\u001b[2Jb${'x'.repeat(2000)}`)?.line).toHaveLength(1000)
    expect(cueOf(`READY FOR CODEX · a\u001b[2Jb`)?.line).toBe('READY FOR CODEX · a [2Jb')
  })

  test('turns: each file\'s last turn, done with its cue or under way', async () => {
    const out = [
      '==> /c.jsonl', `done\tu-1\t2026-10-09T10:05:00Z\t${READY_CODEX}\t2026-10-09T09:00:00Z`,
      '==> /x.jsonl', 'busy\tturn-2\t2026-10-09T10:06:00Z\t\tnot a time',
      '==> /n.jsonl', 'done\tturn-3\t2026-10-09T10:07:00Z\t',
      '==> /bad.jsonl', 'done\tbad id;rm\t2026-10-09T10:07:00Z\t', 'done\tok-1\tnot a time\t',
      '==> /none.jsonl',
    ].join('\n')
    const turns = parseTurns(out)
    expect([...turns.keys()]).toEqual(['/c.jsonl', '/x.jsonl', '/n.jsonl'])
    // with when the owner last typed into the agent, when the pipeline found that
    expect(turns.get('/c.jsonl')).toEqual({ state: 'done', id: 'u-1', at: Date.parse('2026-10-09T10:05:00Z'), cue: cueOf(READY_CODEX), typedAt: Date.parse('2026-10-09T09:00:00Z') })
    expect(turns.get('/x.jsonl')).toEqual({ state: 'busy', id: 'turn-2', at: Date.parse('2026-10-09T10:06:00Z') })
    expect(turns.get('/n.jsonl')?.cue).toBeUndefined()
  })

  test('steps: a hand-off passes once the other agent is free; the owner is told what is theirs', async () => {
    const ws = { name: 'RBAC', relay: relayOn() }
    // by default each has finished a turn (its first prompt) with no cue
    // null: no turn finished yet
    const claude = (turn: ReturnType<typeof done> | null = done('c0', 'Ready.'), isBusy = false): Side => ({ tool: 'claude', pane: '%1', isBusy, ...(turn === null ? {} : { turn }) })
    const codex = (turn: ReturnType<typeof done> | null = done('x0', 'Ready.'), isBusy = false): Side => ({ tool: 'codex', pane: '%2', isBusy, ...(turn === null ? {} : { turn }) })
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW)).toEqual([{ kind: 'pass', key: 'pass-c1', from: 'claude', to: 'codex', pane: '%2', line: READY_CODEX }])
    expect(relaySteps(ws, { claude: claude(), codex: codex(done('x1', READY_CLAUDE)) }, NOW)).toEqual([{ kind: 'pass', key: 'pass-x1', from: 'codex', to: 'claude', pane: '%1', line: READY_CLAUDE }])
    // the other is at work: it waits; the sender still at work, or its turn under way: nothing yet
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CODEX)), codex: codex(done('x0', 'Ready.'), true) }, NOW)).toEqual([])
    // the other has not finished a turn: it may be at a question of its own (trust, an update) that Enter
    // would answer, so nothing is typed; the owner is told once
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CODEX)), codex: codex(null) }, NOW)).toEqual([
      { kind: 'tell', key: 'wait-c1', text: 'RBAC: Claude handed over; the relay passes it once Codex has finished a turn. If Codex is waiting at a question in its pane, answer it.', isForOwner: false },
    ])
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CODEX), true), codex: codex() }, NOW)).toEqual([])
    // a turn that ended before the relay was turned on, no cue, or a cue for itself: nothing
    expect(relaySteps({ ...ws, relay: relayOn({ since: NOW }) }, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW)).toEqual([])
    expect(relaySteps(ws, { claude: claude(done('c1', 'All done.')), codex: codex() }, NOW)).toEqual([])
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CLAUDE)), codex: codex() }, NOW)).toEqual([])
    // off: nothing; notify: the owner is told instead, with the line to paste
    expect(relaySteps({ ...ws, relay: relayOn({ mode: 'off' }) }, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW)).toEqual([])
    expect(relaySteps({ name: 'RBAC' }, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW)).toEqual([])
    expect(relaySteps({ ...ws, relay: relayOn({ mode: 'notify' }) }, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW))
      .toEqual([{ kind: 'tell', key: 'tell-c1', from: 'claude', text: `RBAC: Claude handed over to Codex. Paste: ${READY_CODEX}`, isForOwner: false }])
    // NEEDS USER and SCOPE CLOSED are the owner's, in either mode
    const needs = 'NEEDS USER · peer-coding/feat-rbac · feat/rbac@abc1234'
    expect(relaySteps(ws, { claude: claude(done('c2', needs)), codex: codex() }, NOW)).toEqual([{ kind: 'tell', key: 'tell-c2', from: 'claude', text: `RBAC: Claude needs you. ${needs}`, isForOwner: true }])
    // the other agent is not running in the workspace: the owner is told
    expect(relaySteps(ws, { claude: claude(done('c1', READY_CODEX)) }, NOW)).toEqual([
      { kind: 'tell', key: 'tell-c1', from: 'claude', text: `RBAC: Claude handed over, but Codex is not running in the workspace. Paste: ${READY_CODEX}`, isForOwner: true },
    ])
    // after RELAY_CAP passes in a row it waits for the owner, holding a cue only where it would pass it:
    // not while the other is at work (as on the cue it has just passed), nor before its first turn
    const capped = { ...ws, relay: relayOn({ streak: RELAY_CAP }) }
    expect(relaySteps(capped, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW).map(s => s.key)).toEqual(['cap-c1'])
    expect(relaySteps(capped, { claude: claude(done('c1', READY_CODEX)), codex: codex(done('x0', 'Ready.'), true) }, NOW)).toEqual([])
    expect(relaySteps(capped, { claude: claude(done('c1', READY_CODEX)), codex: codex(null) }, NOW).map(s => s.key)).toEqual(['wait-c1'])
    expect(relaySteps(capped, { claude: claude(done('c1', READY_CODEX)), codex: codex() }, NOW)[0]).toMatchObject({ text: 'RBAC: the relay passed 10 hand-offs in a row and waits for you; type to either agent, or press continue in /sessions, to pass the next.' })
    // a turn older than TURN_MAX_AGE_MS is never acted on (the ledger forgets steps after 30 days)
    expect(relaySteps({ ...ws, relay: relayOn({ since: 0 }) }, { claude: claude(done('c1', READY_CODEX, NOW - TURN_MAX_AGE_MS - 1)), codex: codex() }, NOW)).toEqual([])
    expect(TURN_MAX_AGE_MS).toBeLessThan(30 * 24 * 3600_000)
    // the count: a pass adds one; a cue for the owner starts it again
    const pass = { kind: 'pass' as const, key: 'pass-c1', to: 'codex' as const, pane: '%2', line: READY_CODEX }
    expect(afterStep(relayOn({ streak: 3 }), pass, 'passed', NOW)).toEqual(relayOn({ streak: 4, status: 'passed to Codex', at: NOW }))
    expect(afterStep(relayOn({ streak: 3 }), pass, 'not-agent zsh', NOW)).toEqual(relayOn({ streak: 3, status: 'could not pass to Codex', at: NOW }))
    // a scrolled-back pane: it waits, and says so
    expect(afterStep(relayOn({ streak: 3 }), pass, 'in-mode', NOW)).toEqual(relayOn({ streak: 3, status: 'waits: Codex\'s pane is scrolled back (copy mode; q leaves it)', at: NOW }))
    expect(['passed', 'in-mode', 'taken'].map(passFailure)).toEqual([undefined, undefined, undefined])
    expect(['not-agent zsh', 'gone', 'failed', ''].map(passFailure)).toEqual(['its pane runs zsh, not the agent', 'its pane is gone', 'tmux could not type into its pane', 'tmux could not type into its pane'])
    expect(passFailure('unsent')).toMatch(/waits in its input: leave copy mode \(q\) and press Enter there$/)
    expect(afterStep(relayOn({ streak: 3 }), { kind: 'tell', key: 'tell-c2', text: '', isForOwner: true }, 'told', NOW)).toEqual(relayOn({ streak: 0, status: 'needs you', at: NOW }))
    // a cue held at the cap stays held, said so, while the other agent starts again
    const wait = { kind: 'tell' as const, key: 'wait-c3', text: '', isForOwner: false }
    expect(afterStep(relayOn({ streak: RELAY_CAP, status: 'waits for you' }), wait, 'told', NOW)).toEqual(relayOn({ streak: RELAY_CAP, status: 'waits for you', at: NOW }))
    expect(afterStep(relayOn({ streak: 2, status: 'passed to Codex' }), wait, 'told', NOW).status).toBe('waits for the other agent\'s first turn')
  })

  test('the owner typing to either agent starts the count over', async () => {
    const side = (tool: 'claude' | 'codex', typedAt?: number): Side => ({ tool, pane: tool === 'claude' ? '%1' : '%2', isBusy: false, turn: { ...done(`${tool}-0`, 'Ready.'), ...(typedAt === undefined ? {} : { typedAt }) } })
    // waiting at the cap; the owner typed to Claude since: it goes on, the prompt counted
    expect(afterOwner(relayOn({ streak: RELAY_CAP, status: 'waits for you' }), { claude: side('claude', NOW - 1_000), codex: side('codex') }))
      .toEqual(relayOn({ streak: 0, status: 'going on', typedAt: NOW - 1_000 }))
    // the newer of the two sides; any other status is left as it is
    expect(afterOwner(relayOn({ streak: 3, status: 'passed to Codex', typedAt: NOW - 9_000 }), { claude: side('claude', NOW - 5_000), codex: side('codex', NOW - 2_000) }))
      .toEqual(relayOn({ streak: 0, status: 'passed to Codex', typedAt: NOW - 2_000 }))
    // a prompt already counted, one from before the relay was on, or none: nothing changes
    expect(afterOwner(relayOn({ streak: 3, typedAt: NOW - 2_000 }), { claude: side('claude', NOW - 2_000), codex: side('codex', NOW - 4_000) })).toBeUndefined()
    expect(afterOwner(relayOn({ streak: 3, since: NOW - 1_000 }), { claude: side('claude', NOW - 2_000) })).toBeUndefined()
    expect(afterOwner(relayOn({ streak: 3 }), { claude: side('claude'), codex: side('codex') })).toBeUndefined()
    expect(afterOwner(relayOn({ streak: 3 }), {})).toBeUndefined()
  })

  test('at the cap, a prompt from the owner lets the held hand-off pass; a cue already passed is never held', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    const at = (ms: number) => new Date(NOW - ms).toISOString()
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn({ streak: RELAY_CAP - 1 }) }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    const kept = () => JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay
    const steps = () => runs.filter(r => r[2] === RELAY_SCRIPT).map(r => [r[4], r[6]])
    const collect = async () => {
      await clock.advance(4_000)
      await $.command.run(SESSIONS)
    }
    // the tenth pass in a row: nothing is held yet, so the row offers no continue
    world.turns = { 'session-104': `done\tturn-c1\t${at(60_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${at(120_000)}\t` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(kept()).toMatchObject({ streak: RELAY_CAP, status: 'passed to Codex' })
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    expect(await ui.find({ key: 'relay-go practice-rbac' })).toBeUndefined()
    // Codex at work on it: nothing is held, nothing said
    world.turns = { ...world.turns, '/rollouts/a.jsonl': `busy\tturn-x1\t${at(30_000)}\t` }
    await collect()
    // Codex finished with no cue: Claude's cue, passed already, is not held either
    world.turns = { ...world.turns, '/rollouts/a.jsonl': `done\tturn-x1\t${at(20_000)}\t` }
    await collect()
    expect(steps()).toEqual([['pass', 'pass-turn-c1'], ['tell', 'cap-turn-c1']])
    expect(kept()).toMatchObject({ streak: RELAY_CAP, status: 'passed to Codex' })
    // Codex hands back: held at the cap, the owner told
    world.turns = { ...world.turns, '/rollouts/a.jsonl': `done\tturn-x2\t${at(10_000)}\t${READY_CLAUDE}` }
    await collect()
    expect(steps().at(-1)).toEqual(['tell', 'cap-turn-x2'])
    expect(kept()).toMatchObject({ streak: RELAY_CAP, status: 'waits for you' })
    expect(await ui.find({ key: 'relay-go practice-rbac' })).toBeDefined()
    // the owner types to Claude: the count starts over at once, while Claude works on the prompt
    world.turns = { ...world.turns, 'session-104': `busy\tturn-c2\t${at(5_000)}\t\t${at(5_000)}` }
    await collect()
    expect(steps().at(-1)).toEqual(['tell', 'cap-turn-x2'])
    expect(kept()).toMatchObject({ streak: 0, status: 'going on', typedAt: NOW - 5_000 })
    // Claude done: the held cue passes
    world.turns = { ...world.turns, 'session-104': `done\tturn-c2\t${at(1_000)}\t\t${at(5_000)}` }
    await collect()
    expect(steps().at(-1)).toEqual(['pass', 'pass-turn-x2'])
    expect(kept()).toMatchObject({ streak: 1, status: 'passed to Claude', typedAt: NOW - 5_000 })
    // the same prompt seen again counts once
    await collect()
    expect(kept()).toMatchObject({ streak: 1, typedAt: NOW - 5_000 })
    await ui.unmount()
  })

  test('the collecting session passes Claude\'s hand-off into Codex\'s pane, once, and shows it', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', purpose: 'RBAC', relay: relayOn() }] }))
    // WORKER (claude, idle) on the left, the Codex terminal resumed on ttys045 on the right
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    world.turns = { 'session-104': `done\tturn-c1\t${new Date(NOW - 60_000).toISOString()}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${new Date(NOW - 120_000).toISOString()}\t` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const relayed = () => runs.filter(r => r[2] === RELAY_SCRIPT).map(r => r.slice(4, 10))
    const ledger = '/Users/u/Library/Application Support/live-sessions/relayed'
    expect(relayed()).toEqual([['pass', ledger, 'pass-turn-c1', '%2', 'codex', READY_CODEX]])
    // only the two agents' own records are read
    const read = runs.find(r => r[2] === TURN_SCRIPT)!.slice(4)
    expect(read).toHaveLength(2)
    expect(read.some(f => f.includes('session-104'))).toBe(true)
    expect(read).toContain('/rollouts/a.jsonl')
    const relay = JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay
    expect(relay).toEqual({ ...relayOn({ streak: 1, status: 'passed to Codex' }), at: expect.any(Number) })
    // shown on the workspace's row, with its mode
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(shown).toMatch(/relay: passed to Codex/)
    expect((await ui.find({ key: 'relay practice-rbac' }))?.props.label).toBe('Relay: auto')
    // the next collection (here or in any session) finds the step taken
    await clock.advance(4_000)
    await $.command.run(SESSIONS)
    expect(runs.filter(r => r[2] === RELAY_SCRIPT)).toHaveLength(2)
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay.streak).toBe(1)
    await ui.unmount()
  })

  test('nothing passes while an agent is at work, by its own records or Claude\'s registry, nor from another workspace\'s panes', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // each step collects anew: the snapshot is taken again once it is older than 3.5 s
    const collect = async () => {
      await clock.advance(4_000)
      await $.command.run(SESSIONS)
    }
    const relaying = { ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }
    const at = (ms: number) => new Date(NOW - ms).toISOString()
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex', '%3': 'claude', '%4': 'codex' }
    const passes = () => runs.filter(r => r[2] === RELAY_SCRIPT)
    // Codex's own records say a task is under way: Claude's hand-off waits
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [relaying] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.turns = { 'session-104': `done\tturn-c1\t${at(60_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `busy\tturn-x1\t${at(30_000)}\t` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(passes()).toEqual([])
    // Claude's registry says it is working (WEB CONSOLE, ttys004), though its transcript's last turn ended with a cue
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys004\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.turns = { 'session-101': `done\tturn-c2\t${at(60_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${at(120_000)}\t` }
    await collect()
    expect(runs.filter(r => r[2] === TURN_SCRIPT).at(-1)!.some(f => f.includes('session-101'))).toBe(true)
    expect(passes()).toEqual([])
    // the agents of another workspace (its relay off) are never this one's
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [relaying, { ...practice, id: 'other', name: 'Other', createdAt: NOW }] }))
    world.tmuxPanes = 'ws-other\tpeers\t/dev/ttys022\t%3\tclaude\nws-other\tpeers\t/dev/ttys045\t%4\tcodex\n'
    world.turns = { 'session-104': `done\tturn-c3\t${at(60_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${at(120_000)}\t` }
    const collectedBefore = runs.filter(r => r[0] === '/usr/bin/pgrep').length
    await collect()
    expect(runs.filter(r => r[0] === '/usr/bin/pgrep').length).toBe(collectedBefore + 1)
    expect(passes()).toEqual([])
  })

  test('a pane scrolled back (copy mode): the hand-off waits, said once, and passes later', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    world.inMode.add('%2')
    world.turns = { 'session-104': `done\tturn-c1\t${new Date(NOW - 60_000).toISOString()}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${new Date(NOW - 120_000).toISOString()}\t` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const kept = () => JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay
    const first = kept()
    expect(first.status).toBe('waits: Codex\'s pane is scrolled back (copy mode; q leaves it)')
    // still scrolled back at the next collection: tried again, the same said once (its time unchanged), no notification
    await clock.advance(4_000)
    await $.command.run(SESSIONS)
    expect(kept()).toEqual(first)
    expect(runs.filter(r => r[2] === RELAY_SCRIPT).map(r => r[4])).toEqual(['pass', 'pass'])
    // out of copy mode: passed
    world.inMode.clear()
    await clock.advance(4_000)
    await $.command.run(SESSIONS)
    expect(kept()).toMatchObject({ streak: 1, status: 'passed to Codex' })
  })

  test('a step already taken by another session changes nothing here', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    const before = relayOn({ streak: 2, status: 'passed to Claude', at: NOW - 5_000 })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: before }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    world.turns = { 'session-104': `done\tturn-c1\t${new Date(NOW - 60_000).toISOString()}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${new Date(NOW - 120_000).toISOString()}\t` }
    world.ledger.add('pass-turn-c1')
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay).toEqual(before)
  })

  test('never types into a pane that runs a shell; tells the owner instead', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    // Codex exited: its pane is back at the shell
    world.paneCommands = { '%1': 'claude', '%2': 'zsh' }
    world.turns = { 'session-104': `done\tturn-c1\t${new Date(NOW - 60_000).toISOString()}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x0\t${new Date(NOW - 120_000).toISOString()}\t` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const steps = runs.filter(r => r[2] === RELAY_SCRIPT).map(r => [r[4], r[6]])
    expect(steps).toEqual([['pass', 'pass-turn-c1'], ['tell', 'failed-pass-turn-c1']])
    expect(runs.filter(r => r[2] === RELAY_SCRIPT).at(-1)![9]).toBe(`Practice RBAC: the relay did not pass the hand-off to Codex: its pane runs zsh, not the agent. Paste: ${READY_CODEX}`)
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].relay.status).toBe('could not pass to Codex')
  })

  test('the mode button goes auto, notify, off; after the cap, continue lets it go on', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, relay: relayOn({ streak: RELAY_CAP, since: NOW - 1, status: 'waits for you' }) }, { ...practice, id: 'plain', name: 'Plain' }] }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const kept = () => JSON.parse(files.get(WORKSPACES)!).workspaces.map((w: Workspace) => w.relay)
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain(`relay: waits for you after ${RELAY_CAP} hand-offs`)
    await ui.press({ key: 'relay-go practice-rbac' })
    expect(kept()[0]).toEqual(relayOn({ since: NOW - 1, streak: 0, status: 'going on' }))
    await ui.press({ key: 'relay practice-rbac' })
    expect(kept()[0].mode).toBe('notify')
    await ui.press({ key: 'relay practice-rbac' })
    expect(kept()[0].mode).toBe('off')
    // turned on, it counts cues from now: an earlier hand-off is never passed
    await ui.press({ key: 'relay plain' })
    expect(kept()[1]).toEqual({ mode: 'auto', since: expect.any(Number), streak: 0 })
    await ui.press({ key: 'relay practice-rbac' })
    expect(kept()[0]).toEqual({ mode: 'auto', since: kept()[1].since, streak: 0 })
    expect(kept()[0].since).toBeGreaterThan(NOW - 1)
    expect((await ui.find({ key: 'relay plain' }))?.props.label).toBe('Relay: auto')
    await ui.unmount()
  })
})

describe('bringing running sessions into a workspace', () => {
  test('helpers: environments by profile, one session of each agent, Codex flags and folder, saved threads read safely', async () => {
    expect([envOfProfile('claude', 'claude'), envOfProfile('claude', 'claude-work'), envOfProfile('codex', 'codex-work'), envOfProfile('claude', 'codex'), envOfProfile('claude', 'claude-default')])
      .toEqual(['', 'work', 'work', undefined, undefined])
    expect(toggled([], 'claude:a')).toEqual(['claude:a'])
    expect(toggled(['claude:a', 'codex:x'], 'claude:b')).toEqual(['codex:x', 'claude:b'])
    expect(toggled(['claude:a', 'codex:x'], 'codex:x')).toEqual(['claude:a'])
    // full access stays full access; anything else writes in the workspace; approvals kept where `codex resume` takes them
    expect(codexFlags('danger-full-access\tnever\t/x\n')).toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'])
    expect(codexFlags('read-only\ton-request\t/x\n')).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'])
    expect(codexFlags('workspace-write\tuntrusted\t/x')).toEqual(['--sandbox', 'workspace-write'])
    expect(codexFlags('')).toEqual(['--sandbox', 'workspace-write'])
    expect([codexDir('a\tb\t/Users/u/dev/web-app\n'), codexDir('a\tb\trelative'), codexDir('a\tb\t/x\u0007y'), codexDir('')]).toEqual(['/Users/u/dev/web-app', undefined, undefined, undefined])
    // a Codex turn by its whole rollout: under way, between turns, or unknown
    expect(['"type":"task_started"\n', '"type":"task_complete"\n', '"type":"turn_aborted"', ''].map(codexTaskState)).toEqual(['busy', 'done', 'done', undefined])
    // saved threads: ids that cannot pass for an option, flags whole as the plugin writes them
    expect(threadFrom('claude', { id: 'session-1', dir: '/a', flags: ['--permission-mode', 'plan'], since: 5 })).toEqual({ id: 'session-1', dir: '/a', flags: ['--permission-mode', 'plan'], since: 5 })
    expect(threadFrom('claude', { id: 'session-1', dir: '/a', flags: [] })).toEqual({ id: 'session-1', dir: '/a' })
    for (const bad of [
      { id: 'x;rm', dir: '/a' }, { id: '--dangerously-skip-permissions', dir: '/a' }, { id: 'x', dir: 'a' }, { id: 'x', dir: '/a\nb' },
      { id: 'x', dir: '/a', flags: ['--dangerously-bypass-approvals-and-sandbox'] }, { id: 'x', dir: '/a', flags: ['plan'] },
      { id: 'x', dir: '/a', flags: ['--permission-mode'] }, { id: 'x', dir: '/a', flags: 'plan' }, null, 'x',
    ]) expect(threadFrom('claude', bad)).toBeUndefined()
    expect(threadFrom('codex', { id: 'x', dir: '/a', flags: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] })?.flags).toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'])
    for (const flags of [['never'], ['--sandbox', 'read-only'], ['--sandbox', 'workspace-write', '--ask-for-approval', 'untrusted'], ['--ask-for-approval', 'never']]) {
      expect(threadFrom('codex', { id: 'x', dir: '/a', flags })).toBeUndefined()
    }
    // a workspace keeps its readable threads; one it cannot read is dropped, never the workspace
    const listed = workspacesFrom({ workspaces: [{ ...practice, threads: { claude: { id: 'session-1', dir: '/a' }, codex: { id: 'x;y', dir: '/b' } } }, { ...practice, id: 'b', threads: { codex: 'nope' } }] })
    expect(listed.map(w => w.threads)).toEqual([{ claude: { id: 'session-1', dir: '/a' } }, undefined])
  })

  test('a conversation is kept by one workspace only: kept for one, it is taken from any other', async () => {
    const t = (id: string) => ({ id, dir: '/a' })
    const list = [{ ...practice, id: 'a', threads: { claude: t('c1'), codex: t('x1') } }, { ...practice, id: 'b', threads: { claude: t('c2') } }, { ...practice, id: 'c' }]
    expect(withThreads(list, 'b', { claude: t('c2'), codex: t('x1') }).map(w => [w.id, w.threads])).toEqual([
      ['a', { claude: t('c1') }], ['b', { claude: t('c2'), codex: t('x1') }], ['c', undefined],
    ])
    expect(withThreads(list, 'a', {}).map(w => w.threads)).toEqual([undefined, { claude: t('c2') }, undefined])
  })

  test('a pane started with a conversation resumes it, from where it ran, with its flags, unless Claude has it open elsewhere', async () => {
    // a fragment of a pane's script as the command line holds it: quoted once in the pane's script, once more in tmux's command
    const nested = (fragment: string) => fragment.replace(/'/g, `'\\''`).replace(/'/g, `'\\''`)
    const ws = {
      ...practice, env: '', checkout: '/Users/u/dev/web-app',
      threads: {
        claude: { id: 'session-101', dir: '/Users/u/dev/web-app/src', flags: ['--permission-mode', 'plan'] },
        codex: { id: RESUMED_A, dir: '/Users/u/dev/web-app', flags: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] },
      },
    }
    const line = openCommand(ws, HOME)
    expect(line).toContain(nested(`open=; for f in '/Users/u/.claude'/sessions/*.json; do grep -q '"sessionId":"session-101"' "$f" 2>/dev/null && kill -0 "$(basename "$f" .json)" 2>/dev/null && open=1; done; `))
    expect(line).toContain(nested(`if [ -n "$open" ]; then echo 'This conversation is open in another Claude session; close it there, then open the workspace again.'; else cd '/Users/u/dev/web-app/src' && env `))
    expect(line).toContain(nested(` claude --resume session-101 '--permission-mode' 'plan' --add-dir '/Users/u/dev/web-app-worktrees' \${p:+--} \${p:+"$p"}; fi; exec`))
    expect(line).toContain(nested(` codex resume -c check_for_update_on_startup=false '--sandbox' 'danger-full-access' '--ask-for-approval' 'never' --add-dir '/Users/u/dev/web-app-worktrees' -C '/Users/u/dev/web-app' -- ${RESUMED_A} \${p:+"$p"}; exec`))
    // a named environment's Claude registry
    expect(openCommand({ ...ws, env: 'work' }, HOME)).toContain(nested(`for f in '/Users/u/.claude-work'/sessions/*.json;`))
    // no sandbox kept: the workspace's own; an agent with no conversation starts new
    const plain = openCommand({ ...ws, threads: { codex: { id: RESUMED_A, dir: '/Users/u/dev/web-app' } } }, HOME)
    expect(plain).toContain(nested(` codex resume -c check_for_update_on_startup=false --sandbox workspace-write --add-dir '/Users/u/dev/web-app-worktrees' -C '/Users/u/dev/web-app' -- ${RESUMED_A} `))
    expect(plain).toContain(nested(` claude --add-dir '/Users/u/dev/web-app-worktrees' \${p:+--}`))
  })

  test('first prompts: a brought-in agent keeps what it knows and goes on as a peer; uncommitted work is the owner\'s call', async () => {
    const ws = { ...practice, purpose: 'roles for admins', checkout: '/Users/u/dev/web-app', threads: { claude: { id: 'a', dir: '/x' } } }
    const claude = joinPrompt(ws, 'claude')
    expect(claude).toContain('The owner moved this conversation into the workspace: everything above stays yours.')
    expect(claude).toContain('Codex runs in the pane beside you, starting new.')
    expect(claude).toContain('If the work above already has a peer-coding branch, go on with it.')
    expect(claude).toContain('Work of yours not committed yet stays where it is: ask the owner with NEEDS USER before moving any of it.')
    expect(claude).toContain('/Users/u/dev/web-app-worktrees/')
    expect(peerPrompt(ws)).toContain('Claude runs in the pane beside you, in its own conversation, which the owner brought in, and is getting peer coding ready now')
    const both = { ...ws, threads: { claude: { id: 'a', dir: '/x' }, codex: { id: 'b', dir: '/y' } } }
    expect(joinPrompt(both, 'codex')).toContain('Claude runs in the pane beside you, in its own conversation, brought in too, and is getting peer coding ready now')
    expect(joinPrompt(both, 'codex')).toContain('add what you know from your own work above that it does not say')
    expect(setupPrompt({ ...ws, threads: { codex: { id: 'b', dir: '/y' } } })).toContain('which the owner brought in: your alignment brief can ask it where its work stands.')
    expect(setupPrompt({ ...ws, threads: undefined })).toContain('You are Claude, one of two peers here; Codex runs in the pane beside you. The owner turned on')
  })

  test('the conversations a workspace\'s panes run are kept: an interactive Claude or a Codex known for certain, of its environment', async () => {
    const ws = { id: 'practice-rbac', env: '', threads: { claude: { id: 'session-1', dir: '/a', flags: ['--permission-mode', 'plan'], since: 7 } } }
    const panes = { ttys004: { session: 'ws-practice-rbac', window: 'claude', pane: '%1' }, ttys045: { session: 'ws-practice-rbac', window: 'codex', pane: '%2' }, ttys009: { session: 'other', window: 'claude', pane: '%3' } }
    const claudeRow = (fields: Partial<ClaudeSession>): ClaudeSession => ({ pid: 1, sessionId: 'session-1', jobId: '', name: 'x', cwd: '/a', startCwd: '/a', status: 'idle', kind: 'interactive', profile: 'claude', tty: 'ttys004', isForeground: true, since: NOW, ...fields })
    const codexRow = (fields: Partial<CodexSession>): CodexSession => ({ key: RESUMED_A, title: 't', cwd: '/b', profile: 'codex', surface: 'terminal', tty: 'ttys045', updatedAt: NOW, lastActive: NOW, agents: 0, pid: 207, match: 'held', ...fields })
    const snap = (claude: ClaudeSession[], codex: CodexSession[]) => ({ tmux: { panes, clients: {} }, claude, codex })
    // the same Claude conversation keeps its flags and when it joined; Codex's is learnt; another tmux session's pane is not this one's
    expect(seenThreads([ws], snap([claudeRow({}), claudeRow({ tty: 'ttys009', sessionId: 'session-9' })], [codexRow({})])))
      .toEqual(new Map([['practice-rbac', { claude: ws.threads.claude, codex: { id: RESUMED_A, dir: '/b' } }]]))
    // nothing new: nothing to write
    expect(seenThreads([{ ...ws, threads: { ...ws.threads, codex: { id: RESUMED_A, dir: '/b' } } }], snap([claudeRow({})], [codexRow({})])).size).toBe(0)
    // another conversation in its pane (/clear, or a new claude run there): kept without the old one's flags or join time
    expect(seenThreads([ws], snap([claudeRow({ sessionId: 'session-2' })], [])).get('practice-rbac')).toEqual({ claude: { id: 'session-2', dir: '/a' } })
    // an exec run in Codex's pane is never its conversation
    expect(seenThreads([ws], snap([], [codexRow({ isExec: true })])).size).toBe(0)
    // never learnt: a print or background Claude, another environment's, a Codex not known for certain, or none
    expect(seenThreads([ws], snap([claudeRow({ sessionId: 'session-2', kind: 'print' })], [])).size).toBe(0)
    expect(seenThreads([ws], snap([claudeRow({ sessionId: 'session-2', profile: 'claude-work' })], [])).size).toBe(0)
    expect(seenThreads([ws], snap([], [codexRow({ match: 'folder' }), codexRow({ key: 'other-1', tty: 'ttys050', pid: 300 })])).size).toBe(0)
    expect(seenThreads([ws], snap([], [codexRow({ key: 'pid-207', match: undefined })])).size).toBe(0)
  })

  test('the sessions a new workspace can bring in: a Codex terminal only when which conversation it runs is certain', async () => {
    const snap = snapshotOf()
    const listed = (dir?: string, selfId = 'session-elsewhere', s: Snapshot = snap) => bringable(s, { now: NOW, selfId }, dir)
    const members = (dir?: string, selfId?: string, s?: Snapshot) => listed(dir, selfId, s).filter(b => b.blocked === undefined).map(b => b.member)
    // the background session (102) never
    expect(members()).not.toContain('claude:session-102')
    expect(members()).toContain('claude:session-101')
    // web-app has two Codex terminals of one account: 201 holds its rollout open (certain); 207, matched by its command line, is not
    expect(members('/Users/u/dev/web-app')).toContain(`codex:${HELD}`)
    expect(members('/Users/u/dev/web-app')).not.toContain(`codex:${RESUMED_A}`)
    expect(listed('/Users/u/dev/web-app').find(b => b.member === 'codex-tty:ttys045')?.blocked)
      .toBe('which conversation it runs is not certain (other Codex work under this account): close it yourself, then bring in its conversation')
    // the only Codex terminal of its account, nothing else written there since it started: certain
    const alone = { ...snap, codex: snap.codex.filter(c => c.key === RESUMED_A) }
    expect(members('/Users/u/dev/web-app', undefined, alone)).toContain(`codex:${RESUMED_A}`)
    // ...not once another conversation of that account was written since (a /new inside it, or another folder's work)
    const row = alone.codex[0]!
    const elsewhere = { ...alone, codex: [...alone.codex, { ...row, key: 'n-1', cwd: '/Users/u/dev/web-app-worktrees/feat-a', surface: 'cli', tty: '', pid: undefined, match: undefined, updatedAt: NOW }] }
    expect(members('/Users/u/dev/web-app', undefined, elsewhere)).not.toContain(`codex:${RESUMED_A}`)
    // a conversation made in Codex's terminal and open in none is offered, closed, once every terminal of the account is certain
    const closed = { ...row, key: 'closed-1', surface: 'cli', tty: '', pid: undefined, match: undefined, startedAt: undefined, updatedAt: NOW - 300_000 }
    expect(listed('/Users/u/dev/web-app', undefined, { ...snap, codex: [closed] }).find(b => b.member === 'codex:closed-1')).toMatchObject({ isClosed: true, label: `Codex · ${row.title} (closed)` })
    expect(members('/Users/u/dev/web-app', undefined, { ...snap, codex: [closed, { ...row, updatedAt: NOW - 600_000, startedAt: NOW - 3600_000 }] })).not.toContain('codex:closed-1')
    // ...never one written in the last minute (it may be open somewhere still)
    expect(members('/Users/u/dev/web-app', undefined, { ...snap, codex: [{ ...closed, updatedAt: NOW - 30_000 }] })).not.toContain('codex:closed-1')
    // this session itself never; another repository's never; one in a workspace's panes never
    expect(members(undefined, 'session-101')).not.toContain('claude:session-101')
    expect(members('/Users/u/dev/api')).not.toContain('claude:session-101')
    const inWs = { ...snap, workspaces: [practice], tmux: { panes: { ttys004: { session: 'ws-practice-rbac', window: 'claude', pane: '%1' } }, clients: {} } }
    expect(members(undefined, '', inWs)).not.toContain('claude:session-101')
  })

  test('the relay types into a brought-in agent only once it has finished a turn in the workspace', async () => {
    const ws = { name: 'RBAC', relay: relayOn(), threads: { codex: { id: 'x', dir: '/a', since: NOW - 30_000 } } }
    const sides = (codexAt: number): Partial<Record<'claude' | 'codex', Side>> => ({
      claude: { tool: 'claude', pane: '%1', isBusy: false, turn: done('c1', READY_CODEX, NOW - 10_000) },
      codex: { tool: 'codex', pane: '%2', isBusy: false, turn: done('x0', 'from before', codexAt) },
    })
    expect(relaySteps(ws, sides(NOW - 60_000), NOW).map(s => s.key)).toEqual(['wait-c1'])
    expect(relaySteps(ws, sides(NOW - 20_000), NOW).map(s => s.key)).toEqual(['pass-c1'])
  })

  test('New workspace with it: the session is brought in; checked, re-checked, closed where it ran (that process), and resumed', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // an older workspace kept this Claude conversation (it ran there once)
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, id: 'old', name: 'Old', threads: { claude: { id: 'session-101', dir: '/Users/u/dev/web-app' }, codex: { id: 'x-old', dir: '/a' } } }] }))
    // WEB CONSOLE (ttys004, default environment) between turns, working in web-app
    files.set('/Users/u/.claude/sessions/101.json', JSON.stringify({ ...JSON.parse(files.get('/Users/u/.claude/sessions/101.json')!), status: 'idle', statusUpdatedAt: NOW - 60_000 }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'item:claude-101')
    expect((await ui.find({ key: 'bring claude-101' }))?.props.label).toBe('New workspace with it (n)')
    await ui.press({ key: 'bring claude-101' })
    // the form: its project, its environment, it chosen; the Codex terminal holding its conversation offered, the other shown, not offered
    expect((await ui.find({ key: 'form:project' }))?.props.value).toBe('~/dev/web-app')
    expect((await ui.find({ key: 'form:bring claude:session-101' }))?.props.label).toBe('[x] Claude · WEB CONSOLE')
    expect((await ui.find({ key: `form:bring codex:${HELD}` }))?.props.label).toMatch(/^\[ \] Codex · /)
    expect(await ui.find({ key: 'form:bring codex-tty:ttys045' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('Codex · the terminal in ttys045 · not offered: which conversation it runs is not certain')
    await ui.press({ key: `form:bring codex:${HELD}` })
    await ui.input({ key: 'form:name', text: 'Console', kind: 'change' })
    await ui.input({ key: 'form:purpose', text: 'finish the console', kind: 'change' })
    await ui.press({ key: 'form:create' })
    // each closed where it ran, that very process, then the workspace made with their conversations
    expect(world.stopped).toEqual(['ttys004 claude 101', 'ttys000 codex|node 201'])
    const [old, saved] = JSON.parse(files.get(WORKSPACES)!).workspaces
    // the conversation goes on in the new workspace alone: the old one no longer keeps it
    expect(old.threads).toEqual({ codex: { id: 'x-old', dir: '/a' } })
    expect(saved.threads).toEqual({
      claude: { id: 'session-101', dir: '/Users/u/dev/web-app', flags: ['--dangerously-skip-permissions'], since: saved.createdAt },
      codex: { id: HELD, dir: '/Users/u/dev/web-app', flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], since: saved.createdAt },
    })
    expect(files.get(promptPath(HOME, 'console', 'claude'))).toBe(joinPrompt(saved, 'claude'))
    expect(files.get(promptPath(HOME, 'console', 'codex'))).toBe(joinPrompt(saved, 'codex'))
    expect(files.get(openScriptPath(HOME, 'console'))).toBe(`${openCommand(saved, HOME)}\n`)
    // every check ran before anything was closed, and each was checked again just before its own close
    const order = runs.filter(r => r[2] === MODE_SCRIPT || r[2] === CODEX_MODE_SCRIPT || r[2] === CODEX_TASK_SCRIPT || r[2] === STOP_SCRIPT)
      .map(r => (r[2] === STOP_SCRIPT ? 'stop' : r[2] === CODEX_TASK_SCRIPT ? 'turn' : 'mode'))
    expect(order).toEqual(['mode', 'turn', 'mode', 'stop', 'turn', 'stop'])
    await ui.unmount()
  })

  test('the only Codex terminal of its account is brought in once Codex\'s own records show no other conversation since it started', async ($, on) => {
    const { files, toasts, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // of ~/.codex's terminals, only 207 (matched by its command line) is left
    for (const pid of [201, 208, 209, 211]) world.exited.add(pid)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const create = async (name: string) => {
      if ((await ui.find({ key: 'new-from:/Users/u/dev/web-app' })) === undefined) await reveal(ui, 'tree:/Users/u/dev/web-app')
      await ui.press({ key: 'new-from:/Users/u/dev/web-app' })
      await ui.press({ key: `form:bring codex:${RESUMED_A}` })
      await ui.input({ key: 'form:name', text: name, kind: 'change' })
      await ui.press({ key: 'form:create' })
      return (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    }
    // 'Ship the console', made in a Codex terminal (through Codex's background service), was written 20 hours ago, after
    // 207 started 29 hours ago, though not in the last half hour (so not in the snapshot): which one 207 runs is not certain
    expect(await create('Reports')).toMatch(/Not done: Codex · .* cannot be brought in: which conversation it runs is no longer certain; close it yourself, then bring in its conversation\./)
    expect(world.stopped).toEqual([])
    await ui.press({ key: 'form:cancel' })
    // none since, and its last write over a minute ago: closed, that very process, and resumed
    world.hiddenThreads.add('f')
    await clock.advance(120_000)
    await create('Reports')
    expect(world.stopped).toEqual(['ttys045 codex|node 207'])
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].threads.codex.id).toBe(RESUMED_A)
    expect(toasts.at(-1)).toMatch(/Codex · Find the report writer went on there, each in its own conversation\./)
    await ui.unmount()
  })

  test('a Codex conversation the owner closed is brought in as it is: nothing to close, resumed in the workspace', async ($, on) => {
    const { files, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    // Codex terminal 207 closed by the owner; the account's other terminals are gone too but 201 (it holds its rollout)
    for (const pid of [207, 208, 209, 211]) world.exited.add(pid)
    await clock.advance(120_000)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'tree:/Users/u/dev/web-app')
    await ui.press({ key: 'new-from:/Users/u/dev/web-app' })
    expect((await ui.find({ key: `form:bring codex:${RESUMED_A}` }))?.props.label).toBe('[ ] Codex · Find the report writer (closed)')
    await ui.press({ key: `form:bring codex:${RESUMED_A}` })
    await ui.input({ key: 'form:name', text: 'Reports', kind: 'change' })
    await ui.press({ key: 'form:create' })
    expect(world.stopped).toEqual([])
    const saved = JSON.parse(files.get(WORKSPACES)!).workspaces[0]
    expect(saved.threads).toEqual({ codex: { id: RESUMED_A, dir: '/Users/u/dev/web-app', flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], since: saved.createdAt } })
    await ui.unmount()
  })

  test('bringing in is refused, with nothing closed, for a session at work, with no turn, or under another environment; one busy again at its close is left', async ($, on) => {
    const { files, toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    const said = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    const create = async (o: { codex?: boolean; env?: string } = {}) => {
      if ((await ui.find({ key: 'bring claude-101' })) === undefined) await reveal(ui, 'item:claude-101')
      await ui.press({ key: 'bring claude-101' })
      await ui.input({ key: 'form:name', text: 'Console', kind: 'change' })
      if (o.codex === true) await ui.press({ key: `form:bring codex:${HELD}` })
      if (o.env !== undefined) await ui.select({ key: 'form:env', value: o.env })
      await ui.press({ key: 'form:create' })
      return said()
    }
    // WEB CONSOLE is at work
    expect(await create()).toContain('Not done: Claude · WEB CONSOLE is working: bring it in once its turn is done.')
    await ui.press({ key: 'form:cancel' })
    // between turns, but the form's environment is another
    files.set('/Users/u/.claude/sessions/101.json', JSON.stringify({ ...JSON.parse(files.get('/Users/u/.claude/sessions/101.json')!), status: 'idle', statusUpdatedAt: NOW - 60_000 }))
    await $.command.run(SESSIONS)
    expect(await create({ env: 'work' })).toContain('Not done: Claude · WEB CONSOLE runs under the default environment; choose that one.')
    await ui.press({ key: 'form:cancel' })
    // Codex at work by its whole rollout (a turn longer than the relay's 600 lines), or with no finished turn
    world.codexTask = '"type":"task_started"\n'
    expect(await create({ codex: true })).toMatch(/Not done: Codex · .* is working: bring it in once its turn is done\./)
    await ui.press({ key: 'form:cancel' })
    world.codexTask = ''
    expect(await create({ codex: true })).toMatch(/Not done: Codex · .* has no finished turn to go on from\./)
    await ui.press({ key: 'form:cancel' })
    // 201 no longer holds its rollout (a /new inside it): which conversation it runs is no longer certain
    world.codexTask = '"type":"task_complete"\n'
    world.lsof = 'p201\nfcwd\nn/Users/u/dev/web-app\n'
    expect(await create({ codex: true })).toMatch(/Not done: Codex · .* cannot be brought in: which conversation it runs is no longer certain; close it yourself, then bring in its conversation\./)
    await ui.press({ key: 'form:cancel' })
    world.lsof = undefined
    expect(world.stopped).toEqual([])
    expect(files.get(WORKSPACES)).toBeUndefined()
    // Codex began a turn between the checks and its close: it is left as it was, and the workspace's Codex starts new
    world.codexTask = '"type":"task_complete"\n'
    let checks = 0
    world.codexTaskAnswer = () => (++checks > 1 ? '"type":"task_started"\n' : '"type":"task_complete"\n')
    await create({ codex: true })
    expect(toasts.at(-1)).toMatch(/Not brought in: Codex · .* \(it is working: bring it in once its turn is done; it was left as it was, and the workspace's Codex starts new\)\./)
    const saved = JSON.parse(files.get(WORKSPACES)!).workspaces[0]
    expect(Object.keys(saved.threads)).toEqual(['claude'])
    expect(world.stopped).toEqual(['ttys004 claude 101'])
    await ui.unmount()
  })

  test('opened again, a workspace never resumes a conversation open somewhere else, or written a moment ago', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, threads: { claude: { id: 'session-101', dir: '/Users/u/dev/web-app' } } }] }))
    await $.session.start(START)
    const open = async () => (await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text
    expect(await open()).toBe('Not opened: its agents go on with their own conversations, and Claude\'s runs in ttys004. Close it there first.')
    // Codex's in a terminal, or one written within the last minute (the desktop app, an exec run)
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, threads: { codex: { id: RESUMED_A, dir: '/Users/u/dev/web-app' } } }] }))
    expect(await open()).toBe('Not opened: its agents go on with their own conversations, and Codex\'s runs in ttys045. Close it there first.')
    // its terminal closed, but written 10 s ago (another app may have it open): not yet
    world.exited.add(207)
    await clock.advance(4_000)
    expect(await open()).toMatch(/^Not opened: its agents go on with their own conversations, and Codex's was written a moment ago \(\w+\)\. Close it there first\.$/)
    // one written 5 minutes ago, open in no terminal: opened
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, threads: { codex: { id: 'b', dir: '/Users/u/projects', since: 1 } } }] }))
    expect(await open()).toBe('Opened ws-practice-rbac in a new Terminal window.')
    // resumed anew: the relay types into it only after a turn from now
    expect(JSON.parse(files.get(WORKSPACES)!).workspaces[0].threads.codex.since).toBeGreaterThan(NOW)
    expect(runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT)).toHaveLength(1)
  })
})

describe('the context guard', () => {
  test('Codex compacts right after this session passed its hand-off, when its context is full enough; never otherwise', async () => {
    const ws = { compactAt: undefined as number | undefined }
    const codex = (filled: number | undefined, turn: Side['turn'] = done('x1', READY_CLAUDE)): Side => ({ tool: 'codex', pane: '%2', isBusy: false, turn, ...(filled === undefined ? {} : { filled }) })
    const claude: Side = { tool: 'claude', pane: '%1', isBusy: false, turn: done('c1', READY_CODEX) }
    const passed = { kind: 'pass' as const, key: 'pass-x1', from: 'codex' as const, to: 'claude' as const, pane: '%1', line: READY_CLAUDE }
    const none = new Set<string>()
    // its cue typed into Claude's pane and entered, its context 62% full: /compact, once for that turn
    expect(compactStep(ws, { claude, codex: codex(62) }, passed, 'passed', none)).toEqual({ kind: 'compact', key: 'compact-x1', to: 'codex', pane: '%2', line: '/compact', filled: 62 })
    // a pass not made by this session now (taken: another may still be at it), or not made at all: never
    for (const outcome of ['taken', 'in-mode', 'unsent', 'not-agent zsh', 'gone', 'failed']) expect(compactStep(ws, { claude, codex: codex(90) }, passed, outcome, none)).toBeUndefined()
    // Claude's hand-off: Claude compacts itself; a cue for the owner, or any told step: never
    expect(compactStep(ws, { claude, codex: codex(90) }, { ...passed, key: 'pass-c1', from: 'claude', to: 'codex', pane: '%2' }, 'passed', none)).toBeUndefined()
    expect(compactStep(ws, { claude, codex: codex(90) }, { kind: 'tell', key: 'tell-x1', from: 'codex', text: '', isForOwner: true }, 'told', none)).toBeUndefined()
    // its pane typed into in this collection (it may be starting a turn): not now
    expect(compactStep(ws, { claude, codex: codex(90) }, passed, 'passed', new Set(['%2']))).toBeUndefined()
    // below the line, unknown, off, its turn under way or not a hand-off: nothing
    expect(compactStep(ws, { claude, codex: codex(49) }, passed, 'passed', none)).toBeUndefined()
    expect(compactStep(ws, { claude, codex: codex(undefined) }, passed, 'passed', none)).toBeUndefined()
    expect(compactStep({ compactAt: 0 }, { claude, codex: codex(99) }, passed, 'passed', none)).toBeUndefined()
    expect(compactStep({ compactAt: 70 }, { claude, codex: codex(65) }, passed, 'passed', none)).toBeUndefined()
    expect(compactStep(ws, { claude, codex: codex(90, { state: 'busy', id: 'x2', at: NOW }) }, passed, 'passed', none)).toBeUndefined()
    expect(compactStep(ws, { claude, codex: codex(90, done('x1', 'NEEDS USER · peer-coding/feat-rbac · feat/rbac@abc1234')) }, passed, 'passed', none)).toBeUndefined()
    expect(COMPACT_AT).toBe(50)
    // said after what the pass said
    const compacting = compactStep(ws, { claude, codex: codex(62) }, passed, 'passed', none)!
    expect(afterStep(relayOn({ streak: 3, status: 'passed to Claude' }), compacting, 'passed', NOW)).toEqual(relayOn({ streak: 3, status: 'passed to Claude; Codex compacting (its context 62% full)', at: NOW }))
    expect(afterStep(relayOn({ streak: 3, status: 'passed to Claude' }), compacting, 'in-mode', NOW)).toEqual(relayOn({ streak: 3, status: 'passed to Claude' }))
    // what Claude keeps: one line, whatever the workspace is called
    expect(claudeKeep('RBAC')).toBe('Peer-coding workspace "RBAC": keep what it is for, the peer-coding branch and its worktree, the round, where the peer-coding records are (CURRENT.md), what the owner decided, and the cue you last sent; the details stay in those records.')
    expect(claudeKeep('A\nB\u0007')).toMatch(/^Peer-coding workspace "A B ": keep/)
    // a saved setting this does not read: the default stands
    expect(workspacesFrom({ workspaces: [{ ...practice, compactAt: 70 }, { ...practice, id: 'b', compactAt: 'half' }, { ...practice, id: 'c', compactAt: 150 }] }).map(w => w.compactAt)).toEqual([70, undefined, undefined])
  })

  test('turns: how full Codex\'s context is, from its last count', async () => {
    const turns = parseTurns(['==> /x.jsonl', `done\tturn-1\t2026-10-09T10:05:00Z\t${READY_CLAUDE}\t\t62`, '==> /y.jsonl', 'done\tturn-2\t2026-10-09T10:05:00Z\t\t\t1000', '==> /z.jsonl', 'busy\tturn-3\t2026-10-09T10:05:00Z\t\t\tx'].join('\n'))
    expect([turns.get('/x.jsonl')?.filled, turns.get('/y.jsonl')?.filled, turns.get('/z.jsonl')?.filled]).toEqual([62, undefined, undefined])
  })

  test('the relay passes Codex\'s hand-off, then has Codex compact; never Claude, never a pane it just typed into, never in notify mode', async ($, on) => {
    const { files, runs, clock } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    const at = (ms: number) => new Date(NOW - ms).toISOString()
    // each line typed, once: a step tried again is taken (the ledger), never typed again
    const typed = () => runs.filter(r => r[2] === RELAY_SCRIPT && r[4] === 'pass').map(r => [r[6], r[7], r[9]]).filter((r, i, all) => all.findIndex(o => o[0] === r[0]) === i)
    const kept = () => JSON.parse(files.get(WORKSPACES)!).workspaces[0]
    const collect = async () => {
      await clock.advance(4_000)
      await $.command.run(SESSIONS)
    }
    // Codex hands back with its context 62% full
    world.turns = { 'session-104': `done\tturn-c0\t${at(300_000)}\tReady.`, '/rollouts/a.jsonl': `done\tturn-x1\t${at(60_000)}\t${READY_CLAUDE}\t\t62` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(typed()).toEqual([['pass-turn-x1', '%1', READY_CLAUDE], ['compact-turn-x1', '%2', '/compact']])
    expect(kept().relay.status).toBe('passed to Claude; Codex compacting (its context 62% full)')
    // the next collection: the pass is taken, so nothing more
    await collect()
    expect(typed()).toHaveLength(2)
    // Claude hands over: passed; the relay never types /compact into Claude
    world.turns = { 'session-104': `done\tturn-c1\t${at(30_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x2\t${at(120_000)}\t\t\t90` }
    await collect()
    expect(typed().slice(2)).toEqual([['pass-turn-c1', '%2', READY_CODEX]])
    // both hand over in one collection: Claude's cue goes into Codex's pane first, so Codex is not compacted then
    world.turns = { 'session-104': `done\tturn-c2\t${at(20_000)}\t${READY_CODEX}`, '/rollouts/a.jsonl': `done\tturn-x3\t${at(10_000)}\t${READY_CLAUDE}\t\t90` }
    await collect()
    expect(typed().slice(3).map(t => t[0])).toEqual(['pass-turn-c2', 'pass-turn-x3'])
    // notify mode: nothing is typed, compaction neither
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...kept(), relay: { ...kept().relay, mode: 'notify' } }] }))
    world.turns = { 'session-104': `done\tturn-c4\t${at(9_000)}\tReady.`, '/rollouts/a.jsonl': `done\tturn-x4\t${at(5_000)}\t${READY_CLAUDE}\t\t90` }
    await collect()
    expect(typed()).toHaveLength(5)
  })

  test('a workspace\'s Claude compacts itself after its hand-off to Codex is passed, when its context is full enough', async ($, on) => {
    const { files, clock } = engine(on, machine, { termProgram: 'Apple_Terminal', selfId: 'session-104' })
    let percent = 61
    on('session.usage', async () => ({ value: { startedAt: NOW, context: { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: [] } }))
    const compacted: (string | undefined)[] = []
    // the engine's compaction, recorded: done (a summary left), or vetoed
    let isVetoed = false
    on('session.compact', async ($, e) => {
      compacted.push(e.instructions)
      return isVetoed ? { skip: 'vetoed by the test' } : { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
    })
    // the engine's own end of a turn
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ledger = '/Users/u/Library/Application Support/live-sessions/relayed'
    const end = async (answer: string, id: string) => {
      world.turns = { 'session-104': `done\t${id}\t${new Date(NOW).toISOString()}\t${answer.split('\n').at(-1)}` }
      await $.turn.complete({ answer, durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
    }
    const wait = async (ms: number) => {
      for (let t = 0; t < ms; t += 2_000) await clock.advance(2_000)
    }
    // handed to Codex: it waits for the relay's pass, then compacts, told what to keep
    await end(`Done.\n${READY_CODEX}`, 'turn-c1')
    await wait(4_000)
    expect(compacted).toEqual([])
    files.set(`${ledger}/pass-turn-c1`, '')
    await wait(4_000)
    expect(compacted).toEqual([claudeKeep('Practice RBAC')])
    // done: logged for the ops screen
    expect(world.events.at(-1)).toMatchObject({ kind: 'compact', workspace: 'practice-rbac', agent: 'claude', text: 'Practice RBAC: Claude compacted (its context was 61% full)' })
    // vetoed (a hook, a turn begun): asked, not logged
    isVetoed = true
    await end(`Done.\n${READY_CODEX}`, 'turn-v1')
    files.set(`${ledger}/pass-turn-v1`, '')
    await wait(4_000)
    expect(world.events.filter(e => e.kind === 'compact')).toHaveLength(1)
    expect(compacted).toHaveLength(2)
    isVetoed = false
    // its final reply written a moment after the turn's end: read again until it is
    world.turns = { 'session-104': `busy\tturn-r0\t${new Date(NOW).toISOString()}\t` }
    await $.turn.complete({ answer: `Done.\n${READY_CODEX}`, durationMs: 1_000, isAborted: false, turnId: 'turn-r1', reason: 'answer' })
    await wait(2_000)
    world.turns = { 'session-104': `done\tturn-r1\t${new Date(NOW).toISOString()}\t${READY_CODEX}` }
    files.set(`${ledger}/pass-turn-r1`, '')
    await wait(4_000)
    expect(compacted).toHaveLength(3)
    // cleared into another conversation while it waited: no
    await end(`Done.\n${READY_CODEX}`, 'turn-s1')
    await wait(2_000)
    world.sessionId = 'session-new'
    files.set(`${ledger}/pass-turn-s1`, '')
    await wait(4_000)
    world.sessionId = undefined
    expect(compacted).toHaveLength(3)
    // a cue for the owner: no
    await end('Asking.\nNEEDS USER · peer-coding/feat-rbac · feat/rbac@abc1234', 'turn-c2')
    files.set(`${ledger}/pass-turn-c2`, '')
    await wait(4_000)
    // never passed in two minutes (Codex at work, the relay waiting): no
    await end(`Done.\n${READY_CODEX}`, 'turn-c3')
    await wait(130_000)
    // a new turn began while it waited for the pass: no
    await end(`Done.\n${READY_CODEX}`, 'turn-c4')
    await wait(2_000)
    world.turns = { 'session-104': `busy\tturn-c5\t${new Date(NOW).toISOString()}\t` }
    files.set(`${ledger}/pass-turn-c4`, '')
    await wait(4_000)
    // below the line: no
    percent = 40
    await end(`Done.\n${READY_CODEX}`, 'turn-c6')
    files.set(`${ledger}/pass-turn-c6`, '')
    await wait(4_000)
    expect(compacted).toHaveLength(3)
    // the relay in notify mode, or the guard off: no
    percent = 90
    for (const relay of [relayOn({ mode: 'notify' }), relayOn()]) {
      files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay, ...(relay.mode === 'auto' ? { compactAt: 0 } : {}) }] }))
      await clock.advance(4_000)
      await $.command.run(SESSIONS)
      await end(`Done.\n${READY_CODEX}`, `turn-n-${relay.mode}`)
      files.set(`${ledger}/pass-turn-n-${relay.mode}`, '')
      await wait(4_000)
    }
    expect(compacted).toHaveLength(3)
  })

  test('Compact at, in a workspace\'s actions: 50, 60, 70, 80 percent, off', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, relay: relayOn() }] }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'ws:practice-rbac')
    const label = async () => (await ui.find({ key: 'compact practice-rbac' }))?.props.label
    const seen: unknown[] = [await label()]
    for (let i = 0; i < 5; i++) {
      await ui.press({ key: 'compact practice-rbac' })
      seen.push(JSON.parse(files.get(WORKSPACES)!).workspaces[0].compactAt)
    }
    expect(seen).toEqual(['Compact at: 50% → 60%', 60, 70, 80, 0, 50])
    await ui.unmount()
  })
})

describe('the ops screen', () => {
  test('the relay\'s event log: a hand-off passed or not, what is the owner\'s, a hold, a compaction; nothing for a step taken already', async () => {
    const ws = { id: 'rbac', name: 'RBAC' }
    const pass = { kind: 'pass' as const, key: 'pass-x1', from: 'codex' as const, to: 'claude' as const, pane: '%1', line: READY_CLAUDE }
    expect(eventOf(ws, pass, 'passed')).toEqual({ kind: 'relay', text: `RBAC: Codex → Claude: ${READY_CLAUDE}`, workspace: 'rbac', agent: 'claude' })
    expect(eventOf(ws, pass, 'not-agent zsh')).toEqual({ kind: 'failed', text: 'RBAC: not passed to Claude: its pane runs zsh, not the agent', workspace: 'rbac', agent: 'claude' })
    for (const outcome of ['taken', 'in-mode']) expect(eventOf(ws, pass, outcome)).toBeUndefined()
    expect(eventOf(ws, { kind: 'tell', key: 'tell-c2', from: 'claude', text: 'RBAC: Claude needs you. NEEDS USER · x', isForOwner: true }, 'told')).toEqual({ kind: 'needs', text: 'RBAC: Claude needs you. NEEDS USER · x', workspace: 'rbac', agent: 'claude' })
    expect(eventOf(ws, { kind: 'tell', key: 'tell-c3', from: 'claude', text: 'paste it', isForOwner: false }, 'told')?.kind).toBe('notify')
    expect(eventOf(ws, { kind: 'tell', key: 'cap-c4', text: 'held', isForOwner: true }, 'told')).toEqual({ kind: 'waits', text: 'held', workspace: 'rbac' })
    expect(eventOf(ws, { kind: 'compact', key: 'compact-x1', to: 'codex', pane: '%2', line: '/compact', filled: 62 }, 'passed')).toEqual({ kind: 'compact', text: 'RBAC: Codex compacting (its context 62% full)', workspace: 'rbac', agent: 'codex' })
    expect(eventOf(ws, { kind: 'compact', key: 'compact-x1', to: 'codex', pane: '%2', line: '/compact', filled: 62 }, 'unsent')).toBeUndefined()
    // a tell that did not happen is no event; an event's text is cut to 500 characters
    expect(eventOf(ws, { kind: 'tell', key: 'tell-c2', from: 'claude', text: 'x', isForOwner: true }, 'failed')).toBeUndefined()
    // cut by bytes, whole characters kept: well under 1 KB a line whatever the script
    expect(cutBytes('要'.repeat(400), 600)).toBe('要'.repeat(200))
    expect(cutBytes('a要', 3)).toBe('a')
    expect(cutBytes('ok', 600)).toBe('ok')
    // as written in a JSON line: a quote or a backslash takes two
    expect(cutBytes('"\\"\\', 5)).toBe('"\\')
    expect(JSON.stringify(cutBytes('"'.repeat(900), 600)).length).toBeLessThanOrEqual(602)
    const cut = eventOf(ws, { ...pass, line: `READY FOR CLAUDE · ${'要'.repeat(2000)}` }, 'passed')!.text
    expect([...cut].reduce((n, ch) => n + (ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : 3), 0)).toBeLessThanOrEqual(600)
    expect(cut.endsWith('要')).toBe(true)
  })

  test('the collecting session writes what the relay did to the event log', async ($, on) => {
    const { files } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [{ ...practice, checkout: '/Users/u/dev/web-app', relay: relayOn() }] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys022\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxOwner = String(NOW)
    world.paneCommands = { '%1': 'claude', '%2': 'codex' }
    world.turns = { 'session-104': `done\tturn-c0\t${new Date(NOW - 300_000).toISOString()}\tReady.`, '/rollouts/a.jsonl': `done\tturn-x1\t${new Date(NOW - 60_000).toISOString()}\t${READY_CLAUDE}\t\t62` }
    await $.session.start(START)
    await $.command.run(SESSIONS)
    expect(world.events.map(e => [e.kind, e.workspace, e.agent])).toEqual([['relay', 'practice-rbac', 'claude'], ['compact', 'practice-rbac', 'codex']])
    expect(world.events.every(e => typeof e.at === 'number')).toBe(true)
  })

  test('Ops screen opens the ops console, from this plugin\'s folder, in a Terminal window over the screen in use', async ($, on) => {
    const { runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await ui.press({ key: 'ops' })
    const opened = runs.find(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT)
    expect(opened?.[5]).toMatch(/^node --no-warnings '\/.*\/ops\/ops\.mjs'$/)
    expect(JSON.parse(opened![6]!)).toMatchObject({ x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number), fontSize: expect.any(Number) })
    await ui.unmount()
  })

  test('outside Terminal.app there is no Ops screen button: it opens a Terminal window', async ($, on) => {
    engine(on, machine, { termProgram: 'vscode' })
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    expect(await ui.find({ key: 'ops' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('hiding a workspace window', () => {
  test('its status bar hides it: hide.sh written, the click bound over tmux\'s own, the bar says so', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Practice RBAC' })).text).toMatch(/^Created Practice RBAC/)
    // once the window made the session, it is prepared
    expect(files.get(hidePath(HOME))).toBe(HIDE_SCRIPT)
    expect(runs.find(r => r[0] === 'tmux' && r[1] === 'bind-key')).toEqual(['tmux', ...hideBinding(hidePath(HOME))!])
    const right = runs.filter(r => r[0] === 'tmux' && r[1] === 'set-option' && r[4] === 'status-right').map(r => r[5])
    expect(right).toEqual([HIDE_LABEL])
    // the click on Hide runs hide.sh with the terminal; any other click on the bar is still tmux's own
    expect(hideBinding('/h/hide.sh')).toEqual(['bind-key', '-T', 'root', 'MouseDown1Status', 'if-shell', '-F', '#{==:#{mouse_status_range},ls-hide}', `run-shell -b "/bin/sh '/h/hide.sh' '#{client_tty}' >/dev/null 2>&1"`, 'switch-client -t ='])
    expect(hideBinding("/it's/hide.sh")).toBeUndefined()
    expect(hideBinding('/a#b/hide.sh')).toBeUndefined()
  })

  test('a click on the bar the person bound to something of theirs stays theirs; the bar then only says closing keeps the agents', async ($, on) => {
    const { runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    world.statusClick = 'bind-key -T root MouseDown1Status select-pane -t ='
    await $.session.start(START)
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'new ~/dev/web-app work Practice RBAC' })
    expect(runs.filter(r => r[0] === 'tmux' && r[1] === 'bind-key')).toEqual([])
    expect(runs.filter(r => r[0] === 'tmux' && r[1] === 'set-option' && r[4] === 'status-right').map(r => r[5])).toEqual([KEEPS_LABEL])
    expect([mayBindHide('bind-key -T root MouseDown1Status switch-client -t ='), mayBindHide(`bind-key -T root MouseDown1Status if-shell -F "#{==:#{mouse_status_range},ls-hide}" x y`), mayBindHide('bind-key -T root MouseDown1Status select-pane -t =')]).toEqual([true, true, false])
  })

  test('a workspace opened again after its session ended (a restart) gets its Hide too', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    await $.session.start(START)
    expect((await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })).text).toBe('Opened ws-practice-rbac in a new Terminal window.')
    expect(runs.filter(r => r[0] === 'tmux' && r[1] === 'set-option' && r[4] === 'status-right').map(r => r[5])).toEqual([HIDE_LABEL])
  })

  test('Hide leaves a tmux session not started for the workspace as it is', async ($, on) => {
    const { files, runs, toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys004\t%1\tclaude\n'
    world.tmuxClients = 'ws-practice-rbac\t/dev/ttys001\n'
    world.tmuxOwner = '12345'
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'ws:practice-rbac')
    await ui.press({ key: 'hide practice-rbac' })
    expect(runs.filter(r => r[0] === '/bin/sh' && r[1] === hidePath(HOME))).toEqual([])
    expect(toasts.at(-1)).toBe('Not hidden: tmux session ws-practice-rbac was not started for Practice RBAC.')
    await ui.unmount()
  })

  test('Hide window in a workspace\'s actions hides each window attached to it; the agents keep running', async ($, on) => {
    const { files, runs, toasts } = engine(on, machine, { termProgram: 'Apple_Terminal' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    world.tmuxPanes = 'ws-practice-rbac\tpeers\t/dev/ttys004\t%1\tclaude\nws-practice-rbac\tpeers\t/dev/ttys045\t%2\tcodex\n'
    world.tmuxClients = 'ws-practice-rbac\t/dev/ttys001\nws-practice-rbac\t/dev/ttys002\nother\t/dev/ttys003\n'
    world.tmuxOwner = String(NOW)
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const ui = await $.ui.mount({ plugin: 'live-sessions', surface: 'terminal', ...PANE, props: paneProps(110) })
    await reveal(ui, 'ws:practice-rbac')
    await ui.press({ key: 'hide practice-rbac' })
    expect(runs.filter(r => r[0] === '/bin/sh' && r[1] === hidePath(HOME)).map(r => r[2])).toEqual(['/dev/ttys001', '/dev/ttys002'])
    expect(files.get(hidePath(HOME))).toBe(HIDE_SCRIPT)
    expect(toasts.at(-1)).toBe('Practice RBAC hidden: its agents keep running; Open brings it back.')
    await ui.unmount()
  })
})

describe('workspace windows open where they were', () => {
  test('placements: kept ones checked; the first is most of the screen, in the font of the window it is opened from', async () => {
    expect(placementFrom({ x: 10.4, y: 20, width: 1200, height: 800, fontSize: 13 })).toEqual({ x: 10, y: 20, width: 1200, height: 800, fontSize: 13 })
    expect(placementFrom({ x: 0, y: 0, width: 1200, height: 800, fontSize: 200 })?.fontSize).toBe(0)
    for (const bad of [null, 'x', { x: 0, y: 0, width: 100, height: 800 }, { x: 'a', y: 0, width: 1200, height: 800 }, { y: 0, width: 1200, height: 800 }]) expect(placementFrom(bad)).toBeUndefined()
    expect(defaultPlacement({ x: 0, y: 30, width: 2560, height: 1410 }, 14)).toEqual({ x: 192, y: 136, width: 2176, height: 1199, fontSize: 14 })
    expect(defaultPlacement({ x: 0, y: 30, width: 2560, height: 1410 }, 0).fontSize).toBe(0)
    // still showing: at least a quarter of it on a screen there is now
    const screens = [{ x: 0, y: 30, width: 2560, height: 1410 }]
    expect([isOnScreen({ x: 100, y: 100, width: 1000, height: 800, fontSize: 0 }, screens), isOnScreen({ x: 2300, y: 100, width: 1000, height: 800, fontSize: 0 }, screens), isOnScreen({ x: 5200, y: -2000, width: 1000, height: 800, fontSize: 0 }, screens)]).toEqual([true, true, false])
    expect(isOnScreen({ x: 2500, y: 100, width: 1000, height: 800, fontSize: 0 }, screens)).toBe(false)
  })

  test('a new window opens where the workspace\'s was when hidden; else most of the screen, in this tab\'s font', async ($, on) => {
    const { files, runs } = engine(on, machine, { termProgram: 'Apple_Terminal', selfId: 'session-104' })
    files.set(WORKSPACES, JSON.stringify({ version: 1, workspaces: [practice] }))
    await $.session.start(START)
    await $.command.run(SESSIONS)
    const opens = () => runs.filter(r => r[0] === '/usr/bin/osascript' && r[4] === OPEN_SCRIPT).map(r => (r[6] === undefined ? undefined : JSON.parse(r[6])))
    // never hidden: the screen, and the font of this session's tab (ttys022)
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })
    expect(runs.find(r => r[4] === SCREEN_SCRIPT)?.[5]).toBe('ttys022')
    expect(opens().at(-1)).toEqual({ x: 192, y: 136, width: 2176, height: 1199, fontSize: 12 })
    // hidden before: where it was
    world.started.clear()
    files.set(placementPath(HOME, 'ws-practice-rbac'), JSON.stringify({ x: 40, y: 60, width: 1500, height: 900, fontSize: 13 }))
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })
    expect(opens().at(-1)).toEqual({ x: 40, y: 60, width: 1500, height: 900, fontSize: 13 })
    // kept where no screen is now (a display unplugged): most of the screen in use instead
    world.started.clear()
    files.set(placementPath(HOME, 'ws-practice-rbac'), JSON.stringify({ x: 5200, y: -2000, width: 1500, height: 900, fontSize: 13 }))
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })
    expect(opens().at(-1)).toEqual({ x: 192, y: 136, width: 2176, height: 1199, fontSize: 12 })
    // on the second screen: kept
    world.started.clear()
    files.set(placementPath(HOME, 'ws-practice-rbac'), JSON.stringify({ x: 2700, y: 100, width: 1500, height: 900, fontSize: 13 }))
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })
    expect(opens().at(-1)).toEqual({ x: 2700, y: 100, width: 1500, height: 900, fontSize: 13 })
    // a kept file that is not a placement is not used
    world.started.clear()
    files.set(placementPath(HOME, 'ws-practice-rbac'), '{"x": "far"}')
    await $.command.run({ ...SESSIONS, command: 'workspace', args: 'open practice-rbac' })
    expect(opens().at(-1)).toEqual({ x: 192, y: 136, width: 2176, height: 1199, fontSize: 12 })
  })
})
