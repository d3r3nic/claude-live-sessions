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
  | { action: 'new'; dir: string; env: string; name: string }
  | { action: 'open' | 'rm'; ref: string }
  | { action: 'help'; error?: string }

/**
 * `/workspace` arguments: `new <folder> [<env>] <name>`, `open <name>`,
 * `rm <name>`, or nothing to list. `<env>` is one of `envs` (`default` for
 * the default environment); `~` in the folder is the home directory.
 */
export function parseWorkspaceArgs(args: string, envs: readonly string[], home: string): WorkspaceCommand {
  const [verb = '', ...rest] = words(args)
  if (verb === '' || verb === 'list') return { action: 'list' }
  if (verb === 'open' || verb === 'rm') {
    return rest.length > 0 ? { action: verb, ref: rest.join(' ') } : { action: 'help', error: `say which workspace to ${verb}` }
  }
  if (verb !== 'new') return { action: 'help', error: `"${verb}" is not one of new, open, rm, list` }
  const [folder = '', ...after] = rest
  const isEnv = (word: string | undefined) => word !== undefined && (word === 'default' || envs.includes(word))
  const env = isEnv(after[0]) ? (after[0] === 'default' ? '' : after[0]!) : ''
  const name = (isEnv(after[0]) ? after.slice(1) : after).join(' ').trim()
  if (folder === '' || name === '') return { action: 'help', error: 'new needs a folder and a name' }
  const dir = folder === '~' ? home : folder.startsWith('~/') ? `${home}${folder.slice(1)}` : folder
  if (!dir.startsWith('/')) return { action: 'help', error: 'the folder must be absolute or start with ~' }
  return { action: 'new', dir: dir.replace(/\/+$/, '') || '/', env, name }
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
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
]

/** An agent's start under a workspace's environment: its config directory, Claude's or Codex's. */
export function agentStart(tool: 'claude' | 'codex', env: string, home: string, bin: string = tool): string {
  const vars = env === '' ? '' : tool === 'claude' ? `CLAUDE_CONFIG_DIR=${shellWord(`${home}/.claude-${env}`)} ` : `CODEX_HOME=${shellWord(`${home}/.codex-${env}`)} `
  return `env ${SESSION_MARKERS.map(v => `-u ${v}`).join(' ')} ${vars}${bin}`
}

/**
 * The command line that opens a workspace in a terminal: creates its tmux
 * session if it is not running (a `claude` window and a `codex` window in
 * its folder, each leaving a shell when its agent exits), then attaches.
 * Closing that terminal detaches; the agents keep running in tmux.
 * `socket` and `bins` are for tests; `attach: false` only creates.
 */
export function openCommand(
  ws: Pick<Workspace, 'id' | 'env' | 'dir'>,
  home: string,
  o: { socket?: string; bins?: { claude: string; codex: string }; attach?: boolean } = {},
): string {
  const tmux = o.socket === undefined ? 'tmux' : `tmux -L ${shellWord(o.socket)}`
  const name = tmuxName(ws)
  const window = (tool: 'claude' | 'codex') =>
    shellWord(`${agentStart(tool, ws.env, home, o.bins?.[tool])}; exec "$SHELL" -l`)
  const create = [
    `${tmux} has-session -t ${shellWord(`=${name}`)} 2>/dev/null ||`,
    `${tmux} new-session -d -s ${shellWord(name)} -c ${shellWord(ws.dir)} -n claude ${window('claude')}`,
    `\\; new-window -t ${shellWord(`=${name}:`)} -c ${shellWord(ws.dir)} -n codex ${window('codex')}`,
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
 * The environments on this machine: a Claude config directory
 * (`.claude-<env>`) or a Codex home (`.codex-<env>`) that is one; '' is the
 * default (`.claude`, `.codex`). `isProfile` says whether a directory is.
 */
export function envsFrom(dirNames: readonly string[], isProfile: (dirName: string) => boolean): string[] {
  const envs = new Set<string>()
  for (const name of dirNames) {
    const m = /^\.(claude|codex)(?:-([a-z0-9][a-z0-9_.-]*))?$/i.exec(name)
    if (m !== null && isProfile(name)) envs.add(m[2] ?? '')
  }
  return [...envs].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}

/** The workspaces file, if it is one. */
export function workspacesFrom(raw: unknown): Workspace[] {
  const list = (raw as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(list)) return []
  return list.filter((ws): ws is Workspace => {
    const o = ws as Partial<Workspace> | null
    return typeof o === 'object' && o !== null && typeof o.id === 'string' && /^[a-z0-9-]{1,40}$/.test(o.id) &&
      typeof o.name === 'string' && typeof o.env === 'string' && typeof o.dir === 'string' && o.dir.startsWith('/') &&
      typeof o.createdAt === 'number'
  })
}
