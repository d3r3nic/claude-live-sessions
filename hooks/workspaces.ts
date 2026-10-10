// Workspaces: named projects, each a folder, an environment and one tmux
// session running its agents. Pure: no `$`, so the tests drive it directly.
import type { Workspace } from '../types'
import { threadFrom } from './bring'

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
  | { action: 'new'; dir: string; env: string; name: string; purpose: string }
  | { action: 'open' | 'rm'; ref: string }
  | { action: 'help'; error?: string }

/**
 * `/workspace` arguments: `new <folder> <env> <name> [--for <purpose>]`,
 * `open <name>`, `rm <name>`, or nothing to list. `<env>` is required and
 * must be one of `envs` or `default`: a misspelt one is an error, never
 * another account. `~` in the folder is the home directory. Every word after
 * `--for` is the purpose.
 */
export function parseWorkspaceArgs(args: string, envs: readonly string[], home: string): WorkspaceCommand {
  const [verb = '', ...rest] = words(args)
  if (verb === '' || verb === 'list') return { action: 'list' }
  if (verb === 'open' || verb === 'rm') {
    return rest.length > 0 ? { action: verb, ref: rest.join(' ') } : { action: 'help', error: `say which workspace to ${verb}` }
  }
  if (verb !== 'new') return { action: 'help', error: `"${verb}" is not one of new, open, rm, list` }
  const [folder = '', envWord = '', ...afterEnv] = rest
  const at = afterEnv.indexOf('--for')
  const nameWords = at >= 0 ? afterEnv.slice(0, at) : afterEnv
  const purpose = at >= 0 ? afterEnv.slice(at + 1).join(' ').trim() : ''
  if (at >= 0 && purpose === '') return { action: 'help', error: '--for needs what the workspace is for' }
  const option = nameWords.find(word => word.startsWith('--'))
  if (option !== undefined) return { action: 'help', error: `"${option}" is not an option /workspace takes` }
  const name = nameWords.join(' ').trim()
  if (folder === '' || envWord === '' || name === '') return { action: 'help', error: 'new needs a folder, an environment and a name' }
  if (envWord !== 'default' && !envs.includes(envWord)) return { action: 'help', error: `there is no environment "${envWord}"` }
  const env = envWord === 'default' ? '' : envWord
  const dir = absoluteDir(folder, home)
  if (dir === undefined) return { action: 'help', error: 'the folder must be absolute or start with ~/' }
  return { action: 'new', dir, env, name, purpose }
}

/** A folder as typed, as an absolute path: `~` and `~/...` are the home directory; anything else relative, undefined. */
export function absoluteDir(typed: string, home: string): string | undefined {
  const text = typed.trim()
  const dir = text === '~' ? home : text.startsWith('~/') ? `${home}${text.slice(1)}` : text
  return dir.startsWith('/') ? dir.replace(/\/+$/, '') || '/' : undefined
}

/** The workspace `ref` names: its id, or its name in any case. */
export const findWorkspace = (list: readonly Workspace[], ref: string) =>
  list.find(ws => ws.id === ref) ?? list.find(ws => ws.name.toLowerCase() === ref.trim().toLowerCase())

/** A string as one shell word. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
export const shellQuote = shellWord

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
 * offer, whose default answer on Enter installs a new version, and in the
 * sandbox it uses for a trusted project (workspace-write), which lets it
 * write in the worktrees folder too; its approvals stay as configured.
 * An agent with a conversation to resume (`threads`) resumes it, from the
 * folder it ran in, with the flags that keep its permissions.
 */
