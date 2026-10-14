// Bringing running sessions into a new workspace: each one closes where it
// runs and its pane in the workspace resumes the same conversation. Pure: no
// `$`, so the tests drive it directly.
import type { CodexSession, Snapshot, Thread, Workspace } from '../types'
import { claudeState, envOfProfile, WORKING_MS } from './collect'
import { tmuxName } from './workspaces'

// which account a profile is: kept with the view, which shows one account at a time
export { envOfProfile } from './collect'

type Tool = 'claude' | 'codex'

/** An id that goes into a command line as it is: letters, digits and dashes, never first a dash (an option). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

/** A running session the form can bring in. */
export type Bringable = {
  /** Its lasting id: `claude:<session id>` or `codex:<thread id>`. */
  member: string
  tool: Tool
  label: string
  env: string
  /** Between turns: what bringing it in needs. */
  isIdle: boolean
  /** Why it cannot be brought in, when it cannot: it is shown, not offered. */
  blocked?: string
  /** A Codex conversation open in no terminal (closed by the owner): resumed, nothing to close. */
  isClosed?: boolean
}

/**
 * Whether a Codex terminal's conversation is known for certain, so that
 * closing it closes that conversation and no other. Codex records no link
 * from a terminal to its conversation, so only: it holds the conversation's
 * rollout open (checked again, fresh, before it is closed); Codex's shared
 * background server holds it open for it, its terminals and the
 * conversations it holds pairing off (`loaded`: checked again before it is
 * closed, and after, that nothing holds it open any more: HOLDERS_SCRIPT); or
 * it is the only Codex terminal under its Codex home and no other
 * conversation there was written since it started (a `/new` or `/resume`
 * inside it would make one; checked again in Codex's own records before it
 * is closed). An exec run is never one.
 */
export function isKnownCodex(snap: Pick<Snapshot, 'codex'>, s: CodexSession): boolean {
  if (s.surface !== 'terminal' || s.pid === undefined || s.match === undefined || s.isExec === true || !SAFE_ID.test(s.key) || s.key.startsWith('pid-')) return false
  if (s.match === 'held' || s.match === 'loaded') return true
  const since = (s.startedAt ?? 0) - 5_000
  // what a Codex terminal could be running: another terminal's conversation, or one made in a terminal (an exec run
  // and its thread, or the desktop app's, never are)
  return !snap.codex.some(o => o !== s && o.profile === s.profile && o.isExec !== true && (o.surface === 'terminal' || (o.surface === 'cli' && o.updatedAt >= since)))
}

/**
 * The running sessions a new workspace can bring in: a Claude session in a
 * terminal (not in the background, not this one) or a Codex terminal whose
 * conversation is known, neither already in a workspace's panes; with
 * `dir`, only those of the repository it is in (any of its worktrees): `dir`
 * may name the repository's folders (its main checkout and its worktrees,
 * wherever they are). Idle ones first, then most recent.
 */
