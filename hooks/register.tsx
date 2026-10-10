import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaudeSession, CodexSession, Place, Relay, Snapshot, Thread, Workspace } from '../types'
import type { Screen } from './workspaces'
import { AGENT_COMMANDS, afterOwner, afterStep, claudeKeep, compactStep, COMPACT_AT, cueOf, parseTurns, passFailure, RELAY_CAP, RELAY_SCRIPT, relaySteps, TURN_SCRIPT } from './relay'
import type { Side, Step } from './relay'
import { bringable, codexDir, codexFlags, CODEX_MODE_SCRIPT, CODEX_TASK_SCRIPT, codexTaskState, JOB_COMMANDS, ROLLOUT_SCRIPT, seenThreads, STOP_SCRIPT, toggled, withThreads } from './bring'
import {
  CHECKOUT_SCRIPT,
  CLIENTS_FORMAT,
  PROJECTS_SCRIPT,
  PANES_FORMAT,
  assigned,
  envsFrom,
  findWorkspace,
  OWNER_OPTION,
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
  defaultPlacement,
  isOnScreen,
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
  isForeground,
  isShell,
  modeFlags,
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
  parseThreads,
  profileOf,
  readOnlyArgs,
  registryPid,
  resumeCommand,
  sortClaude,
  statusSummary,
  threadQuery,
  transcriptPath,
  viewOf,
  windowFrom,
  windowLabel,
  workDir,
  WORKING_MS,
  isFromTerminal,
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
const SHARED_VERSION = 7
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

/** The activity window; kept across sessions in `$.store` as `windowMs`. */
const activeWindow = atom({ plugin: 'live-sessions', key: 'window' } as const, 0)
/** A move to the background asked for once: the row, and when. A second press within CONFIRM_MS makes it. */
const pendingMove = atom({ plugin: 'live-sessions', key: 'pendingMove' } as const, { key: '', at: 0 })
const CONFIRM_MS = 6_000

const NO_DRAFT = { isOpen: false, name: '', query: '', dir: '', env: '', purpose: '', error: '', bring: [] as string[] }
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
/** Where the relay keeps each step it took, so no step is taken twice. */
const ledgerPath = (home: string) => `${home}/Library/Application Support/live-sessions/relayed`

/** The person's own order of repositories, worktrees and sessions; kept in `$.store` as `order`. */
const manualOrder = atom({ plugin: 'live-sessions', key: 'order' } as const, {} as Record<string, string[]>)

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
  const claude = claudeRows.map(s => ({ ...s, cwd: workDir(s.cwd, recentOf(`claude-${s.pid}`), known) }))
  const codex = started.map(s => ({ ...s, cwd: workDir(s.cwd, recentOf(`codex-${s.key}`), known) }))
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

const isSnapshot = (v: unknown): v is Snapshot => {
  const o = v as Partial<Snapshot> | null
  return (
    typeof o === 'object' && o !== null && Array.isArray(o.claude) && Array.isArray(o.codex) &&
    typeof o.places === 'object' && o.places !== null && Array.isArray(o.problems) && typeof o.checkedAt === 'number' &&
    Array.isArray(o.workspaces) && Array.isArray(o.envs) && typeof o.tmux === 'object' && o.tmux !== null
  )
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
async function changeWorkspaces($: EngineInterface, home: string, change: (list: Workspace[]) => Workspace[]) {
  const now = await readWorkspaces($, home)
  if (!now.isReadable) return false
  await $.fs.write(workspacesPath(home), `${JSON.stringify({ version: 1, workspaces: change(now.list) }, null, 2)}\n`)
  return true
}

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
    $.ui.status(statusSummary(taken))
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
    $.ui.toast(`Not hidden: tmux session ${tmuxName(ws)} was not started for ${ws.name}.`)
    return
  }
  await $.fs.write(hidePath(home), HIDE_SCRIPT)
  const listed = await $.process
    .run(['tmux', 'list-clients', '-F', CLIENTS_FORMAT], { timeoutMs: 10_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const ttys = parseClients(listed.stdout)[tmuxName(ws)] ?? []
  for (const tty of ttys) {
    await $.process.run(['/bin/sh', hidePath(home), `/dev/${tty}`], { timeoutMs: 15_000 }).catch(() => undefined)
  }
  $.ui.toast(ttys.length === 0 ? `${ws.name} has no window open.` : `${ws.name} hidden: its agents keep running; Open brings it back.`)
  await refresh($, 0)
}

/** Brings a session's Terminal tab to the front, or opens a background session in a new window. */
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
  const wasRunning = (await tmux(['has-session', '-t', `=${name}`])).exitCode === 0
  if (wasRunning) {
    // show-options takes no `=` target; has-session just found this exact name, which tmux prefers to a prefix
    const owner = (await tmux(['show-options', '-t', name, '-qv', OWNER_OPTION])).stdout.trim()
    if (owner !== String(ws.createdAt)) {
      return { isOpen: false, text: `Not opened: tmux session ${name} was not started for this workspace; end it (tmux kill-session -t ${name}) or remove this workspace.` }
    }
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
    const claude = ws.threads.claude === undefined ? undefined : snap.claude.find(s => s.sessionId === ws.threads!.claude!.id)
    // a Codex conversation open in a terminal, or written a moment ago anywhere (the desktop app, an exec run)
    const codex = ws.threads.codex === undefined ? undefined : snap.codex.find(s => s.key === ws.threads!.codex!.id && (s.surface === 'terminal' || now - s.updatedAt < WORKING_MS))
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
  // where it was when last hidden, while that still shows on a screen there is now; else most of the screen in
  // use, in the font of the window it is opened from
  const kept = await $.fs.read(placementPath(home, name)).then(text => placementFrom(JSON.parse(text))).catch(() => undefined)
  const seen = await screens($, osascript)
  const place = kept !== undefined && seen !== undefined && isOnScreen(kept, seen.screens) ? kept : seen === undefined ? undefined : defaultPlacement(seen.screens[0]!, seen.fontSize)
  const opened = await osascript(OPEN_SCRIPT, command, ...(place === undefined ? [] : [JSON.stringify(place)]))
  const isOpened = opened.exitCode === 0 && opened.stdout.trim() === 'opened'
  // the window makes the session (made new, or again after it ended): once it is there, its bar gets Hide
  if (isOpened && !wasRunning) await prepareWhenMade($, home, ws)
  return isOpened
    ? { isOpen: true, text: `Opened ${name} in a new Terminal window.` }
    : { isOpen: false, text: `Not opened (${firstLine(opened.stderr) || `exit ${opened.exitCode}`}). Run: ${command}` }
}

/** The screens there are now (the one in use first), and the font size of this session's own tab. */
async function screens($: EngineInterface, osascript: (script: string, ...args: string[]) => Promise<{ stdout: string }>) {
  const selfId = await $.session.id()
  const tty = (await read($, snapshot)).claude.find(s => s.sessionId === selfId)?.tty ?? ''
  try {
    const seen = JSON.parse((await osascript(SCREEN_SCRIPT, /^ttys\d+$/.test(tty) ? tty : 'none')).stdout) as { screens?: Screen[]; fontSize?: number }
    const all = (seen.screens ?? []).filter(s => [s.x, s.y, s.width, s.height].every(n => typeof n === 'number' && Number.isFinite(n)) && s.width > 0 && s.height > 0)
    return all.length === 0 ? undefined : { screens: all, fontSize: typeof seen.fontSize === 'number' ? seen.fontSize : 0 }
  } catch {
    return undefined
  }
}

async function openSession($: EngineInterface, target: NonNullable<Item['target']>) {
  const osascript = (script: string, arg: string) =>
    $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, arg], { timeoutMs: 10_000 })
  if ('workspace' in target) {
    const ws = (await read($, snapshot)).workspaces.find(w => tmuxName(w) === target.workspace)
    if (ws === undefined) return
    const result = await openWorkspace($, ws, target)
    if (!result.isOpen) $.ui.toast(result.text, { timeoutMs: 20_000 })
    return
  }
  if ('tty' in target) {
    const out = await osascript(FOCUS_SCRIPT, target.tty)
    if (out.stdout.trim() !== 'shown') $.ui.toast(`No Terminal tab runs on ${target.tty}.`)
    return
  }
  const command = attachCommand(target.attach, target.profile, (await $.env.get('HOME')) ?? '')
  if (command === undefined) return
  await osascript(OPEN_SCRIPT, command)
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
    $.ui.toast('That session is already being moved.')
    return
  }
  moving.add(move.pid)
  try {
    await moveChecked($, move)
  } catch (error) {
    $.ui.toast(`The move stopped: ${message(error)}`)
  } finally {
    moving.delete(move.pid)
  }
}