function paneScript(tool: 'claude' | 'codex', ws: Pick<Workspace, 'id' | 'env' | 'checkout' | 'threads'>, home: string, bin?: string): string {
  // (an id from the workspaces file reaches the line only as threadFrom read it: letters, digits, dashes)
  const thread = ws.threads?.[tool]
  const addDir = ws.checkout === undefined ? '' : ` --add-dir ${shellWord(`${ws.checkout}-worktrees`)}`
  const prompt = shellWord(promptPath(home, ws.id, tool))
  const flags = (thread?.flags ?? []).map(f => ` ${shellWord(f)}`).join('')
  const start = agentStart(tool, ws.env, home, bin)
  const agent =
    thread === undefined
      ? `${start}${tool === 'codex' ? ` ${UPDATE_OFF} --sandbox workspace-write` : ''}${addDir} \${p:+--} \${p:+"$p"}`
      : tool === 'claude'
        // a Claude conversation is kept under the folder it started in: resumed from there, unless a live Claude
        // session has it open (its registry entry, its process there): then it says so and leaves a shell
        ? `open=; for f in ${shellWord(`${home}/.claude${ws.env === '' ? '' : `-${ws.env}`}`)}/sessions/*.json; do grep -q '"sessionId":"${thread.id}"' "$f" 2>/dev/null && kill -0 "$(basename "$f" .json)" 2>/dev/null && open=1; done; ` +
          `if [ -n "$open" ]; then echo 'This conversation is open in another Claude session; close it there, then open the workspace again.'; ` +
          `else cd ${shellWord(thread.dir)} && ${start} --resume ${thread.id}${flags}${addDir} \${p:+--} \${p:+"$p"}; fi`
        : `${start} resume ${UPDATE_OFF}${thread.flags?.includes('--sandbox') === true ? '' : ' --sandbox workspace-write'}${flags}${addDir} -C ${shellWord(thread.dir)} -- ${thread.id} \${p:+"$p"}`
  const run = `p=$(cat ${prompt} 2>/dev/null) && rm -f ${prompt}; ${agent}`
  return `/bin/sh -c ${shellWord(`${run}; exec "$SHELL" -l`)}`
}
const UPDATE_OFF = '-c check_for_update_on_startup=false'

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
 * agent takes the mouse); and each side's border naming its agent.
 * tmux.conf and other sessions are left as they are.
 */
export function sessionSetup(name: string, windows: readonly string[], canHide = false, title = ''): string[][] {
  return [
    ['set-option', '-t', name, 'mouse', 'on'],
    // the bar's left end: the workspace's own name (tmux reads `#` in it as a format: doubled)
    ...(title === '' ? [] : [['set-option', '-t', name, 'status-left-length', '50'], ['set-option', '-t', name, 'status-left', ` ${title.replace(/#/g, '##')} `]]),
    ['set-option', '-t', name, 'status-right-length', '60'],
    ['set-option', '-t', name, 'status-right', canHide ? HIDE_LABEL : KEEPS_LABEL],
    ...windows.flatMap(window => [
      ['set-window-option', '-t', window, 'pane-border-status', 'top'],
      ['set-window-option', '-t', window, 'pane-border-format', BORDER_FORMAT],
    ]),
  ]
}

/** The status bar's right end, which a click hides the window by (HIDE_RANGE), or, where it cannot, what closing it does. */
export const HIDE_RANGE = 'ls-hide'
export const HIDE_LABEL = `#[range=user|${HIDE_RANGE}]#[reverse] Hide window · agents keep running #[norange default] `
export const KEEPS_LABEL = ' closing this window leaves the agents running '

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
      // where it was and its font, so the workspace opens there again
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

/** Where a workspace window was, as hide.sh keeps it: its position and size (points, from the top left) and font size. */
export type Placement = { x: number; y: number; width: number; height: number; fontSize: number }

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

/** Whether a kept placement still shows: at least a quarter of it on one of the screens there are now. */
export function isOnScreen(place: Placement, screens: readonly Screen[]): boolean {
  const area = place.width * place.height
  return screens.some(s => {
    const w = Math.min(place.x + place.width, s.x + s.width) - Math.max(place.x, s.x)
    const h = Math.min(place.y + place.height, s.y + s.height) - Math.max(place.y, s.y)
    return w > 0 && h > 0 && w * h >= area / 4
  })
}

/**
 * A workspace window's first place: most of the screen (85% of the part
 * the menu bar and Dock leave, centred), in the font size of the window it
 * is opened from, so it never opens small in a profile's larger font.
 */
export function defaultPlacement(screen: Screen, fontSize: number): Placement {
  const width = Math.round(screen.width * 0.85)
  const height = Math.round(screen.height * 0.85)
  return {
    x: Math.round(screen.x + (screen.width - width) / 2),
    y: Math.round(screen.y + (screen.height - height) / 2),
    width,
    height,
    fontSize: fontSize >= 6 && fontSize <= 72 ? Math.round(fontSize) : 0,
  }
}

/**
 * Every screen's free part (Screen), the one in use now (mainScreen: the
 * one with the keyboard's window) first, and the font size of terminal
 * "$1"'s tab (`ttys012`; 0 when no Terminal tab is that terminal): JSON.
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
  const terminal = Application('Terminal')
  if (terminal.running()) {
    const tty = '/dev/' + argv[0]
    for (const w of terminal.windows()) for (const t of w.tabs()) if (t.tty() === tty) fontSize = t.fontSize()
  }
  return JSON.stringify({ screens, fontSize })
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
 * and Codex on the right, in its folder, each pane marked with its agent and
 * leaving a shell when its agent exits), then attaches. Closing that
 * terminal detaches; the agents keep running in tmux. `socket` (a private
 * server that reads no tmux.conf) and `bins` are for tests; `attach: false`
 * only creates.
 */
