// Workspaces: named projects, each a folder, an environment and one tmux
// session running its agents. Pure: no `$`, so the tests drive it directly.
import type { Workspace } from '../types'
import { HOLDERS_SCRIPT, threadFrom } from './bring'
import { checkEveryFrom, checkFrom } from './drift'
import { problemFrom } from './problem'

/** The tmux session a workspace runs in. */
export const tmuxName = (ws: Pick<Workspace, 'id'>) => `ws-${ws.id}`

/** A workspace id from its name: lowercase letters, digits and dashes, unique among `taken`. */
export function slugOf(name: string, taken: readonly string[] = []): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** Splits `/workspace` arguments like a shell: quotes group words. */
export function words(args: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(args); m !== null; m = re.exec(args)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

export type WorkspaceCommand =
  | { action: 'list' }
  | { action: 'new'; dir: string; env: string; name: string; purpose: string; only?: 'claude' | 'codex'; goOn?: true }
  | { action: 'open' | 'close' | 'rm'; ref: string }
  | { action: 'add'; ref: string; tool: 'claude' | 'codex'; id?: string }
  | { action: 'help'; error?: string }

/**
 * `/workspace` arguments: `new <folder> <env> <name> [--only claude|codex]
 * [--go-on] [--for <purpose>]`, `open <name>`, `close <name>`, `rm <name>`,
 * `add <name> claude|codex [<session id>]` (the other agent, to a workspace
 * of one: starting new, or going on with the conversation of the running
 * Claude session or Codex conversation of that id), or nothing to list. `<env>` is required and must be one of `envs` or `default`: a
 * misspelt one is an error, never another account. `~` in the folder is the
 * home directory. Before `--for`: `--only` names the one agent it runs;
 * `--go-on` has the agents go on with the branch checked out in the folder.
 * Every word after `--for` is the purpose.
 */
export function parseWorkspaceArgs(args: string, envs: readonly string[], home: string): WorkspaceCommand {
  const [verb = '', ...rest] = words(args)
  if (verb === '' || verb === 'list') return { action: 'list' }
  if (verb === 'open' || verb === 'close' || verb === 'rm') {
    return rest.length > 0 ? { action: verb, ref: rest.join(' ') } : { action: 'help', error: `say which workspace to ${verb}` }
  }
  if (verb === 'add') {
    // the name may be several words: the agent is the last word, or the one before an id
    const last = rest.at(-1)?.toLowerCase() ?? ''
    const before = rest.at(-2)?.toLowerCase() ?? ''
    const isTool = (w: string): w is 'claude' | 'codex' => w === 'claude' || w === 'codex'
    const [tool, id, name] = isTool(last) ? [last, undefined, rest.slice(0, -1)] : isTool(before) ? [before, rest.at(-1), rest.slice(0, -2)] : [undefined, undefined, rest]
    if (tool === undefined || name.length === 0) return { action: 'help', error: 'add needs a workspace, then claude or codex, then (to go on with a running session) its id' }
    if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) return { action: 'help', error: `"${id}" is not a session's id` }
    return { action: 'add', ref: name.join(' '), tool, ...(id === undefined ? {} : { id }) }
  }
  if (verb !== 'new') return { action: 'help', error: `"${verb}" is not one of new, open, close, add, rm, list` }
  const [folder = '', envWord = '', ...afterEnv] = rest
  const at = afterEnv.indexOf('--for')
  const beforeFor = at >= 0 ? afterEnv.slice(0, at) : afterEnv
  const purpose = at >= 0 ? afterEnv.slice(at + 1).join(' ').trim() : ''
  if (at >= 0 && purpose === '') return { action: 'help', error: '--for needs what the workspace is for' }
  const onlyAt = beforeFor.indexOf('--only')
  const only = onlyAt >= 0 ? beforeFor[onlyAt + 1]?.toLowerCase() : undefined
  if (onlyAt >= 0 && only !== 'claude' && only !== 'codex') return { action: 'help', error: '--only takes claude or codex' }
  const withoutOnly = onlyAt >= 0 ? [...beforeFor.slice(0, onlyAt), ...beforeFor.slice(onlyAt + 2)] : beforeFor
  const goOnAt = withoutOnly.indexOf('--go-on')
  const nameWords = goOnAt >= 0 ? [...withoutOnly.slice(0, goOnAt), ...withoutOnly.slice(goOnAt + 1)] : withoutOnly
  const option = nameWords.find(word => word.startsWith('--'))
  if (option === '--only' || option === '--go-on') return { action: 'help', error: `${option} is given once` }
  if (option !== undefined) return { action: 'help', error: `"${option}" is not an option /workspace takes` }
  const name = nameWords.join(' ').trim()
  if (folder === '' || envWord === '' || name === '') return { action: 'help', error: 'new needs a folder, an environment and a name' }
  if (envWord !== 'default' && !envs.includes(envWord)) return { action: 'help', error: `there is no environment "${envWord}"` }
  const env = envWord === 'default' ? '' : envWord
  const dir = absoluteDir(folder, home)
  if (dir === undefined) return { action: 'help', error: 'the folder must be absolute or start with ~/' }
  return { action: 'new', dir, env, name, purpose, ...(only === 'claude' || only === 'codex' ? { only } : {}), ...(goOnAt >= 0 ? { goOn: true as const } : {}) }
}

/** A folder as typed, as an absolute path: `~` and `~/...` are the home directory; anything else relative, undefined. */
export function absoluteDir(typed: string, home: string): string | undefined {
  const text = typed.trim()
  const dir = text === '~' ? home : text.startsWith('~/') ? `${home}${text.slice(1)}` : text
  return dir.startsWith('/') ? dir.replace(/\/+$/, '') || '/' : undefined
}

/** The agents a workspace runs: the one the owner chose, or Claude and Codex. */
export const agentsOf = (ws: Pick<Workspace, 'only'>): ('claude' | 'codex')[] => (ws.only === undefined ? ['claude', 'codex'] : [ws.only])

/** The workspace `ref` names: its id, or its name in any case. */
export const findWorkspace = (list: readonly Workspace[], ref: string) =>
  list.find(ws => ws.id === ref) ?? list.find(ws => ws.name.toLowerCase() === ref.trim().toLowerCase())

/** A string as one shell word. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
export const shellQuote = shellWord

/**
 * Where the ops screen leaves what it asks of a Claude session running this plugin in a Terminal tab (it opens and
 * closes workspaces as /sessions does, with the same checks): `<nonce>.json`, a Request; taken by renaming it (one
 * session alone can), answered in `<nonce>.done`, an Answer.
 */
export const requestsDir = (home: string) => `${home}/Library/Application Support/live-sessions/requests`
export const REQUEST_FILE = /^([a-z0-9]{8,40})\.json$/
export type Request = { action: 'open' | 'close'; id: string; at: number }
export type Answer = { text: string; isDone: boolean }
/** A request, if it is one: open or close a workspace by its id, asked at `at`. */
export function requestFrom(raw: unknown): Request | undefined {
  const o = raw as Partial<Record<keyof Request, unknown>> | null
  if (typeof o !== 'object' || o === null || (o.action !== 'open' && o.action !== 'close')) return undefined
  if (typeof o.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(o.id) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
  return { action: o.action, id: o.id, at: o.at }
}
/** An answer, if it is one. */
export function answerFrom(raw: unknown): Answer | undefined {
  const o = raw as Partial<Record<keyof Answer, unknown>> | null
  return typeof o === 'object' && o !== null && typeof o.text === 'string' && typeof o.isDone === 'boolean' ? { text: o.text, isDone: o.isDone } : undefined
}
/** How long a request waits to be taken; older ones are dropped untaken. */
export const REQUEST_MAX_AGE_MS = 30_000

/**
 * Where a workspace an agent is being added to is marked (`{at}`), so that no session opens it meanwhile with its one
 * agent; a mark older than ADDING_MAX_AGE_MS (a session gone mid-way) holds nothing back.
 */
export const addingPath = (home: string, id: string) => `${home}/Library/Application Support/live-sessions/adding/${id}.json`
export const ADDING_MAX_AGE_MS = 5 * 60_000

/** The file a terminal runs (`/bin/sh <file>`) to open a workspace: its command line, in POSIX sh whatever the login shell. */
export const openScriptPath = (home: string, id: string) => `${home}/Library/Application Support/live-sessions/open/${id}.sh`

/**
 * The variables Claude Code sets in what it starts. An agent started from
 * a Claude session would inherit them, and with them its transcript saving
 * turned off; each workspace agent starts without them.
 */
const SESSION_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
  // which account: cleared, then set for a named environment only, whatever the tmux server holds
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
]

/** An agent's start under a workspace's environment: its config directory, Claude's or Codex's. */
export function agentStart(tool: 'claude' | 'codex', env: string, home: string, bin: string = tool): string {
  const vars = env === '' ? '' : tool === 'claude' ? `CLAUDE_CONFIG_DIR=${shellWord(`${home}/.claude-${env}`)} ` : `CODEX_HOME=${shellWord(`${home}/.codex-${env}`)} `
  return `env ${SESSION_MARKERS.map(v => `-u ${v}`).join(' ')} ${vars}${bin}`
}