async function moveChecked($: EngineInterface, move: NonNullable<Item['move']>) {
  const home = (await $.env.get('HOME')) ?? ''
  const refuse = (why: string) => $.ui.toast(`Not moved: ${why}.`)
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
  $.ui.toast(
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
  w: { dir: string; env: string; name: string; purpose: string; bring?: readonly string[] },
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

async function makeWorkspace(
  $: EngineInterface,
  w: { dir: string; env: string; name: string; purpose: string; bring?: readonly string[] },
): Promise<{ isCreated: boolean; text: string }> {
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
  await refresh($, VISIBLE_MAX_AGE_MS)
  const snap = await read($, snapshot)
  // the sessions brought in, each checked as it runs now; then closed where they run, so each conversation
  // goes on in the workspace alone
  const checked = await checkBring($, home, snap, w.bring ?? [], w.env, dir)
  if ('error' in checked) return fail(checked.error)
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
      // made for a purpose: Claude gets it ready, and the relay passes the cues from the start
      ...(purpose === '' ? {} : { purpose, relay: { mode: 'auto' as const, since: createdAt, streak: 0 } }),
    }
    // the conversations brought in go on in this workspace alone
    return withThreads([...now, ws], ws.id, threads)
  })
  if (!saved || ws === undefined) {
    const closed = Object.entries(threads).map(([tool, t]) => `${tool === 'claude' ? `claude --resume ${t.id}` : `codex resume ${t.id}`} (in ${t.dir})`)
    return fail(`${UNREADABLE}${closed.length > 0 ? `; to go on with what was closed: ${closed.join(', ')}` : ''}`)
  }
  const made: Workspace = ws
  if (purpose !== '') {
    await $.fs.write(promptPath(home, made.id, 'claude'), made.threads?.claude === undefined ? setupPrompt(made) : joinPrompt(made, 'claude'))
    await $.fs.write(promptPath(home, made.id, 'codex'), made.threads?.codex === undefined ? peerPrompt(made) : joinPrompt(made, 'codex'))
  } else {
    // one left by a removed workspace of the same id never reaches this one's agents
    await removePrompts($, home, made.id)
  }
  await refresh($, 0)
  const label = `${made.name} (${made.env || 'default'}, ${made.dir})`
  const opened = await openWorkspace($, made)
  const goOn = checked.bring.filter(b => made.threads?.[b.tool] !== undefined).map(b => b.label)
  const start = (purpose === ''
    ? `Claude and Codex start side by side in tmux session ${tmuxName(made)}.`
    : `Claude and Codex start side by side in tmux session ${tmuxName(made)}; Claude gets peer coding ready for it, and the relay passes each hand-over to the other.`) +
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
 * conversation known for certain; with the conversation it resumes there and
 * the flags that keep its permissions.
 */