export function openCommand(
  ws: Pick<Workspace, 'id' | 'env' | 'dir' | 'createdAt' | 'checkout' | 'threads'> & { name?: string },
  home: string,
  o: { socket?: string; bins?: { claude: string; codex: string }; attach?: boolean } = {},
): string {
  // a test's private server reads no tmux.conf: the person's plugins (a session restore) never run in it
  const tmux = o.socket === undefined ? 'tmux' : `tmux -L ${shellWord(o.socket)} -f /dev/null`
  const name = tmuxName(ws)
  const pane = (tool: 'claude' | 'codex') => shellWord(paneScript(tool, ws, home, o.bins?.[tool]))
  // tmux expands `#` sequences in -c: a literal `#` is `##`
  const dir = shellWord(ws.dir.replace(/#/g, '##'))
  // each command in the sequence acts on the pane the one before made
  const create = [
    `${tmux} has-session -t ${shellWord(`=${name}`)} 2>/dev/null ||`,
    `${tmux} new-session -d -s ${shellWord(name)} -c ${dir} -n peers ${pane('claude')}`,
    `\\; set-option -p ${AGENT_OPTION} claude`,
    `\\; split-window -h -c ${dir} ${pane('codex')}`,
    `\\; set-option -p ${AGENT_OPTION} codex`,
    // set-option takes no `=` exact-match target; the session was just made under this exact name
    `\\; set-option -t ${shellWord(name)} ${OWNER_OPTION} ${shellWord(String(ws.createdAt))}`,
    ...sessionSetup(name, [`${name}:peers`], false, ws.name ?? '').map(args => `\\; ${args.map((a, i) => (i === 0 ? a : shellWord(a))).join(' ')}`),
  ].join(' ')
  return o.attach === false ? create : `${create}; ${tmux} attach -t ${shellWord(`=${name}`)}`
}

/** `tmux list-panes -a -F PANES_FORMAT`: one line per pane. */
export const PANES_FORMAT = `#{session_name}\t#{window_name}\t#{pane_tty}\t#{pane_id}\t#{${AGENT_OPTION}}`
/** `tmux list-clients -F CLIENTS_FORMAT`: one line per attached terminal. */
export const CLIENTS_FORMAT = '#{session_name}\t#{client_tty}'

/**
 * Which tmux pane each tty is: tty (`ttys012`) → its session, its agent (the
 * pane's mark, or else its window's name, as workspaces made before the
 * mark had a window per agent) and the pane's id (`%12`).
 */
export function parsePanes(stdout: string): Record<string, { session: string; window: string; pane: string }> {
  const panes: Record<string, { session: string; window: string; pane: string }> = {}
  for (const line of stdout.split('\n')) {
    const [session, window, tty, pane = '', agent = ''] = line.split('\t')
    if (session && window !== undefined && tty?.startsWith('/dev/')) panes[tty.slice(5)] = { session, window: agent || window, pane }
  }
  return panes
}

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
    const claude = threadFrom('claude', (ws.threads as Record<string, unknown> | undefined)?.claude)
    const codex = threadFrom('codex', (ws.threads as Record<string, unknown> | undefined)?.codex)
    // a compaction setting this does not read is left out: the default stands
    const compactAt = Number.isInteger(ws.compactAt) && ws.compactAt! >= 0 && ws.compactAt! <= 100 ? ws.compactAt : undefined
    const { members: _, threads: __, compactAt: ___, ...rest } = ws
    return {
      ...rest,
      ...(members !== undefined && members.length > 0 ? { members } : {}),
      ...(claude === undefined && codex === undefined ? {} : { threads: { ...(claude === undefined ? {} : { claude }), ...(codex === undefined ? {} : { codex }) } }),
      ...(compactAt === undefined ? {} : { compactAt }),
    }
  })
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

/** CHECKOUT_SCRIPT's answer: the main checkout, or why there is none, said for a person. */
export function checkoutResult(stdout: string): { checkout: string } | { error: string } {
  const line = stdout.trim().split('\n').pop() ?? ''
  if (line.startsWith('ok /')) return { checkout: line.slice(3) }
  if (line === 'error: not-a-repo') return { error: 'that folder is not in a git checkout; peer coding works on a git repository' }
  if (line === 'error: no-main') return { error: 'git cannot tell where this repository\'s main checkout is; pick the main checkout' }
  return { error: 'its worktrees folder could not be made beside the repository' }
}

