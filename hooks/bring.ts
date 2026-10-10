// Bringing running sessions into a new workspace: each one closes where it
// runs and its pane in the workspace resumes the same conversation. Pure: no
// `$`, so the tests drive it directly.
import type { ClaudeSession, CodexSession, Snapshot, Thread, Workspace } from '../types'
import { claudeState, WORKING_MS } from './collect'
import { tmuxName } from './workspaces'

type Tool = 'claude' | 'codex'

/** An id that goes into a shell command as it is. */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

/** The environment a session's profile belongs to: '' for `claude`/`codex`, `work` for `claude-work`; undefined for none. */
export function envOfProfile(tool: Tool, profile: string): string | undefined {
  if (profile === tool) return ''
  const m = new RegExp(`^${tool}-([a-z0-9][a-z0-9_.-]*)$`, 'i').exec(profile)
  return m === null || m[1]!.toLowerCase() === 'default' ? undefined : m[1]!
}

/** A running session the form can bring in. */
export type Bringable = {
  /** Its lasting id: `claude:<session id>` or `codex:<thread id>`. */
  member: string
  tool: Tool
  label: string
  env: string
  /** Between turns: what bringing it in needs. */
  isIdle: boolean
}

/**
 * The running sessions a new workspace can bring in: a Claude session in a
 * terminal (not in the background, not this one) or a Codex terminal whose
 * conversation is known, neither already in a workspace's panes; with
 * `dir`, only those of the repository it is in (any of its worktrees). Idle
 * ones first, then most recent.
 */
