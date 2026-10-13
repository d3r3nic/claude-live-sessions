import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BackgroundTask, ClaudeSession, CodexSession, Place, Relay, SessionContext, Snapshot, Thread, UsageView, Workspace } from '../types'
import { accountOfFile, applyScan, claudeLimits, clockOf, currentLimits, EMPTY_USAGE, limitSaid, markKey, mergeLimits, offsetOf, OFFSETS_SCRIPT, parseContexts, rankUsage, scanInput, sharedLimitsFrom, usageFrom, USAGE_FILES_SCRIPT, USAGE_KEEP_MS, WINDOW_MS, wholeFiles } from './usage'
import type { Limit, UsageState } from './usage'
import { AGENT_COMMANDS, afterOwner, afterStep, claudeKeep, COMPACT_FROM, cueOf, cutBytes, eventOf, EVENT_SCRIPT, parseTurns, passFailure, RELAY_CAP, RELAY_SCRIPT, relaySteps, tokensSaid, TURN_SCRIPT } from './relay'
import type { RelayEvent, Side, Step } from './relay'
import { branchOf, checkDue, DRIFT_EVERY, driftRequest, isDueAfterCompaction, parseVerdict, recordFolderOf, RECORDS_SCRIPT } from './drift'
import { hiddenNames, hideInTree, hideNames, hidingFrom, namesPath, namesProblem, NO_HIDING, turned } from './names'
import type { Hiding } from './names'
import { bringable, codexDir, envOfProfile, isKnownCodex, CODEX_FOLDER_SCRIPT, CODEX_TASK_SCRIPT, codexTaskState, JOB_COMMANDS, ROLLOUT_SCRIPT, seenThreads, STOP_SCRIPT, toggled, withThreads } from './bring'
import {
  agentsOf,
  CHECKOUT_SCRIPT,
  CLIENTS_FORMAT,
  PROJECTS_SCRIPT,
  PANES_FORMAT,
  assigned,
  envsFrom,
  findWorkspace,
  OWNER_OPTION,
  isLeftover,
  isOwnPane,
  isQuietPane,
  paneStates,
  PANE_STATE_FORMAT,
  parentsFrom,
  REQUEST_FILE,
  REQUEST_MAX_AGE_MS,
  requestFrom,
  requestsDir,
  openCommand,
  parseClients,
  parsePanes,
  parseWorkspaceArgs,
  slugOf,
  tmuxName,
  workspacesFrom,
  absoluteDir,
  checkoutResult,
  peerPrompt,
  openScriptPath,
  promptPath,
  rankProjects,
  shellQuote,
  sessionSetup,
  setupPrompt,
  joinPrompt,
  soloPrompt,
  BRANCH_SCRIPT,
  headOf,
  parseWorktrees,
  typedPath,
  whereFrom,
  WHERE_SCRIPT,
  WORKTREES_SCRIPT,
  agentPlacement,
  screensFrom,
  workspacePlacement,
  hideBinding,
  hidePath,
  placementFrom,
  placementPath,
  SCREEN_SCRIPT,
  HIDE_SCRIPT,
  mayBindHide,
} from './workspaces'
import {
  ACTIVE_MS,
  AGENT_MS,
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
  ago,
  claudeFromRegistry,
  claudeState,
  codexProcFrom,
  codexSessions,
  codexTerminals,
  isClaudeProcess,
  isAttachTo,
  isForeground,
  isShell,
  modeFlags,
  normalPath,
  PLACE_SCRIPT,
  RECENT_SCRIPT,
  REPOS_SCOPE,
  WORKSPACES_SCOPE,
  itemsScope,
  moved,
  orderFrom,
  treesScope,
  parseBackground,
  parseEnv,
  parsePs,
  parseRollouts,
  parsePlaces,
  parseRecent,
  parseTasks,
  parseThreads,
  profileOf,
  readOnlyArgs,
  registryPid,
  resumeCommand,
  shownIn,
  sortClaude,
  statusSummary,
  tasksNow,
  threadQuery,
  transcriptPath,
  viewOf,
  windowFrom,
  windowLabel,
  workDir,
  WORKING_MS,
  isFromTerminal,
  isSnapshot,
  SHARED_VERSION,
  ALL_ACCOUNTS,
  forAccount,
} from './collect'
import type { CodexProc, Item, Proc, ThreadRow } from './collect'

type Element = ReturnType<typeof h>

const PANE = 'live-sessions'
const TITLE = 'Sessions'
const TICK_MS = 4_000
/** How old a snapshot may be while the pane is in view. */
const VISIBLE_MAX_AGE_MS = 3_500
/** How old it may be for the status line alone. */
const IDLE_MAX_AGE_MS = 30_000
/** How long the rollout files codex terminals hold are trusted before `lsof` reads them again. */
const LSOF_MAX_AGE_MS = 30_000
/** How long a directory's repository, worktree and branch are trusted before git is asked again. */
const PLACE_MAX_AGE_MS = 120_000
/** The activity windows the pane offers; `/sessions 4d` or `12h` sets any other. */
const WINDOWS = [
  { label: '1d', hotkey: '1', ms: 86_400_000 },
  { label: '2d', hotkey: '2', ms: 2 * 86_400_000 },
  { label: '3d', hotkey: '3', ms: 3 * 86_400_000 },
  { label: '7d', hotkey: '7', ms: 7 * 86_400_000 },
  { label: 'all', hotkey: 'a', ms: 0 },
] as const
/** `ps` start times in the registry's spelling: English month names, UTC. */
const PS_ENV = { LC_ALL: 'C', TZ: 'UTC' }
/**
 * One snapshot shared by every session on the machine, so the processes run
 * once per interval however many sessions show it.
 */
const sharedPath = (home: string) => `${home}/Library/Caches/live-sessions/snapshot.json`

const EMPTY: Snapshot = {
  claude: [], codex: [], places: {}, workspaces: [], envs: [], tmux: { panes: {}, clients: {} }, checkedAt: 0, problems: [],
}
/** The workspaces, kept where every profile's sessions read them. */
const workspacesPath = (home: string) => `${home}/Library/Application Support/live-sessions/workspaces.json`
const UNREADABLE = 'its list cannot be read; fix or move ~/Library/Application Support/live-sessions/workspaces.json'
const snapshot = atom({ plugin: 'live-sessions', key: 'snapshot' } as const, EMPTY)
/**
 * The pane is painted in the terminal's own background: the engine fills a
 * pane with the theme's panel color, which under an ANSI theme is whatever
 * the terminal's palette makes of it, and gray text on it may not read.
 */
const background = atom({ plugin: 'live-sessions', key: 'background' } as const, '')
/** Each tool's own color, dark enough to read on white and on the terminal's background. */
const TOOL_COLOR = { claude: '#c15f3c', codex: '#1f5fd0' } as const
/** An idle session's row. */
const IDLE_BACKGROUND = '#ffffff'
/** A session's background work listed under its row: the oldest this many, then how many more. */
const TASKS_SHOWN = 3

/** The activity window; kept across sessions in `$.store` as `windowMs`. */
const activeWindow = atom({ plugin: 'live-sessions', key: 'window' } as const, 0)
/** Every account's sessions and workspaces shown, not only this session's account's; kept across sessions. */
const allAccounts = atom({ plugin: 'live-sessions', key: 'allAccounts' } as const, false)
/** A move to the background asked for once: the row, and when. A second press within CONFIRM_MS makes it. */
const pendingMove = atom({ plugin: 'live-sessions', key: 'pendingMove' } as const, { key: '', at: 0 })
const CONFIRM_MS = 6_000

const NO_DRAFT = { isOpen: false, name: '', query: '', dir: '', env: '', purpose: '', error: '', bring: [] as string[], only: '' as '' | 'claude' | 'codex', goOn: '', choices: [] as string[] }
/** The new-workspace form. */
const draft = atom({ plugin: 'live-sessions', key: 'draft' } as const, NO_DRAFT)
/** The session whose workspace is being chosen. */
const assigning = atom({ plugin: 'live-sessions', key: 'assigning' } as const, { key: '', member: '' })
/** A workspace is being made in this session. */
const creating = atom({ plugin: 'live-sessions', key: 'creating' } as const, false)
/** The row whose actions are shown, as `item:<key>`, `tree:<key>`, `repo:<key>` or `ws:<id>`; '' for none. */
const selected = atom({ plugin: 'live-sessions', key: 'selected' } as const, '')
/** The git repositories on this Mac, for the form; looked for when it opens. */
const projects = atom({ plugin: 'live-sessions', key: 'projects' } as const, [] as string[])
/** The worktrees of the form's project its agents can go on with, as found for its folder. */
const worktrees = atom({ plugin: 'live-sessions', key: 'worktrees' } as const, { dir: '', list: [] as { path: string; branch: string }[] })
/** Where the relay keeps each step it took, so no step is taken twice. */
const ledgerPath = (home: string) => `${home}/Library/Application Support/live-sessions/relayed`

/** The person's own order of repositories, worktrees and sessions; kept in `$.store` as `order`. */
const manualOrder = atom({ plugin: 'live-sessions', key: 'order' } as const, {} as Record<string, string[]>)
/** The names kept off the screens, and their switch (ABC-XYZ), as the shared file last said. */
const hiding = atom({ plugin: 'live-sessions', key: 'hiding' } as const, NO_HIDING)

/** Registry files already parsed, by path, kept while their mtime holds. */
const registry = new Map<string, { mtimeMs: number; raw: unknown }>()
let held: { key: string; at: number; byPid: Map<number, string[]> } | undefined
const placed = new Map<string, { at: number; place: Place }>()
/** After a git run that failed, how long before its directories are asked again. */
const GIT_RETRY_MS = 30_000
let recentRead: { key: string; at: number; dirs: Map<string, string[]> } | undefined
/** How long the working directories sessions recorded are trusted before they are read again. */
const RECENT_MAX_AGE_MS = 30_000
/** The refresh under way, which a second caller joins rather than starting another. */
let inFlight: Promise<void> | undefined
let lastAttemptAt = 0

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function claudeSessions(
  $: EngineInterface,
  files: readonly { dir: string; path: string; mtimeMs: number }[],
  procs: ReadonlyMap<number, Proc>,
  home: string,
): Promise<ClaudeSession[]> {
  const rows = await Promise.all(
    files.map(async f => {
      let cached = registry.get(f.path)
      if (cached?.mtimeMs !== f.mtimeMs) {
        const raw = await $.fs
          .read(f.path)
          .then(text => JSON.parse(text) as unknown)
          .catch(() => undefined)
        cached = { mtimeMs: f.mtimeMs, raw }
        registry.set(f.path, cached)
      }
      return claudeFromRegistry(cached.raw, profileOf(f.dir), procs, home)
    }),
  )
  return sortClaude(rows.filter(row => row !== undefined))
}