/** Where a workspace's first prompt for an agent waits until the agent starts (and takes it, once). */
export const promptPath = (home: string, id: string, tool: 'claude' | 'codex') =>
  `${home}/Library/Application Support/live-sessions/prompts/${id}-${tool}.txt`

/**
 * One agent's pane: a POSIX script (so a fish or zsh login shell changes
 * nothing) that starts the agent able to work in the project's worktrees
 * folder too, and leaves a shell when it exits. Each takes its first prompt
 * from the workspace, when there is one, and removes it so a restart never
 * sends it again; it goes after `--`, so an option taking several values
 * (Claude's --add-dir) never takes it. Codex starts without its update
 * offer, whose default answer on Enter installs a new version, and runs its
 * conversation itself (NO_DAEMON). Every agent
 * starts with its permission checks bypassed, the owner's choice for their
 * workspaces (`BYPASS`): Claude asks before nothing, and Codex runs with no
 * sandbox and no approvals (so it needs no --add-dir for the worktrees
 * folder). An agent with a conversation to resume (`threads`) resumes it,
 * from the folder it ran in, bypassed the same way, whatever mode it ran in
 * before.
 */
function paneScript(tool: 'claude' | 'codex', ws: Pick<Workspace, 'id' | 'env' | 'checkout' | 'threads' | 'only'>, home: string, bin?: string, waitFor?: WaitFor): string {
  // (an id from the workspaces file reaches the line only as threadFrom read it: letters, digits, dashes)
  const thread = ws.threads?.[tool]
  const addDir = ws.checkout === undefined ? '' : ` --add-dir ${shellWord(`${ws.checkout}-worktrees`)}`
  const prompt = shellWord(promptPath(home, ws.id, tool))
  const flags = ` ${BYPASS[tool]}`
  const start = agentStart(tool, ws.env, home, bin)
  // Claude's way of working, in its system prompt (before --add-dir, which takes every value up to `--`)
  const lean = tool === 'claude' ? ` --append-system-prompt ${shellWord(leanWork(ws.only === undefined))}` : ''
  // Claude's folder: its registry of running sessions has a file per process (its pid's) while it runs
  const claudeHome = `${home}/.claude${ws.env === '' ? '' : `-${ws.env}`}`
  const agent =
    thread === undefined
      ? tool === 'codex'
        ? `${start} ${UPDATE_OFF} ${NO_DAEMON}${flags} \${p:+--} \${p:+"$p"}`
        : `${start}${flags}${lean}${addDir} \${p:+--} \${p:+"$p"}`
      : tool === 'claude'
        // a Claude conversation is kept under the folder it started in: resumed from there, unless a live Claude
        // session has it open (its registry entry, its process there): then it says so and leaves a shell. Brought in
        // from the session that opened the workspace (`waitFor`), it first waits while that very process runs (its pid,
        // started when it was: never another given its pid), unless that session's registry entry names another
        // conversation twice in a row (a /clear or /resume there: it no longer runs this one)
        ? (!isWaitFor(waitFor) ? '' :
          `w=; n=0; while [ "$(echo $(${PROCESS_START} -p ${waitFor.pid} 2>/dev/null))" = ${shellWord(waitFor.since)} ]; do ` +
          `if grep -q '"sessionId":"' ${shellWord(`${claudeHome}/sessions/${waitFor.pid}.json`)} 2>/dev/null && ! grep -q '"sessionId":"${thread.id}"' ${shellWord(`${claudeHome}/sessions/${waitFor.pid}.json`)} 2>/dev/null; then n=$((n + 1)); [ "$n" -ge 2 ] && break; else n=0; fi; ` +
          `[ -n "$w" ] || echo 'Waiting for the Claude session this conversation was brought in from to close; it goes on here then.'; w=1; sleep 0.5; done; `) +
          `open=; for f in ${shellWord(claudeHome)}/sessions/*.json; do grep -q '"sessionId":"${thread.id}"' "$f" 2>/dev/null && kill -0 "$(basename "$f" .json)" 2>/dev/null && open=1; done; ` +
          `if [ -n "$open" ]; then echo 'This conversation is open in another Claude session: close it there, then close this workspace and open it again.'; ` +
          `else cd ${shellWord(thread.dir)} && ${start} --resume ${thread.id}${flags}${lean}${addDir} \${p:+--} \${p:+"$p"}; fi`
        // a Codex conversation is resumed only once no Codex holds it open: Codex's shared server lets one go about a
        // minute after the terminal it ran closes, so a workspace with a terminal brought in opens at once and its
        // Codex waits for that here (PANE_LETS_GO_S at most), saying so; still held, it is not resumed, and says by what
        : `hs=${shellWord(HOLDERS_SCRIPT)}; h=$(/bin/sh -c "$hs" sh ${thread.id} 0); ` +
          `if [ "$h" != free ]; then echo ${shellWord(CODEX_WAIT_LINE)}; h=$(/bin/sh -c "$hs" sh ${thread.id} ${PANE_LETS_GO_S}); fi; ` +
          `if [ "$h" = free ]; then ${start} resume ${UPDATE_OFF} ${NO_DAEMON}${flags} -C ${shellWord(thread.dir)} -- ${thread.id} \${p:+"$p"}; ` +
          `else echo "This conversation is still open in another Codex (its process: \${h#held }): close it there, then close this workspace and open it again."; fi`
  const run = `p=$(cat ${prompt} 2>/dev/null) && rm -f ${prompt}; ${agent}`
  return `/bin/sh -c ${shellWord(`${run}; exec "$SHELL" -l`)}`
}
const UPDATE_OFF = '-c check_for_update_on_startup=false'
/** What a workspace's Codex pane says while Codex holds the conversation it resumes. */
export const CODEX_WAIT_LINE = 'Waiting for Codex to let this conversation go (its shared server keeps one about a minute after its terminal closes); it goes on here then.'
/** How long, in seconds, a workspace's Codex pane waits for its conversation to be let go before it gives up. */
export const PANE_LETS_GO_S = 180

/**
 * A process to wait for: its pid, and when it started as PROCESS_START prints it (words one space apart), so that a
 * process given its pid later is never taken for it.
 */
export type WaitFor = { pid: number; since: string }
/** When the process `-p <pid>` started, the same wherever it is asked (`Tue Oct 13 18:27:10 2026`, in UTC). */
export const PROCESS_START = 'LC_ALL=C TZ=UTC /bin/ps -o lstart='
/** PROCESS_START's answer as a WaitFor's `since`: its words one space apart, or undefined when it is not a start time. */
export function processStart(stdout: string): string | undefined {
  const since = stdout.trim().split(/\s+/).join(' ')
  return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(since) ? since : undefined
}
const isWaitFor = (w: WaitFor | undefined): w is WaitFor => w !== undefined && Number.isInteger(w.pid) && w.pid > 1 && processStart(w.since) === w.since
/**
 * A workspace's Codex runs its conversation itself, never in Codex's shared background server: it holds the
 * conversation's rollout open, which is how which conversation it runs is known for certain (CodexMatch `held`), and
 * it ends with its pane.
 */
export const NO_DAEMON = '--no-daemon'
/** How every workspace agent starts, fresh or resumed: its permission checks bypassed (Claude), or its approvals and sandbox (Codex). */
export const BYPASS = { claude: '--dangerously-skip-permissions', codex: '--dangerously-bypass-approvals-and-sandbox' } as const

/** The tmux pane option that says which agent a pane is for. */
export const AGENT_OPTION = '@live-sessions-agent'

/**
 * Each side's border: its agent's name (by the pane's mark, or else, as a
 * workspace made before the marks had a window per agent, by its window's
 * name), and on the side that takes the keys, so it says.
 */
const named = (of: string) => `#{?#{==:${of},claude},Claude,#{?#{==:${of},codex},Codex,`
export const BORDER_FORMAT =
  ` ${named(`#{${AGENT_OPTION}}`)}${named('#{window_name}')}#{pane_current_command}}}}}#{?pane_active, · your keys go here,} `

/**
 * A workspace's tmux session, set up to be used by hand, as tmux commands
 * (arguments) for the session `name` (titled `title` on its bar) and each of its `windows` (targets): the
 * mouse on in that session alone, so a click picks the side the keys go to
 * and the wheel scrolls the side under it (or reaches its agent, when the
 * agent takes the mouse); its bar at the top, the workspace's name at its
 * left end, `HIDE WINDOW` (or what closing it does) at its right end, then
 * `jobs`: what tmux.conf runs from the bar's right end (statusJobs; a session
 * restore's save, tmux-continuum's, runs so); with no `jobs` read, the right
 * end left to tmux.conf until they are; for one window no window list; and
 * each side's border naming its agent. tmux.conf and other sessions are left
 * as they are.
 */