/**
 * Claude's first prompt in a workspace made for a purpose: get peer coding
 * ready under the peer-coding rules, on a branch named for the purpose (the
 * workspace's name is the owner's label only), and hand over by its cue,
 * which the workspace's relay passes on.
 */
export function setupPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'threads'>): string {
  const codex = ws.threads?.codex === undefined ? 'Codex runs in the pane beside you' : 'Codex runs in the pane beside you, in its own conversation, which the owner brought in: your alignment brief can ask it where its work stands'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `You are Claude, one of two peers here; ${codex}. ${RELAY_FOR_CLAUDE}`,
    '',
    'Get the workspace ready for peer coding, using the peer-coding skill and the rules it leads to:',
    '1. If this repository is not set up for peer coding in the current layout, set it up. Record the owner\'s decisions you already know and ask for the rest with NEEDS USER.',
    `2. Start a branch for this purpose: name it from the purpose by the settings' branch naming, never from the workspace's name, in its own worktree in ${ws.checkout ?? '<checkout>'}-worktrees/.`,
    '3. Make your alignment move for that branch and end your turn with the line the rules\' cue prints.',
  ].join('\n')
}

/**
 * Codex's first prompt in a workspace made for a purpose: who it is, that
 * Claude is getting things ready, and that the relay will bring Claude's
 * hand-off. Its short answer is its first finished turn, which the relay
 * waits for before it types anything into Codex's pane.
 */
export function peerPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'threads'>): string {
  const claude = ws.threads?.claude === undefined ? 'Claude runs in the pane beside you' : 'Claude runs in the pane beside you, in its own conversation, which the owner brought in,'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `You are Codex, one of two peers here; ${claude} and is getting peer coding ready now, under the peer-coding rules. ${RELAY_FOR_CODEX}`,
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
export function joinPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout' | 'threads'>, tool: 'claude' | 'codex'): string {
  const moved = 'The owner moved this conversation into the workspace: everything above stays yours.'
  if (tool === 'codex') {
    const claude = ws.threads?.claude === undefined ? 'Claude runs in the pane beside you' : 'Claude runs in the pane beside you, in its own conversation, brought in too,'
    return [
      `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
      '',
      `${moved} You are Codex, one of two peers here; ${claude} and is getting peer coding ready now, under the peer-coding rules. ${RELAY_FOR_CODEX}`,
      '',
      'Nothing to do until then: reply with one short line saying you are ready. When Claude\'s hand-off comes, align with it, and add what you know from your own work above that it does not say.',
    ].join('\n')
  }
  const codex = ws.threads?.codex === undefined ? 'Codex runs in the pane beside you, starting new' : 'Codex runs in the pane beside you, in its own conversation, brought in too'
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    `${moved} You are Claude, one of two peers here; ${codex}. ${RELAY_FOR_CLAUDE}`,
    '',
    'From here, work as a peer under the peer-coding rules, using the peer-coding skill:',
    '1. If this repository is not set up for peer coding in the current layout, set it up. Record the owner\'s decisions you already know and ask for the rest with NEEDS USER.',
    `2. If the work above already has a peer-coding branch, go on with it. Otherwise start one for this purpose: name it from the purpose by the settings' branch naming, never from the workspace's name, in its own worktree in ${ws.checkout ?? '<checkout>'}-worktrees/. Work of yours not committed yet stays where it is: ask the owner with NEEDS USER before moving any of it.`,
    '3. Make your alignment move for that branch, telling Codex where the work stands, and end your turn with the line the rules\' cue prints.',
  ].join('\n')
}

/**
 * The git repositories in the home folder, as their main checkouts (a `.git`
 * folder; a worktree or submodule has a `.git` file), at most five levels
 * down, skipping Library, hidden folders, node_modules and worktree folders.
 */
export const PROJECTS_SCRIPT = [
  'find "$1" -maxdepth 5 \\( -name Library -o -name node_modules -o -name .Trash -o -name "*-worktrees" -o \\( -name ".*" ! -name .git \\) \\) -prune',
  // a .git folder is printed, never gone into
  '  -o -type d -name .git -print -prune 2>/dev/null | sed "s#/\\.git\\$##"',
].join(' ')

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
