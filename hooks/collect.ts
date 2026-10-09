// Pure parsing and matching: no `$`, so the tests drive it directly.
import type { ClaudeSession, CodexSession, Place, Snapshot } from '../types'
import { tmuxName } from './workspaces'

/** A Codex thread counts as active this long after its last write. */
export const ACTIVE_MS = 30 * 60_000
/** A subagent counts toward its root thread while it wrote this recently. */
export const AGENT_MS = 2 * 60_000
/** A session that wrote this recently is shown as working. */
export const WORKING_MS = 60_000
/**
 * A Claude turn still `busy` this long after it began is shown as stalled: an
 * older build can leave its registry at `busy` for weeks (one here: 38 days,
 * nothing in its transcript since), so its word alone is not activity.
 */
export const STALE_BUSY_MS = 12 * 3_600_000

/** `working`, `stalled`, `idle`, or the registry's word for a state that wants the person. */
export function claudeState(s: ClaudeSession, now: number): string {
  if (s.status !== 'busy') return s.status
  return now - s.since < STALE_BUSY_MS ? 'working' : 'stalled'
}

/** The status line: how many of each are live, how many working. */
export function statusSummary(snap: Snapshot): string {
  const busyClaude = snap.claude.filter(s => claudeState(s, snap.checkedAt) === 'working').length
  const busyCodex = snap.codex.filter(s => s.updatedAt > 0 && snap.checkedAt - s.updatedAt < WORKING_MS).length
  return `Claude ${snap.claude.length} (${busyClaude} working) · Codex ${snap.codex.length} (${busyCodex} working) · /sessions`
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID = new RegExp(`^${UUID_RE}$`, 'i')

/**
 * Prints `pid<TAB>CODEX_HOME<TAB>PWD` for each pid in "$1" (comma-separated),
 * so no other part of those processes' environments leaves the pipeline. The
 * environment follows the arguments in `ps -E`, so the last occurrence is the
 * environment's own; a value ends where the next ` NAME=` begins.
 */
export const ENV_SCRIPT = [
  `/bin/ps -ww -E -o pid=,args= -p "$1" | /usr/bin/awk '`,
  'function last(line, name,    key, i, rest, found, has, q) {',
  '  key = " " name "="; rest = line; found = ""; has = 0',
  '  while ((i = index(rest, key)) > 0) { rest = substr(rest, i + length(key)); found = rest; has = 1 }',
  '  if (!has) return ""',
  '  q = match(found, / [A-Za-z_][A-Za-z0-9_]*=/)',
  '  return q ? substr(found, 1, q - 1) : found',
  '}',
  '{ print $1 "\\t" last($0, "CODEX_HOME") "\\t" last($0, "PWD") }',
  `'`,
].join('\n')

/**
 * Asks Terminal.app for the background of the tab on the tty in argv[0], as
 * sRGB hex (`dfdbc3`), or prints nothing. Terminal reports the color in
 * calibrated RGB; converted, it is the color a 24-bit background paints.
 */
export const BACKGROUND_SCRIPT = [
  "ObjC.import('AppKit')",
  'function run(argv) {',
  "  const want = '/dev/' + argv[0]",
  "  const windows = Application('Terminal').windows",
  '  const ttys = windows.tabs.tty()',
  '  for (let w = 0; w < ttys.length; w++) {',
  '    const j = ttys[w].indexOf(want)',
  '    if (j < 0) continue',
  '    const [r, g, b] = windows[w].tabs[j].backgroundColor()',
  '    const c = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(r, g, b, 1).colorUsingColorSpace($.NSColorSpace.sRGBColorSpace)',
  '    return [c.redComponent, c.greenComponent, c.blueComponent]',
  "      .map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0'))",
  "      .join('')",
  '  }',
  "  return ''",
  '}',
].join('\n')

/**
 * Brings Terminal.app's tab on the tty in argv[0] to the front (its window
 * restored and raised, the tab selected); prints `shown`, or nothing when
 * no tab has that tty.
 */
export const FOCUS_SCRIPT = [
  'function run(argv) {',
  "  const want = '/dev/' + argv[0]",
  "  const terminal = Application('Terminal')",
  '  const ttys = terminal.windows.tabs.tty()',
  '  for (let w = 0; w < ttys.length; w++) {',
  '    const j = ttys[w].indexOf(want)',
  '    if (j < 0) continue',
  '    const win = terminal.windows.byId(terminal.windows[w].id())',
  '    win.miniaturized = false',
  '    win.tabs[j].selected = true',
  '    win.index = 1',
  '    terminal.activate()',
  "    return 'shown'",
  '  }',
  "  return ''",
  '}',
].join('\n')

/** Opens a new Terminal.app window running the command in argv[0] in the person's shell. */
export const OPEN_SCRIPT = [
  'function run(argv) {',
  "  const terminal = Application('Terminal')",
  '  terminal.doScript(argv[0])',
  '  terminal.activate()',
  "  return 'opened'",
  '}',
].join('\n')

/** The command that resumes a session in a terminal, where it started and under its profile. */
export function resumeCommand(s: Pick<ClaudeSession, 'sessionId' | 'startCwd' | 'profile'>, home: string): string {
  return `cd ${shellWord(s.startCwd)} && ${profileEnv(s.profile, home) ?? ''}claude --resume ${s.sessionId}`
}

/**
 * The command that opens a background Claude session in a terminal. Closing
 * that window leaves the session running in the background. A profile other
 * than the default is reached through its config directory.
 */
export function attachCommand(sessionId: string, profile: string, home: string): string | undefined {
  const env = profileEnv(profile, home)
  if (!SAFE_ID.test(sessionId) || env === undefined) return undefined
  return `${env}claude attach ${sessionId}`
}

/** An id that goes into a shell command as it is: letters, digits and dashes only. */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/
/** A string as one shell word. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
/** What reaches a profile other than the default: its config directory. */
const profileEnv = (profile: string, home: string) =>
  !/^claude(-[\w.-]+)?$/.test(profile) ? undefined : profile === 'claude' ? '' : `CLAUDE_CONFIG_DIR=${shellWord(`${home}/.${profile}`)} `

/**
 * The command a session's own terminal tab runs once the session has
 * exited there: resume it in the background (same id, from where it started,
 * with its permission flags), then attach this tab to it. From then on,
 * closing the tab leaves it running.
 */
export function backgroundCommand(
  s: Pick<ClaudeSession, 'sessionId' | 'startCwd' | 'profile'>,
  home: string,
  modeFlagWords: readonly string[],
): string | undefined {
  const env = profileEnv(s.profile, home)
  // typed into a shell's line editor: no control character may reach it
  const isTypeable = !/[\u0000-\u001f\u007f]/.test(s.startCwd + home)
  if (!SAFE_ID.test(s.sessionId) || env === undefined || !s.startCwd.startsWith('/') || !isTypeable) return undefined
  if (!modeFlagWords.every(word => FLAG_WORDS.has(word))) return undefined
  const flags = modeFlagWords.map(flag => ` ${flag}`).join('')
  return `cd ${shellWord(s.startCwd)} && ${env}claude --bg --resume ${s.sessionId}${flags} && ${env}claude attach ${s.sessionId.slice(0, 8)}`
}

/** Types the command in argv[1] into Terminal.app's tab on the tty in argv[0], and brings it up; prints `typed`. */
export const TYPE_SCRIPT = [
  'function run(argv) {',
  "  const want = '/dev/' + argv[0]",
  "  const terminal = Application('Terminal')",
  '  const ttys = terminal.windows.tabs.tty()',
  '  for (let w = 0; w < ttys.length; w++) {',
  '    const j = ttys[w].indexOf(want)',
  '    if (j < 0) continue',
  '    const win = terminal.windows.byId(terminal.windows[w].id())',
  '    const tab = win.tabs[j]',
  // windows may have moved between the two reads: type only into the tab that still has the tty
  "    if (tab.tty() !== want) return ''",
  '    terminal.doScript(argv[1], { in: tab })',
  '    win.miniaturized = false',
  '    tab.selected = true',
  '    win.index = 1',
  '    terminal.activate()',
  "    return 'typed'",
  '  }',
  "  return ''",
  '}',
].join('\n')

/** Prints `yes` when a Terminal.app tab has the tty in argv[0]. Changes nothing. */
export const HAS_TAB_SCRIPT = [
  'function run(argv) {',
  "  return Application('Terminal').windows.tabs.tty().some(tabs => tabs.includes('/dev/' + argv[0])) ? 'yes' : ''",
  '}',
].join('\n')

/**
 * Moves a session to the background from its own tab: hangs it up (as a
 * closing terminal does; the tab's shell stays), waits until it has exited,
 * so the resume continues it rather than starting a copy, then types
 * backgroundCommand into that tab and prints `typed`. Args: pid, tty,
 * command, TYPE_SCRIPT. Exits 3 when it cannot be signalled, 4 when it does
 * not exit in 20 s, 5 when it exited but the command could not be typed.
 */
export const MOVE_SCRIPT = [
  'kill -HUP "$1" 2>/dev/null || exit 3',
  'i=0',
  // exited but not yet collected by its parent (a zombie) counts as exited
  'while kill -0 "$1" 2>/dev/null && ! /bin/ps -o stat= -p "$1" | /usr/bin/grep -q "^Z"; do',
  '  i=$((i + 1))',
  '  [ "$i" -gt 100 ] && exit 4',
  '  sleep 0.2',
  'done',
  'out=$(/usr/bin/osascript -l JavaScript -e "$4" "$2" "$3") || exit 5',
  '[ "$out" = typed ] || exit 5',
  'printf typed',
].join('\n')

/** BACKGROUND_SCRIPT's answer as a color (`#dfdbc3`), or undefined. */
export function parseBackground(stdout: string): string | undefined {
  const hex = stdout.trim().toLowerCase()
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : undefined
}

export type Proc = {
  pid: number
  tty: string
  /** `ps -o stat`: `+` when it is the foreground job of its terminal, `T` when stopped. */
  stat: string
  /** Start time as `ps -o lstart` prints it under TZ=UTC, spaces collapsed. */
  startText: string
  startedAt: number
  args: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PS_LINE =
  /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\w{3}) (\w{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})(?:\s+(.*))?$/

/** `ps` writes bytes outside printable ASCII as `\ooo`: back to UTF-8 text. */
export function decodePs(text: string): string {
  return text.replace(/(?:\\[0-7]{3})+/g, run => {
    const bytes = Uint8Array.from(run.slice(1).split('\\'), octal => parseInt(octal, 8))
    return new TextDecoder().decode(bytes)
  })
}

/** The `ps` columns parsePs reads; run with LC_ALL=C and TZ=UTC. */
export const PS_COLUMNS = 'pid=,tty=,stat=,lstart=,args='

/** Parses `ps -ww -o PS_COLUMNS` run with LC_ALL=C and TZ=UTC. */
export function parsePs(stdout: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line)
    if (!m) continue
    const [, pid, tty, stat, dow, mon, day, hh, mm, ss, year, args] = m as unknown as string[]
    const month = MONTHS.indexOf(mon!)
    if (month < 0) continue
    procs.set(Number(pid), {
      pid: Number(pid),
      tty: tty!,
      stat: stat!,
      startText: `${dow} ${mon} ${Number(day)} ${hh}:${mm}:${ss} ${year}`,
      startedAt: Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)),
      args: decodePs((args ?? '').trim()),
    })
  }
  return procs
}