export function sessionSetup(name: string, windows: readonly string[], canHide = false, title = '', jobs?: string): string[][] {
  // the workspace's own name (tmux reads `#` in it as a format: doubled), cut to the bar's left end
  const shown = [...title].length > TITLE_MAX ? `${[...title].slice(0, TITLE_MAX - 1).join('')}…` : title
  return [
    ['set-option', '-t', name, 'mouse', 'on'],
    // the bar at the top, the workspace's name first
    ['set-option', '-t', name, 'status-position', 'top'],
    ['set-option', '-t', name, 'status-left-length', '50'],
    ['set-option', '-t', name, 'status-left', shown === '' ? '' : ` ${shown.replace(/#/g, '##')} `],
    // (tmux.conf's right end not read yet, as when a window first makes the session: tmux.conf's own until it is)
    ...(jobs === undefined
      ? [['set-option', '-u', '-t', name, 'status-right'], ['set-option', '-u', '-t', name, 'status-right-length']]
      : [['set-option', '-t', name, 'status-right-length', '60'], ['set-option', '-t', name, 'status-right', `${canHide ? HIDE_LABEL : KEEPS_LABEL}${jobs}`]]),
    ...windows.flatMap(window => [
      ['set-window-option', '-t', window, 'pane-border-status', 'top'],
      ['set-window-option', '-t', window, 'pane-border-format', BORDER_FORMAT],
      // one window (its agents side by side): no window list, whose `0:peers*` says nothing
      ...(windows.length === 1
        ? [['set-window-option', '-t', window, 'window-status-format', ''], ['set-window-option', '-t', window, 'window-status-current-format', '']]
        : []),
    ]),
  ]
}

/**
 * What tmux.conf runs from the bar's right end (`tmux show-options -gv status-right`): each `#(command)` in it as tmux
 * runs it, written as it is, parentheses inside it kept, in its order; the rest of it (the text it shows) left out. A
 * `#(` after an odd number of `#` is text (`##` is a `#`), and one inside a `#{…}` (a condition's branch, a literal)
 * is left out, as tmux may not run it. A workspace's bar carries them after its own right end, so they go on running
 * while only workspace windows are open (tmux-continuum saves the sessions from one, which shows nothing).
 */
export function statusJobs(right: string): string {
  const jobs: string[] = []
  let inFormat = 0
  for (let k = 0; k < right.length; k++) {
    if (right[k] !== '#') {
      if (inFormat > 0 && right[k] === '}') inFormat--
      continue
    }
    let hashes = 0
    while (right[k + hashes] === '#') hashes++
    const next = right[k + hashes]
    k += hashes - 1
    // `##` pairs are a `#` written out: what follows counts only after an odd run
    if (hashes % 2 === 0) continue
    if (next === '{') {
      inFormat++
      k++
    } else if (next === '(' && inFormat === 0) {
      let depth = 0
      let end = -1
      for (let j = k + 1; j < right.length; j++) {
        if (right[j] === '(') depth++
        else if (right[j] === ')' && --depth === 0) {
          end = j
          break
        }
      }
      if (end < 0) break
      jobs.push(right.slice(k, end + 1))
      k = end
    }
  }
  return jobs.join('')
}

/** The most characters of a workspace's name its bar shows. */
const TITLE_MAX = 40
/** At the status bar's right end: HIDE WINDOW, which a click hides the window by (HIDE_RANGE), or, where it cannot, what closing it does. */
export const HIDE_RANGE = 'ls-hide'
export const HIDE_LABEL = `#[range=user|${HIDE_RANGE}]#[reverse] HIDE WINDOW #[norange default] `
export const KEEPS_LABEL = ' closing this window keeps the agents running '

/** The script a Hide runs, kept beside the workspaces: `/bin/sh <it> <the terminal's tty>`. */
export const hidePath = (home: string) => `${home}/Library/Application Support/live-sessions/hide.sh`

/**
 * Closes the Terminal.app window of terminal "$1" (`ttys012`): only a window
 * of that one tab, once the tab is back at its shell (a tmux client just
 * detached), so nothing running is ever closed. Answers `closed`, `none`
 * (no Terminal tab is that terminal), `shared` (its window has other tabs)
 * or `busy` (something still runs in it).
 */
export const CLOSE_SCRIPT = `function run(argv) {
  const tty = '/dev/' + argv[0]
  const terminal = Application('Terminal')
  // asking a Terminal that is not running would start it
  if (!terminal.running()) return 'none'
  for (let i = 0; i < 30; i++) {
    const w = terminal.windows().find(x => x.tabs().some(t => t.tty() === tty))
    if (w === undefined) return 'none'
    const tabs = w.tabs()
    if (tabs.length !== 1) return 'shared'
    if (!tabs[0].busy()) {
      // where it was, so the workspace opens on that screen again
      const b = w.bounds()
      const place = { x: b.x, y: b.y, width: b.width, height: b.height, fontSize: tabs[0].fontSize() }
      w.close()
      return 'closed ' + JSON.stringify(place)
    }
    delay(0.1)
  }
  return 'busy'
}`

/**
 * hide.sh: hides a workspace's window. Detaches the terminal "$1"
 * (`/dev/ttys012`) from tmux, so its agents keep running, then closes its
 * Terminal.app window (CLOSE_SCRIPT); a terminal tmux did not detach (one
 * that was not attached: its number may be another window's by now) is
 * left as it is. A terminal switched to the workspace from another tmux
 * session (opened from inside the person's own tmux) goes back to that
 * session instead, its window kept. Run by a click on the status bar (in
 * the tmux server, whose own socket `tmux` then reaches) or by the pane.
 */
export const HIDE_SCRIPT = [
  '#!/bin/sh',
  'tty=$1',
  'case $tty in /dev/ttys[0-9]*) ;; *) exit 0;; esac',
  `last=$(tmux display-message -p -c "$tty" '#{client_last_session}' 2>/dev/null)`,
  'if [ -n "$last" ] && tmux has-session -t "=$last" 2>/dev/null; then tmux switch-client -c "$tty" -t "=$last"; exit 0; fi',
  // which workspace session it shows, asked before it is detached: its window's place is kept under that name
  `session=$(tmux display-message -p -c "$tty" '#{client_session}' 2>/dev/null)`,
  'tmux detach-client -t "$tty" 2>/dev/null || exit 0',
  `out=$(/usr/bin/osascript -l JavaScript - "\${tty#/dev/}" <<'JXA'`,
  CLOSE_SCRIPT,
  'JXA',
  ')',
  // the letters spelt out: a range would take others in some locales
  'case $session in ws-*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) session=;; ws-?*) ;; *) session=;; esac',
  'case $out in "closed {"*) [ -n "$session" ] && mkdir -p "$(dirname "$0")/windows" && printf \'%s\\n\' "\${out#closed }" > "$(dirname "$0")/windows/$session.json";; esac',
  'echo "\${out%% *}"',
  '',
].join('\n')

/**
 * Where a window goes, as hide.sh keeps a workspace's: its position and size (points, from the top left) and font
 * size; and, for one being opened, the Terminal profile (settings set) it takes (the ops screen: that of the tab it is
 * opened from; a window of agents takes none, so Terminal's default profile).
 */
export type Placement = { x: number; y: number; width: number; height: number; fontSize: number; profile?: string }

/** The file hide.sh keeps a workspace session's window place in. */
export const placementPath = (home: string, session: string) => `${home}/Library/Application Support/live-sessions/windows/${session}.json`

/** A kept placement, if it is one: whole numbers, a window at least 300×200, a font from 6 to 72 (0: as the profile has it). */
export function placementFrom(raw: unknown): Placement | undefined {
  const o = raw as Partial<Record<keyof Placement, unknown>> | null
  if (typeof o !== 'object' || o === null) return undefined
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  const [x, y, width, height, fontSize] = [n(o.x), n(o.y), n(o.width), n(o.height), n(o.fontSize) ?? 0]
  if (x === undefined || y === undefined || width === undefined || height === undefined || width < 300 || height < 200) return undefined
  return { x, y, width, height, fontSize: fontSize >= 6 && fontSize <= 72 ? fontSize : 0 }
}

/** A screen's free part (what the menu bar and Dock leave), from the top left of the menu bar's screen, as Terminal places windows. */
export type Screen = { x: number; y: number; width: number; height: number }

/**
 * The screen a kept window is on: of the screens there are now, the one with most of it (on a tie, the one listed
 * first, the screen in use being listed first); none when it shows on none.
 */
export function screenShowing(place: Placement, screens: readonly Screen[]): Screen | undefined {
  const shown = (s: Screen) =>
    Math.max(0, Math.min(place.x + place.width, s.x + s.width) - Math.max(place.x, s.x)) * Math.max(0, Math.min(place.y + place.height, s.y + s.height) - Math.max(place.y, s.y))
  const best = [...screens].sort((a, b) => shown(b) - shown(a))[0]
  return best !== undefined && shown(best) > 0 ? best : undefined
}

/**
 * SCREEN_SCRIPT's answer: the screens there are (each of some size), the screen in use first, and the tab's font size
 * and profile ('' when not known; a name of at most 100 characters, no control characters).
 */
