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
  // `--branch <b>`, `--branch=<b>` or `-b <b>` anywhere after the environment: that branch's own worktree
  let branch = ''
  const nameWords: string[] = []
  for (let i = 0; i < afterEnv.length; i++) {
    const word = afterEnv[i]!
    if (word === '--branch' || word === '-b') {
      branch = afterEnv[++i] ?? ''
      if (branch === '') return { action: 'help', error: `${word} needs a branch name` }
    } else if (word.startsWith('--branch=')) {
      branch = word.slice('--branch='.length)
    } else if (word.startsWith('--')) {
      return { action: 'help', error: `"${word}" is not an option /workspace takes` }
    } else {
      nameWords.push(word)
    }
  }
  const name = nameWords.join(' ').trim()
  if (folder === '' || envWord === '' || name === '') return { action: 'help', error: 'new needs a folder, an environment and a name' }
  if (envWord !== 'default' && !envs.includes(envWord)) return { action: 'help', error: `there is no environment "${envWord}"` }
  const env = envWord === 'default' ? '' : envWord
  const dir = absoluteDir(folder, home)
  if (dir === undefined) return { action: 'help', error: 'the folder must be absolute or start with ~/' }
  return { action: 'new', dir, env, name, branch }
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
      typeof o.createdAt === 'number'
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
 * Makes branch "$2"'s worktree for the folder "$1" and prints `ok <path>`,
 * or `error: <why>` and exits non-zero. The worktree goes beside the
 * repository's main checkout, in `<checkout>-worktrees/<branch>`, each `/` a
 * `-`. From the main checkout that is its top folder (so a submodule or a
 * separate git dir is placed right); from a linked worktree, the checkout its
 * shared git dir belongs to, or a refusal when git cannot tell. The
 * repository's own hooks and fsmonitor never run, as when git is run directly. A branch there already,
 * here or on a remote, is checked out (a remote one tracked); a new branch
 * starts from the folder's own commit.
 */
export const WORKTREE_SCRIPT = [
  'dir=$1; branch=$2',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"; }',
  'g check-ref-format --branch "$branch" >/dev/null 2>&1 || { echo "error: bad-name"; exit 10; }',
  'top=$(g -C "$dir" rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] || { echo "error: not-a-repo"; exit 11; }',
  'own=$(g -C "$dir" rev-parse --path-format=absolute --git-dir) || exit 11',
  'common=$(g -C "$dir" rev-parse --path-format=absolute --git-common-dir) || exit 11',
  'if [ "$own" = "$common" ]; then main=$top',
  'else',
  '  wt=$(g --git-dir="$common" config --get core.worktree)',
  '  if [ -n "$wt" ]; then main=$(cd "$common" && cd "$wt" && pwd -P)',
  '  elif [ "$(basename "$common")" = .git ]; then main=$(dirname "$common")',
  '  fi',
  'fi',
  'case $main in /*) ;; *) echo "error: no-main"; exit 15;; esac',
  `target="$(dirname "$main")/$(basename "$main")-worktrees/$(printf '%s' "$branch" | tr / -)"`,
  '[ -e "$target" ] && { printf \'error: exists %s\\n\' "$target"; exit 12; }',
  'if g -C "$dir" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null ||',
  '  [ -n "$(g -C "$dir" for-each-ref --format=x "refs/remotes/*/$branch")" ]; then',
  '  out=$(g -C "$dir" worktree add "$target" "$branch" 2>&1)',
  'else',
  '  base=$(g -C "$dir" rev-parse --verify HEAD) || { echo "error: no-commit"; exit 13; }',
  '  out=$(g -C "$dir" worktree add -b "$branch" "$target" "$base" 2>&1)',
  'fi',
  `[ $? -eq 0 ] || { printf 'error: git %s\\n' "$(printf '%s\\n' "$out" | grep -E '^(fatal|error):' | tail -n 1)"; exit 14; }`,
  `printf 'ok %s\\n' "$target"`,
].join('\n')

/** WORKTREE_SCRIPT's answer: the new worktree, or why there is none, said for a person. */
export function worktreeResult(stdout: string, branch: string): { dir: string } | { error: string } {
  const line = stdout.trim().split('\n').pop() ?? ''
  if (line.startsWith('ok /')) return { dir: line.slice(3) }
  const why = line.replace(/^error: /, '')
  if (why === 'bad-name') return { error: `"${branch}" is not a branch name git takes` }
  if (why === 'not-a-repo') return { error: 'that folder is not in a git checkout, so it has no branches' }
  if (why === 'no-main') return { error: 'git cannot tell where this repository\'s main checkout is; start from the main checkout' }
  if (why === 'no-commit') return { error: 'that repository has no commit to start a branch from' }
  if (why.startsWith('exists ')) return { error: `${why.slice(7)} is already there` }
  if (why.startsWith('git ')) return { error: `git could not make the worktree (${why.slice(4) || 'no reason given'})` }
  return { error: 'git could not make the worktree' }
}