/** Parses ENV_SCRIPT's output: pid → `{ codexHome, pwd }`, empty where unset. */
export function parseEnv(stdout: string): Map<number, { codexHome: string; pwd: string }> {
  const env = new Map<number, { codexHome: string; pwd: string }>()
  for (const line of stdout.split('\n')) {
    const [pid, codexHome = '', pwd = ''] = line.split('\t')
    if (pid !== undefined && /^\s*\d+\s*$/.test(pid)) {
      env.set(Number(pid), { codexHome: decodePs(codexHome), pwd: decodePs(pwd) })
    }
  }
  return env
}

/** Parses `lsof -Fpn`: pid → the ids of the Codex rollout files it holds open. */
export function parseRollouts(stdout: string): Map<number, string[]> {
  const held = new Map<number, string[]>()
  const rollout = new RegExp(`/rollout-[^/]*-(${UUID_RE})\\.jsonl$`, 'i')
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    const id = line.startsWith('n') ? rollout.exec(line)?.[1] : undefined
    if (id !== undefined && pid > 0) held.set(pid, [...(held.get(pid) ?? []), id])
  }
  return held
}

export const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

export function placeOf(cwd: string, home: string): string {
  if (cwd === '' || cwd === home) return '~'
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** `.claude-work` → `claude-work`. */
export const profileOf = (dirName: string) => dirName.replace(/^\./, '')

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The pid a registry file names, read before the file is: `<pid>.json`. */
export const registryPid = (fileName: string) => Number(/^(\d+)\.json$/.exec(fileName)?.[1] ?? 0)

/**
 * One registry file (`<config>/sessions/<pid>.json`) as a live session, or
 * undefined when its process is gone or its pid now belongs to another process.
 */
export function claudeFromRegistry(
  raw: unknown,
  profile: string,
  procs: ReadonlyMap<number, Proc>,
  home: string,
): ClaudeSession | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const pid = num(o.pid)
  const sessionId = str(o.sessionId)
  const proc = procs.get(pid)
  if (pid === 0 || sessionId === '' || proc === undefined) return undefined
  const procStart = str(o.procStart)
  if (procStart !== '' && collapse(procStart) !== proc.startText) return undefined
  const cwd = str(o.cwd)
  return {
    pid,
    sessionId,
    startCwd: cwd,
    jobId: str(o.jobId),
    name: str(o.name) || placeOf(cwd, home),
    cwd,
    status: str(o.status) || 'unknown',
    kind: str(o.kind) || 'interactive',
    profile,
    tty: proc.tty,
    isForeground: isForeground(proc.stat),
    since: num(o.statusUpdatedAt) || num(o.updatedAt) || num(o.startedAt),
  }
}