export function bringable(snap: Snapshot, o: { now: number; selfId: string }, dir?: string): Bringable[] {
  const repo = dir === undefined ? undefined : snap.places[dir]?.repo
  const inRepo = (cwd: string) =>
    dir === undefined ||
    (repo !== undefined && repo !== '' ? snap.places[cwd]?.repo === repo : cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}-worktrees/`))
  const workspaceSessions = new Set(snap.workspaces.map(tmuxName))
  const inWorkspace = (tty: string) => workspaceSessions.has(snap.tmux.panes[tty]?.session ?? '')
  const found: (Bringable & { at: number })[] = []
  for (const s of snap.claude) {
    const env = envOfProfile('claude', s.profile)
    if (s.sessionId === o.selfId || s.kind !== 'interactive' || !/^ttys\d+$/.test(s.tty) || !SAFE_ID.test(s.sessionId)) continue
    if (env === undefined || !s.startCwd.startsWith('/') || inWorkspace(s.tty) || !inRepo(s.cwd)) continue
    found.push({ member: `claude:${s.sessionId}`, tool: 'claude', label: `Claude · ${s.name}`, env, isIdle: claudeState(s, o.now) === 'idle', at: s.since })
  }
  for (const s of snap.codex) {
    const env = envOfProfile('codex', s.profile)
    if (s.surface !== 'terminal' || !/^ttys\d+$/.test(s.tty) || !SAFE_ID.test(s.key) || s.key.startsWith('pid-')) continue
    if (env === undefined || !s.cwd.startsWith('/') || inWorkspace(s.tty) || !inRepo(s.cwd)) continue
    const isIdle = !(s.updatedAt > 0 && o.now - s.updatedAt < WORKING_MS)
    found.push({ member: `codex:${s.key}`, tool: 'codex', label: `Codex · ${s.title || s.key.slice(0, 8)}`, env, isIdle, at: s.lastActive })
  }
  return found.sort((a, b) => Number(b.isIdle) - Number(a.isIdle) || b.at - a.at).map(({ at: _, ...b }) => b)
}

/** The form's choice with `member` toggled: at most one session of each agent is brought in. */
export function toggled(chosen: readonly string[], member: string): string[] {
  if (chosen.includes(member)) return chosen.filter(m => m !== member)
  const tool = member.split(':')[0]
  return [...chosen.filter(m => m.split(':')[0] !== tool), member]
}

/** Codex's rollout of the conversation "$2" under the Codex home "$1": its path, or nothing. */
export const ROLLOUT_SCRIPT = 'find "$1/sessions" -type f -name "rollout-*-$2.jsonl" 2>/dev/null | head -n 1'

/**
 * The sandbox, approval policy and folder a Codex conversation last ran
 * with, from its rollout ("$1"): `<sandbox> <tab> <approval> <tab> <cwd>`,
 * or nothing. Only its own `turn_context` records are read.
 */
export const CODEX_MODE_SCRIPT = [
  `/usr/bin/tail -c 4194304 "$1" 2>/dev/null | /usr/bin/grep '"type":"turn_context"' | /usr/bin/tail -n 1`,
  `/usr/bin/jq -R -r 'fromjson? | [.payload.sandbox_policy.type // "", .payload.approval_policy // "", .payload.cwd // ""] | join("\\t")' 2>/dev/null`,
].join(' | ')

/** The folder from CODEX_MODE_SCRIPT's answer, when it is one a command can take. */
export function codexDir(stdout: string): string | undefined {
  const dir = stdout.trim().split('\t')[2] ?? ''
  return dir.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(dir) ? dir : undefined
}

const APPROVALS = new Set(['untrusted', 'on-failure', 'on-request', 'never'])

/**
 * The flags that resume a Codex conversation as it ran, from
 * CODEX_MODE_SCRIPT's answer: full access stays full access; any other
 * sandbox writes in the workspace (`workspace-write`, as a new workspace's
 * Codex does, which its worktrees folder needs); its approval policy, when
 * it is one Codex takes.
 */
export function codexFlags(stdout: string): string[] {
  const [sandbox = '', approval = ''] = stdout.trim().split('\t')
  return [
    '--sandbox', sandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
    ...(APPROVALS.has(approval) ? ['--ask-for-approval', approval] : []),
  ]
}

const CLAUDE_FLAGS = new Set(['--dangerously-skip-permissions', '--permission-mode', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'])
const CODEX_FLAGS = new Set(['--sandbox', 'workspace-write', 'danger-full-access', '--ask-for-approval', ...APPROVALS])

/** A thread as saved, if it is one: a hand-edited or later one is dropped, never run. */
export function threadFrom(tool: Tool, raw: unknown): Thread | undefined {
  const o = raw as Partial<Thread> | null
  if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || !SAFE_ID.test(o.id) || typeof o.dir !== 'string' || !o.dir.startsWith('/')) return undefined
  if (/[\u0000-\u001f\u007f]/.test(o.dir)) return undefined
  const allowed = tool === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS
  if (o.flags !== undefined && !(Array.isArray(o.flags) && o.flags.every(f => typeof f === 'string' && allowed.has(f)))) return undefined
  return { id: o.id, dir: o.dir, ...(o.flags === undefined || o.flags.length === 0 ? {} : { flags: [...o.flags] }) }
}

/**
 * Closes an agent where it runs, as a terminal closing does, so its
 * conversation can go on elsewhere and never runs twice: hangs up each
 * process of the job in front of the terminal "$1" whose command is one of
 * "$2" (`a|b`), once one of them is "$3", then waits until they have exited.
 * Prints `stopped`; `not-running` when "$3" is not in front of that
 * terminal; `stuck` when they have not exited in 20 s.
 */
export const STOP_SCRIPT = [
  'tty=$1; names=$2; agent=$3',
  'case $tty in ttys[0-9]*) ;; *) echo not-running; exit 0;; esac',
  // each process in front: its pid, a tab, its command's name (the rest of the line: a folder may hold spaces)
  `front() { /bin/ps -t "$tty" -o pid=,stat=,comm= 2>/dev/null | /usr/bin/awk '$2 ~ /[+]/ && $2 !~ /^Z/ { n = $0; sub(/^[ \\t]*[0-9]+[ \\t]+[^ \\t]+[ \\t]+/, "", n); sub(".*/", "", n); print $1 "\\t" n }'; }`,
  'pids=; seen=; tab=$(printf "\\t")',
  'list=$(front)',
  'while IFS=$tab read -r pid name; do',
  '  case "|$names|" in *"|$name|"*) pids="$pids $pid"; [ "$name" = "$agent" ] && seen=1;; esac',
  'done <<EOF',
  '$list',
  'EOF',
  '[ -n "$seen" ] || { echo not-running; exit 0; }',
  'kill -HUP $pids 2>/dev/null',
  'i=0',
  'while :; do',
  '  left=; for p in $pids; do kill -0 "$p" 2>/dev/null && ! /bin/ps -o stat= -p "$p" | /usr/bin/grep -q "^Z" && left=1; done',
  '  [ -z "$left" ] && { echo stopped; exit 0; }',
  '  i=$((i + 1)); [ "$i" -gt 100 ] && { echo stuck; exit 0; }',
  '  sleep 0.2',
  'done',
].join('\n')

/** The commands of an agent's job in front of its terminal: Codex runs as a node wrapper and its own binary. */
export const JOB_COMMANDS: Record<Tool, string> = { claude: 'claude', codex: 'codex|node' }

/**
 * The conversations each workspace's panes run now, where they differ from
 * what it keeps: a pane's Claude session (resumed from where it started) or
 * Codex terminal (from its thread's folder). A pane with no agent running
 * leaves what is kept; the flags kept go with the same conversation only.
 */
export function seenThreads(
  workspaces: readonly Pick<Workspace, 'id' | 'threads'>[],
  panes: Snapshot['tmux']['panes'],
  claude: readonly Pick<ClaudeSession, 'tty' | 'sessionId' | 'startCwd'>[],
  codex: readonly Pick<CodexSession, 'tty' | 'key' | 'cwd' | 'surface'>[],
): Map<string, { claude?: Thread; codex?: Thread }> {
  const changed = new Map<string, { claude?: Thread; codex?: Thread }>()
  for (const ws of workspaces) {
    const now: { claude?: Thread; codex?: Thread } = { ...ws.threads }
    let isChanged = false
    for (const [tty, pane] of Object.entries(panes)) {
      if (pane.session !== tmuxName(ws) || (pane.window !== 'claude' && pane.window !== 'codex')) continue
      const tool = pane.window
      const seen =
        tool === 'claude'
          ? claude.filter(s => s.tty === tty && SAFE_ID.test(s.sessionId) && s.startCwd.startsWith('/')).map(s => ({ id: s.sessionId, dir: s.startCwd }))[0]
          : codex.filter(s => s.surface === 'terminal' && s.tty === tty && SAFE_ID.test(s.key) && !s.key.startsWith('pid-') && s.cwd.startsWith('/')).map(s => ({ id: s.key, dir: s.cwd }))[0]
      const kept = now[tool]
      if (seen === undefined || (kept?.id === seen.id && kept.dir === seen.dir)) continue
      now[tool] = { ...seen, ...(kept?.id === seen.id && kept.flags !== undefined ? { flags: kept.flags } : {}) }
      isChanged = true
    }
    if (isChanged) changed.set(ws.id, now)
  }
  return changed
}
