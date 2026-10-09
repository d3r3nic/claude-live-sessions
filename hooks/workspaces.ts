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
  | { action: 'new'; dir: string; env: string; name: string; branch: string }
  | { action: 'open' | 'rm'; ref: string }
  | { action: 'help'; error?: string }

/**
 * `/workspace` arguments: `new <folder> <env> <name>`, `open <name>`,
 * `rm <name>`, or nothing to list. `<env>` is required and must be one of
 * `envs` or `default`: a misspelt one is an error, never another account.
 * `~` in the folder is the home directory.
 */
export function parseWorkspaceArgs(args: string, envs: readonly string[], home: string): WorkspaceCommand {
  const [verb = '', ...rest] = words(args)
  if (verb === '' || verb === 'list') return { action: 'list' }
  if (verb === 'open' || verb === 'rm') {
    return rest.length > 0 ? { action: verb, ref: rest.join(' ') } : { action: 'help', error: `say which workspace to ${verb}` }
  }
  if (verb !== 'new') return { action: 'help', error: `"${verb}" is not one of new, open, rm, list` }
  const [folder = '', envWord = '', ...afterEnv] = rest
  // `--branch <name>` anywhere after the environment: a new worktree for it
  const at = afterEnv.indexOf('--branch')
  const branch = at >= 0 ? (afterEnv[at + 1] ?? '') : ''
  if (at >= 0 && branch === '') return { action: 'help', error: '--branch needs a branch name' }
  const after = at >= 0 ? [...afterEnv.slice(0, at), ...afterEnv.slice(at + 2)] : afterEnv
  const name = after.join(' ').trim()
  if (folder === '' || envWord === '' || name === '') return { action: 'help', error: 'new needs a folder, an environment and a name' }
  if (envWord !== 'default' && !envs.includes(envWord)) return { action: 'help', error: `there is no environment "${envWord}"` }
  const env = envWord === 'default' ? '' : envWord
  const dir = folder === '~' ? home : folder.startsWith('~/') ? `${home}${folder.slice(1)}` : folder
  if (!dir.startsWith('/')) return { action: 'help', error: 'the folder must be absolute or start with ~' }
  return { action: 'new', dir: dir.replace(/\/+$/, '') || '/', env, name, branch }
}

/** The workspace `ref` names: its id, or its name in any case. */
export const findWorkspace = (list: readonly Workspace[], ref: string) =>
  list.find(ws => ws.id === ref) ?? list.find(ws => ws.name.toLowerCase() === ref.trim().toLowerCase())

/** A string as one shell word. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

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

/** The tmux session option that marks a session as started for one workspace (its createdAt). */
export const OWNER_OPTION = '@live-sessions-workspace'

/**
 * The command line that opens a workspace in a terminal: creates its tmux
 * session if it is not running (a `claude` window and a `codex` window in
 * its folder, each leaving a shell when its agent exits), then attaches.
 * Closing that terminal detaches; the agents keep running in tmux.
 * `socket` and `bins` are for tests; `attach: false` only creates.
 */
export function openCommand(
  ws: Pick<Workspace, 'id' | 'env' | 'dir' | 'createdAt'>,
  home: string,
  o: { socket?: string; bins?: { claude: string; codex: string }; attach?: boolean } = {},
): string {
  const tmux = o.socket === undefined ? 'tmux' : `tmux -L ${shellWord(o.socket)}`
  const name = tmuxName(ws)
  const window = (tool: 'claude' | 'codex') =>
    shellWord(`${agentStart(tool, ws.env, home, o.bins?.[tool])}; exec "$SHELL" -l`)
  // tmux expands `#` sequences in -c: a literal `#` is `##`
  const dir = shellWord(ws.dir.replace(/#/g, '##'))
  const create = [
    `${tmux} has-session -t ${shellWord(`=${name}`)} 2>/dev/null ||`,
    `${tmux} new-session -d -s ${shellWord(name)} -c ${dir} -n claude ${window('claude')}`,
    `\\; new-window -t ${shellWord(`=${name}:`)} -c ${dir} -n codex ${window('codex')}`,
    // set-option takes no `=` exact-match target; the session was just made under this exact name
    `\\; set-option -t ${shellWord(name)} ${OWNER_OPTION} ${shellWord(String(ws.createdAt))}`,
  ].join(' ')
  return o.attach === false ? create : `${create}; ${tmux} attach -t ${shellWord(`=${name}`)}`
}

/** `tmux list-panes -a -F PANES_FORMAT`: one line per pane. */
export const PANES_FORMAT = '#{session_name}\t#{window_name}\t#{pane_tty}'
/** `tmux list-clients -F CLIENTS_FORMAT`: one line per attached terminal. */
export const CLIENTS_FORMAT = '#{session_name}\t#{client_tty}'

/** Which tmux pane each tty is: tty (`ttys012`) → its session and window. */
export function parsePanes(stdout: string): Record<string, { session: string; window: string }> {
  const panes: Record<string, { session: string; window: string }> = {}
  for (const line of stdout.split('\n')) {
    const [session, window, tty] = line.split('\t')
    if (session && window !== undefined && tty?.startsWith('/dev/')) panes[tty.slice(5)] = { session, window }
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
  const named = [...sides].filter(([, tools]) => tools.has('claude') && tools.has('codex')).map(([env]) => env)
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
      typeof o.createdAt === 'number' &&
      (o.members === undefined || (Array.isArray(o.members) && o.members.every(m => typeof m === 'string' && MEMBER_ID.test(m))))
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
 * Where a new branch's worktree goes: beside the repository, in one folder
 * per repository, `<parent>/<repo>-worktrees/<branch>`, each `/` in the
 * branch a `-`.
 */
export function worktreeDir(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/\/+$/, '')
  const at = root.lastIndexOf('/')
  return `${root.slice(0, at)}/${root.slice(at + 1)}-worktrees/${branch.replace(/\//g, '-')}`
}