/** In front of its terminal (`+`), neither stopped (`T`, Ctrl+Z) nor a zombie. */
export const isForeground = (stat: string) => stat.includes('+') && !/^[TZ]/.test(stat)

/** A Claude Code process, by its command: `claude` itself, or a versioned build of it. */
export function isClaudeProcess(args: string): boolean {
  const exe = args.trim().split(/\s+/)[0] ?? ''
  return exe.split('/').pop() === 'claude' || exe.includes('/claude/versions/')
}

/**
 * Prints the permission mode a session last recorded in its transcript
 * ("$1"): `"permissionMode":"auto"`, or nothing. Only Claude's own records
 * are read (lines of type `permission-mode`, several in any transcript's
 * last 256 KB); a prompt's text is escaped inside its own line besides.
 */
export const MODE_SCRIPT = [
  `/usr/bin/tail -c 262144 "$1" 2>/dev/null`,
  `/usr/bin/grep '^{"type":"permission-mode",'`,
  `/usr/bin/grep -o '"permissionMode":"[A-Za-z]*"'`,
  '/usr/bin/tail -n 1',
].join(' | ')

/** A shell, by its command name (`-zsh` for a login shell): what a session's parent should be. */
export const isShell = (comm: string) => /(^|\/)-?(zsh|bash|sh|fish|ksh|tcsh|dash)$/.test(comm.trim())

/** The modes `claude --permission-mode` takes, as a session records them. */
const MODES = new Set(['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'])

/**
 * The flags that resume a session with the permission mode it had, from
 * MODE_SCRIPT's output: none for the default, undefined for a mode this
 * does not know, which stops the move rather than change its permissions.
 */
export function modeFlags(stdout: string): string[] | undefined {
  const mode = /"permissionMode":"([A-Za-z]*)"/.exec(stdout)?.[1] ?? ''
  if (mode === '' || mode === 'default') return []
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions']
  return MODES.has(mode) ? ['--permission-mode', mode] : undefined
}
const FLAG_WORDS = new Set(['--dangerously-skip-permissions', '--permission-mode', ...MODES])

const rank = (s: ClaudeSession) => (s.status === 'busy' ? 0 : s.status === 'idle' ? 2 : 1)

export const sortClaude = (list: ClaudeSession[]) =>
  [...list].sort((a, b) => rank(a) - rank(b) || b.since - a.since)

/** An open codex terminal, as its process and environment tell it. */
export type CodexProc = {
  pid: number
  tty: string
  startedAt: number
  /** The Codex home it runs under (CODEX_HOME, else `<home>/.codex`). */
  codexHome: string
  cwd: string
  resumeId?: string
  /** A `codex exec` run, whose thread is an exec thread. */
  isExec: boolean
  /** Rollout files it holds open: its own threads, when it runs them in-process. */
  held: readonly string[]
}

