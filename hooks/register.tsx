import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaudeSession, Place, Snapshot, Workspace } from '../types'
import {
  CLIENTS_FORMAT,
  PANES_FORMAT,
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
const SHARED_VERSION = 6
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

  const candidates = homeEntries.filter(d => d.kind === 'dir' && /^\.(claude|codex)(-[a-z0-9][a-z0-9_.-]*)?$/i.test(d.name)).map(d => d.name)
  const profiles = await profileDirs($, home, candidates)
  const envs = envsFrom(candidates, name => profiles.has(name))
  const [kept, tmux] = await Promise.all([readWorkspaces($, home), tmuxState($)])
  if (!kept.isReadable) problems.push(`workspaces: ${UNREADABLE}`)
  const workspaces = kept.list

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
  const text = await $.fs.read(workspacesPath(home)).catch(() => undefined)
  if (text === undefined) return { list: [], isReadable: true }
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

/** Brings a session's Terminal tab to the front, or opens a background session in a new window. */
/**
 * Brings a workspace up: the Terminal tab already attached to its tmux
 * session to the front, else a new window that creates the session (if it
 * is not running) and attaches. `window` is selected first.
 */
async function openWorkspace($: EngineInterface, ws: Workspace, window?: string): Promise<{ isOpen: boolean; text: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const name = tmuxName(ws)
  const tmux = (args: string[]) =>
    $.process.run(['tmux', ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  const isDir = await $.fs.stat(ws.dir).then(s => s.kind === 'dir').catch(() => false)
  if (!isDir) return { isOpen: false, text: `Not opened: its folder ${ws.dir} is not there any more.` }
  // a running session of that name must be this workspace's own, not an older one or anyone else's
  if ((await tmux(['has-session', '-t', `=${name}`])).exitCode === 0) {
    // show-options takes no `=` target; has-session just found this exact name, which tmux prefers to a prefix
    const owner = (await tmux(['show-options', '-t', name, '-qv', OWNER_OPTION])).stdout.trim()
    if (owner !== String(ws.createdAt)) {
      return { isOpen: false, text: `Not opened: tmux session ${name} was not started for this workspace; end it (tmux kill-session -t ${name}) or remove this workspace.` }
    }
    if (window !== undefined) await tmux(['select-window', '-t', `=${name}:${window}`])
  }
  const command = openCommand(ws, home)
  const term = await $.env.get('TERM_PROGRAM')
  if (term === 'tmux') {
    // from inside tmux: create it if need be, then switch this terminal to it
    const made = await $.process
      .run(['/bin/sh', '-c', openCommand(ws, home, { attach: false })], { timeoutMs: 20_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
    const switched = made.exitCode === 0 ? await tmux(['switch-client', '-t', `=${name}`]) : made
    return switched.exitCode === 0
      ? { isOpen: true, text: `Switched to ${name}.` }
      : { isOpen: false, text: `Not opened (${firstLine(switched.stderr) || `exit ${switched.exitCode}`}). Run: ${command}` }
  }
  if (term !== 'Apple_Terminal') return { isOpen: false, text: `Open it in a terminal: ${command}` }
  const osascript = (script: string, arg: string) =>
    $.process
      .run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, arg], { timeoutMs: 10_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: message(error) }))
  // the terminals attached now (the snapshot may be seconds old)
  const attached = parseClients((await tmux(['list-clients', '-F', CLIENTS_FORMAT])).stdout)[name] ?? []
  for (const tty of attached) {
    if ((await osascript(FOCUS_SCRIPT, tty)).stdout.trim() === 'shown') return { isOpen: true, text: `Brought ${name} to the front.` }
  }
  const opened = await osascript(OPEN_SCRIPT, command)
  return opened.exitCode === 0 && opened.stdout.trim() === 'opened'
    ? { isOpen: true, text: `Opened ${name} in a new Terminal window.` }
    : { isOpen: false, text: `Not opened (${firstLine(opened.stderr) || `exit ${opened.exitCode}`}). Run: ${command}` }
}

async function openSession($: EngineInterface, target: NonNullable<Item['target']>) {
  const osascript = (script: string, arg: string) =>
    $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, arg], { timeoutMs: 10_000 })
  if ('workspace' in target) {
    const ws = (await read($, snapshot)).workspaces.find(w => tmuxName(w) === target.workspace)
    if (ws === undefined) return
    const result = await openWorkspace($, ws, target.window)
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
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'sessions',
      description: 'Show or hide the live Claude Code and Codex sessions on this Mac',
      argumentHint: '[2d | 12h | all | reset]',
    })
    await $.command.register({
      name: 'workspace',
      description: 'Named workspaces: a folder, an environment, Claude and Codex in one tmux session',
      argumentHint: 'new <folder> [<env>] <name> | open <name> | rm <name>',
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
    const usage = `Usage: /workspace new <folder> <${['default', ...named].join(' | ')}> <name>; /workspace open <name>; /workspace rm <name>`
    const command = parseWorkspaceArgs(e.args, named, home)
    const { list, isReadable } = await readWorkspaces($, home)
    const label = (ws: Workspace) => `${ws.name} (${ws.env || 'default'}, ${ws.dir})`
    switch (command.action) {
      case 'help':
        return { text: `${command.error === undefined ? '' : `Not done: ${command.error}. `}${usage}` }
      case 'list':
        return { text: list.length === 0 ? `No workspaces yet. ${usage}` : `Workspaces: ${list.map(label).join('; ')}. ${usage}` }
      case 'open': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        return { text: (await openWorkspace($, ws)).text }
      }
      case 'rm': {
        const ws = findWorkspace(list, command.ref)
        if (ws === undefined) return { text: `No workspace named "${command.ref}".` }
        if (!(await changeWorkspaces($, home, now => now.filter(w => w.id !== ws.id)))) return { text: `Not done: ${UNREADABLE}.` }
        await refresh($, 0)
        return { text: `Removed ${label(ws)}. Its agents keep running in tmux session ${tmuxName(ws)} (end it: tmux kill-session -t ${tmuxName(ws)}).` }
      }
      case 'new': {
        if (!isReadable) return { text: `Not done: ${UNREADABLE}.` }
        const isDir = await $.fs.stat(command.dir).then(s => s.kind === 'dir').catch(() => false)
        if (!isDir) return { text: `Not done: ${command.dir} is not a folder.` }
        // never the name of a tmux session already running: a new workspace never takes over an old one
        const running = Object.values(snap.tmux.panes).map(p => p.session).filter(s => s.startsWith('ws-')).map(s => s.slice(3))
        let ws: Workspace | undefined
        const createdAt = await $.clock.now()
        const saved = await changeWorkspaces($, home, now => {
          ws = { id: slugOf(command.name, [...now.map(w => w.id), ...running]), name: command.name, env: command.env, dir: command.dir, createdAt }
          return [...now, ws]
        })
        if (!saved || ws === undefined) return { text: `Not done: ${UNREADABLE}.` }
        await refresh($, 0)
        const opened = await openWorkspace($, ws)
        return {
          text: opened.isOpen
            ? `Created ${label(ws)}: Claude and Codex start in tmux session ${tmuxName(ws)}. Closing its window leaves them running; /workspace open ${ws.id} brings it back. ${opened.text}`
            : `Created ${label(ws)}, but it was not opened: ${opened.text}`,
        }
      }
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
    const titleWidth = Math.max(8, width - (6 + 7 + 10 + (hasWhere ? 9 : 0) + 5 + 4 + (hasMove ? 11 : 0)))
    const pending = await read($, pendingMove)
    const isPending = (key: string) => pending.key === key && now - pending.at < CONFIRM_MS
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

    // ↑ ↓ move a row among its siblings as listed now; a dim arrow is the end of the list
    const arrows = (scope: string, shown: readonly string[], key: string): Element =>
      shown.length < 2 ? (
        <Box width={4} flexShrink={0} />
      ) : (
        <Box width={3} flexShrink={0} marginLeft={1} flexDirection="row" columnGap={1}>
          <Button key={`up ${scope} ${key}`} label="↑" plain dimColor={shown[0] === key} onPress={() => void move($, scope, shown, key, -1)} />
          <Button key={`down ${scope} ${key}`} label="↓" plain dimColor={shown[shown.length - 1] === key} onPress={() => void move($, scope, shown, key, 1)} />
        </Box>
      )

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
          {hasMove && (
            <Box width={10} flexShrink={0} marginLeft={1}>
              {i.move !== undefined && (
                <Button
                  key={`bg ${i.key}`}
                  label={isPending(i.key) ? 'sure?' : 'to bg'}
                  {...(isPending(i.key) ? { variant: 'primary' as const } : {})}
                  onPress={() => void pressMove(i.key, i.move!)()}
                />
              )}
            </Box>
          )}
          {arrows(scope, siblings, i.key)}
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
          <Text bold>Workspaces</Text>
          {view.workspaces.length === 0 && (
            <Text dimColor wrap="truncate-end">{'  none yet: /workspace new <folder> [env] <name>'}</Text>
          )}
          {view.workspaces.map(ws => (
            <Box key={`ws-${ws.key}`} flexDirection="column" width={width}>
              <Box flexDirection="row" width={width}>
                <Box flexGrow={1} flexShrink={1} flexDirection="row">
                  <Text bold wrap="truncate-end">{`  ${ws.name}`}</Text>
                  <Text color="permission">{`  ${ws.env || 'default'}`}</Text>
                  <Text dimColor wrap="truncate-end">{`  ${ws.dir}`}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text dimColor>{ws.isAttached ? 'open' : ws.isRunning ? 'running' : 'stopped'}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Button key={`wsopen ${ws.key}`} label="open" onPress={() => void openWorkspaceById($, ws.key)} />
                </Box>
                {arrows(WORKSPACES_SCOPE, view.workspaces.map(w => w.key), ws.key)}
              </Box>
              {ws.items.map(i => itemRow(i, ws.items.map(x => x.key), itemsScope(`ws:${ws.key}`)))}
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
              {arrows(REPOS_SCOPE, repoKeys, repo.key)}
            </Box>
            {repo.trees.map(tree => (
              <Box key={`tree-${tree.key}`} flexDirection="column" width={width}>
                <Box flexDirection="row" width={width}>
                  <Box flexGrow={1} flexShrink={1} flexDirection="row">
                    <Text wrap="truncate-end">{`  ${tree.label}`}</Text>
                    {tree.path !== '' && <Text dimColor wrap="truncate-end">{`  ${tree.path}`}</Text>}
                  </Box>
                  {arrows(treesScope(repo.key), repo.trees.map(t => t.key), tree.key)}
                </Box>
                {tree.items.map(i => itemRow(i, tree.items.map(x => x.key), itemsScope(tree.key)))}
              </Box>
            ))}
          </Box>
        ))}
        {problems}
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {`checked ${ago(now - snap.checkedAt)} ago${hidden > 0 ? ` · ${hidden} idle longer, hidden` : ''}${hasMove ? ' · [to bg] twice: keeps it running after its tab closes' : ''} · /sessions hides`}
          </Text>
        </Box>
      </Box>
    )
  })
}