export function bringable(snap: Snapshot, o: { now: number; selfId: string }, dir?: string | readonly string[]): Bringable[] {
  const dirs = dir === undefined ? undefined : typeof dir === 'string' ? [dir] : dir
  const repo = dirs?.map(d => snap.places[d]?.repo).find(r => r !== undefined && r !== '')
  const inRepo = (cwd: string) =>
    dirs === undefined ||
    (repo !== undefined ? snap.places[cwd]?.repo === repo : dirs.some(d => cwd === d || cwd.startsWith(`${d}/`) || cwd.startsWith(`${d}-worktrees/`)))
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
    if (s.surface !== 'terminal' || !/^ttys\d+$/.test(s.tty)) continue
    if (env === undefined || !s.cwd.startsWith('/') || inWorkspace(s.tty) || !inRepo(s.cwd)) continue
    if (s.isExec === true) continue
    const isIdle = !(s.updatedAt > 0 && o.now - s.updatedAt < WORKING_MS)
    const isKnown = isKnownCodex(snap, s)
    // a terminal whose conversation is not known for certain is shown, never offered: closing it could close another
    const blocked = isKnown ? undefined : s.key.startsWith('pid-') ? 'its conversation was not found; close it yourself, then bring in its conversation' : 'which conversation it runs is not certain (other Codex work under this account): close it yourself, then bring in its conversation'
    found.push({
      // an uncertain terminal is named by its terminal alone: a title would be a guess, and could send the owner to close another
      member: isKnown ? `codex:${s.key}` : `codex-tty:${s.tty}`, tool: 'codex', label: `Codex · ${isKnown ? s.title || s.key.slice(0, 8) : `the terminal in ${s.tty}`}`, env, isIdle, at: s.lastActive,
      ...(blocked === undefined ? {} : { blocked }),
    })
  }
  // a conversation made in Codex's terminal and open in none (closed by the owner), once every Codex terminal under
  // that account is certain (else it may be the one an uncertain terminal runs), and not written in the last minute
  for (const s of snap.codex) {
    const env = envOfProfile('codex', s.profile)
    if (s.surface !== 'cli' || !SAFE_ID.test(s.key) || env === undefined || !s.cwd.startsWith('/') || !inRepo(s.cwd) || o.now - s.updatedAt < WORKING_MS) continue
    if (snap.codex.some(t => t.surface === 'terminal' && t.isExec !== true && t.profile === s.profile && !isKnownCodex(snap, t))) continue
    found.push({ member: `codex:${s.key}`, tool: 'codex', label: `Codex · ${s.title || s.key.slice(0, 8)} (closed)`, env, isIdle: true, isClosed: true, at: s.lastActive })
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
 * How a Codex conversation's last turn stands, from its whole rollout ("$1"):
 * the last task event, `"type":"task_started"` while one is under way.
 */
export const CODEX_TASK_SCRIPT = `/usr/bin/grep -oE '"type":"(task_started|task_complete|turn_aborted)"' "$1" 2>/dev/null | /usr/bin/tail -n 1`

/** CODEX_TASK_SCRIPT's answer: a task under way, none (between turns), or unknown (no task yet, or no rollout). */
export function codexTaskState(stdout: string): 'busy' | 'done' | undefined {
  const last = stdout.trim()
  return last.includes('task_started') ? 'busy' : /task_complete|turn_aborted/.test(last) ? 'done' : undefined
}

/**
 * The folder a Codex conversation last ran in, from its rollout ("$1"), or
 * nothing. Only its own `turn_context` records are read.
 */
export const CODEX_FOLDER_SCRIPT = [
  `/usr/bin/tail -c 4194304 "$1" 2>/dev/null | /usr/bin/grep '"type":"turn_context"' | /usr/bin/tail -n 1`,
  `/usr/bin/jq -R -r 'fromjson? | .payload.cwd // ""' 2>/dev/null`,
].join(' | ')

/** The folder from CODEX_FOLDER_SCRIPT's answer, when it is one a command can take. */
export function codexDir(stdout: string): string | undefined {
  const dir = stdout.replace(/\n+$/, '')
  return dir.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(dir) ? dir : undefined
}

/**
 * A thread as saved, if it is one: a hand-edited or later one is dropped, never run. The permission flags versions
 * before 0.27 kept with it are let go: every workspace agent now resumes bypassed (workspaces.ts BYPASS).
 */
export function threadFrom(raw: unknown): Thread | undefined {
  const o = raw as Partial<Thread> | null
  if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || !SAFE_ID.test(o.id) || typeof o.dir !== 'string' || !o.dir.startsWith('/')) return undefined
  if (/[\u0000-\u001f\u007f]/.test(o.dir)) return undefined
  const since = typeof o.since === 'number' && Number.isFinite(o.since) ? o.since : undefined
  return { id: o.id, dir: o.dir, ...(since === undefined ? {} : { since }) }
}

/**
 * The list with `threads` kept for the workspace `id` (none: none kept), and
 * those conversations taken from any other workspace: a conversation goes on
 * in one workspace at most, so two never resume it at once.
 */
export function withThreads(list: readonly Workspace[], id: string, threads: { claude?: Thread; codex?: Thread }): Workspace[] {
  const ids = new Set([threads.claude?.id, threads.codex?.id].filter((x): x is string => x !== undefined))
  const isTaken = (t: Thread | undefined) => t !== undefined && ids.has(t.id)
  const pick = (t: { claude?: Thread; codex?: Thread }) => ({
    ...(t.claude === undefined ? {} : { claude: t.claude }),
    ...(t.codex === undefined ? {} : { codex: t.codex }),
  })
  return list.map(ws => {
    const kept = ws.id === id ? pick(threads) : pick({ claude: isTaken(ws.threads?.claude) ? undefined : ws.threads?.claude, codex: isTaken(ws.threads?.codex) ? undefined : ws.threads?.codex })
    if (ws.id !== id && ws.threads === undefined) return ws
    const { threads: _, ...rest } = ws
    return kept.claude === undefined && kept.codex === undefined ? rest : { ...rest, threads: kept }
  })
}

/**
 * Closes an agent where it runs, as a terminal closing does, so its
 * conversation can go on elsewhere and never runs twice: once the process
 * "$3" is in front of the terminal "$1" under one of the commands "$2"
 * (`a|b`), hangs up each process of that job named so, then waits until they
 * have exited. Prints `stopped`; `not-running` when that process is not in
 * front of that terminal (gone, suspended, behind another program); `stuck`
 * when they have not exited in 20 s.
 */