const NOT_SESSIONS = new Set(['app-server', 'mcp-server', 'mcp', 'sandbox', 'login', 'logout', 'completion'])
/** Codex options whose value is the next word, so it is not read as a subcommand. */
const VALUE_FLAGS = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval',
  '-C', '--cd', '-i', '--image', '--enable', '--disable', '--local-provider', '--add-dir',
])

/** The words after the executable: the args, past an executable path that holds spaces. */
function wordsAfterExe(args: string): string[] {
  const words = args.split(/\s+/).filter(Boolean)
  const exe = words.findIndex(w => w.split('/').pop() === 'codex')
  return words.slice(exe >= 0 ? exe + 1 : 1)
}

/** The first word that is neither an option nor an option's value. */
function subcommandOf(words: readonly string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (VALUE_FLAGS.has(w)) i++
    else if (!w.startsWith('-')) return w
  }
  return undefined
}

/**
 * The codex processes (by `pgrep -x codex`) on a terminal that are sessions:
 * not a server, a sandbox helper or a login.
 */
export function codexTerminals(procs: ReadonlyMap<number, Proc>, codexPids: ReadonlySet<number>): Proc[] {
  return [...procs.values()].filter(p => {
    if (!codexPids.has(p.pid) || p.tty === '??' || p.tty === '') return false
    const sub = subcommandOf(wordsAfterExe(p.args))
    return sub === undefined || !NOT_SESSIONS.has(sub)
  })
}