export function screensFrom(stdout: string): { screens: Screen[]; fontSize: number; profile: string } | undefined {
  try {
    const seen = JSON.parse(stdout) as { screens?: Screen[]; fontSize?: number; profile?: unknown }
    const all = (seen.screens ?? []).filter(s => [s.x, s.y, s.width, s.height].every(n => typeof n === 'number' && Number.isFinite(n)) && s.width > 0 && s.height > 0)
    const profile = typeof seen.profile === 'string' && seen.profile.length <= 100 && !/[\u0000-\u001f\u007f]/.test(seen.profile) ? seen.profile : ''
    return all.length === 0 ? undefined : { screens: all, fontSize: typeof seen.fontSize === 'number' ? seen.fontSize : 0, profile }
  } catch {
    return undefined
  }
}

/**
 * A workspace's window, opened from /sessions or the ops screen (agentPlacement): on the screen it was on when last
 * hidden (`kept`), while that is still there, else on the screen in use.
 */
export function workspacePlacement(seen: { screens: readonly Screen[]; fontSize: number }, kept: Placement | undefined): Placement {
  return agentPlacement((kept === undefined ? undefined : screenShowing(kept, seen.screens)) ?? seen.screens[0]!, seen.fontSize)
}

/**
 * The font a window this plugin opens gets: a little smaller than that of the window it is opened from (80% of it, 6
 * points at least); 0 (as its profile has it) when not known.
 */
export function openedFontSize(fontSize: number): number {
  return fontSize >= 6 && fontSize <= 72 ? Math.max(6, Math.round(fontSize * 0.8)) : 0
}

/** How much of the screen's free part a window of agents takes, across and down. */
export const AGENT_WINDOW_SHARE = 0.6

/**
 * A window of agents this plugin opens (a workspace's, a session opened in the background's): 60% of the screen's free
 * part (what the menu bar and Dock leave) across and down, centred, a little smaller than the font of the window it is
 * opened from (openedFontSize), in Terminal's default profile (the owner's choice: an agent's chat in the profile new
 * windows get, light here, never that of the tab it is opened from); never a profile's small default window, nor the
 * size and font it had before.
 */
export function agentPlacement(screen: Screen, fontSize: number): Placement {
  const width = Math.round(screen.width * AGENT_WINDOW_SHARE)
  const height = Math.round(screen.height * AGENT_WINDOW_SHARE)
  return { x: Math.round(screen.x + (screen.width - width) / 2), y: Math.round(screen.y + (screen.height - height) / 2), width, height, fontSize: openedFontSize(fontSize) }
}

/**
 * The colours of a workspace's tmux panes, as tmux's window-style takes them (`fg=#000000,bg=#dfdbc3`): those of
 * Terminal's default profile, its windows' own, so its panes look the same in any window (one switched to from inside
 * tmux, one opened before), and an agent asking the terminal for them (OSC 10 and 11: Codex blends its input line and
 * the owner's messages from them, once, at its start) is told them; undefined unless both are `#rrggbb`.
 */
export function paneStyle(colors: { fg: string; bg: string } | undefined): string | undefined {
  const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c)
  return colors !== undefined && isHex(colors.fg) && isHex(colors.bg) ? `fg=${colors.fg.toLowerCase()},bg=${colors.bg.toLowerCase()}` : undefined
}

/**
 * The tmux commands that give a running workspace's windows (`tmux list-windows -F '#{window_id}'` as it printed them)
 * its panes' colours as it is opened again (from /sessions or the ops screen): paneStyle; or, when they are not known,
 * none, taking away colours set before (a background alone, as versions before 0.32.1 set the opener tab's), so each
 * pane shows the colours of the window showing it, never black text on a black background set for another window.
 */
export function windowColors(listed: string, style: string | undefined): string[][] {
  const windows = listed.split('\n').map(id => id.trim()).filter(id => /^@\d+$/.test(id))
  return windows.map(window => (style === undefined ? ['set-window-option', '-u', '-t', window, 'window-style'] : ['set-window-option', '-t', window, 'window-style', style]))
}

/**
 * Every screen's free part (Screen), the one in use now (mainScreen: the
 * one with the keyboard's window) first, and the font size and profile of
 * terminal "$1"'s tab (`ttys012`; 0 and '' when no Terminal tab is that
 * terminal): JSON.
 * Screens are placed from the top left of the menu bar's screen
 * (screens[0]), as Terminal places windows. Never starts Terminal.
 */
export const SCREEN_SCRIPT = `function run(argv) {
  ObjC.import('AppKit')
  const all = $.NSScreen.screens
  const top = all.objectAtIndex(0).frame.size.height
  const place = s => {
    const free = s.visibleFrame
    return { x: free.origin.x, y: top - free.origin.y - free.size.height, width: free.size.width, height: free.size.height }
  }
  const main = place($.NSScreen.mainScreen)
  const screens = [main]
  for (let i = 0; i < all.count; i++) {
    const s = place(all.objectAtIndex(i))
    if (s.x !== main.x || s.y !== main.y || s.width !== main.width || s.height !== main.height) screens.push(s)
  }
  let fontSize = 0
  let profile = ''
  const terminal = Application('Terminal')
  if (terminal.running()) {
    const tty = '/dev/' + argv[0]
    for (const w of terminal.windows()) for (const t of w.tabs()) if (t.tty() === tty) {
      fontSize = t.fontSize()
      try { profile = t.currentSettings().name() } catch (error) {}
    }
  }
  return JSON.stringify({ screens, fontSize, profile })
}`

/**
 * The click on the status bar's Hide (for every tmux session: bindings are
 * the server's), keeping tmux's own answer to any other click there. Its
 * command names hide.sh, so a path tmux would read otherwise (a quote, `#`)
 * gets none.
 */