/** The rollout files each terminal holds open, read again at most every LSOF_MAX_AGE_MS. */
async function heldRollouts($: EngineInterface, pids: readonly number[], now: number) {
  const key = [...pids].sort((a, b) => a - b).join(',')
  if (held?.key !== key || now - held.at >= LSOF_MAX_AGE_MS) {
    // lsof exits 1 when one of the pids has gone: what it printed still holds;
    // -n -P: no name lookups, which a slow or absent network would stall
    const out = await $.process
      .run(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', key, '-Fpn'], { timeoutMs: 10_000 })
      .catch(() => undefined)
    held = { key, at: now, byPid: parseRollouts(out?.stdout ?? '') }
  }
  return held.byPid
}

/** Each directory's repository, worktree and branch: git asked once for all that are not known from the last PLACE_MAX_AGE_MS. */
async function placesOf($: EngineInterface, dirs: readonly string[], now: number, problems: string[]) {
  const wanted = [...new Set(dirs)].filter(dir => dir.startsWith('/'))
  const unknown = wanted.filter(dir => {
    const known = placed.get(dir)
    return known === undefined || now - known.at >= PLACE_MAX_AGE_MS
  })
  if (unknown.length > 0) {
    // a directory outside any repository prints nothing but its header and `--`: a folder of its own
    const out = await $.process
      .run(['/bin/sh', '-c', PLACE_SCRIPT, 'sh', ...unknown], { timeoutMs: 20_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
    const found = parsePlaces(out.stdout)
    // a failed run is said; its directories are asked again after GIT_RETRY_MS, not on every collection
    if (out.exitCode !== 0 && found.size < unknown.length) problems.push(`git: ${firstLine(out.stderr) || `exit ${out.exitCode}`}`)
    for (const dir of unknown) {
      const place = found.get(dir)
      placed.set(dir, place !== undefined
        ? { at: now, place }
        : { at: now - PLACE_MAX_AGE_MS + GIT_RETRY_MS, place: { repo: '', name: '', tree: dir, branch: '' } })
    }
  }
  const fallback = (dir: string): Place => ({ repo: '', name: '', tree: dir, branch: '' })
  return Object.fromEntries(wanted.map(dir => [dir, placed.get(dir)?.place ?? fallback(dir)] as const))
}

/**
 * The working directories each file records lately, oldest first: one
 * pipeline for all of them, read again at most every RECENT_MAX_AGE_MS
 * (where a session works moves slowly; the pane in view refreshes faster).
 */
async function recentDirs($: EngineInterface, files: readonly string[], now: number) {
  if (files.length === 0) return new Map<string, string[]>()
  const key = [...files].sort().join('\n')
  if (recentRead?.key === key && now - recentRead.at < RECENT_MAX_AGE_MS) return recentRead.dirs
  const out = await $.process
    .run(['/bin/sh', '-c', RECENT_SCRIPT, 'sh', ...files], { timeoutMs: 20_000 })
    .catch(() => undefined)
  const dirs = parseRecent(out?.stdout ?? '')
  if (out !== undefined) recentRead = { key, at: now, dirs }
  return dirs
}

/**
 * Each file's context at its last request (usage.pl ctx, over its last 256
 * KB): one run for all of them, read again at most every CONTEXT_MAX_AGE_MS.
 */
async function contextsOf($: EngineInterface, files: readonly string[], now: number) {
  if (files.length === 0) return new Map<string, SessionContext>()
  const key = [...files].sort().join('\n')
  if (contextRead?.key === key && now - contextRead.at < CONTEXT_MAX_AGE_MS) return contextRead.contexts
  const out = await $.process
    .run(['/usr/bin/perl', `${$.plugin.root}/hooks/usage.pl`, 'ctx', ...files], { timeoutMs: 20_000 })
    .catch(() => undefined)
  const contexts = parseContexts(out?.stdout ?? '')
  if (out !== undefined) contextRead = { key, at: now, contexts }
  return contexts
}
let contextRead: { key: string; at: number; contexts: Map<string, SessionContext> } | undefined
const CONTEXT_MAX_AGE_MS = 10_000

/**
 * The background work each session started and has not seen end, by its transcript (tasks.pl, from when its process
 * started): one run for all of them, read again at most every TASKS_MAX_AGE_MS, and at once when a session's state
 * changes. Only sessions not idle are read: an idle one has none running, as Claude Code's own status says.
 */
async function tasksOf($: EngineInterface, sessions: readonly { file: string; since: number; status: string }[], now: number) {
  if (sessions.length === 0) return new Map<string, BackgroundTask[]>()
  const key = sessions.map(s => `${s.since} ${s.status} ${s.file}`).sort().join('\n')
  if (tasksRead?.key === key && now - tasksRead.at < TASKS_MAX_AGE_MS) return tasksRead.tasks
  const out = await $.process
    .run(['/usr/bin/perl', `${$.plugin.root}/hooks/tasks.pl`, ...sessions.flatMap(s => [String(s.since), s.file])], { timeoutMs: 20_000 })
    .catch(() => undefined)
  const tasks = parseTasks(out?.stdout ?? '')
  if (out !== undefined) tasksRead = { key, at: now, tasks }
  return tasks
}
let tasksRead: { key: string; at: number; tasks: Map<string, BackgroundTask[]> } | undefined
const TASKS_MAX_AGE_MS = 10_000

async function codexThreads(
  $: EngineInterface,
  codexHome: string,
  terminals: readonly CodexProc[],
  now: number,
  problems: string[],
): Promise<ThreadRow[] | undefined> {
  const files = await $.fs.list(codexHome).catch(() => [])
  const db = files
    .map(f => /^state_(\d+)\.sqlite$/.exec(f.name))
    .filter(m => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0]
  if (db === undefined) return undefined
  const mine = terminals.filter(t => t.codexHome === codexHome)
  const since = Math.min(now - ACTIVE_MS, ...mine.map(t => t.startedAt - 5_000))
  const ids = mine.flatMap(t => [...t.held, ...(t.resumeId === undefined ? [] : [t.resumeId])])
  const sql = threadQuery(since, now - AGENT_MS, ids)
  const name = profileOf(codexHome.split('/').pop() ?? codexHome)
  try {
    const path = `${codexHome}/${db}`
    const isHeldOpen = await $.fs.exists(`${path}-shm`)
    const out = await $.process.run(
      ['sqlite3', '-json', '-cmd', '.timeout 2000', ...readOnlyArgs(path, isHeldOpen), sql],
      { timeoutMs: 10_000 },
    )
    if (out.exitCode !== 0) {
      problems.push(`${name}: ${firstLine(out.stderr) || `sqlite3 exited ${out.exitCode}`}`)
      return undefined
    }
    return parseThreads(out.stdout)
  } catch (error) {
    problems.push(`${name}: ${message(error)}`)
    return undefined
  }
}

async function collect($: EngineInterface, home: string, now: number): Promise<Snapshot> {
  const problems: string[] = []
  const homeEntries = await $.fs.list(home)
  const dirsLike = (pattern: RegExp) =>
    homeEntries.filter(d => d.kind === 'dir' && pattern.test(d.name)).map(d => d.name)

  const files: { dir: string; path: string; mtimeMs: number; pid: number }[] = []
  for (const dir of dirsLike(/^\.claude(-[\w.-]+)?$/)) {
    const sessionsDir = `${home}/${dir}/sessions`
    if (!(await $.fs.exists(sessionsDir))) continue
    try {
      for (const f of await $.fs.list(sessionsDir)) {
        const pid = registryPid(f.name)
        if (f.kind === 'file' && pid > 0) files.push({ dir, path: `${sessionsDir}/${f.name}`, mtimeMs: f.mtimeMs, pid })
      }
    } catch (error) {
      problems.push(`${profileOf(dir)}: ${message(error)}`)
    }
  }

  const pgrep = await $.process.run(['/usr/bin/pgrep', '-x', 'codex'], { timeoutMs: 10_000 })
  if (pgrep.exitCode > 1) problems.push(`pgrep: ${firstLine(pgrep.stderr) || `exited ${pgrep.exitCode}`}`)
  const codexPids = new Set(pgrep.stdout.split('\n').filter(l => /^\d+$/.test(l.trim())).map(Number))

  // `ps -p` exits 1 when a listed pid has gone; only what it says on stderr is a fault
  const pids = [...new Set([...files.map(f => f.pid), ...codexPids])]
  let procs = new Map<number, Proc>()
  if (pids.length > 0) {
    const ps = await $.process.run(['/bin/ps', '-ww', '-o', PS_COLUMNS, '-p', pids.join(',')], {
      env: PS_ENV,
      timeoutMs: 10_000,
    })
    if (ps.stderr.trim() !== '') problems.push(`ps: ${firstLine(ps.stderr)}`)
    procs = parsePs(ps.stdout)
  }

  const claudeRows = await claudeSessions($, files.filter(f => procs.has(f.pid)), procs, home)

  const open = codexTerminals(procs, codexPids)
  let terminals: CodexProc[] = []
  if (open.length > 0) {
    const openPids = open.map(p => p.pid)
    const env = await $.process.run(['/bin/sh', '-c', ENV_SCRIPT, 'sh', openPids.join(',')], {
      env: PS_ENV,
      timeoutMs: 10_000,
    })
    const envByPid = parseEnv(env.stdout)
    const byPid = await heldRollouts($, openPids, now)
    terminals = open.map(p => codexProcFrom(p, envByPid.get(p.pid), byPid.get(p.pid) ?? [], home))
  }
  const codexHomes = new Set([
    ...dirsLike(/^\.codex(-[\w.-]+)?$/).map(name => `${home}/${name}`),
    ...terminals.map(t => t.codexHome),
  ])
  const threads = new Map<string, ThreadRow[]>()
  for (const codexHome of codexHomes) {
    const rows = await codexThreads($, codexHome, terminals, now, problems)
    if (rows !== undefined) threads.set(codexHome, rows)
  }
  const started = codexSessions({ terminals, threads, now })

  // each session is listed where it has been working, which its own records say
  const rollouts = new Map([...threads.values()].flat().map(t => [t.id, t.rollout_path] as const))
  const fileOf = new Map<string, string>([
    ...claudeRows.map(s => [`claude-${s.pid}`, transcriptPath(`${home}/.${s.profile}`, s.cwd, s.sessionId)] as const),
    ...started.flatMap(s => {
      const rollout = rollouts.get(s.key)
      return rollout === undefined || rollout === '' ? [] : [[`codex-${s.key}`, rollout] as const]
    }),
  ])
  const recent = await recentDirs($, [...new Set(fileOf.values())], now)
  const recentOf = (key: string) => recent.get(fileOf.get(key) ?? '') ?? []
  const allDirs = [...claudeRows.map(s => s.cwd), ...started.map(s => s.cwd), ...[...recent.values()].flat()]
  const known = await placesOf($, allDirs, now, problems)
  // and how large its context is, as its records say
  const contexts = await contextsOf($, [...new Set(fileOf.values())], now)
  const contextOf = (key: string) => {
    const context = contexts.get(fileOf.get(key) ?? '')
    return context === undefined ? {} : { context }
  }
  // and the background work it has going (a session whose process start the registry does not say is not read: every
  // task its transcript ever started would count)
  const busyRows = claudeRows.filter(s => s.status !== 'idle' && (s.startedAt ?? 0) > 0)
  const tasks = await tasksOf($, busyRows.map(s => ({ file: fileOf.get(`claude-${s.pid}`)!, since: s.startedAt!, status: s.status })), now)
  const tasksFor = (s: ClaudeSession) => {
    const going = tasksNow(s.status, busyRows.includes(s) ? (tasks.get(fileOf.get(`claude-${s.pid}`)!) ?? []) : [], now)
    return going.length === 0 ? {} : { tasks: going }
  }
  const claude = claudeRows.map(s => ({ ...s, cwd: workDir(s.cwd, recentOf(`claude-${s.pid}`), known), ...contextOf(`claude-${s.pid}`), ...tasksFor(s) }))
  const codex = started.map(s => ({ ...s, cwd: workDir(s.cwd, recentOf(`codex-${s.key}`), known), ...contextOf(`codex-${s.key}`) }))
  const places = Object.fromEntries(
    [...claude, ...codex].map(s => [s.cwd, known[s.cwd] ?? { repo: '', name: '', tree: s.cwd, branch: '' }] as const),
  )

  const envs = await envsOf($, home, homeEntries)
  const [kept, tmux] = await Promise.all([readWorkspaces($, home), tmuxState($)])
  if (!kept.isReadable) problems.push(`workspaces: ${UNREADABLE}`)
  let workspaces = kept.list
  // the conversation each pane runs, kept: opened again after its tmux session ended, it goes on with them
  const seen = kept.isReadable ? seenThreads(workspaces, { tmux, claude: claudeRows, codex: started }) : new Map<string, { claude?: Thread; codex?: Thread }>()
  // each conversation kept for one workspace only: a newer sighting takes it from any other
  if (seen.size > 0 && (await changeWorkspaces($, home, list => [...seen].reduce((now, [id, threads]) => withThreads(now, id, threads), list)))) {
    workspaces = (await readWorkspaces($, home)).list
  }
  try {
    await passCues($, home, now, { workspaces, tmux, claude: claudeRows, codex: started, fileOf })
    if (workspaces.some(ws => ws.relay !== undefined && ws.relay.mode !== 'off')) workspaces = (await readWorkspaces($, home)).list
  } catch (error) {
    problems.push(`relay: ${message(error)}`)
  }

  return { claude, codex, places, workspaces, envs, tmux, checkedAt: now, problems }
}


/** The workspaces; `isReadable` false when the file is there but is not one, which nothing then overwrites. */
async function readWorkspaces($: EngineInterface, home: string): Promise<{ list: Workspace[]; isReadable: boolean }> {
  // only a file that is not there is an empty list: one there but unreadable (too large, no permission) is kept
  if (!(await $.fs.exists(workspacesPath(home)))) return { list: [], isReadable: true }
  const text = await $.fs.read(workspacesPath(home)).catch(() => undefined)
  if (text === undefined) return { list: [], isReadable: false }
  try {
    const raw = JSON.parse(text) as unknown
    return { list: workspacesFrom(raw), isReadable: Array.isArray((raw as { workspaces?: unknown } | null)?.workspaces) }
  } catch {
    return { list: [], isReadable: false }
  }
}

/**
 * Changes the workspaces as they are now: read again just before writing,
 * so a change another session made meanwhile is kept. Refuses (false) a
 * file it cannot read rather than replace it.
 */
async function changeWorkspaces($: EngineInterface, home: string, change: (list: Workspace[]) => Workspace[]): Promise<boolean> {
  // one change at a time in this session: each reads what the one before it wrote (a check finishing while the relay
  // saves would otherwise write back what it read before, undoing the relay's change)
  const turn = changing.then(async () => {
    const now = await readWorkspaces($, home)
    if (!now.isReadable) return false
    await $.fs.write(workspacesPath(home), `${JSON.stringify({ version: 1, workspaces: change(now.list) }, null, 2)}\n`)
    return true
  })
  changing = turn.catch(() => false)
  return turn
}
let changing: Promise<unknown> = Promise.resolve()

/** tmux's panes and attached terminals; none when no tmux server runs. */
async function tmuxState($: EngineInterface): Promise<Snapshot['tmux']> {
  const run = (args: string[]) =>
    $.process.run(['tmux', ...args], { timeoutMs: 10_000 }).then(out => (out.exitCode === 0 ? out.stdout : '')).catch(() => '')
  const [panes, clients] = await Promise.all([run(['list-panes', '-a', '-F', PANES_FORMAT]), run(['list-clients', '-F', CLIENTS_FORMAT])])
  return { panes: parsePanes(panes), clients: parseClients(clients) }
}

/** The environments on this Mac: '' for the default accounts, then each named pair of profiles. */
async function envsOf($: EngineInterface, home: string, homeEntries?: readonly { name: string; kind: string }[]) {
  const entries = homeEntries ?? (await $.fs.list(home))
  const candidates = entries.filter(d => d.kind === 'dir' && /^\.(claude|codex)(-[a-z0-9][a-z0-9_.-]*)?$/i.test(d.name)).map(d => d.name)
  const profiles = await profileDirs($, home, candidates)
  return envsFrom(candidates, name => profiles.has(name))
}

/** A Claude config directory has sessions or settings; a Codex home has its config or its login. */
async function profileDirs($: EngineInterface, home: string, names: readonly string[]) {
  const found = new Set<string>()
  for (const name of names) {
    const marks = name.startsWith('.claude') ? ['sessions', 'settings.json'] : ['config.toml', 'auth.json']
    for (const mark of marks) {
      if (await $.fs.exists(`${home}/${name}/${mark}`)) {
        found.add(name)
        break
      }
    }
  }
  return found
}

/** Another session's snapshot, when it is younger than `maxAgeMs`. */
async function readShared($: EngineInterface, home: string, now: number, maxAgeMs: number) {
  try {
    const raw = JSON.parse(await $.fs.read(sharedPath(home))) as { version?: unknown; snapshot?: unknown }
    if (raw.version !== SHARED_VERSION || !isSnapshot(raw.snapshot)) return undefined
    const age = now - raw.snapshot.checkedAt
    return age >= 0 && age < maxAgeMs ? raw.snapshot : undefined
  } catch {
    return undefined
  }
}

function refresh($: EngineInterface, maxAgeMs: number): Promise<void> {
  inFlight ??= (async () => {
    const home = (await $.env.get('HOME')) ?? ''
    const now = await $.clock.now()
    lastAttemptAt = now
    let next = await readShared($, home, now, maxAgeMs)
    if (next === undefined) {
      try {
        next = await collect($, home, now)
      } catch (error) {
        // keep the last good rows, their age showing how stale they are
        next = { ...(await read($, snapshot)), problems: [message(error)] }
      }
      if (next.checkedAt === now) {
        // other sessions then collect for themselves; this one still shows what it found
        const shared = JSON.stringify({ version: SHARED_VERSION, snapshot: next })
        await $.fs.write(sharedPath(home), shared).catch(() => undefined)
      }
    }
    const taken = next
    await update($, snapshot, () => taken)
    $.ui.status(await summaryShown($, home, taken))
  })()
    // the environment can go mid-refresh (a reload); its successor starts afresh
    .catch(() => undefined)
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

/** Reads this session's Terminal.app tab background, where the session runs in one. */
async function learnBackground($: EngineInterface) {
  if ((await $.env.get('TERM_PROGRAM')) !== 'Apple_Terminal') return
  const selfId = await $.session.id()
  const tty = (await read($, snapshot)).claude.find(s => s.sessionId === selfId)?.tty
  if (tty === undefined || !/^ttys\d+$/.test(tty)) return
  const out = await $.process
    .run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', BACKGROUND_SCRIPT, tty], { timeoutMs: 5_000 })
    .catch(() => undefined)
  const color = parseBackground(out?.stdout ?? '')
  if (color !== undefined) await update($, background, () => color)
}

/** The account this session's pane, status line and ops screen show: its own, or ALL_ACCOUNTS (also when its own is not known). */
async function shownAccount($: EngineInterface, home: string): Promise<string> {
  const own = await ownEnv($, home)
  return own === undefined || (await read($, allAccounts)) ? ALL_ACCOUNTS : own
}

/** The status line's counts, of the account this session shows. */
async function summaryShown($: EngineInterface, home: string, snap: Snapshot): Promise<string> {
  return statusSummary(forAccount(snap, await shownAccount($, home)))
}

async function toggleAccounts($: EngineInterface) {
  const next = await update($, allAccounts, now => !now)
  await $.store.set('allAccounts', next)
  // the status line follows at once, not at the next collection
  $.ui.status(await summaryShown($, (await $.env.get('HOME')) ?? '', await read($, snapshot)))
}

/** A toast, the hidden names out of sight in it as the shared file says now. */
async function toast($: EngineInterface, text: string, options?: { timeoutMs?: number }) {
  const shown = hideNames(text, hiddenNames(await currentHiding($)))
  if (options === undefined) $.ui.toast(shown)
  else $.ui.toast(shown, options)
}

/** A notification's text, the hidden names out of sight in it as the shared file says now (any session may send it). */
async function told($: EngineInterface, text: string) {
  return hideNames(text, hiddenNames(await currentHiding($).catch(() => NO_HIDING)))
}

/** The shared file as last read (its text and what it says), so it is parsed again only when it changed. */
let namesRead: { text: string; hiding: Hiding } | undefined
/** What the pane last drew: what a press of ABC-XYZ turns from. */
let namesDrawn: Hiding | undefined
/**
 * The names and their switch as the shared file says now (another screen may have turned it). A file gone hides
 * nothing; one that cannot be read, is half written or is not a list of names leaves them as they were, never shown by
 * mistake.
 */
async function currentHiding($: EngineInterface): Promise<Hiding> {
  const path = namesPath((await $.env.get('HOME')) ?? '')
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined) {
    if (await $.fs.exists(path).catch(() => true)) return namesRead?.hiding ?? NO_HIDING
    namesRead = undefined
    return NO_HIDING
  }
  if (namesRead?.text === text) return namesRead.hiding
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return namesRead?.hiding ?? NO_HIDING
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return namesRead?.hiding ?? NO_HIDING
  namesRead = { text, hiding: hidingFrom(raw) }
  return namesRead.hiding
}

/** The names' switch kept for the pane to draw from, as the shared file says now. */
async function readHiding($: EngineInterface) {
  const now = await currentHiding($)
  const before = await read($, hiding)
  if (before.isHidden !== now.isHidden || before.names.join('\n') !== now.names.join('\n')) await update($, hiding, () => now)
}

/**
 * ABC-XYZ: the listed names hidden on every screen, or shown again, the other way from how the pane showed them; with
 * none listed yet, says where they go. A file that cannot be read or is not a list of names is left as it is, and said.
 */
async function toggleHiding($: EngineInterface) {
  const path = namesPath((await $.env.get('HOME')) ?? '')
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined && (await $.fs.exists(path).catch(() => true))) {
    await toast($, `Not turned: ${path} cannot be read.`, { timeoutMs: 15_000 })
    return
  }
  let raw: unknown
  if (text !== undefined) {
    try {
      raw = JSON.parse(text)
    } catch {
      raw = null
    }
  }
  const problem = text === undefined ? undefined : namesProblem(raw)
  if (problem?.isList === false) {
    await toast($, `Not turned: ${path} ${problem.said}; fix it or move it away.`, { timeoutMs: 15_000 })
    return
  }
  const wasHiding = hiddenNames(namesDrawn ?? (await currentHiding($))).length > 0
  const written = turned(raw, !wasHiding)
  try {
    await $.fs.write(path, written)
  } catch (error) {
    await toast($, `Not turned: ${path} cannot be written (${message(error)}).`, { timeoutMs: 15_000 })
    return
  }
  namesRead = { text: written, hiding: hidingFrom(JSON.parse(written)) }
  await update($, hiding, () => namesRead!.hiding)
  if (wasHiding) return
  if (namesRead.hiding.names.length === 0) await toast($, `No names to hide yet: list them in ${path}, as {"names": ["…"]}.`, { timeoutMs: 15_000 })
  else if (problem !== undefined) await toast($, `${path} ${problem.said}.`, { timeoutMs: 15_000 })
}

async function setWindow($: EngineInterface, ms: number) {
  await update($, activeWindow, () => ms)
  await $.store.set('windowMs', ms)
}

/** Moves `key` one place among `shown` (as listed when pressed) in `scope`, and keeps the order. */
async function move($: EngineInterface, scope: string, shown: readonly string[], key: string, delta: -1 | 1) {
  const next = await update($, manualOrder, order => ({ ...order, [scope]: moved(order[scope], shown, key, delta) }))
  await $.store.set('order', next)
}

/**
 * Sets a running workspace session up for use by hand (sessionSetup) in
 * each of its windows, with its status bar's Hide: hide.sh written, and the
 * click bound unless the person bound that click to something of their own.
 */
async function prepareSession($: EngineInterface, home: string, name: string, title: string) {
  const tmux = (args: string[]) =>
    $.process.run(['tmux', ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  const path = hidePath(home)
  await $.fs.write(path, HIDE_SCRIPT)
  const binding = hideBinding(path)
  const listed = await tmux(['list-keys', '-T', 'root', 'MouseDown1Status'])
  const canHide = binding !== undefined && listed.exitCode === 0 && mayBindHide(listed.stdout) && (await tmux(binding)).exitCode === 0
  const windows = (await tmux(['list-windows', '-t', `=${name}`, '-F', '#{window_id}'])).stdout.split('\n').filter(id => /^@\d+$/.test(id.trim())).map(id => id.trim())
  for (const args of sessionSetup(name, windows, canHide, title)) await tmux(args)
}

/**
 * Ends the tmux session `name` when it holds only what a session restore (tmux-resurrect, after a restart) brought back
 * under it: no owner mark (`owner`), empty shells (isLeftover). Answers whether it did.
 */
async function endLeftover($: EngineInterface, name: string, owner: string): Promise<boolean> {
  if (owner !== '') return false
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 10_000 }).catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const listed = await run(['tmux', 'list-panes', '-s', '-t', `=${name}`, '-F', PANE_STATE_FORMAT])
  const ps = await run(['/bin/ps', '-ax', '-o', 'ppid='])
  if (listed.exitCode !== 0 || ps.exitCode !== 0 || !isLeftover(owner, listed.stdout, parentsFrom(ps.stdout))) return false
  return (await run(['tmux', 'kill-session', '-t', `=${name}`])).exitCode === 0
}

/**
 * Each workspace's own tmux session running when a session starts, set up as this version sets one up: one an earlier
 * version made gets Hide beside its name and gives the bar's right end back to tmux.conf (where tmux-continuum saves
 * from), without waiting to be opened again. A session not started for its workspace is left as it is.
 */
async function prepareRunning($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const snap = await read($, snapshot)
  for (const ws of snap.workspaces) {
    if (!Object.values(snap.tmux.panes).some(p => isOwnPane(ws, p))) continue
    if (await isOwnSession($, ws)) await prepareSession($, home, tmuxName(ws), ws.name)
  }
}

/** Whether the running tmux session `ws` would use was started for it (its owner mark is its createdAt). */
async function isOwnSession($: EngineInterface, ws: Workspace) {
  const out = await $.process
    .run(['tmux', 'show-options', '-t', tmuxName(ws), '-qv', OWNER_OPTION], { timeoutMs: 10_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  return out.exitCode === 0 && out.stdout.trim() === String(ws.createdAt)
}

/**
 * After a window was asked to make the workspace's session: once it is
 * there (a few seconds at most), and is this workspace's, it is prepared.
 */
async function prepareWhenMade($: EngineInterface, home: string, ws: Workspace) {
  for (let i = 0; i < 20; i++) {
    const has = await $.process.run(['tmux', 'has-session', '-t', `=${tmuxName(ws)}`], { timeoutMs: 5_000 }).catch(() => ({ exitCode: -1 }))
    if (has.exitCode === 0) {
      if (await isOwnSession($, ws)) await prepareSession($, home, tmuxName(ws), ws.name)
      return
    }
    await $.clock.sleep(250)
  }
}

/** Hides a workspace's windows: each terminal attached to it detached and its Terminal window closed; the agents keep running. */
async function hideWorkspace($: EngineInterface, ws: Workspace) {
  const home = (await $.env.get('HOME')) ?? ''
  if (!(await isOwnSession($, ws))) {
    await toast($, `Not hidden: tmux session ${tmuxName(ws)} was not started for ${ws.name}.`)
    return
  }
  const hidden = await hideWindows($, home, ws)
  await toast($, hidden === 0 ? `${ws.name} has no window open.` : `${ws.name} hidden: its agents keep running; Open brings it back.`)
  await refresh($, 0)
}

/** Each terminal attached to a workspace's session detached and its Terminal window closed (hide.sh); how many there were. */
async function hideWindows($: EngineInterface, home: string, ws: Workspace): Promise<number> {
  await $.fs.write(hidePath(home), HIDE_SCRIPT)
  const listed = await $.process
    .run(['tmux', 'list-clients', '-F', CLIENTS_FORMAT], { timeoutMs: 10_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const ttys = parseClients(listed.stdout)[tmuxName(ws)] ?? []
  for (const tty of ttys) {
    await $.process.run(['/bin/sh', hidePath(home), `/dev/${tty}`], { timeoutMs: 15_000 }).catch(() => undefined)
  }
  return ttys.length
}

/**
 * Closes a workspace for now, to be opened again later: each agent in it, checked between turns, closed as a terminal
 * closing does (its conversation kept for the workspace, which Open goes on with), its windows hidden, then its tmux
 * session ended. Its panes are read as they are now: each runs a shell with nothing under it, or an agent checked as
 * bring-in checks one (its conversation the one kept, between turns, not waiting on the owner, no background work going).
 * Anything else in a pane (a program of the owner's, an agent not known for certain) is never ended: nothing is closed
 * then. Never from the workspace's own Claude, which would close itself first. An agent that began a turn after the
 * checks is left running.
 */
async function closeWorkspace($: EngineInterface, ws: Workspace): Promise<{ isClosed: boolean; text: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const name = tmuxName(ws)
  const tmux = (args: string[]) =>
    $.process.run(['tmux', ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  const not = (why: string) => ({ isClosed: false, text: `Not closed: ${why}.` })
  const reopens = 'Open starts it again, going on with its conversations'
  if ((await tmux(['has-session', '-t', `=${name}`])).exitCode !== 0) return { isClosed: true, text: `${ws.name} is closed already; ${reopens}.` }
  // show-options takes no `=` target; has-session just found this exact name, which tmux prefers to a prefix
  const owner = (await tmux(['show-options', '-t', name, '-qv', OWNER_OPTION])).stdout.trim()
  if (owner !== String(ws.createdAt)) {
    if (!(await endLeftover($, name, owner))) return not(`tmux session ${name} was not started for this workspace`)
    await refresh($, 0)
    return { isClosed: true, text: `${ws.name} was not running (tmux had brought back empty shells under its name after a restart: ended); ${reopens}.` }
  }
  // the conversations kept for it as they are now; then each pane as it is now
  await refresh($, 0)
  const snap = await read($, snapshot)
  const kept = snap.workspaces.find(w => w.id === ws.id) ?? ws
  const listed = await tmux(['list-panes', '-s', '-t', `=${name}`, '-F', PANE_STATE_FORMAT])
  const ps = await $.process.run(['/bin/ps', '-ax', '-o', 'ppid='], { timeoutMs: 10_000 }).catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  if (listed.exitCode !== 0 || ps.exitCode !== 0) return not('its panes could not be read')
  const parents = parentsFrom(ps.stdout)
  const selfId = await $.session.id()
  const NAME = { claude: 'Claude', codex: 'Codex' } as const
  const asked = 'close the workspace'
  type Agent = { tool: 'claude' | 'codex'; tty: string; pid: number; check: () => Promise<string | undefined> }
  const agents: Agent[] = []
  for (const pane of paneStates(listed.stdout)) {
    if (isQuietPane(pane, parents)) continue
    const claude = snap.claude.find(c => c.tty === pane.tty && c.kind === 'interactive')
    const codex = snap.codex.find(c => c.tty === pane.tty && c.surface === 'terminal' && c.pid !== undefined && !c.key.startsWith('pid-'))
    if (claude !== undefined) {
      if (claude.sessionId === selfId) return not('this is the workspace\'s own Claude, which would close itself first; close it from another session or the Ops screen')
      if (envOfProfile('claude', claude.profile) !== ws.env) return not('the Claude in its pane runs under another account than the workspace\'s; close it there yourself')
      if (kept.threads?.claude?.id !== claude.sessionId) return not('the conversation Claude runs is not kept for the workspace yet; try again in a moment')
      const check = async () => {
        const live = await liveClaude($, home, claude.pid, claude.profile, claude.sessionId, asked)
        return typeof live === 'string' ? `Claude ${live}` : live.tty !== pane.tty ? 'Claude has moved from its pane' : undefined
      }
      agents.push({ tool: 'claude', tty: pane.tty, pid: claude.pid, check })
    } else if (codex !== undefined) {
      if (envOfProfile('codex', codex.profile) !== ws.env) return not('the Codex in its pane runs under another account than the workspace\'s; close it there yourself')
      if (!isKnownCodex(snap, codex) || kept.threads?.codex?.id !== codex.key) return not('which conversation Codex runs is not known for certain yet; try again in a moment')
      const codexHome = `${home}/.${codex.profile}`
      const rollout = (await $.process.run(['/bin/sh', '-c', ROLLOUT_SCRIPT, 'sh', codexHome, codex.key], { timeoutMs: 15_000 }).catch(() => ({ stdout: '' }))).stdout.trim()
      if (!rollout.startsWith('/')) return not(`Codex's conversation was not found under ~/.${codex.profile}`)
      const check = async () => {
        // which conversation it runs, made sure of again now, as bring-in does
        if (!(await isSureCodex($, codexHome, codex))) return 'which conversation Codex runs is no longer certain; try again in a moment'
        const busy = await codexBusy($, rollout, asked)
        if (busy !== undefined) return `Codex ${busy}`
        return codex.updatedAt > 0 && (await $.clock.now()) - codex.updatedAt < WORKING_MS ? `Codex is working: ${asked} once its turn is done` : undefined
      }
      agents.push({ tool: 'codex', tty: pane.tty, pid: codex.pid!, check })
    } else {
      // (not an agent known here: one just started, or something of the owner's) never ended unchecked
      return not(`${pane.command || 'something'} runs in one of its panes, and close cannot check it; end it there, or try again in a moment`)
    }
  }
  // every agent between turns first, so nothing is closed while one is not
  for (const a of agents) {
    const why = await a.check()
    if (why !== undefined) return not(why)
  }
  const closed: string[] = []
  for (const a of agents) {
    // checked again just before it is closed: one that began a turn since is left running
    const why = await a.check()
    const out = why !== undefined
      ? why
      : (await $.process.run(['/bin/sh', '-c', STOP_SCRIPT, 'sh', a.tty, JOB_COMMANDS[a.tool], String(a.pid)], { timeoutMs: 30_000 }).catch(() => ({ stdout: 'failed' }))).stdout.trim()
    if (out === 'stopped') closed.push(NAME[a.tool])
    else {
      const left = why ?? `${NAME[a.tool]} did not close in ${a.tty}`
      return { isClosed: false, text: `Not closed: ${left}.${closed.length === 0 ? '' : ` ${closed.join(' and ')} closed meanwhile, its conversation kept; close the workspace again once ${NAME[a.tool]} can be.`}` }
    }
  }
  await hideWindows($, home, ws)
  const ended = await tmux(['kill-session', '-t', `=${name}`])
  await refresh($, 0)
  if (ended.exitCode !== 0 && (await tmux(['has-session', '-t', `=${name}`])).exitCode === 0) {
    return { isClosed: false, text: `Not closed: tmux session ${name} did not end (${firstLine(ended.stderr) || `exit ${ended.exitCode}`}).${closed.length === 0 ? '' : ` ${closed.join(' and ')} closed, its conversation kept.`}` }
  }
  return { isClosed: true, text: `Closed ${ws.name}${closed.length === 0 ? ' (no agent was running in it)' : `: ${closed.join(' and ')} ended between turns`}; ${reopens}.` }
}

/**
 * Whether a Codex terminal runs the conversation its row says, made sure of now: the rollout it holds open, read fresh;
 * or, the only Codex terminal of its account, no other conversation written there since it started.
 */
async function isSureCodex($: EngineInterface, codexHome: string, s: CodexSession): Promise<boolean> {
  if (s.pid === undefined) return false
  if (s.match === 'held') {
    const held = await $.process.run(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', String(s.pid), '-Fpn'], { timeoutMs: 10_000 }).catch(() => ({ stdout: '' }))
    return (parseRollouts(held.stdout).get(s.pid) ?? []).includes(s.key)
  }
  return (await codexWrittenSince($, codexHome, (s.startedAt ?? (await $.clock.now())) - 5_000)).every(t => t === s.key)
}

/**
 * Brings a workspace up: the Terminal tab already attached to its tmux
 * session to the front, else a new window that creates the session (if it
 * is not running) and attaches. `window` is selected first.
 */
async function openWorkspace($: EngineInterface, ws: Workspace, at?: { window: string; pane?: string }): Promise<{ isOpen: boolean; text: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const name = tmuxName(ws)
  const tmux = (args: string[]) =>
    $.process.run(['tmux', ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  const isDir = await $.fs.stat(ws.dir).then(s => s.kind === 'dir').catch(() => false)
  if (!isDir) return { isOpen: false, text: `Not opened: its folder ${ws.dir} is not there any more.` }
  // a running session of that name must be this workspace's own, not an older one or anyone else's
  let wasRunning = (await tmux(['has-session', '-t', `=${name}`])).exitCode === 0
  // show-options takes no `=` target; has-session just found this exact name, which tmux prefers to a prefix
  const owner = wasRunning ? (await tmux(['show-options', '-t', name, '-qv', OWNER_OPTION])).stdout.trim() : ''
  // what a session restore brought back under its name after a restart (empty shells): ended, the workspace started anew
  if (wasRunning && owner !== String(ws.createdAt) && (await endLeftover($, name, owner))) wasRunning = false
  if (wasRunning && owner !== String(ws.createdAt)) {
    return { isOpen: false, text: `Not opened: tmux session ${name} was not started for this workspace; end it (tmux kill-session -t ${name}) or remove this workspace.` }
  }
  if (wasRunning) {
    // one made before the mouse, the side labels and Hide were set up gets them now, in each of its windows
    await prepareSession($, home, name, ws.name)
    // its agent's pane (a workspace made before panes were marked has a window per agent)
    if (at?.pane !== undefined && /^%\d+$/.test(at.pane)) {
      await tmux(['select-window', '-t', at.pane])
      await tmux(['select-pane', '-t', at.pane])
    } else if (at !== undefined) {
      await tmux(['select-window', '-t', `=${name}:${at.window}`])
    }
  }
  // started now, each agent resumes its conversation: never one that runs somewhere else too
  if (!wasRunning && ws.threads !== undefined) {
    await refresh($, 0)
    const snap = await read($, snapshot)
    const now = await $.clock.now()
    // only the agents it runs: a conversation kept for one it does not run is never resumed
    const runs = agentsOf(ws)
    const claude = ws.threads.claude === undefined || !runs.includes('claude') ? undefined : snap.claude.find(s => s.sessionId === ws.threads!.claude!.id)
    // a Codex conversation open in a terminal, or written a moment ago anywhere (the desktop app, an exec run)
    const codex = ws.threads.codex === undefined || !runs.includes('codex') ? undefined : snap.codex.find(s => s.key === ws.threads!.codex!.id && (s.surface === 'terminal' || now - s.updatedAt < WORKING_MS))
    const elsewhere = [
      ...(claude === undefined ? [] : [`Claude's runs in ${claude.tty === '??' ? 'the background' : claude.tty}`]),
      ...(codex === undefined ? [] : [`Codex's ${codex.surface === 'terminal' ? `runs in ${codex.tty}` : `was written a moment ago (${codex.surface})`}`]),
    ]
    if (elsewhere.length > 0) return { isOpen: false, text: `Not opened: its agents go on with their own conversations, and ${elsewhere.join(' and ')}. Close it there first.` }
    // each resumes now: the relay types into it only after a turn from here (it may first ask how to resume)
    await changeWorkspaces($, home, list => list.map(w => (w.id !== ws.id || w.threads === undefined ? w : {
      ...w,
      threads: Object.fromEntries(Object.entries(w.threads).map(([tool, t]) => [tool, { ...t, since: now }])),
    })))
  }
  // a terminal's login shell may be any shell: it is only given `/bin/sh <file>`, the file holding the command
  const file = openScriptPath(home, ws.id)
  await $.fs.write(file, `${openCommand(ws, home)}\n`)
  const command = `/bin/sh ${shellQuote(file)}`
  const term = await $.env.get('TERM_PROGRAM')
  if (term === 'tmux') {
    // from inside tmux: create it if need be, then switch this terminal to it
    const made = await $.process
      .run(['/bin/sh', '-c', openCommand(ws, home, { attach: false })], { timeoutMs: 20_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
    if (made.exitCode === 0 && !wasRunning) await prepareWhenMade($, home, ws)
    const switched = made.exitCode === 0 ? await tmux(['switch-client', '-t', `=${name}`]) : made
    return switched.exitCode === 0
      ? { isOpen: true, text: `Switched to ${name}.` }
      : { isOpen: false, text: `Not opened (${firstLine(switched.stderr) || `exit ${switched.exitCode}`}). Run: ${command}` }
  }
  if (term !== 'Apple_Terminal') return { isOpen: false, text: `Open it in a terminal: ${command}` }
  const osascript = (script: string, ...args: string[]) =>
    $.process
      .run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, ...args], { timeoutMs: 10_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  // the terminals attached now (the snapshot may be seconds old)
  const attached = parseClients((await tmux(['list-clients', '-F', CLIENTS_FORMAT])).stdout)[name] ?? []
  for (const tty of attached) {
    if ((await osascript(FOCUS_SCRIPT, tty)).stdout.trim() === 'shown') return { isOpen: true, text: `Brought ${name} to the front.` }
  }
  // on the screen it was on when last hidden, while that screen is still there (else the one in use), 60% of it, in the
  // font of the window it is opened from: never the size and font it had
  const kept = await $.fs.read(placementPath(home, name)).then(text => placementFrom(JSON.parse(text))).catch(() => undefined)
  const seen = await screens($, osascript)
  const place = seen === undefined ? undefined : workspacePlacement(seen, kept)
  const opened = await osascript(OPEN_SCRIPT, command, ...(place === undefined ? [] : [JSON.stringify(place)]))
  const isOpened = opened.exitCode === 0 && opened.stdout.trim() === 'opened'
  // the window makes the session (made new, or again after it ended): once it is there, its bar gets Hide
  if (isOpened && !wasRunning) await prepareWhenMade($, home, ws)
  return isOpened
    ? { isOpen: true, text: `Opened ${name} in a new Terminal window.` }
    : { isOpen: false, text: `Not opened (${firstLine(opened.stderr) || `exit ${opened.exitCode}`}). Run: ${command}` }
}

/**
 * The ops screen (ops/ops.mjs, beside this plugin's hooks) in a Terminal window of its own, filling the screen in
 * use (what the menu bar and Dock leave), in this tab's own font size.
 */
async function openOps($: EngineInterface) {
  const osascript = (script: string, ...args: string[]) =>
    $.process
      .run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, ...args], { timeoutMs: 10_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  const home = (await $.env.get('HOME')) ?? ''
  // the account this pane shows
  const account = await shownAccount($, home)
  const file = normalPath(`${$.plugin.root}/ops/ops.mjs`)
  // that screen open already (it restarts itself when the plugin changes): its window to the front, never a second one;
  // its Node as the shell ran it (`node`, or a path a version manager's shim gave it)
  const tail = ` --no-warnings ${file} --account ${account}`.trimEnd()
  const running = shownIn(await terminalProcesses($), p => p.args.endsWith(tail) && /(^|\/)node$/.test(p.args.slice(0, -tail.length)))
  for (const tty of running) {
    if ((await osascript(FOCUS_SCRIPT, tty)).stdout.trim() === 'shown') return
  }
  const seen = await screens($, osascript)
  const place = seen === undefined ? undefined : { ...seen.screens[0]!, fontSize: seen.fontSize }
  const command = `node --no-warnings ${shellQuote(file)} --account ${shellQuote(account)}`
  const opened = await osascript(OPEN_SCRIPT, command, ...(place === undefined ? [] : [JSON.stringify(place)]))
  if (opened.stdout.trim() !== 'opened') await toast($, `The ops screen did not open (${firstLine(opened.stderr) || `exit ${opened.exitCode}`}). Run: ${command}`, { timeoutMs: 15_000 })
}

/** This person's processes that have a terminal (`ps` with neither -a nor -x); none when `ps` cannot be run. */
async function terminalProcesses($: EngineInterface): Promise<Proc[]> {
  const ps = await $.process.run(['/bin/ps', '-ww', '-o', PS_COLUMNS], { env: PS_ENV, timeoutMs: 10_000 }).catch(() => undefined)
  return ps === undefined ? [] : [...parsePs(ps.stdout).values()]
}

/** The screens there are now (the one in use first), and the font size of this session's own tab. */
async function screens($: EngineInterface, osascript: (script: string, ...args: string[]) => Promise<{ stdout: string }>) {
  const selfId = await $.session.id()
  const tty = (await read($, snapshot)).claude.find(s => s.sessionId === selfId)?.tty ?? ''
  return screensFrom((await osascript(SCREEN_SCRIPT, /^ttys\d+$/.test(tty) ? tty : 'none').catch(() => ({ stdout: '' }))).stdout)
}

/** Brings a session's Terminal tab to the front: a background session's, the tab attached to it, else a new window attached to it. */
async function openSession($: EngineInterface, target: NonNullable<Item['target']>) {
  const osascript = (script: string, arg: string) =>
    $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, arg], { timeoutMs: 10_000 })
  if ('workspace' in target) {
    const ws = (await read($, snapshot)).workspaces.find(w => tmuxName(w) === target.workspace)
    if (ws === undefined) return
    const result = await openWorkspace($, ws, target)
    if (!result.isOpen) await toast($, result.text, { timeoutMs: 20_000 })
    return
  }
  if ('tty' in target) {
    const out = await osascript(FOCUS_SCRIPT, target.tty)
    if (out.stdout.trim() !== 'shown') await toast($, `No Terminal tab runs on ${target.tty}.`)
    return
  }
  // a tab showing it already: brought to the front, never a second window
  for (const tty of shownIn(await terminalProcesses($), p => isAttachTo(p.args, [target.attach, target.sessionId]))) {
    if ((await osascript(FOCUS_SCRIPT, tty).catch(() => ({ stdout: '' }))).stdout.trim() === 'shown') return
  }
  const command = attachCommand(target.attach, target.profile, (await $.env.get('HOME')) ?? '')
  if (command === undefined) return
  // 60% of the screen in use, in this tab's font: never the profile's small default window
  const seen = await screens($, (script, ...args) =>
    $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, ...args], { timeoutMs: 10_000 }).catch(() => ({ stdout: '' })))
  const place = seen === undefined ? undefined : agentPlacement(seen.screens[0]!, seen.fontSize)
  await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', OPEN_SCRIPT, command, ...(place === undefined ? [] : [JSON.stringify(place)])], { timeoutMs: 10_000 })
}

/**
 * Moves an idle Claude session from its terminal tab to the background, in
 * that same tab: checked again first (the same process, the same session,
 * still idle), then hung up, resumed in the background and attached there.
 */
/** Sessions with a move under way: one move at a time per session. */
const moving = new Set<number>()

/**
 * Moves an idle Claude session from its terminal tab to the background, in
 * that same tab. Everything that could stop it is checked before the
 * session is touched: it is still the same Claude process and session,
 * idle, in front of its terminal, in a Terminal.app tab, with a permission
 * mode this knows. Then it is hung up, resumed in the background and
 * attached there. Whatever goes wrong after the hang-up, the toast says how
 * to resume it.
 */
async function moveToBackground($: EngineInterface, move: NonNullable<Item['move']>) {
  if (moving.has(move.pid)) {
    await toast($, 'That session is already being moved.')
    return
  }
  moving.add(move.pid)
  try {
    await moveChecked($, move)
  } catch (error) {
    await toast($, `The move stopped: ${message(error)}`)
  } finally {
    moving.delete(move.pid)
  }
}

async function moveChecked($: EngineInterface, move: NonNullable<Item['move']>) {
  const home = (await $.env.get('HOME')) ?? ''
  const refuse = async (why: string) => toast($, `Not moved: ${why}.`)
  const raw = await $.fs
    .read(`${home}/.${move.profile}/sessions/${move.pid}.json`)
    .then(text => JSON.parse(text) as unknown)
    .catch(() => undefined)
  // without its start time the pid could be anyone's
  if (typeof (raw as { procStart?: unknown } | undefined)?.procStart !== 'string') return refuse('its registry entry has no start time')
  const ps = await $.process.run(['/bin/ps', '-ww', '-o', PS_COLUMNS, '-p', String(move.pid)], { env: PS_ENV, timeoutMs: 10_000 })
  const proc = parsePs(ps.stdout).get(move.pid)
  const still = claudeFromRegistry(raw, move.profile, parsePs(ps.stdout), home)
  const now = await $.clock.now()
  if (proc === undefined || still === undefined || still.sessionId !== move.sessionId || !isClaudeProcess(proc.args)) {
    return refuse('that session has ended or its process changed')
  }
  if (still.kind !== 'interactive' || claudeState(still, now) !== 'idle') return refuse('it is no longer idle')
  if (!isForeground(proc.stat)) return refuse('it is suspended (Ctrl+Z) or not in front of its terminal; bring it back first')
  // started by an interactive shell, so the shell is what takes the typed resume once it exits. A launcher
  // script's interpreter is a shell too, but it runs in the foreground job with claude; an interactive
  // shell puts claude in a job of its own and waits outside it (no `+`)
  const ppid = (await $.process.run(['/bin/ps', '-o', 'ppid=', '-p', String(move.pid)], { timeoutMs: 10_000 })).stdout.trim()
  const parent = /^\d+$/.test(ppid)
    ? (await $.process.run(['/bin/ps', '-o', 'stat=,comm=', '-p', ppid], { timeoutMs: 10_000 })).stdout.trim()
    : ''
  const [parentStat = '', ...parentComm] = parent.split(/\s+/)
  if (!isShell(parentComm.join(' ')) || parentStat.includes('+')) {
    return refuse('it was not started directly by an interactive shell, so the resume could not be typed after it')
  }
  const hasTab = await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', HAS_TAB_SCRIPT, proc.tty], { timeoutMs: 10_000 })
  if (hasTab.stdout.trim() !== 'yes') return refuse(`${proc.tty} is not a Terminal.app tab (tmux, iTerm, VS Code are not supported)`)
  const transcript = transcriptPath(`${home}/.${move.profile}`, still.startCwd, still.sessionId)
  const mode = await $.process.run(['/bin/sh', '-c', MODE_SCRIPT, 'sh', transcript], { timeoutMs: 10_000 })
  const flags = modeFlags(mode.stdout)
  if (flags === undefined) return refuse('its permission mode is not one this knows')
  const command = backgroundCommand(still, home, flags)
  if (command === undefined) return refuse('its id, profile or folder cannot be typed safely')
  const resume = resumeCommand(still, home)
  const out = await $.process
    .run(['/bin/sh', '-c', MOVE_SCRIPT, 'sh', String(move.pid), proc.tty, command, TYPE_SCRIPT], { timeoutMs: 40_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  await toast($,
    out.exitCode === 0 && out.stdout.trim() === 'typed'
      ? `Moving to the background in ${proc.tty}: closing that tab now leaves it running.`
      : out.exitCode === 3
        ? 'Not moved: the session could not be signalled.'
        : out.exitCode === 4
          ? `The session has not exited after 20 s; nothing was resumed. If it closes, resume it in its tab: ${resume}`
          : `The session ended but the resume could not be typed into ${proc.tty}. Resume it there: ${command}`,
    { timeoutMs: 20_000 },
  )
}

/**
 * Makes a workspace, from the command or the pane's form alike: checks the
 * folder (or, with a branch, makes that branch's worktree beside its
 * repository), saves it under an id no running tmux session has, opens it.
 */
async function createWorkspace(
  $: EngineInterface,
  w: NewWorkspace,
): Promise<{ isCreated: boolean; text: string }> {
  // one at a time: a second press of create, or Enter then create, never makes a second workspace
  let isMine = false
  await update($, creating, now => {
    isMine = !now
    return true
  })
  if (!isMine) return { isCreated: false, text: 'Not done: a workspace is already being made.' }
  try {
    return await makeWorkspace($, w)
  } finally {
    await update($, creating, () => false)
  }
}

/**
 * A workspace to make: `goOn` to go on with the branch checked out in `dir`
 * (`goOnBranch`: the one the form showed for it); `bringFrom`, the folder the
 * form offered the sessions to bring in for (the project, where `dir` is a
 * worktree of it chosen to go on with).
 */
type NewWorkspace = {
  dir: string
  env: string
  name: string
  purpose: string
  bring?: readonly string[]
  only?: 'claude' | 'codex'
  goOn?: boolean
  goOnBranch?: string
  bringFrom?: string
  /** The repository's other folders (its branches' worktrees, wherever they are), whose sessions were offered too. */
  bringAlso?: readonly string[]
}

async function makeWorkspace($: EngineInterface, w: NewWorkspace): Promise<{ isCreated: boolean; text: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const fail = (why: string) => ({ isCreated: false, text: `Not done: ${why}.` })
  if (w.name.trim() === '') return fail('a workspace needs a name')
  const typed = absoluteDir(w.dir, home)
  if (typed === undefined) return fail(`the folder must be absolute or start with ~/ ("${w.dir}" is neither)`)
  if (!(await envsOf($, home)).includes(w.env)) return fail(`there is no environment "${w.env}"`)
  if (!(await readWorkspaces($, home)).isReadable) return fail(UNREADABLE)
  const isDir = await $.fs.stat(typed).then(s => s.kind === 'dir').catch(() => false)
  if (!isDir) return fail(`${typed} is not a folder`)
  const dir = typed
  // its repository's main checkout: the agents may work in its worktrees folder too, and a purpose needs one
  const found = await $.process
    .run(['/bin/sh', '-c', CHECKOUT_SCRIPT, 'sh', typed], { timeoutMs: 30_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const place = checkoutResult(found.stdout)
  const purpose = w.purpose.trim()
  if (purpose !== '' && 'error' in place) return fail(place.error)
  const checkout = 'checkout' in place ? place.checkout : undefined
  // going on with the branch checked out in the folder: read from git, never typed; a branch's own worktree only, never
  // the main checkout (its branch is the repository's own line), and the one the form showed
  let branch: string | undefined
  if (w.goOn === true) {
    const head = headOf((await $.process.run(['/bin/sh', '-c', BRANCH_SCRIPT, 'sh', typed], { timeoutMs: 10_000 }).catch(() => ({ stdout: '' }))).stdout)
    if (head?.isMain === true) return fail(`${typed} is the repository's main checkout: go on with a branch in its own worktree (in ${checkout ?? '<checkout>'}-worktrees/)`)
    branch = head?.branch
    if (branch === undefined) return fail(`${typed} has no branch checked out to go on with`)
    if (head?.isDefault === true) return fail(`${branch}, checked out in ${typed}, is the repository's default branch: go on with a branch of its own`)
    if (w.goOnBranch !== undefined && w.goOnBranch !== branch) return fail(`the branch checked out in ${typed} is now ${branch}, not ${w.goOnBranch}; choose again`)
  }
  await refresh($, VISIBLE_MAX_AGE_MS)
  const snap = await read($, snapshot)
  // the sessions brought in, each checked as it runs now; then closed where they run, so each conversation
  // goes on in the workspace alone
  // checked as the form offered them: for its project, which a worktree chosen to go on with is part of
  const checked = await checkBring($, home, snap, w.bring ?? [], w.env, [absoluteDir(w.bringFrom ?? '', home) ?? dir, ...(w.bringAlso ?? [])])
  if ('error' in checked) return fail(checked.error)
  // a workspace of one agent takes in a session of that agent only
  const stranger = checked.bring.find(b => !agentsOf(w).includes(b.tool))
  if (stranger !== undefined) return fail(`${stranger.label} is not ${w.only === 'claude' ? 'Claude' : 'Codex'}, the one agent this workspace runs`)
  const threads: { claude?: Thread; codex?: Thread } = {}
  const notBrought: string[] = []
  const createdAt = await $.clock.now()
  for (const b of checked.bring) {
    // checked again just before it is closed: one that began a turn since is left running
    const live = b.tool === 'claude' && b.runs !== undefined ? await liveClaude($, home, b.runs.pid, b.profile, b.thread.id) : undefined
    const why = typeof live === 'string' ? live : b.rollout === undefined ? undefined : await codexBusy($, b.rollout)
    // a conversation closed already has nothing to close
    const out = why !== undefined
      ? { stdout: why }
      : b.runs === undefined
        ? { stdout: 'stopped' }
        : await $.process
          .run(['/bin/sh', '-c', STOP_SCRIPT, 'sh', b.runs.tty, JOB_COMMANDS[b.tool], String(b.runs.pid)], { timeoutMs: 30_000 })
          .catch(() => ({ stdout: 'failed' }))
    if (out.stdout.trim() === 'stopped') threads[b.tool] = { ...b.thread, since: createdAt }
    else notBrought.push(`${b.label} (${why === undefined ? `it did not close in ${b.runs?.tty ?? 'its terminal'}` : `it ${why}`}; it was left as it was, and the workspace's ${b.tool === 'claude' ? 'Claude' : 'Codex'} starts new)`)
  }
  // never the name of a tmux session already running: a new workspace never takes over an old one
  const running = Object.values(snap.tmux.panes).map(p => p.session).filter(s => s.startsWith('ws-')).map(s => s.slice(3))
  let ws: Workspace | undefined
  const saved = await changeWorkspaces($, home, now => {
    ws = {
      id: slugOf(w.name, [...now.map(x => x.id), ...running]), name: w.name.trim(), env: w.env, dir, createdAt,
      ...(checkout === undefined ? {} : { checkout }),
      ...(threads.claude === undefined && threads.codex === undefined ? {} : { threads }),
      ...(w.only === undefined ? {} : { only: w.only }),
      ...(branch === undefined ? {} : { branch }),
      // made for a purpose: Claude gets it ready, and the relay passes the cues from the start (one agent has no one to pass to)
      ...(purpose === '' ? {} : { purpose, ...(w.only === undefined ? { relay: { mode: 'auto' as const, since: createdAt, streak: 0 } } : {}) }),
    }
    // the conversations brought in go on in this workspace alone
    return withThreads([...now, ws], ws.id, threads)
  })
  if (!saved || ws === undefined) {
    const closed = Object.entries(threads).map(([tool, t]) => `${tool === 'claude' ? `claude --resume ${t.id}` : `codex resume ${t.id}`} (in ${t.dir})`)
    return fail(`${UNREADABLE}${closed.length > 0 ? `; to go on with what was closed: ${closed.join(', ')}` : ''}`)
  }
  const made: Workspace = ws
  if (purpose !== '' && made.only === undefined) {
    await $.fs.write(promptPath(home, made.id, 'claude'), made.threads?.claude === undefined ? setupPrompt(made) : joinPrompt(made, 'claude'))
    await $.fs.write(promptPath(home, made.id, 'codex'), made.threads?.codex === undefined ? peerPrompt(made) : joinPrompt(made, 'codex'))
  } else {
    // one left by a removed workspace of the same id never reaches this one's agents
    await removePrompts($, home, made.id)
    if (purpose !== '' && made.only !== undefined) await $.fs.write(promptPath(home, made.id, made.only), soloPrompt(made, made.only))
  }
  await refresh($, 0)
  const label = `${made.name} (${made.env || 'default'}, ${made.dir})`
  const opened = await openWorkspace($, made)
  const goOn = checked.bring.filter(b => made.threads?.[b.tool] !== undefined).map(b => b.label)
  const alone = made.only === undefined ? undefined : made.only === 'claude' ? 'Claude' : 'Codex'
  const onBranch = made.branch === undefined ? '' : `, going on with ${made.branch}`
  const start = (alone !== undefined
    ? `${alone} starts alone in tmux session ${tmuxName(made)}${purpose === '' ? '.' : `; it gets ready for the purpose${onBranch}, says where things stand and waits for you.`}`
    : purpose === ''
    ? `Claude and Codex start side by side in tmux session ${tmuxName(made)}.`
    : `Claude and Codex start side by side in tmux session ${tmuxName(made)}; Claude gets peer coding ready for it${onBranch}, and the relay passes each hand-over to the other.`) +
    (goOn.length > 0 ? ` ${goOn.join(' and ')} went on there, each in its own conversation${made.threads?.claude === undefined ? '' : ' (if Claude asks how to resume a large conversation, from a summary or in full, answer it in its pane)'}.` : '') +
    (notBrought.length > 0 ? ` Not brought in: ${notBrought.join('; ')}.` : '')
  return {
    isCreated: true,
    text: opened.isOpen
      ? `Created ${label}. ${start} Closing its window leaves them running; /workspace open ${made.id} brings it back. ${opened.text}`
      : `Created ${label}, but it was not opened: ${opened.text}`,
  }
}

/** A session to bring in: where it runs (none for a conversation already closed), and the conversation it resumes. */
type Bring = { tool: 'claude' | 'codex'; label: string; runs?: { tty: string; pid: number }; profile: string; rollout?: string; thread: Thread }

/**
 * The sessions to bring into a new workspace, each checked as it runs now:
 * one of each agent at most, of the workspace's repository, in a terminal,
 * between turns, under the workspace's environment, and (Codex) its
 * conversation known for certain; with the conversation it resumes there
 * (bypassed, as every workspace agent).
 */
async function checkBring($: EngineInterface, home: string, snap: Snapshot, members: readonly string[], env: string, dir: string | readonly string[]): Promise<{ bring: Bring[] } | { error: string }> {
  const bring: Bring[] = []
  const now = await $.clock.now()
  const offered = bringable(snap, { now, selfId: await $.session.id() }, dir)
  for (const member of members) {
    const [tool = '', id = ''] = member.split(':')
    if ((tool !== 'claude' && tool !== 'codex') || bring.some(b => b.tool === tool)) return { error: `"${member}" is not one session of each agent` }
    const name = tool === 'claude' ? 'that Claude session' : 'that Codex terminal'
    const offer = offered.find(b => b.member === member)
    if (offer === undefined) return { error: `${name} cannot be brought in: it has ended, works in another repository, runs in the background or in a workspace already, or is this session` }
    if (offer.blocked !== undefined) return { error: `${offer.label} cannot be brought in: ${offer.blocked}` }
    if (offer.env !== env) return { error: `${offer.label} runs under the ${offer.env || 'default'} environment; choose that one` }
    if (tool === 'claude') {
      const s = snap.claude.find(c => c.sessionId === id)!
      const live = await liveClaude($, home, s.pid, s.profile, id)
      if (typeof live === 'string') return { error: `${offer.label} ${live}` }
      // (it goes on bypassed, as every workspace agent: the mode it ran in is not kept)
      bring.push({ tool, label: offer.label, runs: { tty: live.tty, pid: s.pid }, profile: s.profile, thread: { id, dir: live.startCwd } })
    } else {
      const s = snap.codex.find(c => c.key === id && (offer.isClosed === true ? c.surface === 'cli' : c.surface === 'terminal'))!
      const codexHome = `${home}/.${s.profile}`
      const rollout = (await $.process.run(['/bin/sh', '-c', ROLLOUT_SCRIPT, 'sh', codexHome, id], { timeoutMs: 15_000 })).stdout.trim()
      if (!rollout.startsWith('/')) return { error: `${offer.label}'s conversation was not found under ~/.${s.profile}` }
      // which conversation the terminal runs, made sure of again now: the rollout it holds open, read fresh; or,
      // the only Codex terminal of that account, no other conversation written there since it started
      if (offer.isClosed !== true) {
        if (!(await isSureCodex($, codexHome, s))) return { error: `${offer.label} cannot be brought in: which conversation it runs is no longer certain; close it yourself, then bring in its conversation` }
      }
      const busy = await codexBusy($, rollout)
      if (busy !== undefined || (s.updatedAt > 0 && now - s.updatedAt < WORKING_MS)) return { error: `${offer.label} ${busy ?? 'is working: bring it in once its turn is done'}` }
      const mode = (await $.process.run(['/bin/sh', '-c', CODEX_FOLDER_SCRIPT, 'sh', rollout], { timeoutMs: 10_000 })).stdout
      const folder = codexDir(mode) ?? s.cwd
      if (!folder.startsWith('/')) return { error: `${offer.label}'s folder is not known` }
      bring.push({ tool, label: offer.label, ...(offer.isClosed === true ? {} : { runs: { tty: s.tty, pid: s.pid! } }), profile: s.profile, rollout, thread: { id, dir: folder } })
    }
  }
  return { bring }
}

/**
 * A Claude session as it runs now, by its registry entry and process: between turns, in front of its terminal; else why
 * not, said for what was `asked` of it.
 */
async function liveClaude($: EngineInterface, home: string, pid: number, profile: string, id: string, asked = 'bring it in'): Promise<ClaudeSession | string> {
  const raw = await $.fs.read(`${home}/.${profile}/sessions/${pid}.json`).then(text => JSON.parse(text) as unknown).catch(() => undefined)
  const ps = await $.process.run(['/bin/ps', '-ww', '-o', PS_COLUMNS, '-p', String(pid)], { env: PS_ENV, timeoutMs: 10_000 })
  const procs = parsePs(ps.stdout)
  const proc = procs.get(pid)
  const still = claudeFromRegistry(raw, profile, procs, home)
  if (proc === undefined || still === undefined || still.sessionId !== id || !isClaudeProcess(proc.args)) return 'has ended or its process changed'
  const state = claudeState(still, await $.clock.now())
  if (state === 'background') return `has background work running: ${asked} once it has ended`
  if (state === 'waiting') return `waits on you: answer it, then ${asked}`
  if (state !== 'idle') return `is working: ${asked} once its turn is done`
  if (!isForeground(proc.stat)) return 'is suspended (Ctrl+Z) or not in front of its terminal; bring it back first'
  return still
}

/** The top-level conversations of a Codex home written since `since`, by Codex's own records (undefined ids when unreadable: never sure). */
async function codexWrittenSince($: EngineInterface, codexHome: string, since: number): Promise<string[]> {
  const files = await $.fs.list(codexHome).catch(() => [])
  const db = files.map(f => /^state_(\d+)\.sqlite$/.exec(f.name)).filter(m => m !== null).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0]
  if (db === undefined) return ['?']
  const path = `${codexHome}/${db}`
  const out = await $.process
    .run(['sqlite3', '-json', '-cmd', '.timeout 2000', ...readOnlyArgs(path, await $.fs.exists(`${path}-shm`)), threadQuery(since, since, [], { noExec: true })], { timeoutMs: 10_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  if (out.exitCode !== 0) return ['?']
  // only a conversation made in a terminal could be the one a Codex terminal runs
  return parseThreads(out.stdout).filter(t => t.updated_at_ms >= since && isFromTerminal(t) && t.source !== 'exec').map(t => t.id)
}

/**
 * Why a Codex conversation cannot be closed now, by its whole rollout: a turn under way, or none yet; undefined when
 * between turns. Said for what was `asked` of it.
 */
async function codexBusy($: EngineInterface, rollout: string, asked = 'bring it in'): Promise<string | undefined> {
  const state = codexTaskState((await $.process.run(['/bin/sh', '-c', CODEX_TASK_SCRIPT, 'sh', rollout], { timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout)
  return state === 'done' ? undefined : state === 'busy' ? `is working: ${asked} once its turn is done` : 'has no finished turn to go on from'
}

async function submitDraft($: EngineInterface) {
  // a path typed (or pasted, or picked) and created before the form had placed it: placed first, as the form would
  // have shown it
  const before = await read($, draft)
  if (typedPath(before.query) !== undefined && (before.dir === '' || (await read($, worktrees)).dir !== before.dir)) await placeTyped($, before.query)
  const d = await read($, draft)
  // found in several places: the owner picks one first (said on the form; a form from before has no such list)
  if (Array.isArray(d.choices) && d.choices.length > 0) return
  // (a form open since before the choice was offered has none: both)
  const only = d.only === 'claude' || d.only === 'codex' ? d.only : undefined
  // a worktree chosen to go on with (one the form shows: found for its folder, which a new form, a pick or typing
  // starts over) is the workspace's folder; the sessions to bring in were offered for the project, its worktrees too
  const project = d.dir || d.query
  const found = await read($, worktrees)
  const isPlaced = found.dir !== '' && found.dir === d.dir
  const goOn = isPlaced ? found.list.find(w => w.path === d.goOn) : undefined
  const made = await createWorkspace($, {
    name: d.name, dir: goOn?.path ?? project, env: d.env, purpose: d.purpose, bring: d.bring, bringFrom: project, bringAlso: isPlaced ? found.list.map(w => w.path) : [],
    ...(only === undefined ? {} : { only }),
    ...(goOn === undefined ? {} : { goOn: true, goOnBranch: goOn.branch }),
  })
  if (made.isCreated) {
    await update($, draft, () => NO_DRAFT)
    await toast($, made.text, { timeoutMs: 15_000 })
  } else {
    await update($, draft, now => ({ ...now, error: made.text }))
  }
}

/**
 * The places a path names: as typed (absolute, or from `~/`); a relative one (as an editor names a file:
 * `shop-worktrees/<branch>/docs/README.md`) everywhere it is, in the home folder or beside or in a repository the form
 * found. Undefined once the form holds something else (typed on: the lookup is let go).
 */
async function pathsOf($: EngineInterface, typed: string, home: string): Promise<string[] | undefined> {
  const named = typedPath(typed)
  if (named === undefined) return []
  if (!named.isRelative) return [absoluteDir(named.path, home)].filter(p => p !== undefined)
  const found = await read($, projects)
  const bases = [...new Set([home, ...found.map(p => p.slice(0, p.lastIndexOf('/'))), ...found])].filter(b => b.startsWith('/'))
  const paths: string[] = []
  for (const base of bases) {
    if ((await read($, draft)).query !== typed) return undefined
    const path = `${base}/${named.path}`
    if (await $.fs.exists(path).catch(() => false)) paths.push(path)
  }
  return paths
}

/**
 * What the form's repository field names, placed in git: its repository's main checkout is the project, the branches
 * there are offered to go on with, and a path inside a branch's own worktree chooses that branch. A relative path found
 * in more than one worktree is placed nowhere: the places are listed to pick from. A path outside git is left as typed;
 * a search word is not a path. Kept only while the form still holds what was placed.
 */
async function placeTyped($: EngineInterface, typed: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const paths = await pathsOf($, typed, home)
  if (paths === undefined) return
  const places: { path: string; where: NonNullable<ReturnType<typeof whereFrom>> }[] = []
  for (const path of paths) {
    const found = await $.process.run(['/bin/sh', '-c', WHERE_SCRIPT, 'sh', path], { timeoutMs: 15_000 }).catch(() => undefined)
    const where = found?.exitCode === 0 ? whereFrom(found.stdout) : undefined
    if (where !== undefined) places.push({ path, where })
  }
  if (new Set(places.map(p => p.where.top)).size > 1) {
    // in several worktrees: which one is the owner's to say
    await update($, draft, now => (now.query !== typed ? now : { ...now, dir: '', goOn: '', choices: places.map(p => p.path), error: `${typed.trim()} is in ${places.length} places: pick one, or type more of its path` }))
    return
  }
  const where = places[0]?.where
  if (where === undefined) return
  // the form first, and the worktrees offered only if it still holds what was placed: a lookup that ends late changes nothing
  let isPlaced = false
  await update($, draft, now => {
    if (!now.isOpen || now.query !== typed) return now
    isPlaced = true
    return { ...now, dir: where.checkout, goOn: where.goOn?.path ?? '', choices: [], error: '' }
  })
  if (isPlaced) await update($, worktrees, () => ({ dir: where.checkout, list: where.worktrees }))
}

/** A workspace's first-prompt files, gone. */
async function removePrompts($: EngineInterface, home: string, id: string) {
  await $.process.run(['/bin/rm', '-f', promptPath(home, id, 'claude'), promptPath(home, id, 'codex')], { timeoutMs: 10_000 }).catch(() => undefined)
}

/** Opens the form, with `dir` filled in when given (and a session to bring in, with its environment), and looks for the projects to offer. */
async function openDraft($: EngineInterface, dir: string, with_?: { member: string; env: string }) {
  const home = (await $.env.get('HOME')) ?? ''
  const shown = dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
  // in this session's own environment unless a session brought in names another
  const own = await ownEnv($, home)
  const env = own !== undefined && (await read($, snapshot)).envs.includes(own) ? own : ''
  await update($, draft, () => ({ ...NO_DRAFT, isOpen: true, dir, query: shown, env, ...(with_ === undefined ? {} : { bring: [with_.member], env: with_.env }) }))
  // a form opened anew shows no worktrees another one found
  await update($, worktrees, () => ({ dir: '', list: [] }))
  // while this pane has the keys (the form opened by its key), what is typed next goes into the name, not to the pane's keys
  await $.ui.focus({ requestId: PANE, key: 'form:name' }).catch(() => undefined)
  if (dir.startsWith('/')) await placeTyped($, shown)
  if ((await read($, projects)).length > 0) return
  const found = await $.process
    .run(['/bin/sh', '-c', PROJECTS_SCRIPT, 'sh', home], { timeoutMs: 30_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const paths = found.stdout.split('\0').filter(p => p.startsWith('/'))
  await update($, projects, () => paths)
}

const RELAY_NEXT: Record<Relay['mode'], Relay['mode']> = { auto: 'notify', notify: 'off', off: 'auto' }

/** The relay's mode, pressed round: auto, notify, off. Turned on, it counts cues from now. */
async function cycleRelay($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const now = await $.clock.now()
  await changeWorkspaces($, home, list => list.map(ws => {
    if (ws.id !== id) return ws
    const mode = RELAY_NEXT[ws.relay?.mode ?? 'off']
    return { ...ws, relay: mode === 'off' ? { ...(ws.relay ?? { since: now, streak: 0 }), mode } : { mode, since: now, streak: 0 } }
  }))
  await refresh($, 0)
}

/** From this many columns a workspace is drawn in a box (its border and padding take 4); narrower, a session row would not fit in one. */
const BOXED_FROM = 60

/** The context sizes, in tokens, a workspace's Claude may compact itself from, pressed round; 0 is off. */
const COMPACT_STEPS = [200_000, 300_000, 400_000, 500_000, 0]
const nextCompactFrom = (now: number) => COMPACT_STEPS[(COMPACT_STEPS.indexOf(now) + 1) % COMPACT_STEPS.length] ?? COMPACT_FROM
const compactSaid = (n: number) => (n === 0 ? 'off' : tokensSaid(n))

/** How large Claude's context may grow before it compacts itself at a hand-off: 200k, 300k, 400k, 500k tokens, off. */
async function cycleCompactFrom($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  await changeWorkspaces($, home, list => list.map(ws => (ws.id === id ? { ...ws, compactFrom: nextCompactFrom(ws.compactFrom ?? COMPACT_FROM) } : ws)))
  await refresh($, 0)
}

/** Hand-offs between drift checks, pressed round: every 4, every 8, off. */
const CHECK_STEPS = [4, 8, 0]
const nextCheckEvery = (now: number) => CHECK_STEPS[(CHECK_STEPS.indexOf(now) + 1) % CHECK_STEPS.length] ?? DRIFT_EVERY
const everyLabel = (n: number) => (n === 0 ? 'off' : `every ${n}`)

async function cycleCheckEvery($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  await changeWorkspaces($, home, list => list.map(ws => (ws.id === id ? { ...ws, checkEvery: nextCheckEvery(ws.checkEvery ?? DRIFT_EVERY) } : ws)))
  await refresh($, 0)
}

async function checkNow($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  await toast($, 'Checking the workspace: it takes a minute or so.', { timeoutMs: 8_000 })
  await toast($, await checkDrift($, home, id).catch((error: unknown) => `The check could not be done: ${message(error)}`), { timeoutMs: 15_000 })
}

/** The account this session runs under: '' for the default one, the name of a `~/.claude-<name>` one; undefined if neither. */
async function ownEnv($: EngineInterface, home: string): Promise<string | undefined> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.replace(/\/+$/, '')
  if (dir === undefined || dir === '' || dir === `${home}/.claude`) return ''
  return dir.startsWith(`${home}/.`) ? envOfProfile('claude', dir.slice(home.length + 2)) : undefined
}

/** The workspaces being checked in this session: one check of each at a time. */
const checking = new Set<string>()
/** The workspaces of another account this session has said it does not check. */
const toldAccount = new Set<string>()

/**
 * A drift check: one model call (Opus) holds what a workspace's agents are
 * doing (their latest hand-offs, from the event log, and their peer-coding
 * records) against what the owner said it is for. The verdict is kept on
 * the workspace, logged, and, unless on track, notified: the agents may need
 * the owner's help. Says what it found.
 */
async function checkDrift($: EngineInterface, home: string, id: string, isAfterCompaction = false): Promise<string> {
  if (checking.has(id)) return 'A check of that workspace is under way.'
  checking.add(id)
  try {
    const ws = (await readWorkspaces($, home)).list.find(w => w.id === id)
    if (ws === undefined) return 'That workspace is gone.'
    if (ws.purpose === undefined) return `${ws.name} has no purpose to check against: it was made without one.`
    // under the workspace's own account: its records never go out through another's
    const env = await ownEnv($, home)
    if (env !== ws.env) {
      // said once a session in the event log too, so a workspace no session of its account checks is not left unsaid
      // (its count stays due: the next pass a session of its account makes checks it)
      const account = ws.env === '' ? 'the default one' : ws.env
      if (!toldAccount.has(id)) {
        toldAccount.add(id)
        await logEvent($, home, { kind: 'check', text: `${ws.name}: not checked from this session: its checks run in a Claude session of its own account (${account}).`, workspace: id })
      }
      return `${ws.name} is checked from a Claude session of its own account (${account}).`
    }
    // the passes counted when it began: the ones made while it runs count toward the next check; and the compaction
    // it was started for (a newer one, made while it runs, waits for its own)
    const counted = ws.relay?.sinceCheck ?? 0
    const compactedAt = ws.compacted?.at
    // a check done or not, the next is at the next milestone (a failed one is never tried again at every hand-off)
    // and a compaction is checked once, done or not (a failed check is not tried again at every hand-off)
    const restart = (more: Partial<Workspace>) =>
      changeWorkspaces($, home, list => list.map(w => (w.id !== id ? w : {
        ...w, ...more,
        ...(w.relay === undefined ? {} : { relay: { ...w.relay, sinceCheck: Math.max(0, (w.relay.sinceCheck ?? 0) - counted) } }),
        ...(isAfterCompaction && w.compacted !== undefined && w.compacted.at === compactedAt ? { compacted: { ...w.compacted, isChecked: true } } : {}),
      })))
    const cues = await recentCues($, home, id)
    const latest = cues.filter(c => recordFolderOf(c) !== undefined).at(-1)
    const folder = latest === undefined ? undefined : recordFolderOf(latest)
    const records = ws.checkout === undefined || folder === undefined
      ? ''
      : (await $.process.run(['/bin/sh', '-c', RECORDS_SCRIPT, 'sh', ws.checkout, folder, branchOf(latest!) ?? ''], { timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout
    // nothing the agents wrote: nothing to judge, and no model call
    if (cues.length === 0 && records.trim() === '') {
      await restart({})
      return `${ws.name}: nothing to check yet: no hand-offs logged and no peer-coding records found.`
    }
    const ask = driftRequest(ws, cues, records, isAfterCompaction)
    const reply = await $.model
      .complete({ model: 'opus', system: ask.system, prompt: ask.prompt, maxTokens: 1200, effort: 'medium', timeoutMs: 180_000 })
      .catch((error: unknown) => ({ isAnswered: false as const, reason: message(error) }))
    const verdict = reply.isAnswered ? parseVerdict(reply.text) : undefined
    // a workspace removed meanwhile is not reported on
    if (!(await readWorkspaces($, home)).list.some(w => w.id === id)) return 'That workspace is gone.'
    if (verdict === undefined) {
      const why = reply.isAnswered ? 'no verdict in its reply' : `the model did not answer: ${reply.reason}${'error' in reply ? `, ${reply.error}` : ''}`
      await restart({})
      await logEvent($, home, { kind: 'check', text: `${ws.name}: ${isAfterCompaction ? 'after Claude compacted, ' : ''}the check could not be done: ${why}`, workspace: id })
      return `${ws.name}: the check could not be done: ${why}.`
    }
    const now = await $.clock.now()
    await restart({ check: { at: now, ...verdict } })
    const said = `${ws.name}: ${isAfterCompaction ? 'after Claude compacted, ' : ''}${verdict.status.replace('-', ' ')}: ${verdict.brief}${verdict.ask === undefined ? '' : ` Ask: ${verdict.ask}`}`
    await logEvent($, home, { kind: verdict.status === 'on-track' ? 'check' : 'drift', text: said, workspace: id })
    if (verdict.status !== 'on-track') {
      await $.process
        .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', 'tell', ledgerPath(home), `drift-${id}-${now}`, '', '', await told($, `The agents may need your help. ${said}`), '', 'Workspace check'], { timeoutMs: 20_000 })
        .catch(() => undefined)
    }
    await refresh($, 0)
    return said
  } finally {
    checking.delete(id)
  }
}

/**
 * A workspace's latest hand-off lines, oldest first, from the relay's event
 * log and the one before it (its last 8): those passed, those told to the
 * owner (notify mode), and the agents' own for the owner (NEEDS USER, SCOPE
 * CLOSED).
 */
async function recentCues($: EngineInterface, home: string, id: string): Promise<string[]> {
  const read = (path: string) => $.fs.read(path).catch(() => '')
  const text = `${await read(`${eventsPath(home)}.1`)}\n${await read(eventsPath(home))}`
  return text.split('\n').flatMap(line => {
    try {
      const e = JSON.parse(line) as { kind?: unknown; text?: unknown; workspace?: unknown }
      const isCue = e.kind === 'relay' || e.kind === 'notify' || e.kind === 'needs'
      const cue = e.workspace === id && isCue && typeof e.text === 'string' ? /(READY FOR (CLAUDE|CODEX)|NEEDS USER|SCOPE CLOSED) · .*/.exec(e.text)?.[0] : undefined
      return cue === undefined ? [] : [cue]
    } catch {
      return []
    }
  }).slice(-8)
}

/** After RELAY_CAP hand-offs in a row the relay waits; the owner lets it go on. */
async function continueRelay($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  await changeWorkspaces($, home, list => list.map(ws => (ws.id === id && ws.relay !== undefined ? { ...ws, relay: { ...ws.relay, streak: 0, status: 'going on' } } : ws)))
  await refresh($, 0)
}

/**
 * The relay, run by whichever session collects: for each workspace with it
 * on, reads how each agent's last turn stands (only the turn and its cue
 * line), and takes the steps relaySteps gives, each once across sessions.
 */
async function passCues(
  $: EngineInterface,
  home: string,
  now: number,
  o: { workspaces: readonly Workspace[]; tmux: Snapshot['tmux']; claude: readonly ClaudeSession[]; codex: readonly CodexSession[]; fileOf: ReadonlyMap<string, string> },
) {
  // one agent has no one to pass to: a relay turned on by hand there passes nothing
  const live = o.workspaces.filter(ws => ws.only === undefined && ws.relay !== undefined && ws.relay.mode !== 'off')
  if (live.length === 0) return
  const panesOf = (ws: Workspace) =>
    Object.entries(o.tmux.panes).filter(([, p]) => p.session === tmuxName(ws) && (p.window === 'claude' || p.window === 'codex') && p.pane !== undefined)
  const fileFor = (tool: string, tty: string) => {
    if (tool === 'claude') {
      const s = o.claude.find(c => c.tty === tty)
      return s === undefined ? undefined : { file: o.fileOf.get(`claude-${s.pid}`), isBusy: claudeState(s, now) !== 'idle' }
    }
    const s = o.codex.find(c => c.tty === tty)
    return s === undefined ? undefined : { file: o.fileOf.get(`codex-${s.key}`), isBusy: false }
  }
  const files = [...new Set(live.flatMap(ws => panesOf(ws).flatMap(([tty, p]) => fileFor(p.window, tty)?.file ?? [])))]
  const read = files.length === 0 ? { stdout: '' } : await $.process.run(['/bin/sh', '-c', TURN_SCRIPT, 'sh', ...files], { timeoutMs: 20_000 })
  const turns = parseTurns(read.stdout)
  for (let ws of live) {
    const sides: Partial<Record<'claude' | 'codex', Side>> = {}
    for (const [tty, p] of panesOf(ws)) {
      const tool = p.window as 'claude' | 'codex'
      const known = fileFor(tool, tty)
      const turn = known?.file === undefined ? undefined : turns.get(known.file)
      sides[tool] = { tool, pane: p.pane!, isBusy: (known?.isBusy ?? false) || turn?.state === 'busy', ...(turn === undefined ? {} : { turn }) }
    }
    // Claude's context compacted since the last one kept (of any kind: this plugin's at a hand-off, Claude Code's own,
    // the owner's /compact): kept, so a drift check follows its next hand-off
    const seenCompaction = sides.claude?.turn?.compacted
    if (seenCompaction !== undefined && seenCompaction.at > (ws.compacted?.at ?? 0)) {
      let fresh: Workspace | undefined
      const isSaved = await changeWorkspaces($, home, list => list.map(w => {
        if (w.id !== ws.id || seenCompaction.at <= (w.compacted?.at ?? 0)) return w
        fresh = { ...w, compacted: { ...seenCompaction, isChecked: false } }
        return fresh
      }))
      if (isSaved && fresh !== undefined) ws = fresh
    }
    if (ws.relay !== undefined && afterOwner(ws.relay, sides) !== undefined) {
      // the owner typed to an agent: the count starts again, on the relay as the file has it now
      let fresh: Workspace | undefined
      const isSaved = await changeWorkspaces($, home, list => list.map(w => {
        if (w.id !== ws.id || w.relay === undefined) return w
        fresh = { ...w, relay: afterOwner(w.relay, sides) ?? w.relay }
        return fresh
      }))
      if (!isSaved || fresh === undefined) continue
      ws = fresh
    }
    const run = async (step: Step) => {
      // what is told to the owner hides the names; a hand-off typed to an agent is as it was written
      const args = step.kind === 'tell' ? ['tell', '', '', await told($, step.text)] : ['pass', step.pane, AGENT_COMMANDS[step.to], step.line]
      const out = await $.process
        .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', args[0]!, ledgerPath(home), step.key, args[1]!, args[2]!, args[3]!, '', 'Workspace relay'], { timeoutMs: 20_000 })
        .catch(() => ({ stdout: 'failed' }))
      return out.stdout.trim()
    }
    const saveAfter = (step: Step, outcome: string) =>
      changeWorkspaces($, home, list => list.map(w => (w.id === ws.id && w.relay !== undefined ? { ...w, relay: afterStep(w.relay, step, outcome, now) } : w)))
    // a step's outcome, kept on the workspace (a step taken already, by this or another session, changes nothing)
    const settle = async (step: Step, outcome: string) => {
      const event = eventOf(ws, step, outcome)
      if (event !== undefined) await logEvent($, home, event)
      if (outcome === 'taken') return
      const next = ws.relay === undefined ? undefined : afterStep(ws.relay, step, outcome, now)
      // a pass waiting on a scrolled-back pane says so once, not at every collection
      if (outcome === 'in-mode' && next?.status === ws.relay?.status) return
      await saveAfter(step, outcome)
      // a milestone, or Claude's first hand-off since it compacted: what the agents are doing, held against what the
      // workspace is for (one model call, unawaited)
      const isAfterCompaction = isDueAfterCompaction(ws, step, outcome)
      if (checkDue(ws, step, outcome) || isAfterCompaction) void checkDrift($, home, ws.id, isAfterCompaction).catch(() => undefined)
      const why = step.kind === 'pass' ? passFailure(outcome) : undefined
      if (step.kind === 'pass' && why !== undefined) {
        await $.process
          .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', 'tell', ledgerPath(home), `failed-${step.key}`, '', '', await told($, `${ws.name}: the relay did not pass the hand-off to ${step.to === 'claude' ? 'Claude' : 'Codex'}: ${why}. Paste: ${step.line}`), '', 'Workspace relay'], { timeoutMs: 20_000 })
          .catch(() => undefined)
      }
    }
    // Codex compacts itself, by its own measure: nothing is typed into it but hand-offs
    for (const step of relaySteps(ws, sides, now)) await settle(step, await run(step))
  }
}

/** The relay's event log, which the ops screen reads. */
const eventsPath = (home: string) => `${home}/Library/Caches/live-sessions/events.jsonl`

/** Adds an event to the relay's event log, timed now. */
async function logEvent($: EngineInterface, home: string, event: RelayEvent) {
  // its line well under 1 KB whatever wrote the text: one append, never split or mixed with another session's
  const line = JSON.stringify({ at: await $.clock.now(), ...event, text: cutBytes(event.text, 600) })
  await $.process.run(['/bin/sh', '-c', EVENT_SCRIPT, 'sh', eventsPath(home), line], { timeoutMs: 10_000 }).catch(() => undefined)
}

/**
 * In a Claude session that is a workspace's agent: once a turn of its ends
 * with a hand-off to Codex (READY FOR CODEX), the relay is on (auto) and its
 * context has grown to the workspace's `compactFrom` line (COMPACT_FROM
 * unless set), it compacts itself, told what to keep, as soon as the relay
 * has passed that hand-off (its ledger step), while Codex works and its
 * prompt cache is warm: every request of its next turn then re-reads a small
 * context, not the whole. Between turns only (refused while one runs), while
 * that turn is still its last and it is still that conversation. Never after
 * a cue for the owner (NEEDS USER, SCOPE CLOSED): it waits for the owner's
 * answer. On a smaller window than the line allows for, it compacts from
 * 80% of that window. An idle Claude is left as it is: below the line.
 */
async function compactAtHandOff($: EngineInterface, answer: string) {
  const cue = answer.split('\n').map(cueOf).filter(c => c !== undefined).at(-1)
  if (cue?.kind !== 'ready' || cue.to !== 'codex') return
  const home = (await $.env.get('HOME')) ?? ''
  const id = await $.session.id()
  const snap = await read($, snapshot)
  const self = snap.claude.find(s => s.sessionId === id)
  const pane = self === undefined ? undefined : snap.tmux.panes[self.tty]
  const ws = pane === undefined ? undefined : snap.workspaces.find(w => tmuxName(w) === pane.session)
  // a workspace of one agent has no hand-off to wait for, even with a relay turned on there by hand
  if (self === undefined || ws === undefined || pane?.window !== 'claude' || ws.only !== undefined || ws.relay?.mode !== 'auto') return
  const line = ws.compactFrom ?? COMPACT_FROM
  // below the line (on a window too small for it, 80% of the window), or the line off: nothing to do
  const isOver = async () => {
    const { tokens, window } = (await $.session.usage()).context
    const at = window > 0 ? Math.min(line, Math.floor(window * 0.8)) : line
    return line > 0 && tokens !== undefined && tokens >= at ? tokens : undefined
  }
  if ((await isOver()) === undefined) return
  const file = transcriptPath(`${home}/.${self.profile}`, self.startCwd, id)
  // its last turn, as the relay reads its records: that turn (once its reply is written), still its last, until the
  // relay has taken up its hand-off (its ledger step); not in two minutes (Codex at work, the relay waiting for you):
  // left for a later hand-off
  const lastTurn = async () => parseTurns((await $.process.run(['/bin/sh', '-c', TURN_SCRIPT, 'sh', file], { timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout).get(file)
  let turnId: string | undefined
  for (let waited = 0; ; waited += 2_000) {
    const turn = await lastTurn()
    const isThatTurn = turn?.state === 'done' && turn.cue?.line === cue.line && (turnId === undefined || turn.id === turnId)
    if (turnId !== undefined && !isThatTurn) return
    if (isThatTurn) {
      turnId = turn.id
      if (await $.fs.exists(`${ledgerPath(home)}/pass-${turnId}`)) break
    }
    if (waited >= 120_000) return
    await $.clock.sleep(2_000)
  }
  // still the same conversation (not cleared or resumed into another while it waited), and still over the line (not
  // compacted meanwhile by other means, as the owner's /compact)
  if ((await $.session.id()) !== id) return
  const tokens = await isOver()
  if (tokens === undefined) return
  // logged once it has been done (not refused, not vetoed), with what its summary read from the cache and afresh
  const result = await $.session.compact({ instructions: claudeKeep(ws.name) }).catch(() => undefined)
  if (result === undefined || result.skip !== undefined) return
  const spent = result.usage === undefined ? '' : `; it read ${tokensSaid(result.usage.cache_read_input_tokens)} tokens from the cache, ${tokensSaid(result.usage.input_tokens + result.usage.cache_creation_input_tokens)} afresh`
  await logEvent($, home, { kind: 'compact', text: `${ws.name}: Claude compacted at its hand-off (its context was ${tokensSaid(tokens)} tokens${spent})`, workspace: ws.id, agent: 'claude' })
}

/** Forgets a workspace (the command's `rm` and the pane's Remove): its tmux session keeps running. */
async function removeWorkspace($: EngineInterface, ws: Workspace): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  if (!(await changeWorkspaces($, home, now => now.filter(w => w.id !== ws.id)))) return `Not done: ${UNREADABLE}.`
  await removePrompts($, home, ws.id)
  await $.process.run(['/bin/rm', '-f', placementPath(home, tmuxName(ws)), openScriptPath(home, ws.id)], { timeoutMs: 10_000 }).catch(() => undefined)
  await refresh($, 0)
  return `Removed ${ws.name} (${ws.env || 'default'}, ${ws.dir}). Its agents keep running in tmux session ${tmuxName(ws)} (end it: tmux kill-session -t ${tmuxName(ws)}).`
}

async function assignTo($: EngineInterface, member: string, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const isSaved = await changeWorkspaces($, home, list => assigned(list, member, id))
  await update($, assigning, () => ({ key: '', member: '' }))
  if (!isSaved) await toast($, `Not assigned: ${UNREADABLE}.`)
  await refresh($, 0)
}

async function hideWorkspaceById($: EngineInterface, id: string) {
  const ws = (await read($, snapshot)).workspaces.find(w => w.id === id)
  if (ws !== undefined) await hideWorkspace($, ws)
}

async function openWorkspaceById($: EngineInterface, id: string) {
  const ws = (await read($, snapshot)).workspaces.find(w => w.id === id)
  if (ws === undefined) return
  const result = await openWorkspace($, ws)
  if (!result.isOpen) await toast($, result.text, { timeoutMs: 20_000 })
}

async function resetOrder($: EngineInterface) {
  await update($, manualOrder, () => ({}))
  await $.store.set('order', {})
}

/** Shown, not merely open: a pane waiting for room or behind another tab is not in view. */
const isPaneVisible = async ($: EngineInterface) =>
  (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)

async function tick($: EngineInterface, hasStatusLine: boolean) {
  const isVisible = await isPaneVisible($)
  if (!isVisible && !hasStatusLine) return
  // what the ops screen asks of a session
  void takeRequests($).catch(() => undefined)
  // this account's Claude limits, for every account's panes; the usage, while a pane shows it
  void shareLimits($).catch(() => undefined)
  if (isVisible) void refreshUsage($).catch(() => undefined)
  const maxAgeMs = isVisible ? VISIBLE_MAX_AGE_MS : IDLE_MAX_AGE_MS
  if ((await $.clock.now()) - lastAttemptAt < maxAgeMs) return
  await refresh($, maxAgeMs)
}

/**
 * What the ops screen asks (requestsDir: open or close a workspace), done as /sessions does it, only by a session in a
 * Terminal tab (where a workspace's window opens as /sessions opens one; one inside tmux, a workspace's agent, never
 * does): each request taken by one session alone, by renaming it to its own name first, and answered in its `.done`
 * file. One asked longer ago than REQUEST_MAX_AGE_MS (the ops screen has given up on it) is dropped.
 */
async function takeRequests($: EngineInterface) {
  if (isTaking || (await $.env.get('TERM_PROGRAM')) !== 'Apple_Terminal') return
  isTaking = true
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = requestsDir(home)
    const self = (await $.session.id()).replace(/[^A-Za-z0-9-]/g, '')
    const startedAt = await $.clock.now()
    const listed = await $.fs.list(dir).catch(() => [])
    // answers no screen read (it closed, or gave up waiting), 10 minutes on
    const stale = listed.filter(e => e.kind === 'file' && /^[a-z0-9]{8,40}\.done$/.test(e.name) && e.mtimeMs > 0 && (startedAt - e.mtimeMs) > ANSWER_KEEP_MS)
    if (stale.length > 0) await $.process.run(['/bin/rm', '-f', ...stale.map(e => `${dir}/${e.name}`)], { timeoutMs: 10_000 }).catch(() => undefined)
    for (const entry of listed) {
      const nonce = REQUEST_FILE.exec(entry.name)?.[1]
      if (nonce === undefined || entry.kind !== 'file') continue
      const taken = `${dir}/${nonce}.taken-${self}`
      const moved = await $.process.run(['/bin/mv', `${dir}/${entry.name}`, taken], { timeoutMs: 10_000 }).catch(() => ({ exitCode: -1 }))
      if (moved.exitCode !== 0) continue
      const asked = requestFrom(await readJson($, taken))
      await $.process.run(['/bin/rm', '-f', taken], { timeoutMs: 10_000 }).catch(() => undefined)
      const answer = (text: string, isDone: boolean) => $.fs.write(`${dir}/${nonce}.done`, `${JSON.stringify({ text, isDone })}\n`)
      if (asked === undefined) {
        await answer('Not done: the request could not be read.', false)
        continue
      }
      if ((await $.clock.now()) - asked.at > REQUEST_MAX_AGE_MS) continue
      const { list, isReadable } = await readWorkspaces($, home)
      const ws = list.find(w => w.id === asked.id)
      if (!isReadable || ws === undefined) {
        await answer(isReadable ? 'Not done: that workspace is gone.' : `Not done: ${UNREADABLE}.`, false)
        continue
      }
      if (asked.action === 'open') {
        const opened = await openWorkspace($, ws)
        await answer(opened.text, opened.isOpen)
      } else {
        const closed = await closeWorkspace($, ws)
        await answer(closed.text, closed.isClosed)
      }
    }
  } finally {
    isTaking = false
  }
}
let isTaking = false
/** How long an answer no ops screen has read is kept. */
const ANSWER_KEEP_MS = 600_000

/** Where the usage read so far is kept, and each account's Claude limits, for every session on the Mac. */
const usagePath = (home: string) => `${home}/Library/Caches/live-sessions/usage.json`
const limitsPath = (home: string) => `${home}/Library/Caches/live-sessions/limits.json`
/** The usage is read again at most this often (by any session: one read lately is taken as it is). */
const USAGE_MAX_AGE_MS = 120_000
/** A session's own Claude limits are written for the others at most this often. */
const LIMITS_EVERY_MS = 60_000
/** How many files usage.pl reads in one run (its output stays far below what a run may print). */
const SCAN_BATCH = 100
/** The projects listed per tool and window; the rest are counted. */
const USAGE_ROWS = 8

const EMPTY_VIEW: UsageView = { at: 0, problem: '', offset: 0, offsets: {}, accounts: {} }
const usageShown = atom({ plugin: 'live-sessions', key: 'usageShown' } as const, false)
const usageWindow = atom({ plugin: 'live-sessions', key: 'usageWindow' } as const, '7d' as '5h' | '7d')
const usage = atom({ plugin: 'live-sessions', key: 'usage' } as const, EMPTY_VIEW)

const readJson = async ($: EngineInterface, path: string): Promise<unknown> => {
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * This session's account's Claude limits, as its last response reported
 * them, written for the panes of every account (a session reads only its
 * own): when they changed, or a minute on.
 */
let limitsSharedAt = 0
let limitsShared = ''
async function shareLimits($: EngineInterface) {
  const now = await $.clock.now()
  const home = (await $.env.get('HOME')) ?? ''
  const own = await ownEnv($, home)
  if (own === undefined) return
  const limits = claudeLimits(await $.session.usage().then(u => u.rateLimits).catch(() => []), now)
  const said = JSON.stringify(Object.entries(limits).map(([w, l]) => [w, l?.used, l?.resetsAt]))
  if (Object.keys(limits).length === 0 || (said === limitsShared && now - limitsSharedAt < LIMITS_EVERY_MS)) return
  limitsSharedAt = now
  limitsShared = said
  // with what the account's other sessions read: within a window the highest (an idle session holds an older one)
  const all = sharedLimitsFrom(await readJson($, limitsPath(home)))
  const merged = mergeLimits(all[own], limits)
  const reading = (l: Partial<Record<string, Limit>> | undefined) => JSON.stringify(Object.entries(l ?? {}).map(([w, r]) => [w, r?.used, r?.resetsAt]))
  if (reading(merged) !== reading(all[own])) await $.fs.write(limitsPath(home), `${JSON.stringify({ ...all, [own]: merged })}\n`)
}

/**
 * The usage as the pane shows it: the counts read on from where they were
 * left (usage.pl, a batch of files at a time; none read again within
 * USAGE_MAX_AGE_MS, by any session), then each account's limits and, per
 * tool and window, its projects. One read at a time.
 */
let usageRun: Promise<void> | undefined
let usageReadAt = 0
async function refreshUsage($: EngineInterface, isAsked = false) {
  const now = await $.clock.now()
  if (usageRun !== undefined || (!isAsked && now - usageReadAt < USAGE_MAX_AGE_MS)) return usageRun
  usageReadAt = now
  usageRun = (async () => {
    const home = (await $.env.get('HOME')) ?? ''
    // the counts kept: one there but not read (too large to read, cut by another writer) is said, then read again
    const raw = await readJson($, usagePath(home))
    let state: UsageState = usageFrom(raw)
    // what kept it from counting, each said
    const problems: string[] = raw === undefined && (await $.fs.exists(usagePath(home))) ? ['usage: the counts kept could not be read; read again from the start'] : []
    if (now - state.at >= USAGE_MAX_AGE_MS) {
      const configDirs = (await $.fs.list(home).catch(() => []))
        .filter(d => d.kind === 'dir' && /^\.(claude|codex)(-[\w.-]+)?$/.test(d.name))
        .map(d => `${home}/${d.name}`)
      const listed = await $.process.run(['/bin/sh', '-c', USAGE_FILES_SCRIPT, 'sh', ...configDirs], { timeoutMs: 60_000 }).catch(() => undefined)
      const files = (listed?.stdout ?? '').split('\n').filter(f => f.startsWith('/') && accountOfFile(home, f) !== undefined)
      const since = new Date(now - USAGE_KEEP_MS).toISOString()
      for (let i = 0; i < files.length && listed !== undefined; i += SCAN_BATCH) {
        const batch = files.slice(i, i + SCAN_BATCH)
        const out = await $.process
          .run(['/usr/bin/perl', `${$.plugin.root}/hooks/usage.pl`, 'scan', since], { stdin: scanInput(batch, state), timeoutMs: 300_000 })
          .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error), isStdoutTruncated: false }))
        const isCut = out.isStdoutTruncated === true
        // a failed run is not taken: its files are read from where they were, next time
        if (out.exitCode !== 0 && !isCut) {
          problems.push(`usage: ${firstLine(out.stderr) || `perl exited ${out.exitCode}`}`)
          break
        }
        // one cut short (more than a run may print): the files it finished are taken, the rest read on next time
        const taken = isCut ? wholeFiles(out.stdout) : out.stdout
        if (isCut && taken === '') problems.push('usage: too much output from one file')
        state = applyScan(state, taken, now, f => accountOfFile(home, f))
      }
      if (listed === undefined) problems.push('usage: the transcripts could not be listed')
      // a file no longer listed (older than 8 days, gone) is forgotten; a rollout archived meanwhile keeps its mark
      const listedKeys = new Set(files.map(markKey))
      if (listed !== undefined) state = { ...state, files: Object.fromEntries(Object.entries(state.files).filter(([f]) => listedKeys.has(f))) }
      // a write refused (too large, no room) is said: else every read would start over unseen
      if (state !== EMPTY_USAGE) {
        await $.fs.write(usagePath(home), `${JSON.stringify(state)}\n`).catch((error: unknown) => {
          problems.push(`usage: the counts could not be kept (${firstLine(message(error))}); they are read again from the start`)
        })
      }
    }
    // each folder named for its project: its repository, else the folder
    const dirs = [...new Set(Object.keys(state.slots).map(k => k.split('\t').slice(2).join('\t')))]
    const places = await placesOf($, dirs, now, [])
    const own = await ownEnv($, home)
    const live = claudeLimits(await $.session.usage().then(u => u.rateLimits).catch(() => []), now)
    const shared = sharedLimitsFrom(await readJson($, limitsPath(home)))
    const placeOf = (dir: string) => {
      const place = places[dir]
      return place !== undefined && place.repo !== '' ? { key: place.repo, name: place.name } : { key: dir, name: dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir === home ? '~' : dir }
    }
    const accounts = [...new Set([...(await read($, snapshot)).envs, ...Object.keys(state.codexLimits), ...Object.keys(shared), ...(own === undefined ? [] : [own])])]
    const view: UsageView = { at: state.at, problem: problems.join(' · '), offset: 0, offsets: {}, accounts: {} }
    for (const account of accounts) {
      const limits = {
        claude: currentLimits(account === own ? mergeLimits(shared[account], live) : shared[account], now),
        codex: currentLimits(state.codexLimits[account], now),
      }
      const ranks: UsageView['accounts'][string]['ranks'] = {}
      for (const tool of ['claude', 'codex'] as const) {
        for (const window of ['5h', '7d'] as const) {
          const limit = limits[tool][window]
          const ranked = rankUsage(state, { tool, account, window, now, placeOf, ...(limit === undefined ? {} : { limit }) })
          if (ranked.rows.length > 0) ranks[`${tool} ${window}`] = { since: ranked.since, rows: ranked.rows.slice(0, USAGE_ROWS), more: Math.max(0, ranked.rows.length - USAGE_ROWS) }
        }
      }
      view.accounts[account] = { limits, ranks }
    }
    // the Mac's offset from UTC at each time said (now, each reset, each window's start), as daylight saving has it then
    const times = [now, now - WINDOW_MS['5h'], now - WINDOW_MS['7d'], ...Object.values(view.accounts).flatMap(a => [
      ...Object.values(a.limits.claude), ...Object.values(a.limits.codex),
    ].flatMap(l => (l?.resetsAt === undefined ? [] : [l.resetsAt])).concat(Object.values(a.ranks).map(r => r.since)))]
    const unique = [...new Set(times)]
    const offsets = await $.process.run(['/bin/sh', '-c', OFFSETS_SCRIPT, 'sh', ...unique.map(t => String(Math.floor(t / 1000)))], { timeoutMs: 10_000 }).catch(() => undefined)
    const lines = (offsets?.stdout ?? '').split('\n')
    unique.forEach((t, i) => {
      view.offsets[String(t)] = offsetOf(lines[i] ?? '')
    })
    view.offset = view.offsets[String(now)] ?? 0
    await update($, usage, () => view)
  })().finally(() => {
    usageRun = undefined
  })
  return usageRun
}

/** The usage as text (`/sessions usage`): each shown account's limits, then its projects' parts in the window. */
function usageText(used: UsageView, account: string, window: '5h' | '7d', now: number): string {
  if (used.at === 0) return `Usage: not counted yet${used.problem === '' ? '' : ` (${used.problem})`}.`
  const accounts = account === ALL_ACCOUNTS ? Object.keys(used.accounts).sort((a, b) => a.localeCompare(b)) : [account]
  const clock = clockOf(used, now)
  const lines = accounts.flatMap(a => (['claude', 'codex'] as const).flatMap(tool => {
    const of = used.accounts[a]
    const rank = of?.ranks[`${tool} ${window}`]
    const limit = of?.limits[tool][window]
    const head = `${tool === 'claude' ? 'Claude' : 'Codex'} (${a || 'default'}), ${window}${limit === undefined ? '' : `: ${limitSaid(window, limit, now, clock.offsetAt)}`}`
    if (rank === undefined) return limit === undefined ? [] : [`${head}; nothing counted since ${clock.said(now - WINDOW_MS[window], true)}`]
    const rows = rank.rows.map(r => `${r.name} ${Math.round(r.share * 100)}%${r.ofLimit === undefined ? '' : ` (≈ ${r.ofLimit < 1 ? '<1' : Math.round(r.ofLimit)}% of the limit)`}`)
    return [`${head}; since ${clock.said(rank.since, true)}: ${rows.join(', ')}${rank.more === 0 ? '' : `, +${rank.more} more`}`]
  }))
  return [...lines, ...(used.problem === '' ? [] : [`! ${used.problem}`])].join('\n') || `Usage: nothing counted in this ${window} window.`
}

async function toggleUsage($: EngineInterface) {
  const next = await update($, usageShown, now => !now)
  await $.store.set('usageShown', next)
  if (next) void refreshUsage($, true).catch(() => undefined)
}

async function setUsageWindow($: EngineInterface, window: '5h' | '7d') {
  await update($, usageWindow, () => window)
  await $.store.set('usageWindow', window)
}

export const register: Register = on => {
  // a workspace's Claude compacts itself after a hand-off, when its context has grown large enough: never holds up the turn
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') void compactAtHandOff($, e.answer).catch(() => undefined)
    return result
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // a create cut off by a reload of the plugin never holds the next one back
    await update($, creating, () => false)
    await $.command.register({
      name: 'sessions',
      description: 'Show or hide the live Claude Code and Codex sessions on this Mac',
      argumentHint: '[2d | 12h | all | reset | usage [5h | 7d]]',
    })
    await $.command.register({
      name: 'workspace',
      description: 'Named workspaces: a folder, an environment, Claude and Codex (or one of them) in one tmux session',
      argumentHint: 'new <folder> <env> <name> [--only claude|codex] [--go-on] [--for <purpose>] | open <name> | close <name> | rm <name>',
    })
    const kept = await $.store.get('windowMs')
    if (typeof kept === 'number' && kept >= 0) await update($, activeWindow, () => kept)
    const keptAll = await $.store.get('allAccounts')
    if (typeof keptAll === 'boolean') await update($, allAccounts, () => keptAll)
    const keptUsage = await $.store.get('usageShown')
    if (typeof keptUsage === 'boolean') await update($, usageShown, () => keptUsage)
    const keptWindow = await $.store.get('usageWindow')
    if (keptWindow === '5h' || keptWindow === '7d') await update($, usageWindow, () => keptWindow)
    const keptOrder = orderFrom(await $.store.get('order'))
    if (keptOrder !== undefined) await update($, manualOrder, () => keptOrder)
    await readHiding($).catch(() => undefined)
    // a status line only where a person sees one; a pane wherever one is opened
    const hasStatusLine = e.isInteractive
    // a pane left open across a reload is painted without being reopened
    if (hasStatusLine) {
      const refreshed = refresh($, IDLE_MAX_AGE_MS)
      void refreshed.then(() => learnBackground($)).catch(() => undefined)
      void refreshed.then(() => prepareRunning($)).catch(() => undefined)
    }
    $.clock.every(TICK_MS, () => {
      void tick($, hasStatusLine).catch(() => undefined)
    })
    // the names' switch, as another screen may have turned it: looked at every second while the pane is in view
    $.clock.every(1_000, () => {
      void (async () => {
        if (await isPaneVisible($)) await readHiding($)
      })().catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'workspace' }, async ($, e) => {
    const home = (await $.env.get('HOME')) ?? ''
    await refresh($, VISIBLE_MAX_AGE_MS)
    const snap = await read($, snapshot)
    const named = snap.envs.filter(env => env !== '')
    const usage = `Usage: /workspace new <folder> <${['default', ...named].join(' | ')}> <name> [--only claude | codex] [--go-on: with the branch checked out in <folder>] [--for <what it is for: Claude gets peer coding ready for it>]; /workspace open <name>; /workspace close <name> (its agents end between turns; open goes on with their conversations); /workspace rm <name>`
    const command = parseWorkspaceArgs(e.args, named, home)
    const { list, isReadable } = await readWorkspaces($, home)
    const label = (ws: Workspace) => `${ws.name} (${ws.env || 'default'}, ${ws.dir})`
    switch (command.action) {
      case 'help':
        return { text: `${command.error === undefined ? '' : `Not done: ${command.error}. `}${usage}` }
      case 'list':
        return { text: list.length === 0 ? `No workspaces yet. ${usage}` : `Workspaces: ${list.map(label).join('; ')}. ${usage}` }
      case 'open':
      case 'close':
      case 'rm':
        if (!isReadable) return { text: `Not done: ${UNREADABLE}.` }
    }
    switch (command.action) {
      case 'open': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        return { text: (await openWorkspace($, ws)).text }
      }
      case 'close': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        return { text: (await closeWorkspace($, ws)).text }
      }
      case 'rm': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        return { text: await removeWorkspace($, ws) }
      }
      case 'new':
        if (!isReadable) return { text: `Not done: ${UNREADABLE}.` }
        return { text: (await createWorkspace($, command)).text }
    }
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    const usageAsked = /^usage(?:\s+(5h|7d))?$/i.exec(e.args.trim())
    if (usageAsked !== null) {
      await refresh($, VISIBLE_MAX_AGE_MS)
      await refreshUsage($, true)
      return { text: usageText(await read($, usage), await shownAccount($, (await $.env.get('HOME')) ?? ''), (usageAsked[1]?.toLowerCase() ?? (await read($, usageWindow))) as '5h' | '7d', await $.clock.now()) }
    }
    if (e.args.trim().toLowerCase() === 'reset') {
      await resetOrder($)
    } else if (e.args.trim() !== '') {
      const ms = windowFrom(e.args)
      if (ms === undefined) {
        return { text: 'Usage: /sessions [2d | 12h | all]: list the sessions active that recently; /sessions reset: back to the automatic order; /sessions usage [5h | 7d]: each project\'s part of each account\'s limits.' }
      }
      await setWindow($, ms)
    } else if (await isPaneVisible($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Sessions pane closed.' }
    }
    await refresh($, VISIBLE_MAX_AGE_MS)
    await learnBackground($)
    await readHiding($).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    // its limits (and usage) read as it opens, not at the next tick
    void refreshUsage($).catch(() => undefined)
    const windowMs = await read($, activeWindow)
    const showing = windowMs === 0 ? 'all sessions' : `active in the last ${windowLabel(windowMs)}`
    if (opened.isPlaced) return { text: `Sessions pane opened (${showing}).` }
    return { text: `${await summaryShown($, (await $.env.get('HOME')) ?? '', await read($, snapshot))} (${showing}; widen the terminal to see the pane)` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const home = (await $.env.get('HOME')) ?? ''
    // what this session's account sees (or every account's): its sessions, its workspaces, its offers
    const own = await ownEnv($, home)
    const account = await shownAccount($, home)
    const snap = forAccount(await read($, snapshot), account)
    const windowMs = await read($, activeWindow)
    const now = await $.clock.now()
    const selfId = await $.session.id()
    const paint = (await read($, background)) || undefined
    // the names kept off the screens, while ABC-XYZ hides them: out of every text drawn, a row's title before it is cut
    // (as the file says now: a pane coming back into view never draws them from an older look)
    await read($, hiding)
    const hidingNow = await currentHiding($)
    namesDrawn = hidingNow
    const names = hiddenNames(hidingNow)
    // lit while it hides something
    const isHiding = names.length > 0
    const width = e.props.bodyColumns
    const height = e.props.scroll.bodyRows
    const hasWhere = width >= 64
    // each session's context, where a row has room for it
    const hasContext = width >= 80
    const order = await read($, manualOrder)
    const view = viewOf(snap, { home, now, windowMs, selfId, order })
    // a press reaches another Terminal tab or window, so only inside Terminal.app
    const canOpen = (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal'
    const hasMove = hasWhere && canOpen
    // a session row's title, in a row `w` wide
    const titleWidthAt = (w: number) => Math.max(8, w - (6 + 7 + 11 + (hasWhere ? 9 : 0) + (hasContext ? 10 : 0) + 5 + 10))
    const elements = $.ui.resolve(e)
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const form = await read($, draft)
    // the project's worktrees to go on with, once found for the folder the form names
    const found = await read($, worktrees)
    // the agents chosen in the form ('' both; a form open since before the choice was offered has none)
    const formOnly = form.only === 'claude' || form.only === 'codex' ? form.only : ''
    const choosing = await read($, assigning)
    const isCreating = await read($, creating)
    const openForm = (dir: string) => () => void openDraft($, dir)
    const setForm = (field: 'name' | 'purpose') => (value: string) => void update($, draft, d => ({ ...d, [field]: value, error: '' }))
    // typing in the project field searches; a pick sets the folder
    // the running sessions the form can bring in: the project's, once one is chosen; any row's for its own action
    // the workspace this session runs in, if it is one's agent: it never closes itself
    const me = snap.claude.find(c => c.sessionId === selfId)
    const ownSession = me === undefined ? undefined : snap.tmux.panes[me.tty]?.session
    const offeredAll = bringable(snap, { now, selfId })
    const formDir = absoluteDir(form.dir || form.query, home)
    // of the agents chosen: a workspace of one agent takes in a session of that agent only
    const branches = form.isOpen && formDir !== undefined && found.dir === formDir ? found.list : []
    // the places a path typed was found in, to pick one (a form from before this list has none)
    const choices = Array.isArray(form.choices) ? form.choices : []
    // the repository's sessions, wherever its worktrees are
    const offered = form.isOpen && formDir !== undefined ? bringable(snap, { now, selfId }, [formDir, ...branches.map(b => b.path)]).filter(b => formOnly === '' || b.tool === formOnly) : []
    const matches = form.isOpen ? rankProjects(await read($, projects), [...snap.claude, ...snap.codex].map(s => ({ cwd: s.cwd, at: 'lastActive' in s ? s.lastActive : s.since })), form.dir === '' ? form.query : '', home) : []
    const pending = await read($, pendingMove)
    const isPending = (key: string) => pending.key === key && now - pending.at < CONFIRM_MS
    // Remove, like the move, asks for a second press
    const pressRemove = (id: string) => async () => {
      const at = await $.clock.now()
      const asked = await read($, pendingMove)
      if (asked.key === `rm:${id}` && at - asked.at < CONFIRM_MS) {
        await update($, pendingMove, () => ({ key: '', at: 0 }))
        const ws = (await read($, snapshot)).workspaces.find(w => w.id === id)
        if (ws !== undefined) await toast($, await removeWorkspace($, ws), { timeoutMs: 15_000 })
        await update($, selected, () => '')
      } else {
        await update($, pendingMove, () => ({ key: `rm:${id}`, at }))
      }
    }
    // Close too: its agents end (between turns), their conversations kept for Open
    const pressClose = (id: string) => async () => {
      const at = await $.clock.now()
      const asked = await read($, pendingMove)
      if (asked.key === `close:${id}` && at - asked.at < CONFIRM_MS) {
        await update($, pendingMove, () => ({ key: '', at: 0 }))
        const ws = (await read($, snapshot)).workspaces.find(w => w.id === id)
        if (ws !== undefined) await toast($, (await closeWorkspace($, ws)).text, { timeoutMs: 15_000 })
      } else {
        await update($, pendingMove, () => ({ key: `close:${id}`, at }))
      }
    }
    const pressMove = (key: string, move: NonNullable<Item['move']>) => async () => {
      const at = await $.clock.now()
      const asked = await read($, pendingMove)
      if (asked.key === key && at - asked.at < CONFIRM_MS) {
        await update($, pendingMove, () => ({ key: '', at: 0 }))
        await moveToBackground($, move)
      } else {
        await update($, pendingMove, () => ({ key, at }))
      }
    }

    // each row carries one [ more ]; pressed, the row's actions show under it, each a worded button with a
    // key that presses it while this pane has the focus
    const open = await read($, selected)
    // one row's actions at a time; a workspace chooser left open goes with them. The keyboard stays where it
    // is: a key in ( ) works once the person gives this pane the keys (ctrl+x tab), never by surprise
    const toggle = (id: string) => async () => {
      await update($, selected, now => (now === id ? '' : id))
      await update($, assigning, () => ({ key: '', member: '' }))
    }
    const more = (id: string): Element => (
      <Box width={9} flexShrink={0} marginLeft={1}>
        <Button key={`more ${id}`} label={open === id ? 'hide' : 'more'} {...(open === id ? { variant: 'primary' as const } : {})} onPress={() => void toggle(id)()} />
      </Box>
    )
    const bar = (id: string, indent: number, children: Element[], w = width): Element => (
      <Box key={`bar ${id}`} flexDirection="row" flexWrap="wrap" width={w - indent} marginLeft={indent} columnGap={2}>
        {children}
        <Button key={`close ${id}`} label="Close (x)" hotkey="x" onPress={() => void toggle(id)()} />
      </Box>
    )
    // Move up and Move down among a row's siblings as listed now; at an end of the list, drawn dim
    const moves = (scope: string, shown: readonly string[], key: string): Element[] =>
      shown.length < 2
        ? []
        : [
            <Button key={`up ${scope} ${key}`} label="Move up (u)" hotkey="u" dimColor={shown[0] === key} onPress={() => void move($, scope, shown, key, -1)} />,
            <Button key={`down ${scope} ${key}`} label="Move down (d)" hotkey="d" dimColor={shown[shown.length - 1] === key} onPress={() => void move($, scope, shown, key, 1)} />,
          ]

    const itemRow = (i: Item, siblings: readonly string[], scope: string, w = width) => {
      const isWorking = i.state === 'working'
      const isBackground = i.state === 'background'
      const isIdle = i.state === 'idle'
      const color = isWorking ? 'warning' : isBackground ? 'suggestion' : isIdle ? undefined : 'permission'
      const tool = TOOL_COLOR[i.tool]
      const title = hideNames(i.tags.length > 0 ? `${i.title} (${i.tags.join(', ')})` : i.title, names)
      const target = canOpen ? i.target : undefined
      return (
        <Box key={i.key} flexDirection="row" width={w} {...(isIdle ? { backgroundColor: IDLE_BACKGROUND } : {})}>
          <Box width={6} flexShrink={0}>
            <Text color={tool}>{`    ${isWorking ? '●' : isBackground ? '◐' : isIdle ? '○' : '◆'}`}</Text>
          </Box>
          <Box width={7} flexShrink={0}>
            <Text color={tool} bold>{i.tool}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {target === undefined ? (
              <Text wrap="truncate-end">{title}</Text>
            ) : (
              <Button
                key={`open ${i.key}`}
                label={title.length > titleWidthAt(w) ? `${title.slice(0, titleWidthAt(w) - 1)}…` : title}
                plain
                onPress={() => void openSession($, target)}
              />
            )}
          </Box>
          <Box width={10} flexShrink={0} marginLeft={1}>
            <Text color={color} wrap="truncate-end">{i.state}</Text>
          </Box>
          {hasWhere && (
            <Box width={8} flexShrink={0} marginLeft={1}>
              <Text dimColor wrap="truncate-end">{i.where}</Text>
            </Box>
          )}
          {hasContext && (
            <Box width={9} flexShrink={0} marginLeft={1}>
              <Text dimColor wrap="truncate-end">{i.context === undefined ? '' : i.context}</Text>
            </Box>
          )}
          <Box width={4} flexShrink={0} marginLeft={1}>
            <Text dimColor wrap="truncate-end">{ago(now - i.lastActive)}</Text>
          </Box>
          {more(`item:${i.key}`)}
        </Box>
      )
    }
    // the background work a session has going, a line each under its row: what it is, what its call said it does, for
    // how long (the oldest few, then how many more)
    const taskRows = (i: Item, w: number): Element[] => {
      const tasks = i.tasks ?? []
      const shown = tasks.slice(0, TASKS_SHOWN)
      const row = (key: string, text: string) => (
        <Box key={key} width={w - 13} marginLeft={13}>
          <Text dimColor wrap="truncate-end">{text}</Text>
        </Box>
      )
      return [
        ...shown.map(t => row(`task ${i.key} ${t.id}`, `↳ ${t.kind}${t.what === '' ? '' : `  ${t.what}`} · ${ago(now - t.since)}`)),
        ...(tasks.length > shown.length ? [row(`tasks ${i.key}`, `↳ ${tasks.length - shown.length} more`)] : []),
      ]
    }
    // a session's row and, while shown, its actions; while it is being assigned, the workspaces to choose from
    const sessionRow = (i: Item, siblings: readonly string[], scope: string, treeDir = '', w = width) => {
      const id = `item:${i.key}`
      const target = canOpen ? i.target : undefined
      const offer = !treeDir.startsWith('/') || Input === undefined ? undefined : offeredAll.find(b => b.member === i.memberId && b.blocked === undefined)
      const actions = (): Element[] => [
        ...(target === undefined ? [] : [<Button key={`open-bar ${i.key}`} label="Open (o)" hotkey="o" variant="primary" onPress={() => void openSession($, target)} />]),
        // a new workspace this session goes on in, in its own conversation
        ...(offer === undefined ? [] : [<Button key={`bring ${i.key}`} label="New workspace with it (n)" hotkey="n" onPress={() => void openDraft($, treeDir, offer)} />]),
        ...(hasMove && i.move !== undefined
          ? [
              // a click, twice: no key, so no two keystrokes can move a session
              <Button
                key={`bg ${i.key}`}
                label={isPending(i.key) ? 'Press again to move it' : 'To background'}
                {...(isPending(i.key) ? { variant: 'primary' as const } : {})}
                onPress={() => void pressMove(i.key, i.move!)()}
              />,
            ]
          : []),
        ...(i.memberId === undefined
          ? []
          : [<Button key={`assign ${i.key}`} label="Assign to workspace (w)" hotkey="w" onPress={() => void update($, assigning, () => ({ key: i.key, member: i.memberId! }))} />]),
        ...moves(scope, siblings, i.key),
      ]
      const choices = (): Element[] => [
        <Text dimColor>Assign to:</Text>,
        ...snap.workspaces.map(ws => <Button key={`assign-to ${i.key} ${ws.id}`} label={ws.name} onPress={() => void assignTo($, choosing.member, ws.id)} />),
        <Button key={`assign-to ${i.key} -`} label="No workspace" onPress={() => void assignTo($, choosing.member, '')} />,
        <Button key={`assign-cancel ${i.key}`} label="Back" onPress={() => void update($, assigning, () => ({ key: '', member: '' }))} />,
      ]
      return (
        <Box key={`row ${i.key}`} flexDirection="column" width={w}>
          {itemRow(i, siblings, scope, w)}
          {taskRows(i, w)}
          {open === id && bar(id, 6, choosing.key === i.key ? choices() : actions(), w)}
        </Box>
      )
    }
    const repoKeys = view.repos.map(r => r.key)

    const problems = snap.problems.map(p => (
      <Text color="error" wrap="truncate-end">{`! ${p}`}</Text>
    ))
    if (snap.checkedAt === 0) {
      return hideInTree(
        <Box flexDirection="column" width={width} minHeight={height} backgroundColor={paint}>
          {problems.length === 0 ? <Text dimColor>Looking for sessions…</Text> : problems}
        </Box>,
        names,
      )
    }

    const listed = [...view.workspaces.flatMap(w => w.items), ...view.repos.flatMap(r => r.trees.flatMap(t => t.items))]
    const working = listed.filter(i => i.state === 'working').length
    const inBackground = listed.filter(i => i.state === 'background').length

    // each shown account's limits, as last read; under them, while asked for, its projects' parts of them
    const used = await read($, usage)
    const isUsageShown = await read($, usageShown)
    const usedIn = await read($, usageWindow)
    const usageAccounts = account === ALL_ACCOUNTS ? Object.keys(used.accounts).sort((a, b) => a.localeCompare(b)) : [account]
    const accountName = (a: string) => a || 'default'
    const clock = clockOf(used, now)
    const asOf = (l: { at: number }) => (now - l.at > 3_600_000 ? ` (${ago(now - l.at)} ago)` : '')
    const limitsLine = (a: string) => {
      const of = used.accounts[a]
      if (of === undefined) return ''
      const part = (tool: 'claude' | 'codex', label: string) => {
        const said = (['5h', '7d'] as const).flatMap(w => {
          const l = of.limits[tool][w]
          return l === undefined ? [] : [`${limitSaid(w, l, now, clock.offsetAt)}${tool === 'codex' ? asOf(l) : ''}`]
        })
        return said.length === 0 ? [] : [`${label} ${said.join(' · ')}`]
      }
      return [...part('claude', 'Claude'), ...part('codex', 'Codex')].join(' │ ')
    }
    const limitRows = usageAccounts.map(a => ({ a, line: limitsLine(a) })).filter(r => r.line !== '')
    const usagePanel = (): Element[] => [
      <Box key="usage-head" flexDirection="row" width={width} columnGap={1}>
        <Text bold>Usage by project</Text>
        {(['5h', '7d'] as const).map(w => (
          <Button key={`usage-window ${w}`} label={w} {...(w === usedIn ? { variant: 'primary' as const } : {})} onPress={() => void setUsageWindow($, w)} />
        ))}
        <Text dimColor wrap="truncate-end">{used.at === 0 ? 'reading…' : `counted ${ago(now - used.at)} ago · each project's share of the account's use, and about how much of the limit that is`}</Text>
      </Box>,
      ...(used.problem === '' ? [] : [<Text key="usage-problem" color="error" wrap="truncate-end">{`! ${used.problem}`}</Text>]),
      ...usageAccounts.flatMap(a => (['claude', 'codex'] as const).flatMap(tool => {
        const rank = used.accounts[a]?.ranks[`${tool} ${usedIn}`]
        if (rank === undefined) return []
        const limit = used.accounts[a]?.limits[tool][usedIn]
        const label = `${tool === 'claude' ? 'Claude' : 'Codex'} · ${accountName(a)} · since ${clock.said(rank.since, true)}${limit === undefined ? ' · its limit not read yet' : ` · ${Math.round(limit.used)}% of the ${usedIn} limit used`}`
        return [
          <Text key={`usage ${a} ${tool}`} color={TOOL_COLOR[tool]} wrap="truncate-end">{`  ${label}`}</Text>,
          ...rank.rows.map(r => (
            <Box key={`usage ${a} ${tool} ${r.key}`} flexDirection="row" width={width}>
              <Box flexGrow={1} flexShrink={1} marginLeft={4}>
                <Text wrap="truncate-end">{r.name}</Text>
              </Box>
              <Box width={5} flexShrink={0} marginLeft={1}>
                <Text>{`${Math.round(r.share * 100)}%`.padStart(4)}</Text>
              </Box>
              <Box width={16} flexShrink={0} marginLeft={1}>
                <Text dimColor>{r.ofLimit === undefined ? '' : `≈ ${r.ofLimit < 1 ? '<1' : Math.round(r.ofLimit)}% of limit`}</Text>
              </Box>
            </Box>
          )),
          ...(rank.more === 0 ? [] : [<Text key={`usage ${a} ${tool} more`} dimColor>{`    +${rank.more} more`}</Text>]),
        ]
      })),
      ...(used.at !== 0 && usageAccounts.every(a => used.accounts[a] === undefined || (used.accounts[a]!.ranks[`claude ${usedIn}`] === undefined && used.accounts[a]!.ranks[`codex ${usedIn}`] === undefined))
        ? [<Text key="usage-none" dimColor>{`  nothing counted in this ${usedIn} window`}</Text>]
        : []),
    ]
    const hidden = view.total - view.shown
    return hideInTree(
      <Box flexDirection="column" width={width} minHeight={height} backgroundColor={paint}>
        <Box flexDirection="row" width={width}>
          <Text bold>{`${snap.claude.length} Claude · ${snap.codex.length} Codex`}</Text>
          {working > 0 && <Text color="warning">{` · ${working} working`}</Text>}
          {inBackground > 0 && <Text color="suggestion">{` · ${inBackground} background`}</Text>}
        </Box>
        <Box flexDirection="row" width={width} columnGap={1}>
          <Text dimColor>active in</Text>
          {WINDOWS.map(w => (
            <Button
              key={`window-${w.label}`}
              label={w.label}
              hotkey={w.hotkey}
              {...(w.ms === windowMs ? { variant: 'primary' as const } : {})}
              onPress={() => void setWindow($, w.ms)}
            />
          ))}
          {!WINDOWS.some(w => w.ms === windowMs) && <Text color="warning">{windowLabel(windowMs)}</Text>}
          {own !== undefined && (
            <Button
              key="accounts"
              label={account === ALL_ACCOUNTS ? 'all accounts' : `account: ${own || 'default'}`}
              {...(account === ALL_ACCOUNTS ? { variant: 'primary' as const } : {})}
              onPress={() => void toggleAccounts($)}
            />
          )}
          {Object.keys(order).length > 0 && (
            <Button key="reset-order" label="reset order" onPress={() => void resetOrder($)} />
          )}
          <Button key="names" label="ABC-XYZ" {...(isHiding ? { variant: 'primary' as const } : {})} onPress={() => void toggleHiding($)} />
        </Box>
        <Box key="limits" flexDirection="row" width={width} columnGap={1}>
          <Button key="usage" label={isUsageShown ? 'hide usage' : 'usage by project'} {...(isUsageShown ? { variant: 'primary' as const } : {})} onPress={() => void toggleUsage($)} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {limitRows.length === 0 && <Text dimColor wrap="truncate-end">{used.at === 0 ? 'limits: reading…' : 'limits: not read yet'}</Text>}
            {limitRows.map(r => (
              <Text key={`limits ${r.a}`} dimColor wrap="truncate-end">{account === ALL_ACCOUNTS ? `${accountName(r.a)}: ${r.line}` : r.line}</Text>
            ))}
          </Box>
        </Box>
        {isUsageShown && (
          <Box key="usage-panel" flexDirection="column" width={width} marginTop={1}>
            {usagePanel()}
          </Box>
        )}
        <Box key="workspaces" flexDirection="column" width={width} marginTop={1}>
          <Box flexDirection="row" width={width} columnGap={1}>
            <Text bold>Workspaces</Text>
            {Input !== undefined && !form.isOpen && <Button key="workspace:new" label="+ New workspace (n)" hotkey="n" onPress={openForm('')} />}
            {canOpen && <Button key="ops" label="Ops screen" onPress={() => void openOps($)} />}
          </Box>
          {view.workspaces.length === 0 && !form.isOpen && (
            <Text dimColor wrap="truncate-end">{'  none yet: + New workspace, or /workspace new <folder> <env> <name> --for <purpose>'}</Text>
          )}
          {form.isOpen && Input !== undefined && Select !== undefined && (
            <Box key="form" flexDirection="column" width={width - 2} marginLeft={2}>
              <Input key="form:name" label="name" autoFocus value={form.name} placeholder="Practice RBAC" onInput={setForm('name')} onSubmit={() => void submitDraft($)} />
              <Input
                key="form:project"
                label="repository"
                value={form.query}
                placeholder="search by name (a repository or a branch's worktree), or paste a folder or file in one"
                onInput={value => {
                  void (async () => {
                    await update($, draft, d => ({ ...d, query: value, dir: '', bring: [], goOn: '', choices: [], error: '' }))
                    // a path: placed in its repository, and in its branch's worktree when it is in one
                    if (typedPath(value) !== undefined) await placeTyped($, value)
                  })().catch(() => undefined)
                }}
                onSubmit={() => void submitDraft($)}
              />
              {form.dir === '' && (choices.length > 0 || matches.length > 0) && (
                <Select
                  key="form:pick"
                  label="found"
                  // a path found in several places, those; else the repositories and branches the search found
                  options={choices.length > 0 ? choices.map(path => ({ value: path, label: rankProjects([path], [], '', home)[0]?.label ?? path })) : matches.map(m => ({ value: m.path, label: m.label }))}
                  onSelect={value => {
                    const shown = rankProjects([value], [], '', home)[0]?.label ?? value
                    // its folder (and branch) once placed; until then, the folder as picked
                    void (async () => {
                      await update($, draft, d => ({ ...d, dir: '', query: shown, bring: [], goOn: '', choices: [], error: '' }))
                      await placeTyped($, shown)
                    })().catch(() => undefined)
                  }}
                />
              )}
              {form.dir !== '' && absoluteDir(form.query, home) !== form.dir && (
                <Text dimColor wrap="truncate-end">{`  in the repository ${form.dir.startsWith(`${home}/`) ? `~${form.dir.slice(home.length)}` : form.dir}`}</Text>
              )}
              {offered.length > 0 && <Text dimColor wrap="truncate-end">{'bring in (each closes where it runs and goes on here, in its own conversation):'}</Text>}
              {offered.map(b => {
                const isChosen = form.bring.includes(b.member)
                if (b.blocked !== undefined) {
                  return (
                    <Box key={`form:bring-row ${b.member}`} marginLeft={2}>
                      <Text dimColor wrap="truncate-end">{`${b.label} · not offered: ${b.blocked}`}</Text>
                    </Box>
                  )
                }
                return (
                  <Box key={`form:bring-row ${b.member}`} marginLeft={2}>
                    <Button
                      key={`form:bring ${b.member}`}
                      label={`${isChosen ? '[x]' : '[ ]'} ${b.label}${b.isIdle ? '' : ' · working: bring it in once its turn is done'}`}
                      {...(isChosen ? { variant: 'primary' as const } : {})}
                      onPress={() => void update($, draft, d => ({ ...d, bring: toggled(d.bring, b.member), ...(d.bring.includes(b.member) ? {} : { env: b.env }), error: '' }))}
                    />
                  </Box>
                )
              })}
              {branches.length > 0 && (
                <Select
                  key="form:branch"
                  label="branch"
                  options={[
                    { value: 'new', label: 'a new branch for the purpose (a clean start, in a worktree of its own)' },
                    ...branches.map(b => ({ value: b.path, label: `go on with ${b.branch} · ${b.path.startsWith(`${home}/`) ? `~${b.path.slice(home.length)}` : b.path}` })),
                  ]}
                  value={form.goOn || 'new'}
                  onSelect={value => void update($, draft, d => ({ ...d, goOn: value === 'new' ? '' : value, error: '' }))}
                />
              )}
              <Select
                key="form:agents"
                label="agents"
                options={[
                  { value: 'both', label: 'Claude and Codex' },
                  { value: 'claude', label: 'Claude only' },
                  { value: 'codex', label: 'Codex only' },
                ]}
                value={formOnly || 'both'}
                // a session chosen to bring in that the workspace will not run is let go
                onSelect={value => {
                  const only: '' | 'claude' | 'codex' = value === 'claude' ? 'claude' : value === 'codex' ? 'codex' : ''
                  void update($, draft, d => ({ ...d, only, bring: d.bring.filter(m => only === '' || m.startsWith(`${only}:`)), error: '' }))
                }}
              />
              <Select
                key="form:env"
                label="environment"
                options={snap.envs.map(env => ({ value: env || 'default', label: env || 'default' }))}
                value={form.env || 'default'}
                onSelect={value => void update($, draft, d => ({ ...d, env: value === 'default' ? '' : value, error: '' }))}
              />
              <Input
                key="form:purpose"
                label="what it is for"
                value={form.purpose}
                placeholder={formOnly === '' ? 'optional: Claude sets up peer coding for it, and the relay passes each hand-over' : `optional: ${formOnly === 'claude' ? 'Claude' : 'Codex'} gets ready for it, then waits for you`}
                onInput={setForm('purpose')}
                onSubmit={() => void submitDraft($)}
              />
              <Box flexDirection="row" columnGap={1}>
                <Button key="form:create" label={isCreating ? 'creating…' : 'create'} variant="primary" onPress={() => void submitDraft($)} />
                <Button key="form:cancel" label="cancel" onPress={() => void update($, draft, () => NO_DRAFT)} />
              </Box>
              {form.error !== '' && <Text color="error" wrap="wrap">{form.error}</Text>}
            </Box>
          )}
          {view.workspaces.map(ws => {
            // each workspace in a box of its own, a line apart, its border marked while it waits on the owner (the
            // relay, or a check not on track); on a pane too narrow for a row and a box, no box
            const isBoxed = width >= BOXED_FROM
            const inner = isBoxed ? width - 4 : width
            const look = !isBoxed ? {} : { paddingX: 1, borderStyle: 'round', ...(ws.relay.needsOwner || ws.check?.isOk === false ? { borderColor: 'warning' as const } : { borderDimColor: true }) }
            return (
            <Box key={`ws-${ws.key}`} flexDirection="column" width={width} marginTop={1} {...look}>
              <Box key={`ws-head ${ws.key}`} flexDirection="row" width={inner}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">{ws.name}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text color="permission">{ws.env || 'default'}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text dimColor>{ws.isAttached ? 'open' : ws.isRunning ? 'running' : 'stopped'}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={2}>
                  <Button key={`wsopen ${ws.key}`} label="Open" onPress={() => void openWorkspaceById($, ws.key)} />
                </Box>
                {/* in its actions too: on a narrow pane the row keeps room for the name */}
                {width >= 80 && ws.only === undefined && (
                  <Box flexShrink={0} marginLeft={2}>
                    <Button key={`relay ${ws.key}`} label={`Relay: ${ws.relay.mode}`} {...(ws.relay.mode === 'auto' ? { variant: 'primary' as const } : {})} onPress={() => void cycleRelay($, ws.key)} />
                  </Box>
                )}
                {more(`ws:${ws.key}`)}
              </Box>
              <Box key={`ws-dir ${ws.key}`} width={inner - 2} marginLeft={2}>
                <Text dimColor wrap="truncate-end">{`${ws.only === undefined ? '' : `${ws.only === 'claude' ? 'Claude' : 'Codex'} only · `}${ws.branch === undefined ? '' : `on ${ws.branch} · `}${ws.dir}`}</Text>
              </Box>
              {open === `ws:${ws.key}` &&
                bar(`ws:${ws.key}`, 2, [
                  <Button key={`wsopen-bar ${ws.key}`} label="Open (o)" hotkey="o" variant="primary" onPress={() => void openWorkspaceById($, ws.key)} />,
                  // by a click only: turned on, the relay types into the agents
                  ...(ws.isAttached ? [<Button key={`hide ${ws.key}`} label="Hide window" onPress={() => void hideWorkspaceById($, ws.key)} />] : []),
                  // for now: its agents end between turns, and Open goes on with their conversations
                  ...(ws.isRunning && ownSession !== `ws-${ws.key}`
                    ? [
                        <Button
                          key={`wsclose ${ws.key}`}
                          label={isPending(`close:${ws.key}`) ? 'Press again to close it' : 'Close (Open goes on with it)'}
                          {...(isPending(`close:${ws.key}`) ? { variant: 'primary' as const } : {})}
                          onPress={() => void pressClose(ws.key)()}
                        />,
                      ]
                    : []),
                  // the relay, the compaction at a hand-off and the drift check all go by hand-offs: one agent makes none
                  ...(ws.only !== undefined
                    ? []
                    : [
                        <Button key={`relay-bar ${ws.key}`} label={`Relay: ${ws.relay.mode} → ${RELAY_NEXT[ws.relay.mode]}`} onPress={() => void cycleRelay($, ws.key)} />,
                        <Button key={`compact ${ws.key}`} label={`Claude compacts from: ${compactSaid(ws.compactFrom)} → ${compactSaid(nextCompactFrom(ws.compactFrom))}`} onPress={() => void cycleCompactFrom($, ws.key)} />,
                        <Button key={`check ${ws.key}`} label="Check now" onPress={() => void checkNow($, ws.key)} />,
                        <Button key={`check-every ${ws.key}`} label={`Check: ${everyLabel(ws.checkEvery)} → ${everyLabel(nextCheckEvery(ws.checkEvery))}`} onPress={() => void cycleCheckEvery($, ws.key)} />,
                      ]),
                  ...moves(WORKSPACES_SCOPE, view.workspaces.map(w => w.key), ws.key),
                  <Button
                    key={`remove ${ws.key}`}
                    label={isPending(`rm:${ws.key}`) ? 'Press again to remove it' : 'Remove'}
                    {...(isPending(`rm:${ws.key}`) ? { variant: 'primary' as const } : {})}
                    onPress={() => void pressRemove(ws.key)()}
                  />,
                ], inner)}
              {(ws.relay.status !== '' || ws.relay.isWaiting) && (
                <Box key={`ws-relay ${ws.key}`} flexDirection="row" width={inner - 2} columnGap={1} marginLeft={2}>
                  <Text dimColor wrap="truncate-end">{`relay: ${ws.relay.isWaiting ? `waits for you after ${RELAY_CAP} hand-offs` : ws.relay.status}`}</Text>
                  {ws.relay.isWaiting && <Button key={`relay-go ${ws.key}`} label="continue" onPress={() => void continueRelay($, ws.key)} />}
                </Box>
              )}
              {ws.compacted !== undefined && (
                <Box key={`ws-compacted ${ws.key}`} flexDirection="row" width={inner - 2} marginLeft={2}>
                  <Text dimColor wrap="truncate-end">{ws.compacted}</Text>
                </Box>
              )}
              {ws.check !== undefined && (
                <Box key={`ws-check ${ws.key}`} flexDirection="row" width={inner - 2} marginLeft={2}>
                  <Text {...(ws.check.isOk ? { dimColor: true } : { color: 'warning' as const })} wrap="truncate-end">{`check: ${ws.check.text}`}</Text>
                </Box>
              )}
              {ws.items.map(i => sessionRow(i, ws.items.map(x => x.key), itemsScope(`ws:${ws.key}`), '', inner))}
            </Box>
            )
          })}
        </Box>
        {view.shown === 0 && (
          <Box marginTop={1}>
            <Text>{`Nothing active in the last ${windowLabel(windowMs)}.`}</Text>
          </Box>
        )}
        {view.repos.map(repo => (
          <Box key={`repo-${repo.key}`} flexDirection="column" width={width} marginTop={1}>
            <Box flexDirection="row" width={width}>
              <Box flexGrow={1} flexShrink={1}>
                <Text bold wrap="truncate-end">{repo.label}</Text>
              </Box>
              {repoKeys.length > 1 && more(`repo:${repo.key}`)}
            </Box>
            {open === `repo:${repo.key}` && bar(`repo:${repo.key}`, 2, moves(REPOS_SCOPE, repoKeys, repo.key))}
            {repo.trees.map(tree => (
              <Box key={`tree-${tree.key}`} flexDirection="column" width={width}>
                <Box flexDirection="row" width={width}>
                  <Box flexGrow={1} flexShrink={1} flexDirection="row">
                    <Text wrap="truncate-end">{`  ${tree.label}`}</Text>
                    {tree.path !== '' && <Text dimColor wrap="truncate-end">{`  ${tree.path}`}</Text>}
                  </Box>
                  {more(`tree:${tree.key}`)}
                </Box>
                {open === `tree:${tree.key}` &&
                  bar(`tree:${tree.key}`, 4, [
                    ...(Input === undefined ? [] : [<Button key={`new-from:${tree.key}`} label="New workspace here (n)" hotkey="n" variant="primary" onPress={openForm(tree.key)} />]),
                    ...moves(treesScope(repo.key), repo.trees.map(t => t.key), tree.key),
                  ])}
                {tree.items.map(i => sessionRow(i, tree.items.map(x => x.key), itemsScope(tree.key), tree.key))}
              </Box>
            ))}
          </Box>
        ))}
        {problems}
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {`checked ${ago(now - snap.checkedAt)} ago${hidden > 0 ? ` · ${hidden} idle longer, hidden` : ''} · [ more ] shows a row's actions; a key in ( ) presses one once this pane has the keys (ctrl+x tab) · /sessions hides`}
          </Text>
        </Box>
      </Box>,
      names,
    )
  })
}