function resolveDir(dir: string, base: string): string {
  const parts = dir.startsWith('/') ? [] : base.split('/').filter(Boolean)
  for (const part of dir.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Completes a terminal from its environment and the rollout files it holds. */
export function codexProcFrom(
  proc: Proc,
  env: { codexHome: string; pwd: string } | undefined,
  held: readonly string[],
  home: string,
): CodexProc {
  const words = wordsAfterExe(proc.args)
  const optionValue = (long: string, short: string) => {
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      if (w === long || w === short) return words[i + 1]
      if (w.startsWith(`${long}=`)) return w.slice(long.length + 1)
    }
    return undefined
  }
  const pwd = env?.pwd ?? ''
  const cd = optionValue('--cd', '-C')
  const sub = subcommandOf(words)
  const resumeAt = words.indexOf('resume')
  const resumeId = resumeAt >= 0 ? words.slice(resumeAt + 1).find(w => UUID.test(w)) : undefined
  return {
    pid: proc.pid,
    tty: proc.tty,
    startedAt: proc.startedAt,
    codexHome: env?.codexHome || `${home}/.codex`,
    cwd: cd === undefined ? pwd : resolveDir(cd, pwd),
    ...(resumeId === undefined ? {} : { resumeId }),
    isExec: sub === 'exec' || sub === 'e',
    held,
  }
}

/** One top-level thread, as `threadQuery` selects it. */
export type ThreadRow = {
  id: string
  title: string
  name: string
  cwd: string
  source: string
  /** `codex-tui` for a thread a terminal made, whichever route it wrote by. */
  originator: string
  /** The thread's rollout file, whose command records say where it has been working. */
  rollout_path: string
  created_at_ms: number
  updated_at_ms: number
  /** Subagents under this thread, at any depth, that wrote in the last two minutes. */
  agents: number
}

const isFromTerminal = (t: ThreadRow) => t.originator === 'codex-tui' || t.source === 'cli'
const madeBy = (proc: CodexProc, t: ThreadRow) => (proc.isExec ? t.source === 'exec' : isFromTerminal(t))

/** Where a thread no open terminal holds was written from. */
const surfaceOf = (t: ThreadRow) =>
  isFromTerminal(t) ? 'cli' : t.source === 'vscode' ? 'app' : t.source || 'unknown'

/**
 * The Codex sessions: every open terminal matched to its thread, then every
 * other top-level thread written in the last half hour. A terminal's thread
 * is, in order of certainty: the newest of the threads it holds open; the one
 * it resumed; the newest in its folder created since it started; the newest
 * in its folder written since it started. Each pass claims before the next,
 * and within a pass the newest terminal chooses first, so a thread born before
 * the newer of two terminals in a folder started goes to the older one. Two
 * threads both born after it, neither held open, cannot be told apart: the
 * newer terminal takes the one written last.
 */
export function codexSessions(args: {
  terminals: readonly CodexProc[]
  threads: ReadonlyMap<string, readonly ThreadRow[]>
  now: number
}): CodexSession[] {
  const { terminals, threads, now } = args
  const homeName = (codexHome: string) => profileOf(codexHome.split('/').pop() ?? codexHome)
  const newest = (list: ThreadRow[]) => list.sort((a, b) => b.updated_at_ms - a.updated_at_ms)[0]

  const taken = new Set<string>()
  const matched = new Map<number, ThreadRow>()
  const newestFirst = [...terminals].sort((a, b) => b.startedAt - a.startedAt)
  const pass = (pick: (proc: CodexProc, free: ThreadRow[]) => ThreadRow | undefined) => {
    for (const proc of newestFirst) {
      if (matched.has(proc.pid)) continue
      const free = (threads.get(proc.codexHome) ?? []).filter(t => !taken.has(t.id))
      const thread = pick(proc, free)
      if (thread === undefined) continue
      taken.add(thread.id)
      matched.set(proc.pid, thread)
    }
  }
  const sinceStart = (proc: CodexProc, ms: number) => ms >= proc.startedAt - 5_000
  pass((proc, free) => newest(free.filter(t => proc.held.includes(t.id))))
  pass((proc, free) => free.find(t => t.id === proc.resumeId))
  pass((proc, free) =>
    newest(free.filter(t => madeBy(proc, t) && t.cwd === proc.cwd && sinceStart(proc, t.created_at_ms))),
  )
  pass((proc, free) =>
    newest(free.filter(t => madeBy(proc, t) && t.cwd === proc.cwd && sinceStart(proc, t.updated_at_ms))),
  )

  const toRow = (t: ThreadRow, codexHome: string, surface: string, tty: string): CodexSession => ({
    key: t.id,
    // the shared snapshot keeps no more of a first prompt than a row shows
    title: collapse(t.name || t.title).slice(0, 120) || 'untitled thread',
    cwd: t.cwd,
    profile: homeName(codexHome),
    surface,
    tty,
    updatedAt: t.updated_at_ms,
    lastActive: t.updated_at_ms,
    agents: t.agents,
  })
  const rows: CodexSession[] = terminals.map(proc => {
    const thread = matched.get(proc.pid)
    return thread !== undefined
      ? toRow(thread, proc.codexHome, 'terminal', proc.tty)
      : {
          key: `pid-${proc.pid}`,
          title: 'session (thread not found)',
          cwd: proc.cwd,
          profile: homeName(proc.codexHome),
          surface: 'terminal',
          tty: proc.tty,
          updatedAt: 0,
          lastActive: proc.startedAt,
          agents: 0,
        }
  })
  for (const [codexHome, list] of threads) {
    for (const t of list) {
      if (taken.has(t.id) || now - t.updated_at_ms >= ACTIVE_MS) continue
      taken.add(t.id)
      rows.push(toRow(t, codexHome, surfaceOf(t), ''))
    }
  }

  const isWorking = (s: CodexSession) => now - s.updatedAt < WORKING_MS
  return rows.sort((a, b) => Number(isWorking(b)) - Number(isWorking(a)) || b.updatedAt - a.updatedAt)
}

/**
 * The SQL for one Codex home: top-level threads written since `since` or
 * named in `ids`, each with its subagents (any depth, by the spawn edges)
 * that wrote since `agentsSince`. Long texts are cut so a home's rows stay
 * far below what one command's output may hold.
 */
export function threadQuery(since: number, agentsSince: number, ids: readonly string[]): string {
  const idList = [...new Set(ids.filter(id => UUID.test(id)))].map(id => `'${id}'`).join(',')
  const at = (t: string, col: string) => `coalesce(${t}.${col}_ms, ${t}.${col} * 1000)`
  return [
    'with recursive',
    `recent(id) as (select id from threads where archived = 0 and thread_source = 'subagent' and ${at('threads', 'updated_at')} >= ${Math.floor(agentsSince)}),`,
    'up(child, node) as (select id, id from recent union select up.child, e.parent_thread_id from up join thread_spawn_edges e on e.child_thread_id = up.node),',
    'agents(root, n) as (select node, count(distinct child) from up where not exists (select 1 from thread_spawn_edges e where e.child_thread_id = up.node) group by node)',
    "select t.id, substr(t.title, 1, 300) as title, substr(coalesce(t.name, ''), 1, 300) as name, t.cwd,",
    "substr(t.source, 1, 40) as source, coalesce(t.originator, '') as originator, t.rollout_path,",
    `${at('t', 'created_at')} as created_at_ms, ${at('t', 'updated_at')} as updated_at_ms, coalesce(a.n, 0) as agents`,
    'from threads t left join agents a on a.root = t.id',
    "where t.archived = 0 and coalesce(nullif(t.thread_source, ''), 'user') = 'user'",
    `and (${at('t', 'updated_at')} >= ${Math.floor(since)}${idList === '' ? '' : ` or t.id in (${idList})`})`,
    'order by updated_at_ms desc limit 400',
  ].join('\n')
}

/**
 * How sqlite3 opens a Codex database without writing to it. While Codex holds
 * it open (its `-shm` file exists) a read-only connection shares the WAL;
 * with nobody holding it, a read-only connection cannot create that file,
 * so it is read as immutable: no locks, no files made.
 */
export function readOnlyArgs(dbPath: string, isHeldOpen: boolean): string[] {
  return isHeldOpen
    ? ['-readonly', dbPath]
    : [`file:${dbPath.replace(/[%?#]/g, encodeURIComponent)}?immutable=1`]
}

/** Rows from `sqlite3 -json` output; empty output is no rows. */
export function parseThreads(stdout: string): ThreadRow[] {
  if (stdout.trim() === '') return []
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(r => {
    if (typeof r !== 'object' || r === null) return []
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string') return []
    return [
      {
        id: o.id,
        title: str(o.title),
        name: str(o.name),
        cwd: str(o.cwd),
        source: str(o.source),
        originator: str(o.originator),
        rollout_path: str(o.rollout_path),
        created_at_ms: num(o.created_at_ms),
        updated_at_ms: num(o.updated_at_ms),
        agents: num(o.agents),
      },
    ]
  })
}

/**
 * For each file in "$@" (Claude transcripts, Codex rollouts), prints
 * `==> <file>` and the last 40 working directories it records: Claude's
 * entries carry the session's `cwd`, Codex's command records the `cwd` the
 * command ran in (`file://...`). Only those strings leave the pipeline.
 */
export const RECENT_SCRIPT = [
  'for f in "$@"; do',
  `  printf '==> %s\\n' "$f"`,
  `  /usr/bin/tail -c 262144 "$f" 2>/dev/null | /usr/bin/grep -o '"cwd":"[^"]*"' | /usr/bin/tail -n 40`,
  'done',
].join('\n')

/** RECENT_SCRIPT's output: file → its recorded working directories, oldest first. */
export function parseRecent(stdout: string): Map<string, string[]> {
  const recent = new Map<string, string[]>()
  let dirs: string[] | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==> ')) {
      dirs = []
      recent.set(line.slice(4), dirs)
      continue
    }
    if (dirs === undefined || !line.startsWith('"cwd":"')) continue
    try {
      const value = (JSON.parse(`{${line}}`) as { cwd: string }).cwd
      const dir = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
      if (dir.startsWith('/')) dirs.push(dir.replace(/\/+$/, '') || '/')
    } catch {
      // a value grep cut at an escaped quote: skipped
    }
  }
  return recent
}