export function hideBinding(path: string): string[] | undefined {
  if (/['"#\\]/.test(path)) return undefined
  // run-shell shows what a command prints in the pane, over the agent, in a view the relay waits on: none is shown
  return ['bind-key', '-T', 'root', 'MouseDown1Status', 'if-shell', '-F', `#{==:#{mouse_status_range},${HIDE_RANGE}}`,
    `run-shell -b "/bin/sh '${path}' '#{client_tty}' >/dev/null 2>&1"`, STATUS_CLICK]
}
/** tmux's own answer to a click on the status bar. */
export const STATUS_CLICK = 'switch-client -t ='

/**
 * Whether the Hide click may be bound, from `tmux list-keys -T root
 * MouseDown1Status`: only over tmux's own binding, or this one (a path that
 * changed). One the person made is theirs, left as it is.
 */
export function mayBindHide(listed: string): boolean {
  const command = listed.trim().replace(/^bind-key\s+-T\s+root\s+MouseDown1Status\s+/, '')
  return command === '' || command === STATUS_CLICK || command.includes(HIDE_RANGE)
}

/** The tmux session option that marks a session as started for one workspace (its createdAt). */
export const OWNER_OPTION = '@live-sessions-workspace'

/**
 * The command line that opens a workspace in a terminal: creates its tmux
 * session if it is not running (one window, `peers`, with Claude on the left
 * and Codex on the right, or the one agent the owner chose, in its folder,
 * each pane marked with its agent and leaving a shell when its agent exits),
 * then attaches. Closing that
 * terminal detaches; the agents keep running in tmux. Its window's own
 * colours are `colors` (paneStyle: Terminal's default profile's, which the
 * window takes), set before its agents ask for them: tmux answers an agent's
 * question for the terminal's colours (OSC 10, 11) with them, and Codex blends
 * its input line and the owner's messages from them, once, at its start;
 * without them tmux answers with a colour left from another window, or none.
 * `waitFor`: the process of the Claude session whose conversation
 * its Claude resumes (the session that opened it, bringing itself in), which
 * it waits to see closed first (or running another conversation). `socket` (a private server that reads no
 * tmux.conf) and `bins` are for tests; `attach: false` only creates.
 */
export function openCommand(
  ws: Pick<Workspace, 'id' | 'env' | 'dir' | 'createdAt' | 'checkout' | 'threads' | 'only'> & { name?: string },
  home: string,
  o: { socket?: string; bins?: { claude: string; codex: string }; attach?: boolean; colors?: { fg: string; bg: string }; waitFor?: WaitFor } = {},
): string {
  // a test's private server reads no tmux.conf: the person's plugins (a session restore) never run in it
  const tmux = o.socket === undefined ? 'tmux' : `tmux -L ${shellWord(o.socket)} -f /dev/null`
  const name = tmuxName(ws)
  const pane = (tool: 'claude' | 'codex') => shellWord(paneScript(tool, ws, home, o.bins?.[tool], tool === 'claude' ? o.waitFor : undefined))
  // tmux expands `#` sequences in -c: a literal `#` is `##`
  const dir = shellWord(ws.dir.replace(/#/g, '##'))
  // each command in the sequence acts on the pane the one before made
  const [first, second] = agentsOf(ws)
  const style = paneStyle(o.colors)
  const create = [
    `${tmux} has-session -t ${shellWord(`=${name}`)} 2>/dev/null ||`,
    `${tmux} new-session -d -s ${shellWord(name)} -c ${dir} -n peers ${pane(first!)}`,
    // (its window, before the second agent is started, and long before the first has started enough to ask)
    ...(style === undefined ? [] : [`\\; set-window-option window-style ${shellWord(style)}`]),
    `\\; set-option -p ${AGENT_OPTION} ${first}`,
    ...(second === undefined ? [] : [`\\; split-window -h -c ${dir} ${pane(second)}`, `\\; set-option -p ${AGENT_OPTION} ${second}`]),
    // set-option takes no `=` exact-match target; the session was just made under this exact name
    `\\; set-option -t ${shellWord(name)} ${OWNER_OPTION} ${shellWord(String(ws.createdAt))}`,
    ...sessionSetup(name, [`${name}:peers`], false, ws.name ?? '').map(args => `\\; ${args.map((a, i) => (i === 0 ? a : shellWord(a))).join(' ')}`),
  ].join(' ')
  return o.attach === false ? create : `${create}; ${tmux} attach -t ${shellWord(`=${name}`)}`
}

/** `tmux list-panes -a -F PANES_FORMAT`: one line per pane. */
export const PANES_FORMAT = `#{session_name}\t#{window_name}\t#{pane_tty}\t#{pane_id}\t#{${AGENT_OPTION}}\t#{${OWNER_OPTION}}`
/** `tmux list-clients -F CLIENTS_FORMAT`: one line per attached terminal. */
export const CLIENTS_FORMAT = '#{session_name}\t#{client_tty}'

/**
 * Which tmux pane each tty is: tty (`ttys012`) → its session, its agent (the
 * pane's mark, or else its window's name, as workspaces made before the
 * mark had a window per agent), the pane's id (`%12`) and its session's
 * owner mark (OWNER_OPTION: '' for none; unset when the line does not say).
 */
export function parsePanes(stdout: string): Record<string, { session: string; window: string; pane: string; owner?: string }> {
  const panes: Record<string, { session: string; window: string; pane: string; owner?: string }> = {}
  for (const line of stdout.split('\n')) {
    const [session, window, tty, pane = '', agent = '', ...rest] = line.split('\t')
    if (session && window !== undefined && tty?.startsWith('/dev/')) panes[tty.slice(5)] = { session, window: agent || window, pane, ...(rest.length === 0 ? {} : { owner: rest[0]! }) }
  }
  return panes
}

/** Whether a pane is part of a workspace's own session: its session's name, and its owner mark when the pane says it. */
export const isOwnPane = (ws: Pick<Workspace, 'id' | 'createdAt'>, p: { session: string; owner?: string }) =>
  p.session === tmuxName(ws) && (p.owner === undefined || p.owner === String(ws.createdAt))

/** `tmux list-panes -s -t =<session> -F PANE_STATE_FORMAT`: each pane's terminal, its process, what is in front, its start command. */
export const PANE_STATE_FORMAT = '#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_start_command}'
export type PaneState = { tty: string; pid: number; command: string; start: string }
/** The panes PANE_STATE_FORMAT lists (tty without `/dev/`; a pid that is not one, NaN). */
export function paneStates(listed: string): PaneState[] {
  return listed.split('\n').filter(line => line.trim() !== '').map(line => {
    const [tty = '', pid = '', command = '', start = ''] = line.split('\t')
    return { tty: tty.replace(/^\/dev\//, ''), pid: /^\d+$/.test(pid) ? Number(pid) : NaN, command, start }
  })
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'])
/** Whether a program in front of a pane is a shell (a login shell's name may start with `-`). */
export const isShellCommand = (command: string) => SHELLS.has(command.replace(/^-/, ''))
/** Whether nothing runs in a pane: a shell in front, and no process under it (`parents`: ps -ax -o ppid=). */
export const isQuietPane = (p: PaneState, parents: ReadonlySet<number>) => Number.isInteger(p.pid) && !parents.has(p.pid) && isShellCommand(p.command)

/**
 * Whether a tmux session under a workspace's name holds only empty shells, as
 * a session restore (tmux-resurrect, after a restart) brings one back: no
 * owner mark (`owner`), and every pane (`listed`, PANE_STATE_FORMAT) started
 * with no command, with nothing running in it (isQuietPane). Nothing runs
 * there, so it may be ended and the workspace started again.
 */
export function isLeftover(owner: string, listed: string, parents: ReadonlySet<number>): boolean {
  if (owner !== '') return false
  const panes = paneStates(listed)
  return panes.length > 0 && panes.every(p => p.start === '' && isQuietPane(p, parents))
}

/** `ps -ax -o ppid=`: the processes that have a process under them. */
export const parentsFrom = (stdout: string) => new Set(stdout.split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))

/** The terminals attached to each tmux session: session → ttys. */
export function parseClients(stdout: string): Record<string, string[]> {
  const clients: Record<string, string[]> = {}
  for (const line of stdout.split('\n')) {
    const [session, tty] = line.split('\t')
    if (session && tty?.startsWith('/dev/')) (clients[session] ??= []).push(tty.slice(5))
  }
  return clients
}

/**
 * The environments on this machine: the default ('') always, and each
 * `<env>` with both a Claude config directory (`.claude-<env>`) and a Codex
 * home (`.codex-<env>`), so neither agent starts on a config that is not
 * there. `isProfile` says whether a directory is one.
 */
export function envsFrom(dirNames: readonly string[], isProfile: (dirName: string) => boolean): string[] {
  const sides = new Map<string, Set<string>>()
  for (const name of dirNames) {
    const m = /^\.(claude|codex)-([a-z0-9][a-z0-9_.-]*)$/i.exec(name)
    if (m !== null && isProfile(name)) sides.set(m[2]!, (sides.get(m[2]!) ?? new Set()).add(m[1]!.toLowerCase()))
  }
  // `default` is the word for ~/.claude and ~/.codex, so a pair named so is never offered
  const named = [...sides].filter(([env, tools]) => env.toLowerCase() !== 'default' && tools.has('claude') && tools.has('codex')).map(([env]) => env)
  return ['', ...named.sort((a, b) => a.localeCompare(b))]
}

/** A session's lasting id for assigning it: `claude:<session id>` or `codex:<thread id>`. */
export const MEMBER_ID = /^(claude|codex):[A-Za-z0-9-]{1,64}$/

/** The workspaces file, if it is one. */
export function workspacesFrom(raw: unknown): Workspace[] {
  const list = (raw as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(list)) return []
  return list.filter((ws): ws is Workspace => {
    const o = ws as Partial<Workspace> | null
    return typeof o === 'object' && o !== null && typeof o.id === 'string' && /^[a-z0-9-]{1,40}$/.test(o.id) &&
      typeof o.name === 'string' && typeof o.env === 'string' && typeof o.dir === 'string' && o.dir.startsWith('/') &&
      typeof o.createdAt === 'number' && (o.checkout === undefined || (typeof o.checkout === 'string' && o.checkout.startsWith('/'))) &&
      (o.purpose === undefined || typeof o.purpose === 'string')
  }).map(ws => {
    // a member this does not read (a hand edit, a later format) is kept as it is and never costs the workspace
    const members: unknown[] | undefined = Array.isArray(ws.members) ? ws.members : undefined
    // a conversation to resume is run: one this does not read is dropped, and that agent starts new
    const claude = threadFrom((ws.threads as Record<string, unknown> | undefined)?.claude)
    const codex = threadFrom((ws.threads as Record<string, unknown> | undefined)?.codex)
    // a compaction setting this does not read is left out: the default stands; one of the earlier percent lines
    // (`compactAt`) only as off
    const legacy = (ws as { compactAt?: unknown }).compactAt
    const compactFrom = Number.isInteger(ws.compactFrom) && ws.compactFrom! >= 0 && ws.compactFrom! <= 10_000_000 ? ws.compactFrom : legacy === 0 ? 0 : undefined
    // Claude's last compaction at a hand-off (one this does not read is dropped)
    const c = (ws as { compacted?: unknown }).compacted as { at?: unknown; tokens?: unknown; isChecked?: unknown } | undefined
    const compacted = typeof c === 'object' && c !== null && Number.isFinite(c.at) && Number.isFinite(c.tokens) && typeof c.isChecked === 'boolean'
      ? { at: c.at as number, tokens: c.tokens as number, isChecked: c.isChecked }
      : undefined
    // likewise the drift check's interval, and its last verdict (one this does not read is dropped)
    const checkEvery = checkEveryFrom(ws.checkEvery)
    const check = checkFrom(ws.check)
    // and the main problem its Claude last said (one this does not read is dropped)
    const problem = problemFrom(ws.problem)
    // an agent this does not read is dropped: Claude and Codex both start
    const only = ws.only === 'claude' || ws.only === 'codex' ? ws.only : undefined
    // a branch only as git names one (it is shown, never run)
    const branch = branchFrom(ws.branch)
    const { members: _, threads: __, compactAt: ___, compactFrom: ________, compacted: _________, checkEvery: ____, check: _____, only: ______, branch: _______, problem: __________, ...rest } = ws as Workspace & { compactAt?: unknown }
    return {
      ...rest,
      ...(members !== undefined && members.length > 0 ? { members } : {}),
      ...(claude === undefined && codex === undefined ? {} : { threads: { ...(claude === undefined ? {} : { claude }), ...(codex === undefined ? {} : { codex }) } }),
      ...(compactFrom === undefined ? {} : { compactFrom }),
      ...(compacted === undefined ? {} : { compacted }),
      ...(checkEvery === undefined ? {} : { checkEvery }),
      ...(check === undefined ? {} : { check }),
      ...(problem === undefined ? {} : { problem }),
      ...(only === undefined ? {} : { only }),
      ...(branch === undefined ? {} : { branch }),
    }
  })
}

/**
 * A branch's name, if git's rules for one allow it (git check-ref-format:
 * no `..`, `@{`, `//`, part starting with `.`, ending `/`, `.` or `.lock`,
 * nor `@` alone) and it shows as it is: no space, no control or format
 * character (Unicode Cc, Cf: direction marks, zero widths, tag characters)
 * and none Unicode says to ignore in display; at most 200 characters, not
 * starting with a dash.
 */
export function branchFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}~^:?*[\\]{1,200}$/u.test(raw)) return undefined
  const isGits = !raw.startsWith('-') && raw !== '@' && !raw.includes('..') && !raw.includes('@{') && !raw.includes('//') &&
    !raw.endsWith('/') && !raw.endsWith('.') && !raw.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
  return isGits ? raw : undefined
}

/** The list with `member` assigned to the workspace `id` only, or to none when `id` is ''. */
export function assigned(list: readonly Workspace[], member: string, id: string): Workspace[] {
  return list.map(ws => {
    const others = (ws.members ?? []).filter(m => m !== member)
    const members = ws.id === id ? [...others, member] : others
    const { members: _, ...rest } = ws
    return members.length > 0 ? { ...rest, members } : rest
  })
}

/**
 * The main checkout of the repository holding the folder "$1", printed as
 * `ok <path>` after making its worktrees folder beside it
 * (`<checkout>-worktrees`), where the agents put each branch's worktree; or
 * `error: not-a-repo` / `error: no-main`. From the main checkout that is its
 * top folder (so a submodule or a separate git dir is placed right); from a
 * linked worktree, the checkout its shared git dir belongs to. The
 * repository's own hooks and fsmonitor never run, as when git is run
 * directly.
 */
export const CHECKOUT_SCRIPT = [
  'dir=$1',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"; }',
  'top=$(g -C "$dir" rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] || { echo "error: not-a-repo"; exit 11; }',
  'own=$(g -C "$dir" rev-parse --path-format=absolute --git-dir) || exit 11',
  'common=$(g -C "$dir" rev-parse --path-format=absolute --git-common-dir) || exit 11',
  'main=',
  'if [ "$own" = "$common" ]; then main=$top',
  'else',
  '  wt=$(g --git-dir="$common" config --get core.worktree)',
  '  if [ -n "$wt" ]; then main=$(cd "$common" && cd "$wt" && pwd -P)',
  '  elif [ "$(basename "$common")" = .git ]; then main=$(dirname "$common")',
  '  fi',
  'fi',
  'case $main in /*) ;; *) echo "error: no-main"; exit 15;; esac',
  'mkdir -p "$main-worktrees" || exit 16',
  `printf 'ok %s\\n' "$main"`,
].join('\n')

/**
 * CHECKOUT_SCRIPT's answer: the main checkout, or why there is none, said for a person; `isOutside` when the folder is
 * in no git repository (the agents then work in the one the purpose concerns, as they find in getting ready).
 */
export function checkoutResult(stdout: string): { checkout: string } | { error: string; isOutside?: boolean } {
  const line = stdout.trim().split('\n').pop() ?? ''
  if (line.startsWith('ok /')) return { checkout: line.slice(3) }
  if (line === 'error: not-a-repo') return { error: 'that folder is not in a git checkout; peer coding works on a git repository', isOutside: true }
  if (line === 'error: no-main') return { error: 'git cannot tell where this repository\'s main checkout is; pick the main checkout' }
  return { error: 'its worktrees folder could not be made beside the repository' }
}

/**
 * The worktrees of the repository holding the folder "$1", as `git worktree
 * list --porcelain -z` prints them (parseWorktrees reads them): each field
 * ends with a NUL, each worktree with one more, so no folder's name can
 * pass for a field. With git's settings as the other scripts here set them.
 */
export const WORKTREES_SCRIPT = 'git -c core.hooksPath=/dev/null -c core.fsmonitor= -C "$1" worktree list --porcelain -z'

/**
 * The branches a workspace can go on with: each linked worktree (not the
 * main checkout, the first listed) with a branch checked out, there and
 * not about to be pruned.
 */
export function parseWorktrees(stdout: string): { path: string; branch: string }[] {
  const blocks = stdout.split('\0\0').map(b => b.split('\0').filter(Boolean)).filter(b => b.length > 0)
  return blocks.slice(1).flatMap(lines => {
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9)
    const branch = branchFrom(lines.find(l => l.startsWith('branch refs/heads/'))?.slice(18))
    if (path === undefined || !path.startsWith('/') || branch === undefined || lines.some(l => l === 'bare' || l.startsWith('prunable'))) return []
    return [{ path, branch }]
  })
}

/**
 * Where the folder "$1" is in its repository, one line each: `main` (the
 * main checkout, or in it) or `linked` (a linked worktree); the branch
 * checked out there by its short name (empty for a detached HEAD); and the
 * repository's default branch as its origin names it (empty if unknown).
 * Nothing outside git.
 */
export const BRANCH_SCRIPT = [
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"; }',
  'own=$(g -C "$1" rev-parse --path-format=absolute --git-dir) || exit 1',
  'common=$(g -C "$1" rev-parse --path-format=absolute --git-common-dir) || exit 1',
  'if [ "$own" = "$common" ]; then echo main; else echo linked; fi',
  'b=$(g -C "$1" symbolic-ref --short -q HEAD); echo "$b"',
  'd=$(g -C "$1" symbolic-ref --short -q refs/remotes/origin/HEAD); echo "${d#origin/}"',
].join('\n')

/**
 * BRANCH_SCRIPT's answer, undefined outside git: whether the folder is the
 * main checkout, its branch, and whether that branch is the repository's
 * default one.
 */
export function headOf(stdout: string): { isMain: boolean; branch?: string; isDefault: boolean } | undefined {
  const [where, name = '', byOrigin = ''] = stdout.split('\n')
  if (where !== 'main' && where !== 'linked') return undefined
  const branch = branchFrom(name)
  return { isMain: where === 'main', ...(branch === undefined ? {} : { branch }), isDefault: branch !== undefined && branch === branchFrom(byOrigin) }
}

/**
 * How a workspace's agents work, to spend fewer tokens at the same quality:
 * every request re-reads the whole conversation, so fewer, fuller requests
 * and less output cost less. A pair hands over at milestones too, as far as
 * the peer-coding rules leave a turn's size to it. Claude has it in its
 * system prompt (`--append-system-prompt`), which no compaction drops; one
 * brought in also in its first prompt, as a conversation keeps the system
 * prompt it began with until it compacts (Claude Code's system-prompt
 * snapshot). Codex has it in its first prompt, which its compactions keep.
 * It also asks them to need the owner as little as they can (the owner: "less need of the user, and whenever the user
 * is requested, consider if this can be avoided the next time"): what the work settles they decide, and an ask comes
 * with what would let them skip it next time.
 */
export function leanWork(isPair: boolean): string {
  return [
    'Work lean here: every request re-reads this whole conversation, so fewer, fuller steps and less output cost less.',
    ...(isPair ? ['Hand over at milestones, a complete piece of the purpose your peer can review, not after each small step, as far as the peer-coding rules leave that to you.'] : []),
    'Make independent reads and checks in one step (several tool calls at once, or one command).',
    'Read the part of a file you need, and not again unless it changed.',
    isPair
      ? 'Run a test suite once per set of changes, saving its full output where the peer-coding rules keep evidence and printing only its failures and summary.'
      : 'Run a test suite once per set of changes, printing only its failures and summary.',
    'Between steps, write one short line at most, and only when your direction changes.',
    'Need the owner as little as you can: what the request, the code, the project rules or a sound default already settle, decide yourself, say your choice in one line and go on.',
    `When only the owner can decide, ask${isPair ? ' with NEEDS USER' : ''}, and add one line on what would let you skip such a question next time (a rule, a saved default, a check); put that in place yourself when it is yours to do.`,
    'Never skip a check, a test or a review to save tokens.',
  ].join(' ')
}

/** Where a branch's own worktree goes: beside the repository's main checkout. */
const worktreesOf = (ws: Pick<Workspace, 'checkout'>) =>
  ws.checkout === undefined ? 'the worktrees folder beside the repository\'s main checkout (<checkout>-worktrees/)' : `${ws.checkout}-worktrees/`

/**
 * Step 1 of a first prompt for peer coding: the repository set up for it; in a workspace whose folder is in no
 * repository, the one the work is in, found first.
 */
const setUpStep = (ws: Pick<Workspace, 'checkout' | 'dir'>) =>
  ws.checkout === undefined
    ? `1. The workspace's folder, ${ws.dir}, is in no git repository: work in the repository the purpose concerns (the one your work above is in, if any). If it is not set up for peer coding in the current layout, set it up. Record the owner's decisions you already know and ask for the rest with NEEDS USER.`
    : '1. If this repository is not set up for peer coding in the current layout, set it up. Record the owner\'s decisions you already know and ask for the rest with NEEDS USER.'

/**
 * The steps of a new Claude whose peer, Codex, has the work under way, in a workspace whose folder is in no repository:
 * Claude has no work of its own to tell which repository it is, so it asks Codex before it sets anything up.
 */
const askCodexFirst = (ws: Pick<Workspace, 'dir'>) => [
  // (the rules' cue needs a repository set up for peer coding: this question is a line of Claude's own, which the relay
  // passes as it is)
  `1. The workspace's folder, ${ws.dir}, is in no git repository, and the work under way is Codex's: find out from Codex first which repository and branch it is in. Set nothing up yet, and end your turn with exactly this line, which the relay passes to Codex: ${ASK_WHERE}`,
  '2. Codex answers with a line naming them (READY FOR CLAUDE · <repository> · <branch>). Then, if that repository is not set up for peer coding in the current layout, set it up (record the owner\'s decisions you already know and ask for the rest with NEEDS USER); go on with Codex\'s branch there, or start one for this purpose (named from the purpose by the settings\' branch naming, never from the workspace\'s name) in its own worktree beside the repository\'s main checkout (<checkout>-worktrees/); make your alignment move for that branch and end your turn with the line the rules\' cue prints.',
]
/** A new Claude's question to a Codex whose work is under way, in a workspace whose folder is in no repository. */
export const ASK_WHERE = 'READY FOR CODEX · which repository and branch is your work in?'
/** What that Codex is told to answer: one line naming them, which the relay passes to Claude. */
const ANSWER_WHERE = `Claude, new here, will first ask which repository and branch your work is in, as the workspace's folder is in no git repository ("${ASK_WHERE}"): answer with one line naming them, READY FOR CLAUDE · <the repository's folder> · <the branch>, then wait for Claude's hand-off.`
/** Whether a new Claude asks its Codex where the work is first (askCodexFirst): no repository and no branch chosen. */
const isAskedWhere = (ws: Pick<Workspace, 'checkout' | 'branch'>) => ws.checkout === undefined && ws.branch === undefined

/** Step 2 of a first prompt when the owner chose the branch: go on with it there, and start no other. */
const goOnStep = (ws: Pick<Workspace, 'branch' | 'dir'>) =>
  `Go on with the branch the owner chose, ${ws.branch}, in its worktree ${ws.dir}: the work there is under way. Start no other branch.`

/**
 * Claude's first prompt in a workspace made for a purpose: get peer coding
 * ready under the peer-coding rules, on a branch named for the purpose (the
 * workspace's name is the owner's label only), and hand over by its cue,
 * which the workspace's relay passes on.
 */
export function setupPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'threads' | 'branch' | 'dir'>): string {
  // a Codex brought in has work of its own: Claude gets ready with it, asking where it stands
  const isBrought = ws.threads?.codex !== undefined
  const codex = isBrought ? 'Codex runs in the pane beside you, in its own conversation, which the owner brought in' : 'Codex runs in the pane beside you'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `You are Claude, one of two peers here; ${codex}. ${RELAY_FOR_CLAUDE}`,
    '',
    'Get the workspace ready for peer coding, using the peer-coding skill and the rules it leads to:',
    ...(isBrought && isAskedWhere(ws)
      ? askCodexFirst(ws)
      : [
          setUpStep(ws),
          ws.branch !== undefined
            ? `2. ${goOnStep(ws)}`
            : `2. ${isBrought ? 'If Codex\'s work is on a branch, go on with it (ask Codex in your alignment brief if the repository does not show which). Otherwise start' : 'Start'} a branch for this purpose: name it from the purpose by the settings' branch naming, never from the workspace's name, in its own worktree in ${worktreesOf(ws)}.`,
          `3. Make your alignment move for that branch${isBrought ? ', asking Codex where its work stands,' : ''} and end your turn with the line the rules' cue prints.`,
        ]),
  ].join('\n')
}