async function checkBring($: EngineInterface, home: string, snap: Snapshot, members: readonly string[], env: string, dir: string): Promise<{ bring: Bring[] } | { error: string }> {
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
      const mode = await $.process.run(['/bin/sh', '-c', MODE_SCRIPT, 'sh', transcriptPath(`${home}/.${s.profile}`, live.startCwd, id)], { timeoutMs: 10_000 })
      const flags = modeFlags(mode.stdout)
      if (flags === undefined) return { error: `${offer.label}'s permission mode is not one this knows` }
      bring.push({ tool, label: offer.label, runs: { tty: live.tty, pid: s.pid }, profile: s.profile, thread: { id, dir: live.startCwd, ...(flags.length > 0 ? { flags } : {}) } })
    } else {
      const s = snap.codex.find(c => c.key === id && (offer.isClosed === true ? c.surface === 'cli' : c.surface === 'terminal'))!
      const codexHome = `${home}/.${s.profile}`
      const rollout = (await $.process.run(['/bin/sh', '-c', ROLLOUT_SCRIPT, 'sh', codexHome, id], { timeoutMs: 15_000 })).stdout.trim()
      if (!rollout.startsWith('/')) return { error: `${offer.label}'s conversation was not found under ~/.${s.profile}` }
      // which conversation the terminal runs, made sure of again now: the rollout it holds open, read fresh; or,
      // the only Codex terminal of that account, no other conversation written there since it started
      if (offer.isClosed !== true) {
        const isSure = s.match === 'held'
          ? (parseRollouts((await $.process.run(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', String(s.pid), '-Fpn'], { timeoutMs: 10_000 }).catch(() => ({ stdout: '' }))).stdout).get(s.pid!) ?? []).includes(id)
          : (await codexWrittenSince($, codexHome, (s.startedAt ?? now) - 5_000)).every(t => t === id)
        if (!isSure) return { error: `${offer.label} cannot be brought in: which conversation it runs is no longer certain; close it yourself, then bring in its conversation` }
      }
      const busy = await codexBusy($, rollout)
      if (busy !== undefined || (s.updatedAt > 0 && now - s.updatedAt < WORKING_MS)) return { error: `${offer.label} ${busy ?? 'is working: bring it in once its turn is done'}` }
      const mode = (await $.process.run(['/bin/sh', '-c', CODEX_MODE_SCRIPT, 'sh', rollout], { timeoutMs: 10_000 })).stdout
      const folder = codexDir(mode) ?? s.cwd
      if (!folder.startsWith('/')) return { error: `${offer.label}'s folder is not known` }
      bring.push({ tool, label: offer.label, ...(offer.isClosed === true ? {} : { runs: { tty: s.tty, pid: s.pid! } }), profile: s.profile, rollout, thread: { id, dir: folder, flags: codexFlags(mode) } })
    }
  }
  return { bring }
}

/** A Claude session as it runs now, by its registry entry and process: between turns, in front of its terminal; else why not. */
async function liveClaude($: EngineInterface, home: string, pid: number, profile: string, id: string): Promise<ClaudeSession | string> {
  const raw = await $.fs.read(`${home}/.${profile}/sessions/${pid}.json`).then(text => JSON.parse(text) as unknown).catch(() => undefined)
  const ps = await $.process.run(['/bin/ps', '-ww', '-o', PS_COLUMNS, '-p', String(pid)], { env: PS_ENV, timeoutMs: 10_000 })
  const procs = parsePs(ps.stdout)
  const proc = procs.get(pid)
  const still = claudeFromRegistry(raw, profile, procs, home)
  if (proc === undefined || still === undefined || still.sessionId !== id || !isClaudeProcess(proc.args)) return 'has ended or its process changed'
  if (claudeState(still, await $.clock.now()) !== 'idle') return 'is working: bring it in once its turn is done'
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

/** Why a Codex conversation cannot be closed now, by its whole rollout: a turn under way, or none yet; undefined when between turns. */
async function codexBusy($: EngineInterface, rollout: string): Promise<string | undefined> {
  const state = codexTaskState((await $.process.run(['/bin/sh', '-c', CODEX_TASK_SCRIPT, 'sh', rollout], { timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout)
  return state === 'done' ? undefined : state === 'busy' ? 'is working: bring it in once its turn is done' : 'has no finished turn to go on from'
}

async function submitDraft($: EngineInterface) {
  const d = await read($, draft)
  const made = await createWorkspace($, { name: d.name, dir: d.dir || d.query, env: d.env, purpose: d.purpose, bring: d.bring })
  if (made.isCreated) {
    await update($, draft, () => NO_DRAFT)
    $.ui.toast(made.text, { timeoutMs: 15_000 })
  } else {
    await update($, draft, now => ({ ...now, error: made.text }))
  }
}

/** A workspace's first-prompt files, gone. */
async function removePrompts($: EngineInterface, home: string, id: string) {
  await $.process.run(['/bin/rm', '-f', promptPath(home, id, 'claude'), promptPath(home, id, 'codex')], { timeoutMs: 10_000 }).catch(() => undefined)
}

/** Opens the form, with `dir` filled in when given (and a session to bring in, with its environment), and looks for the projects to offer. */
async function openDraft($: EngineInterface, dir: string, with_?: { member: string; env: string }) {
  const home = (await $.env.get('HOME')) ?? ''
  const shown = dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
  await update($, draft, () => ({ ...NO_DRAFT, isOpen: true, dir, query: shown, ...(with_ === undefined ? {} : { bring: [with_.member], env: with_.env }) }))
  // while this pane has the keys (the form opened by its key), what is typed next goes into the name, not to the pane's keys
  await $.ui.focus({ requestId: PANE, key: 'form:name' }).catch(() => undefined)
  if ((await read($, projects)).length > 0) return
  const found = await $.process
    .run(['/bin/sh', '-c', PROJECTS_SCRIPT, 'sh', home], { timeoutMs: 30_000 })
    .catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
  const paths = found.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'))
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

/** The context fills a workspace's agents may be compacted at, pressed round; 0 is off. */
const COMPACT_STEPS = [50, 60, 70, 80, 0]
const nextCompactAt = (now: number) => COMPACT_STEPS[(COMPACT_STEPS.indexOf(now) + 1) % COMPACT_STEPS.length] ?? COMPACT_AT

/** How full an agent's context may get before it compacts at a hand-off: 50, 60, 70, 80 percent, off. */
async function cycleCompactAt($: EngineInterface, id: string) {
  const home = (await $.env.get('HOME')) ?? ''
  await changeWorkspaces($, home, list => list.map(ws => (ws.id === id ? { ...ws, compactAt: nextCompactAt(ws.compactAt ?? COMPACT_AT) } : ws)))
  await refresh($, 0)
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
  const live = o.workspaces.filter(ws => ws.relay !== undefined && ws.relay.mode !== 'off')
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
      // how full Codex's context is, by its own records (Claude compacts itself: compactAtHandOff)
      const filled = tool === 'codex' ? turn?.filled : undefined
      sides[tool] = { tool, pane: p.pane!, isBusy: (known?.isBusy ?? false) || turn?.state === 'busy', ...(turn === undefined ? {} : { turn }), ...(filled === undefined ? {} : { filled }) }
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
      const args = step.kind === 'tell' ? ['tell', '', '', step.text] : ['pass', step.pane, AGENT_COMMANDS[step.to], step.line]
      const out = await $.process
        .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', args[0]!, ledgerPath(home), step.key, args[1]!, args[2]!, args[3]!, '', 'Workspace relay'], { timeoutMs: 20_000 })
        .catch(() => ({ stdout: 'failed' }))
      return out.stdout.trim()
    }
    const saveAfter = (step: Step, outcome: string) =>
      changeWorkspaces($, home, list => list.map(w => (w.id === ws.id && w.relay !== undefined ? { ...w, relay: afterStep(w.relay, step, outcome, now) } : w)))
    // a step's outcome, kept on the workspace (a step taken already, by this or another session, changes nothing)
    const settle = async (step: Step, outcome: string) => {
      if (outcome === 'taken') return
      const next = ws.relay === undefined ? undefined : afterStep(ws.relay, step, outcome, now)
      // a pass waiting on a scrolled-back pane says so once, not at every collection
      if (outcome === 'in-mode' && next?.status === ws.relay?.status) return
      await saveAfter(step, outcome)
      const why = step.kind === 'pass' ? passFailure(outcome) : undefined
      if (step.kind === 'pass' && why !== undefined) {
        await $.process
          .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', 'tell', ledgerPath(home), `failed-${step.key}`, '', '', `${ws.name}: the relay did not pass the hand-off to ${step.to === 'claude' ? 'Claude' : 'Codex'}: ${why}. Paste: ${step.line}`, '', 'Workspace relay'], { timeoutMs: 20_000 })
          .catch(() => undefined)
      }
    }
    // the panes typed into this collection: an agent given a line may be starting a turn, so nothing more goes there
    const typedInto = new Set<string>()
    for (const step of relaySteps(ws, sides, now)) {
      const outcome = await run(step)
      // a pass that failed may have typed before it failed: counted as typed into
      if (step.kind === 'pass' && (outcome === 'passed' || outcome === 'unsent' || outcome === 'failed')) typedInto.add(step.pane)
      await settle(step, outcome)
      // Codex's hand-off passed: if its context is full enough, it compacts now, once for that turn
      const compact = compactStep(ws, sides, step, outcome, typedInto)
      if (compact?.kind === 'compact') {
        const compacted = await run(compact)
        typedInto.add(compact.pane)
        await settle(compact, compacted)
        // scrolled back as it was typed: `/compact` waits in Codex's input, where the next hand-off would be added to it
        if (compacted === 'unsent') {
          await $.process
            .run(['/bin/sh', '-c', RELAY_SCRIPT, 'sh', 'tell', ledgerPath(home), `unsent-${compact.key}`, '', '', `${ws.name}: /compact waits in Codex's input (its pane was scrolled back): leave copy mode (q) and press Enter there, or clear it.`, '', 'Workspace relay'], { timeoutMs: 20_000 })
            .catch(() => undefined)
        }
      }
    }
  }
}

/**
 * In a Claude session that is a workspace's agent: once a turn of its ends
 * with a hand-off to Codex (READY FOR CODEX) and the relay is on (auto), and
 * its context is at least the workspace's `compactAt` percent full, it
 * compacts itself, told what to keep, between turns (refused while one runs):
 * after the relay has passed that hand-off (its ledger step), so Codex starts
 * at once, and only while that turn is still its last. Never after a cue for
 * the owner (NEEDS USER, SCOPE CLOSED): it waits for the owner's answer.
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
  if (self === undefined || ws === undefined || pane?.window !== 'claude' || ws.relay?.mode !== 'auto') return
  const at = ws.compactAt ?? COMPACT_AT
  if (at <= 0) return
  const { context } = await $.session.usage()
  if (context.percent === undefined || context.percent < at) return
  // its last turn, as the relay reads its records: that turn (once its reply is written), still its last, until the
  // relay has taken up its hand-off (its ledger step); not in two minutes (Codex at work, the relay waiting for you):
  // left for a later hand-off
  const file = transcriptPath(`${home}/.${self.profile}`, self.startCwd, id)
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
  // still the same conversation (not cleared or resumed into another while it waited)
  if ((await $.session.id()) !== id) return
  await $.session.compact({ instructions: claudeKeep(ws.name) }).catch(() => undefined)
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
  if (!isSaved) $.ui.toast(`Not assigned: ${UNREADABLE}.`)
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
  if (!result.isOpen) $.ui.toast(result.text, { timeoutMs: 20_000 })
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
  const maxAgeMs = isVisible ? VISIBLE_MAX_AGE_MS : IDLE_MAX_AGE_MS
  if ((await $.clock.now()) - lastAttemptAt < maxAgeMs) return
  await refresh($, maxAgeMs)
}

export const register: Register = on => {
  // a workspace's Claude compacts itself after a hand-off, when its context is full enough: never holds up the turn
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
      argumentHint: '[2d | 12h | all | reset]',
    })
    await $.command.register({
      name: 'workspace',
      description: 'Named workspaces: a folder, an environment, Claude and Codex in one tmux session',
      argumentHint: 'new <folder> <env> <name> [--for <purpose>] | open <name> | rm <name>',
    })
    const kept = await $.store.get('windowMs')
    if (typeof kept === 'number' && kept >= 0) await update($, activeWindow, () => kept)
    const keptOrder = orderFrom(await $.store.get('order'))
    if (keptOrder !== undefined) await update($, manualOrder, () => keptOrder)
    // a status line only where a person sees one; a pane wherever one is opened
    const hasStatusLine = e.isInteractive
    // a pane left open across a reload is painted without being reopened
    if (hasStatusLine) {
      void refresh($, IDLE_MAX_AGE_MS)
        .then(() => learnBackground($))
        .catch(() => undefined)
    }
    $.clock.every(TICK_MS, () => {
      void tick($, hasStatusLine).catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'workspace' }, async ($, e) => {
    const home = (await $.env.get('HOME')) ?? ''
    await refresh($, VISIBLE_MAX_AGE_MS)
    const snap = await read($, snapshot)
    const named = snap.envs.filter(env => env !== '')
    const usage = `Usage: /workspace new <folder> <${['default', ...named].join(' | ')}> <name> [--for <what it is for: Claude gets peer coding ready for it>]; /workspace open <name>; /workspace rm <name>`
    const command = parseWorkspaceArgs(e.args, named, home)
    const { list, isReadable } = await readWorkspaces($, home)
    const label = (ws: Workspace) => `${ws.name} (${ws.env || 'default'}, ${ws.dir})`
    switch (command.action) {
      case 'help':
        return { text: `${command.error === undefined ? '' : `Not done: ${command.error}. `}${usage}` }
      case 'list':
        return { text: list.length === 0 ? `No workspaces yet. ${usage}` : `Workspaces: ${list.map(label).join('; ')}. ${usage}` }
      case 'open':
      case 'rm':
        if (!isReadable) return { text: `Not done: ${UNREADABLE}.` }
    }
    switch (command.action) {
      case 'open': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        return { text: (await openWorkspace($, ws)).text }
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
    if (e.args.trim().toLowerCase() === 'reset') {
      await resetOrder($)
    } else if (e.args.trim() !== '') {
      const ms = windowFrom(e.args)
      if (ms === undefined) {
        return { text: 'Usage: /sessions [2d | 12h | all]: list the sessions active that recently; /sessions reset: back to the automatic order.' }
      }
      await setWindow($, ms)
    } else if (await isPaneVisible($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Sessions pane closed.' }
    }
    await refresh($, VISIBLE_MAX_AGE_MS)
    await learnBackground($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const windowMs = await read($, activeWindow)
    const showing = windowMs === 0 ? 'all sessions' : `active in the last ${windowLabel(windowMs)}`
    if (opened.isPlaced) return { text: `Sessions pane opened (${showing}).` }
    const snap = await read($, snapshot)
    return { text: `${statusSummary(snap)} (${showing}; widen the terminal to see the pane)` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const windowMs = await read($, activeWindow)
    const now = await $.clock.now()
    const home = (await $.env.get('HOME')) ?? ''
    const selfId = await $.session.id()
    const paint = (await read($, background)) || undefined
    const width = e.props.bodyColumns
    const height = e.props.scroll.bodyRows
    const hasWhere = width >= 64
    const order = await read($, manualOrder)
    const view = viewOf(snap, { home, now, windowMs, selfId, order })
    // a press reaches another Terminal tab or window, so only inside Terminal.app
    const canOpen = (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal'
    const hasMove = hasWhere && canOpen
    const titleWidth = Math.max(8, width - (6 + 7 + 10 + (hasWhere ? 9 : 0) + 5 + 10))
    const elements = $.ui.resolve(e)
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const form = await read($, draft)
    const choosing = await read($, assigning)
    const isCreating = await read($, creating)
    const openForm = (dir: string) => () => void openDraft($, dir)
    const setForm = (field: 'name' | 'purpose') => (value: string) => void update($, draft, d => ({ ...d, [field]: value, error: '' }))
    // typing in the project field searches; a pick sets the folder
    // the running sessions the form can bring in: the project's, once one is chosen; any row's for its own action
    const offeredAll = bringable(snap, { now, selfId })
    const formDir = absoluteDir(form.dir || form.query, home)
    const offered = form.isOpen && formDir !== undefined ? bringable(snap, { now, selfId }, formDir) : []
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
        if (ws !== undefined) $.ui.toast(await removeWorkspace($, ws), { timeoutMs: 15_000 })
        await update($, selected, () => '')
      } else {
        await update($, pendingMove, () => ({ key: `rm:${id}`, at }))
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
    const bar = (id: string, indent: number, children: Element[]): Element => (
      <Box key={`bar ${id}`} flexDirection="row" flexWrap="wrap" width={width - indent} marginLeft={indent} columnGap={2}>
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

    const itemRow = (i: Item, siblings: readonly string[], scope: string) => {
      const isWorking = i.state === 'working'
      const isIdle = i.state === 'idle'
      const color = isWorking ? 'warning' : isIdle ? undefined : 'permission'
      const tool = TOOL_COLOR[i.tool]
      const title = i.tags.length > 0 ? `${i.title} (${i.tags.join(', ')})` : i.title
      const target = canOpen ? i.target : undefined
      return (
        <Box key={i.key} flexDirection="row" width={width} {...(isIdle ? { backgroundColor: IDLE_BACKGROUND } : {})}>
          <Box width={6} flexShrink={0}>
            <Text color={tool}>{`    ${isWorking ? '●' : isIdle ? '○' : '◆'}`}</Text>
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
                label={title.length > titleWidth ? `${title.slice(0, titleWidth - 1)}…` : title}
                plain
                onPress={() => void openSession($, target)}
              />
            )}
          </Box>
          <Box width={9} flexShrink={0} marginLeft={1}>
            <Text color={color} wrap="truncate-end">{i.state}</Text>
          </Box>
          {hasWhere && (
            <Box width={8} flexShrink={0} marginLeft={1}>
              <Text dimColor wrap="truncate-end">{i.where}</Text>
            </Box>
          )}
          <Box width={4} flexShrink={0} marginLeft={1}>
            <Text dimColor wrap="truncate-end">{ago(now - i.lastActive)}</Text>
          </Box>
          {more(`item:${i.key}`)}
        </Box>
      )
    }
    // a session's row and, while shown, its actions; while it is being assigned, the workspaces to choose from
    const sessionRow = (i: Item, siblings: readonly string[], scope: string, treeDir = '') => {
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
        <Box key={`row ${i.key}`} flexDirection="column" width={width}>
          {itemRow(i, siblings, scope)}
          {open === id && bar(id, 6, choosing.key === i.key ? choices() : actions())}
        </Box>
      )
    }
    const repoKeys = view.repos.map(r => r.key)

    const problems = snap.problems.map(p => (
      <Text color="error" wrap="truncate-end">{`! ${p}`}</Text>
    ))
    if (snap.checkedAt === 0) {
      return (
        <Box flexDirection="column" width={width} minHeight={height} backgroundColor={paint}>
          {problems.length === 0 ? <Text dimColor>Looking for sessions…</Text> : problems}
        </Box>
      )
    }

    const working = [...view.workspaces.flatMap(w => w.items), ...view.repos.flatMap(r => r.trees.flatMap(t => t.items))]
      .filter(i => i.state === 'working').length
    const hidden = view.total - view.shown
    return (
      <Box flexDirection="column" width={width} minHeight={height} backgroundColor={paint}>
        <Box flexDirection="row" width={width}>
          <Text bold>{`${snap.claude.length} Claude · ${snap.codex.length} Codex`}</Text>
          {working > 0 && <Text color="warning">{` · ${working} working`}</Text>}
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
          {Object.keys(order).length > 0 && (
            <Button key="reset-order" label="reset order" onPress={() => void resetOrder($)} />
          )}
        </Box>
        <Box key="workspaces" flexDirection="column" width={width} marginTop={1}>
          <Box flexDirection="row" width={width} columnGap={1}>
            <Text bold>Workspaces</Text>
            {Input !== undefined && !form.isOpen && <Button key="workspace:new" label="+ New workspace (n)" hotkey="n" onPress={openForm('')} />}
          </Box>
          {view.workspaces.length === 0 && !form.isOpen && (
            <Text dimColor wrap="truncate-end">{'  none yet: + New workspace, or /workspace new <folder> <env> <name> --for <purpose>'}</Text>
          )}
          {form.isOpen && Input !== undefined && Select !== undefined && (
            <Box key="form" flexDirection="column" width={width - 2} marginLeft={2}>
              <Input key="form:name" label="name" autoFocus value={form.name} placeholder="Practice RBAC" onInput={setForm('name')} onSubmit={() => void submitDraft($)} />
              <Input
                key="form:project"
                label="project"
                value={form.query}
                placeholder="type to search your repositories, or a folder"
                onInput={value => void update($, draft, d => ({ ...d, query: value, dir: '', bring: [], error: '' }))}
                onSubmit={() => void submitDraft($)}
              />
              {form.dir === '' && matches.length > 0 && (
                <Select
                  key="form:pick"
                  label="pick"
                  options={matches.map(m => ({ value: m.path, label: m.label }))}
                  onSelect={value => void update($, draft, d => ({ ...d, dir: value, query: rankProjects([value], [], '', home)[0]?.label ?? value, bring: [], error: '' }))}
                />
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
                placeholder="optional: Claude sets up peer coding for it, and the relay passes each hand-over"
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
          {view.workspaces.map(ws => (
            <Box key={`ws-${ws.key}`} flexDirection="column" width={width}>
              <Box flexDirection="row" width={width}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">{`  ${ws.name}`}</Text>
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
                {width >= 80 && (
                  <Box flexShrink={0} marginLeft={2}>
                    <Button key={`relay ${ws.key}`} label={`Relay: ${ws.relay.mode}`} {...(ws.relay.mode === 'auto' ? { variant: 'primary' as const } : {})} onPress={() => void cycleRelay($, ws.key)} />
                  </Box>
                )}
                {more(`ws:${ws.key}`)}
              </Box>
              <Box width={width - 4} marginLeft={4}>
                <Text dimColor wrap="truncate-end">{ws.dir}</Text>
              </Box>
              {open === `ws:${ws.key}` &&
                bar(`ws:${ws.key}`, 4, [
                  <Button key={`wsopen-bar ${ws.key}`} label="Open (o)" hotkey="o" variant="primary" onPress={() => void openWorkspaceById($, ws.key)} />,
                  // by a click only: turned on, the relay types into the agents
                  ...(ws.isAttached ? [<Button key={`hide ${ws.key}`} label="Hide window" onPress={() => void hideWorkspaceById($, ws.key)} />] : []),
                  <Button key={`relay-bar ${ws.key}`} label={`Relay: ${ws.relay.mode} → ${RELAY_NEXT[ws.relay.mode]}`} onPress={() => void cycleRelay($, ws.key)} />,
                  <Button key={`compact ${ws.key}`} label={`Compact at: ${ws.compactAt === 0 ? 'off' : `${ws.compactAt}%`} → ${nextCompactAt(ws.compactAt) === 0 ? 'off' : `${nextCompactAt(ws.compactAt)}%`}`} onPress={() => void cycleCompactAt($, ws.key)} />,
                  ...moves(WORKSPACES_SCOPE, view.workspaces.map(w => w.key), ws.key),
                  <Button
                    key={`remove ${ws.key}`}
                    label={isPending(`rm:${ws.key}`) ? 'Press again to remove it' : 'Remove'}
                    {...(isPending(`rm:${ws.key}`) ? { variant: 'primary' as const } : {})}
                    onPress={() => void pressRemove(ws.key)()}
                  />,
                ])}
              {(ws.relay.status !== '' || ws.relay.isWaiting) && (
                <Box flexDirection="row" width={width} columnGap={1} marginLeft={4}>
                  <Text dimColor wrap="truncate-end">{`relay: ${ws.relay.isWaiting ? `waits for you after ${RELAY_CAP} hand-offs` : ws.relay.status}`}</Text>
                  {ws.relay.isWaiting && <Button key={`relay-go ${ws.key}`} label="continue" onPress={() => void continueRelay($, ws.key)} />}
                </Box>
              )}
              {ws.items.map(i => sessionRow(i, ws.items.map(x => x.key), itemsScope(`ws:${ws.key}`)))}
            </Box>
          ))}
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
      </Box>
    )
  })
}