/** Where Claude Code keeps a session's transcript: its project folder is the start directory, every other character a dash. */
export const transcriptPath = (configDir: string, startCwd: string, sessionId: string) =>
  `${configDir}/projects/${startCwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`

/**
 * For each directory in "$@", prints `==> <dir>`, git's worktree root,
 * shared .git and branch, `--`, then its remotes' URLs with any user or
 * token taken out of them before they leave the pipeline.
 */
export const PLACE_SCRIPT = [
  'for d in "$@"; do',
  `  printf '==> %s\\n' "$d"`,
  '  git -C "$d" rev-parse --path-format=absolute --show-toplevel --git-common-dir --abbrev-ref HEAD 2>/dev/null',
  `  printf -- '--\\n'`,
  `  git -C "$d" config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | /usr/bin/sed -E 's#//[^/@]*@#//#'`,
  'done',
].join('\n')

/** PLACE_SCRIPT's output: directory → its place. */
export function parsePlaces(stdout: string): Map<string, Place> {
  const places = new Map<string, Place>()
  const sections = stdout.split(/^==> /m).slice(1)
  for (const section of sections) {
    const [head = '', ...rest] = section.split('\n')
    const at = rest.indexOf('--')
    const revParse = (at < 0 ? rest : rest.slice(0, at)).join('\n')
    const remotes = at < 0 ? [] : rest.slice(at + 1).filter(Boolean)
    places.set(head, placeFrom(head, revParse, remotes))
  }
  return places
}

/**
 * A remote URL as a repository: its host and path (`github.com/owner/repo`)
 * to group by, and `owner/repo` to show. A user or token in it is never kept.
 */
export function remoteName(url: string): { key: string; name: string } | undefined {
  const text = url.trim()
  let host = ''
  let path = text
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(text)
  if (scp !== null) {
    host = scp[1]!
    path = scp[2]!
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text)
      host = parsed.hostname
      path = decodeURIComponent(parsed.pathname)
    } catch {
      return undefined
    }
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '')
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return undefined
  return { key: `${host}/${parts.join('/')}`.toLowerCase(), name: host === '' ? parts[parts.length - 1]! : parts.slice(-2).join('/') }
}

/**
 * A directory's place from git's answers. Its repository is its origin
 * remote (else the first remote), so clones and worktrees of one repository
 * group together; with no remote, the main checkout that holds the shared
 * .git. Before the first commit git still prints both roots (and exits 128);
 * outside a repository it prints neither.
 */
export function placeFrom(cwd: string, revParse: string, remotes: readonly string[] = []): Place {
  const [top = '', common = '', head = ''] = revParse.split('\n').map(line => line.trim())
  if (!top.startsWith('/') || !common.startsWith('/')) return { repo: '', name: '', tree: cwd, branch: '' }
  const checkout = common.includes('/.git/modules/')
    ? top // a submodule is its own repository
    : common.endsWith('/.git')
      ? common.slice(0, -'/.git'.length)
      : common // a bare repository's worktrees share it
  const urls = new Map<string, string>()
  for (const line of remotes) {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim())
    if (m !== null && !urls.has(m[1]!)) urls.set(m[1]!, m[2]!)
  }
  const remote = remoteName(urls.get('origin') ?? [...urls.values()][0] ?? '')
  return {
    repo: remote?.key ?? checkout,
    name: remote?.name ?? (checkout.replace(/\/+$/, '').split('/').pop() || checkout).replace(/\.git$/, ''),
    tree: top,
    branch: head === 'HEAD' ? '' : head,
  }
}

/**
 * Where a session has been working: of the directories it recorded lately
 * (oldest first) that lie in a repository, the worktree it used most, ties
 * to the one used last; with none in a repository, where it started. A
 * passing visit to a scratch folder does not move it.
 */