/**
 * What a pair made with conversations brought in is for, when the owner says nothing: going on with the work under
 * way there, the one brought in bringing a new peer up to speed.
 */
export function chatsPurpose(brought: readonly ('claude' | 'codex')[]): string {
  const NAME = { claude: 'Claude', codex: 'Codex' } as const
  const [one] = brought
  if (brought.length >= 2 || one === undefined) return 'Going on with the work under way in Claude\'s and Codex\'s conversations, both brought in.'
  return `Going on with the work under way in ${NAME[one]}'s conversation, brought in; ${NAME[one]} brings ${NAME[one === 'claude' ? 'codex' : 'claude']} up to speed.`
}

/**
 * Codex's first prompt in a workspace made for a purpose: who it is, that
 * Claude is getting things ready, and that the relay will bring Claude's
 * hand-off, and how to work (leanWork). Its short answer is its first
 * finished turn, which the relay waits for before it types anything into
 * Codex's pane.
 */
export function peerPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'threads'>): string {
  const claude = ws.threads?.claude === undefined ? 'Claude runs in the pane beside you' : 'Claude runs in the pane beside you, in its own conversation, which the owner brought in,'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `You are Codex, one of two peers here; ${claude} and is getting peer coding ready now, under the peer-coding rules. ${RELAY_FOR_CODEX}`,
    '',
    leanWork(true),
    '',
    'Nothing to do until then: reply with one short line saying you are ready.',
  ].join('\n')
}