export const STOP_SCRIPT = [
  'tty=$1; names=$2; want=$3',
  'case $tty in ttys[0-9]*) ;; *) echo not-running; exit 0;; esac',
  // each process in front: its pid, a tab, its command's name (the rest of the line: a folder may hold spaces)
  `front() { /bin/ps -t "$tty" -o pid=,stat=,comm= 2>/dev/null | /usr/bin/awk '$2 ~ /[+]/ && $2 !~ /^Z/ { n = $0; sub(/^[ \\t]*[0-9]+[ \\t]+[^ \\t]+[ \\t]+/, "", n); sub(".*/", "", n); print $1 "\\t" n }'; }`,
  'pids=; seen=; tab=$(printf "\\t")',
  'list=$(front)',
  'while IFS=$tab read -r pid name; do',
  '  case "|$names|" in *"|$name|"*) pids="$pids $pid"; [ "$pid" = "$want" ] && seen=1;; esac',
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

/**
 * Whether any Codex process (a terminal, a shared background server, the
 * desktop app's) holds the rollout of the conversation "$1" open, asked up to
 * "$2" times 0.3 s apart until none does: a terminal's server lets a
 * conversation go a moment after the terminal closes. Prints `free`, or
 * `held <pid>` when one still holds it.
 */
export const HOLDERS_SCRIPT = [
  'id=$1; tries=$2; i=0',
  'while :; do',
  '  pids=$(/usr/bin/pgrep -x codex | /usr/bin/paste -sd , -)',
  '  pid=',
  `  [ -n "$pids" ] && pid=$(/usr/sbin/lsof -n -P -a -p "$pids" -Fpn 2>/dev/null | /usr/bin/awk -v end="-$id.jsonl" '/^p/ { p = substr($0, 2) } /^n/ && length($0) > length(end) && substr($0, length($0) - length(end) + 1) == end { print p; exit }')`,
  '  [ -z "$pid" ] && { echo free; exit 0; }',
  '  i=$((i + 1)); [ "$i" -ge "$tries" ] && { echo "held $pid"; exit 0; }',
  '  sleep 0.3',
  'done',
].join('\n')

/** HOLDERS_SCRIPT's answer: free, or the process that holds the conversation open (unknown, when it said neither: not free). */
export function holderOf(stdout: string): 'free' | number | undefined {
  const line = stdout.trim()
  if (line === 'free') return 'free'
  const m = /^held (\d+)$/.exec(line)
  return m === null ? undefined : Number(m[1])
}

/** The commands of an agent's job in front of its terminal: Codex runs as a node wrapper and its own binary. */
export const JOB_COMMANDS: Record<Tool, string> = { claude: 'claude', codex: 'codex|node' }

/**
 * The conversations each workspace's panes run now, where they differ from
 * what it keeps: a pane's interactive Claude session (resumed from where it
 * started) or a Codex terminal whose conversation is known for certain (from
 * its thread's folder), under the workspace's own environment. A pane with
 * no such agent leaves what is kept. Flags go with the same conversation only
 * (a conversation started anew, even by /clear, resumes without them).
 */
export function seenThreads(
  workspaces: readonly Pick<Workspace, 'id' | 'env' | 'threads'>[],
  snap: Pick<Snapshot, 'tmux' | 'claude' | 'codex'>,
): Map<string, { claude?: Thread; codex?: Thread }> {
  const changed = new Map<string, { claude?: Thread; codex?: Thread }>()
  for (const ws of workspaces) {
    const now: { claude?: Thread; codex?: Thread } = { ...ws.threads }
    let isChanged = false
    for (const [tty, pane] of Object.entries(snap.tmux.panes)) {
      if (pane.session !== tmuxName(ws) || (pane.window !== 'claude' && pane.window !== 'codex')) continue
      const tool = pane.window
      const kept = now[tool]
      let seen: Thread | undefined
      if (tool === 'claude') {
        const s = snap.claude.find(c => c.tty === tty && c.kind === 'interactive' && SAFE_ID.test(c.sessionId) && c.startCwd.startsWith('/') && envOfProfile('claude', c.profile) === ws.env)
        // when it joined goes with the same conversation only: one started anew in the pane has its own
        seen = s === undefined ? undefined : { id: s.sessionId, dir: s.startCwd, ...(kept?.id === s.sessionId && kept.since !== undefined ? { since: kept.since } : {}) }
      } else {
        const s = snap.codex.find(c => c.tty === tty && isKnownCodex(snap, c) && envOfProfile('codex', c.profile) === ws.env)
        seen = s === undefined ? undefined : { id: s.key, dir: s.cwd, ...(kept?.id === s.key && kept.since !== undefined ? { since: kept.since } : {}) }
      }
      if (seen === undefined || (kept?.id === seen.id && kept.dir === seen.dir)) continue
      now[tool] = seen
      isChanged = true
    }
    if (isChanged) changed.set(ws.id, now)
  }
  return changed
}