export function workDir(start: string, recent: readonly string[], places: Readonly<Record<string, Place>>): string {
  const uses = new Map<string, { count: number; last: number; dir: string }>()
  recent.forEach((dir, at) => {
    const place = places[dir]
    if (place === undefined || place.repo === '') return
    const use = uses.get(place.tree) ?? { count: 0, last: -1, dir }
    uses.set(place.tree, { count: use.count + 1, last: at, dir })
  })
  const best = [...uses.values()].sort((a, b) => b.count - a.count || b.last - a.last)[0]
  return best?.dir ?? start
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** `/sessions` arguments: `2d`, `2` (days), `12h`, `all` (0). Undefined when not one of them. */
export function windowFrom(arg: string): number | undefined {
  const text = arg.trim().toLowerCase()
  if (text === 'all') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(d|days?|h|hours?)?$/.exec(text)
  const n = Number(m?.[1])
  if (m === null || !(n > 0)) return undefined
  return Math.round(n * (m[2]?.startsWith('h') ? HOUR_MS : DAY_MS))
}

/** `2d`, `12h`, `all`. */
export const windowLabel = (ms: number) =>
  ms === 0 ? 'all' : ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round((ms / HOUR_MS) * 10) / 10}h`

const tilde = (path: string, home: string) =>
  path === home ? '~' : home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/** The person's own order: per scope, keys top first. */
export type Order = Readonly<Record<string, readonly string[]>>
export const REPOS_SCOPE = 'repos'
export const treesScope = (repoKey: string) => `trees:${repoKey}`
export const itemsScope = (treeKey: string) => `items:${treeKey}`
/** Ranked keys kept per scope; sessions come and go, so a scope's list is capped. */
const ORDER_CAP = 300

/** `list` in the person's order where they gave one; what they have not placed follows, by `auto`. */
export function arrange<T>(
  list: readonly T[],
  keyOf: (t: T) => string,
  ranked: readonly string[] | undefined,
  auto: (a: T, b: T) => number,
): T[] {
  const rank = new Map((ranked ?? []).map((key, at) => [key, at] as const))
  return [...list].sort((a, b) => {
    const ra = rank.get(keyOf(a))
    const rb = rank.get(keyOf(b))
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined || rb !== undefined) return ra !== undefined ? -1 : 1
    return auto(a, b)
  })
}

/**
 * The order after `key` moves one place up (-1) or down (1) among `shown`,
 * as listed now: the shown keys take that order, and keys not shown now
 * (filtered out, or gone) keep their order after them. A move past either
 * end changes nothing.
 */
export function moved(ranked: readonly string[] | undefined, shown: readonly string[], key: string, delta: -1 | 1): string[] {
  const at = shown.indexOf(key)
  const to = at + delta
  if (at < 0 || to < 0 || to >= shown.length) return [...(ranked ?? [])]
  const next = [...shown]
  next[at] = next[to]!
  next[to] = key
  return [...next, ...(ranked ?? []).filter(k => !next.includes(k))].slice(0, ORDER_CAP)
}

/** A kept order, if it has the shape of one. */
export function orderFrom(value: unknown): Record<string, string[]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(k => typeof k === 'string'),
  )
  return Object.fromEntries(entries)
}

/** One session as the pane lists it, Claude's or Codex's alike. */
export type Item = {
  key: string
  tool: 'claude' | 'codex'
  title: string
  tags: string[]
  /** `working`, `idle`, `stalled`, or the registry's word for a state that wants the person. */
  state: string
  /** The terminal, `detached`, or where a Codex thread runs: `app`, `cli`, `exec`. */
  where: string
  lastActive: number
  /**
   * What a press opens: the terminal tab it runs in, a background Claude
   * session to attach, or the workspace window it runs in.
   */
  target?: { tty: string } | { attach: string; profile: string } | { workspace: string; window: string }
  /** Its lasting id for assigning it to a workspace: `claude:<session id>` or `codex:<thread id>`. */
  memberId?: string
  /** For an idle Claude session in a terminal tab: what moving it to the background starts from. */
  move?: { pid: number; tty: string; profile: string; sessionId: string; startCwd: string }
}
export type TreeView = { key: string; label: string; path: string; items: Item[] }
export type WorkspaceView = {
  key: string
  name: string
  /** The environment's name; '' for the default. */
  env: string
  dir: string
  /** Its tmux session is running; a terminal is attached to it. */
  isRunning: boolean
  isAttached: boolean
  items: Item[]
}
export const WORKSPACES_SCOPE = 'workspaces'
export type RepoView = { key: string; label: string; trees: TreeView[] }

/**
 * What the pane lists: the sessions active within `windowMs` (0: all; a
 * working one always), grouped by repository, then worktree. At each level
 * the person's own order comes first; the rest follow, the busiest and most
 * recent first, directories outside any repository last.
 */
export function viewOf(
  snap: Snapshot,
  o: { home: string; now: number; windowMs: number; selfId: string; order?: Order },
): { workspaces: WorkspaceView[]; repos: RepoView[]; shown: number; total: number } {
  const order = o.order ?? {}
  // a session runs in a workspace when its terminal is a pane of that workspace's tmux session
  const workspaceOf = new Map(snap.workspaces.map(ws => [tmuxName(ws), ws] as const))
  const paneOf = (tty: string) => snap.tmux.panes[tty]
  const inWorkspace = (tty: string) => {
    const pane = paneOf(tty)
    return pane !== undefined && workspaceOf.has(pane.session) ? pane : undefined
  }
  const items: (Item & { cwd: string; tty: string })[] = [
    ...snap.claude.map(s => {
      const isSelf = s.sessionId === o.selfId
      return {
        key: `claude-${s.pid}`,
        tool: 'claude' as const,
        cwd: s.cwd,
        tty: s.tty,
        ...(/^[A-Za-z0-9-]{1,64}$/.test(s.sessionId) ? { memberId: `claude:${s.sessionId}` } : {}),
        title: s.name,
        tags: [
          s.kind === 'bg' ? 'bg' : '',
          s.profile === 'claude' ? '' : s.profile.replace(/^claude-/, ''),
          isSelf ? 'this one' : '',
        ].filter(Boolean),
        state: claudeState(s, o.now),
        where: s.tty === '??' ? 'detached' : s.tty,
        lastActive: s.since,
        ...(!isSelf && s.kind !== 'bg' && s.isForeground && claudeState(s, o.now) === 'idle' && /^ttys\d+$/.test(s.tty) &&
        paneOf(s.tty) === undefined &&
        backgroundCommand(s, o.home, []) !== undefined
          ? { move: { pid: s.pid, tty: s.tty, profile: s.profile, sessionId: s.sessionId, startCwd: s.startCwd } }
          : {}),
        // a background session's own pty is no terminal tab: it is attached to; this one is already here
        ...(isSelf
          ? {}
          : inWorkspace(s.tty) !== undefined
            ? { target: { workspace: inWorkspace(s.tty)!.session, window: inWorkspace(s.tty)!.window } }
            : s.kind === 'bg'
            ? { target: { attach: s.jobId || s.sessionId.slice(0, 8), profile: s.profile } }
            : /^ttys\d+$/.test(s.tty)
              ? { target: { tty: s.tty } }
              : {}),
      }
    }),
    ...snap.codex.map(s => ({
      key: `codex-${s.key}`,
      tool: 'codex' as const,
      cwd: s.cwd,
      tty: s.surface === 'terminal' ? s.tty : '',
      // a terminal with no thread found has no lasting id
      ...(/^[A-Za-z0-9-]{1,64}$/.test(s.key) && !s.key.startsWith('pid-') ? { memberId: `codex:${s.key}` } : {}),
      title: s.title,
      tags: [
        s.profile === 'codex' ? '' : s.profile.replace(/^codex-/, ''),
        s.agents > 0 ? `+${s.agents} agent${s.agents === 1 ? '' : 's'}` : '',
      ].filter(Boolean),
      state: s.updatedAt > 0 && o.now - s.updatedAt < WORKING_MS ? 'working' : 'idle',
      where: s.surface === 'terminal' ? s.tty : s.surface,
      lastActive: s.lastActive,
      ...(s.surface !== 'terminal' || !/^ttys\d+$/.test(s.tty)
        ? {}
        : inWorkspace(s.tty) !== undefined
          ? { target: { workspace: inWorkspace(s.tty)!.session, window: inWorkspace(s.tty)!.window } }
          : { target: { tty: s.tty } }),
    })),
  ]
  const shown = items.filter(i => o.windowMs === 0 || i.state === 'working' || o.now - i.lastActive <= o.windowMs)

  // working first, then a state that wants the person, then idle; most recent first within each
  const rank = (i: Item) => (i.state === 'working' ? 2 : i.state === 'idle' ? 0 : 1)
  const byActivity = (a: Item, b: Item) => rank(b) - rank(a) || b.lastActive - a.lastActive
  const lead = (list: readonly Item[]) => [...list].sort(byActivity)[0]

  // a session belongs to a workspace by running in its tmux session, or by being assigned to it
  const assignedTo = new Map(snap.workspaces.flatMap(ws => (ws.members ?? []).map(m => [m, tmuxName(ws)] as const)))
  const inWorkspaces = new Map<string, Item[]>()
  const repos = new Map<string, RepoView>()
  for (const { cwd, tty, ...item } of shown) {
    const pane = inWorkspace(tty)
    const assignedName = pane === undefined && item.memberId !== undefined ? assignedTo.get(item.memberId) : undefined
    const session = pane?.session ?? assignedName
    if (session !== undefined) {
      const placed = assignedName === undefined ? item : { ...item, tags: [...item.tags, 'assigned'] }
      inWorkspaces.set(session, [...(inWorkspaces.get(session) ?? []), placed])
      continue
    }
    const place = snap.places[cwd] ?? { repo: '', name: '', tree: cwd, branch: '' }
    let repo = repos.get(place.repo)
    if (repo === undefined) {
      repo = { key: place.repo, label: place.repo === '' ? 'Other folders' : place.name, trees: [] }
      repos.set(place.repo, repo)
    }
    let tree = repo.trees.find(t => t.key === place.tree)
    if (tree === undefined) {
      tree = place.repo === ''
        ? { key: place.tree, label: tilde(place.tree, o.home), path: '', items: [] }
        : { key: place.tree, label: place.branch || baseName(place.tree), path: tilde(place.tree, o.home), items: [] }
      repo.trees.push(tree)
    }
    tree.items.push(item)
  }
  const ordered = [...repos.values()].map(repo => {
    const trees = repo.trees.map(t => ({ ...t, items: arrange(t.items, i => i.key, order[itemsScope(t.key)], byActivity) }))
    const byLead = (a: TreeView, b: TreeView) => byActivity(lead(a.items)!, lead(b.items)!)
    return { ...repo, trees: arrange(trees, t => t.key, order[treesScope(repo.key)], byLead) }
  })
  const repoAuto = (a: RepoView, b: RepoView) =>
    Number(a.key === '') - Number(b.key === '') ||
    byActivity(lead(a.trees.flatMap(t => t.items))!, lead(b.trees.flatMap(t => t.items))!)
  const sessionsRunning = new Set(Object.values(snap.tmux.panes).map(p => p.session))
  const workspaces: WorkspaceView[] = snap.workspaces.map(ws => ({
    key: ws.id,
    name: ws.name,
    env: ws.env,
    dir: tilde(ws.dir, o.home),
    isRunning: sessionsRunning.has(tmuxName(ws)),
    isAttached: (snap.tmux.clients[tmuxName(ws)]?.length ?? 0) > 0,
    items: arrange(inWorkspaces.get(tmuxName(ws)) ?? [], i => i.key, order[itemsScope(`ws:${ws.id}`)], byActivity),
  }))
  const created = (w: WorkspaceView) => snap.workspaces.findIndex(ws => ws.id === w.key)
  return {
    workspaces: arrange(workspaces, w => w.key, order[WORKSPACES_SCOPE], (a, b) => created(a) - created(b)),
    repos: arrange(ordered, r => r.key, order[REPOS_SCOPE], repoAuto),
    shown: shown.length,
    total: items.length,
  }
}

/** `1m`, `3h`: how long ago, compactly. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 172_800) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}