const RELAY_FOR_CLAUDE = 'The owner turned on this workspace\'s relay, which stands in for the owner\'s copy and paste: when your turn ends with a peer-coding cue line (READY FOR CODEX, NEEDS USER or SCOPE CLOSED), it types that exact line into Codex\'s chat, or tells the owner. The owner still answers every NEEDS USER.'
const RELAY_FOR_CODEX = 'The owner turned on this workspace\'s relay, which stands in for the owner\'s copy and paste: Claude\'s hand-off line (READY FOR CODEX · …) will be typed here when Claude\'s turn ends, and when your turn ends with a cue line the relay passes it to Claude or tells the owner.'

/**
 * The first prompt of an agent whose conversation the owner brought into a
 * workspace made for a purpose: it keeps everything it knows and goes on as
 * a peer under the peer-coding rules. Claude gets peer coding ready (going on
 * with a branch the work already has) and tells Codex where the work stands;
 * Codex waits for that hand-off, then adds what its own work knows.
 */
export function joinPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'threads' | 'branch' | 'dir'>, tool: 'claude' | 'codex'): string {
  const moved = 'The owner moved this conversation into the workspace: everything above stays yours.'
  if (tool === 'codex') {
    const claude = ws.threads?.claude === undefined ? 'Claude runs in the pane beside you' : 'Claude runs in the pane beside you, in its own conversation, brought in too,'
    return [
      `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
      '',
      `${moved} You are Codex, one of two peers here; ${claude} and is getting peer coding ready now, under the peer-coding rules. ${RELAY_FOR_CODEX}`,
      '',
      leanWork(true),
      '',
      `Nothing to do until then: reply with one short line saying you are ready.${ws.threads?.claude === undefined && isAskedWhere(ws) ? ` ${ANSWER_WHERE}` : ''} When Claude's hand-off comes, align with it, and add what you know from your own work above that it does not say.`,
    ].join('\n')
  }
  const codex = ws.threads?.codex === undefined ? 'Codex runs in the pane beside you, starting new' : 'Codex runs in the pane beside you, in its own conversation, brought in too'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `${moved} You are Claude, one of two peers here; ${codex}. ${RELAY_FOR_CLAUDE}`,
    '',
    leanWork(true),
    '',
    'From here, work as a peer under the peer-coding rules, using the peer-coding skill:',
    setUpStep(ws),
    ws.branch !== undefined
      ? `2. ${goOnStep(ws)} Work of yours not committed yet stays where it is: ask the owner with NEEDS USER before moving any of it.`
      : `2. If the work above already has a peer-coding branch, go on with it. Otherwise start one for this purpose: name it from the purpose by the settings' branch naming, never from the workspace's name, in its own worktree in ${worktreesOf(ws)}. Work of yours not committed yet stays where it is: ask the owner with NEEDS USER before moving any of it.`,
    '3. Make your alignment move for that branch, telling Codex where the work stands, and end your turn with the line the rules\' cue prints.',
  ].join('\n')
}

/**
 * The first prompts when the owner adds the other agent to a workspace of one,
 * made for a purpose: for `tool`, the agent that `isNew` joins now (resuming
 * its own conversation when `isBrought`), or the one that worked there alone
 * (going on with its conversation). Either way Claude gets peer coding ready,
 * going on with a branch the work already has, and Codex waits for its
 * hand-off; the one that was there tells, or is asked, where the work stands.
 */
