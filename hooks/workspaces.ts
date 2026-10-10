// Workspaces: named projects, each a folder, an environment and one tmux
// session running its agents. Pure: no `$`, so the tests drive it directly.
import type { Workspace } from '../types'

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
 */
function paneScript(tool: 'claude' | 'codex', ws: Pick<Workspace, 'id' | 'env' | 'checkout'>, home: string, bin?: string): string {
  const start = `${agentStart(tool, ws.env, home, bin)}${tool === 'codex' ? ' -c check_for_update_on_startup=false --sandbox workspace-write' : ''}`
  const addDir = ws.checkout === undefined ? '' : ` --add-dir ${shellWord(`${ws.checkout}-worktrees`)}`
  const prompt = shellWord(promptPath(home, ws.id, tool))
  const run = `p=$(cat ${prompt} 2>/dev/null) && rm -f ${prompt}; ${start}${addDir} \${p:+--} \${p:+"$p"}`
  return `/bin/sh -c ${shellWord(`${run}; exec "$SHELL" -l`)}`
}

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
 * (arguments) for the session `name` and each of its `windows` (targets): the
 * mouse on in that session alone, so a click picks the side the keys go to
 * and the wheel scrolls the side under it (or reaches its agent, when the
 * agent takes the mouse); and each side's border naming its agent.
 * tmux.conf and other sessions are left as they are.
 */
export function sessionSetup(name: string, windows: readonly string[]): string[][] {
  return [
    ['set-option', '-t', name, 'mouse', 'on'],
    ...windows.flatMap(window => [
      ['set-window-option', '-t', window, 'pane-border-status', 'top'],
      ['set-window-option', '-t', window, 'pane-border-format', BORDER_FORMAT],
    ]),
  ]
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
  ws: Pick<Workspace, 'id' | 'env' | 'dir' | 'createdAt' | 'checkout'>,
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
    ...sessionSetup(name, [`${name}:peers`]).map(args => `\\; ${args.map((a, i) => (i === 0 ? a : shellWord(a))).join(' ')}`),
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
    const { members: _, ...rest } = ws
    return members !== undefined && members.length > 0 ? { ...rest, members } : rest
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
export function setupPrompt(ws: Pick<Workspace, 'name' | 'purpose' | 'checkout'>): string {
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    'You are Claude, one of two peers here; Codex runs in the pane beside you. The owner turned on this workspace\'s relay, which stands in for the owner\'s copy and paste: when your turn ends with a peer-coding cue line (READY FOR CODEX, NEEDS USER or SCOPE CLOSED), it types that exact line into Codex\'s chat, or tells the owner. The owner still answers every NEEDS USER.',
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
export function peerPrompt(ws: Pick<Workspace, 'name' | 'purpose'>): string {
  return [
    `This is the workspace "${ws.name}". What it is for: ${ws.purpose ?? ''}`,
    '',
    'You are Codex, one of two peers here; Claude runs in the pane beside you and is getting peer coding ready now, under the peer-coding rules. The owner turned on this workspace\'s relay, which stands in for the owner\'s copy and paste: Claude\'s hand-off line (READY FOR CODEX · …) will be typed here when Claude\'s turn ends, and when your turn ends with a cue line the relay passes it to Claude or tells the owner.',
    '',
    'Nothing to do until then: reply with one short line saying you are ready.',
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