export function addedPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'branch' | 'dir'>, tool: 'claude' | 'codex', o: { isNew: boolean; isBrought: boolean }): string {
  const other = tool === 'claude' ? 'Codex' : 'Claude'
  const was = o.isNew
    ? `${o.isBrought ? 'The owner moved this conversation into the workspace: everything above stays yours. ' : ''}You join ${other}, who has worked here alone until now: you are one of two peers from here, ${other} in the pane beside you.`
    : `The owner added ${tool === 'claude' ? 'Codex' : 'Claude'} to this workspace, ${o.isBrought ? 'in its own conversation, brought in from elsewhere' : 'starting new'}: you no longer work here alone, but as one of two peers, ${other} in the pane beside you.`
  const head = [`This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`, '']
  if (tool === 'codex') {
    return [
      ...head,
      `${was} Claude is getting peer coding ready now, under the peer-coding rules. ${RELAY_FOR_CODEX}`,
      '',
      leanWork(true),
      '',
      `Nothing to do until then: reply with one short line saying you are ready.${!o.isNew && !o.isBrought && isAskedWhere(ws) ? ` ${ANSWER_WHERE}` : ''} When Claude's hand-off comes, align with it${o.isNew && !o.isBrought ? '.' : `, and add what you know from ${o.isNew ? 'your own work above' : 'your work here'} that it does not say.`}`,
    ].join('\n')
  }
  const known = o.isNew ? 'the work Codex has done here' : 'your work here'
  return [
    ...head,
    `${was} ${RELAY_FOR_CLAUDE}`,
    '',
    leanWork(true),
    '',
    'From here, work as a peer under the peer-coding rules, using the peer-coding skill:',
    // (a new Claude with no work of its own, in a folder in no repository: Codex says which one first)
    ...(o.isNew && !o.isBrought && isAskedWhere(ws)
      ? askCodexFirst(ws)
      : [
          setUpStep(ws),
          ws.branch !== undefined
            ? `2. ${goOnStep(ws)}`
            : `2. If ${known} is on a branch, go on with it${o.isNew ? ' (ask Codex in your alignment brief if the repository does not show which)' : ''}. Otherwise start one for this purpose: name it from the purpose by the settings' branch naming, never from the workspace's name, in its own worktree in ${worktreesOf(ws)}.${o.isNew && !o.isBrought ? '' : ' Work not committed yet stays where it is: ask the owner with NEEDS USER before moving any of it.'}`,
          `3. Make your alignment move for that branch, ${o.isNew ? 'asking Codex where its work stands' : 'telling Codex where the work stands'}, and end your turn with the line the rules' cue prints.`,
        ]),
  ].join('\n')
}

/**
 * The first prompt of a workspace's one agent, made for a purpose: with no
 * peer and no relay there is no peer coding; it gets ready on a branch for
 * the purpose (going on with one already under way), says where things stand
 * and waits for the owner. One brought in keeps everything it knows.
 */
export function soloPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'threads' | 'branch' | 'dir'>, tool: 'claude' | 'codex'): string {
  const isBrought = ws.threads?.[tool] !== undefined
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `${isBrought ? 'The owner moved this conversation into the workspace: everything above stays yours. ' : ''}You are ${tool === 'claude' ? 'Claude' : 'Codex'}, the only agent here: the owner chose to work with you alone, so there is no peer and no relay, and the owner gives you each next step.`,
    '',
    // a new Claude has it in its system prompt
    ...(tool === 'codex' || isBrought ? [leanWork(false), ''] : []),
    'Get ready for this purpose:',
    ws.branch !== undefined
      ? `1. ${goOnStep(ws)}${isBrought ? ' Work of yours not committed yet stays where it is: ask the owner before moving any of it.' : ''}`
      : isBrought
      ? `1. If the work above already has a branch, go on with it. Otherwise start one for this purpose: name it from the purpose, never from the workspace's name, in its own worktree in ${worktreesOf(ws)}. Work of yours not committed yet stays where it is: ask the owner before moving any of it.`
      : `1. If the purpose names a branch or worktree already under way, go on there. Otherwise start a branch for this purpose: name it from the purpose, never from the workspace's name, in its own worktree in ${worktreesOf(ws)}.`,
    '2. Say in a few lines where things stand and what you would do first, then wait for the owner.',
  ].join('\n')
}

/**
 * The git repositories in the home folder, as their main checkouts (a `.git`
 * folder; a worktree or submodule has a `.git` file), at most five levels
 * down, skipping Library, hidden folders and node_modules; and the branches'
 * worktrees in each worktrees folder (`<checkout>-worktrees/<branch>`, a
 * `.git` file), found by their folder's name, never gone into. Each path
 * ends with a NUL, so no folder's name can pass for another path.
 */
export const PROJECTS_SCRIPT = [
  'find "$1" -maxdepth 5 \\( -name Library -o -name node_modules -o -name .Trash -o \\( -name ".*" ! -name .git \\) \\) -prune',
  // a worktrees folder and a .git folder are printed, never gone into
  '  -o -type d -name "*-worktrees" -print0 -prune -o -type d -name .git -print0 -prune 2>/dev/null |',
  `  xargs -0 /bin/sh -c 'for p; do case $p in */.git) printf "%s\\0" "\${p%/.git}";; *) for w in "$p"/*; do [ -f "$w/.git" ] && printf "%s\\0" "$w"; done;; esac; done' sh`,
].join(' ')

/**
 * Where the path "$1" (a folder, or a file in one) is in git: its worktree's
 * top folder and the repository's main checkout, each ended by a NUL, then
 * the repository's worktrees as WORKTREES_SCRIPT prints them. The main
 * checkout is found as CHECKOUT_SCRIPT finds it (a submodule's or a separate
 * git dir's own checkout, never its git folder); nothing (exit 11) outside a
 * repository, nor (exit 15) where git cannot tell its main checkout (a bare
 * repository's, a separate git dir's worktree). With git's settings as the
 * other scripts here set them.
 */
export const WHERE_SCRIPT = [
  'd=$1',
  '[ -d "$d" ] || d=$(dirname "$d")',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"; }',
  'top=$(g -C "$d" rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] || exit 11',
  'own=$(g -C "$d" rev-parse --path-format=absolute --git-dir) || exit 11',
  'common=$(g -C "$d" rev-parse --path-format=absolute --git-common-dir) || exit 11',
  'main=',
  'if [ "$own" = "$common" ]; then main=$top',
  'else',
  '  wt=$(g --git-dir="$common" config --get core.worktree)',
  '  if [ -n "$wt" ]; then main=$(cd "$common" && cd "$wt" && pwd -P)',
  '  elif [ "$(basename "$common")" = .git ]; then main=$(dirname "$common")',
  '  fi',
  'fi',
  'case $main in /*) ;; *) exit 15;; esac',
  `printf '%s\\0%s\\0' "$top" "$main"`,
  'g -C "$d" worktree list --porcelain -z',
].join('\n')

/**
 * WHERE_SCRIPT's answer: the folder's worktree (`top`), the repository's main
 * checkout (the project), the branches it can go on with (parseWorktrees),
 * and the one whose worktree the path is in, if it is in one of those;
 * undefined outside git.
 */
export function whereFrom(stdout: string): { top: string; checkout: string; worktrees: { path: string; branch: string }[]; goOn?: { path: string; branch: string } } | undefined {
  const [top = '', checkout = '', ...rest] = stdout.split('\0')
  if (!top.startsWith('/') || !checkout.startsWith('/') || rest.length === 0) return undefined
  const worktrees = parseWorktrees(rest.join('\0'))
  const goOn = worktrees.find(w => w.path === top)
  return { top, checkout, worktrees, ...(goOn === undefined ? {} : { goOn }) }
}

/**
 * The path a project field holds, if it names one: as typed (absolute, or from
 * `~/`), or the path in brackets an editor shows after a file's name
 * (`README.md (shop-worktrees/x/docs/README.md)`); undefined for a search word.
 * `relative` is true for one that is neither absolute nor from `~/`.
 */
export function typedPath(typed: string): { path: string; isRelative: boolean } | undefined {
  const whole = typed.trim()
  // a path from the root or home is whole, brackets and all; only another may be an editor's `name (path)`
  const isRooted = whole.startsWith('/') || whole === '~' || whole.startsWith('~/')
  const text = (isRooted ? whole : (/\(([^()]+)\)\s*$/.exec(whole)?.[1] ?? whole)).trim().replace(/^\.\//, '')
  if (text === '' || !text.includes('/')) return undefined
  return { path: text.replace(/\/+$/, '') || '/', isRelative: !text.startsWith('/') && text !== '~' && !text.startsWith('~/') }
}

/**
 * The projects to offer, best first: those with a session active most
 * recently (in the checkout, under it or in its worktrees folder), then the
 * rest by path. `query` keeps those whose path holds it, in any case.
 */
export function rankProjects(
  paths: readonly string[],
  activity: readonly { cwd: string; at: number }[],
  query: string,
  home: string,
  max = 8,
): { path: string; label: string }[] {
  const latest = (path: string) =>
    Math.max(0, ...activity.filter(a => a.cwd === path || a.cwd.startsWith(`${path}/`) || a.cwd.startsWith(`${path}-worktrees/`)).map(a => a.at))
  const label = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
  const want = query.trim().toLowerCase().replace(/^~\//, '')
  return [...new Set(paths)]
    .filter(path => want === '' || label(path).toLowerCase().includes(want))
    .map(path => ({ path, at: latest(path) }))
    .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
    .slice(0, max)
    .map(({ path }) => ({ path, label: label(path) }))
}
