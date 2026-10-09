// The relay: in a workspace, passes each agent's peer-coding cue to the
// other agent, as the owner did by copy and paste, and tells the owner when
// a cue is for them. Pure: no `$`, so the tests drive it directly.
import type { Relay, Workspace } from '../types'

/** Cues passed on in a row before the relay waits for the owner. */
export const RELAY_CAP = 10
/**
 * A turn older than this is never acted on: the ledger forgets steps after
 * 30 days, and an agent idle that long still has its last cue in its records.
 */
export const TURN_MAX_AGE_MS = 7 * 24 * 3600_000

type Tool = 'claude' | 'codex'
const NAME: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' }

export type Cue = { kind: 'ready'; to: Tool; line: string } | { kind: 'needs-user' | 'scope-closed'; line: string }

/** A cue as the rules' `cue` prints it, at the start of a line; a list mark, quote or code marks around it are dropped. */
const CUE = /^\s*(?:[0-9]+\.|[-*>])?\s*[`*_]*((READY FOR (CLAUDE|CODEX)|NEEDS USER|SCOPE CLOSED) · [^\n]*?)[`*_]*\s*$/

/** The cue in a line the turn pipeline gave, if it is one: one line, no control characters, at most 1000 characters. */
export function cueOf(line: string): Cue | undefined {
  const m = CUE.exec(line)
  if (m === null) return undefined
  // eslint-disable-next-line no-control-regex
  const text = m[1]!.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000).trim()
  if (m[2] === 'NEEDS USER') return { kind: 'needs-user', line: text }
  if (m[2] === 'SCOPE CLOSED') return { kind: 'scope-closed', line: text }
  return { kind: 'ready', to: m[3] === 'CLAUDE' ? 'claude' : 'codex', line: text }
}

/**
 * For each transcript ("$@"), only how its last turn stands, as `==> <file>`
 * then `done|busy <tab> <turn id> <tab> <ISO time> <tab> <cue line>`: a
 * finished turn's id, when it ended and its last cue line, or a turn under
 * way. Nothing else of what was said leaves the pipeline.
 * - Claude's transcript: a reply that stopped for a tool (or has not
 *   stopped) is a turn under way, whatever started it (a prompt, a skill);
 *   any other stop ends the turn (`end_turn`; one reply can take several
 *   records, read together), as does an interrupt. A prompt starts a turn.
 *   A command that only changes settings or shows output (`/model`,
 *   `/compact`, `!ls`), its output, a compaction's summary and meta records
 *   start nothing.
 * - A Codex rollout: `task_complete` or `turn_aborted` ends a turn,
 *   `task_started` starts one.
 * A subagent's records, and a line cut by `tail`, are skipped.
 */
export const TURN_SCRIPT = [
  'for f in "$@"; do',
  `  printf '==> %s\\n' "$f"`,
  "  tail -n 600 \"$f\" 2>/dev/null | /usr/bin/jq -R -n -r '",
  '    def cue: split("\\n") | map(select(test("^\\\\s*(?:[0-9]+\\\\.|[-*>])?\\\\s*[`*_]*(READY FOR (CLAUDE|CODEX)|NEEDS USER|SCOPE CLOSED) · "))) | (last // "") | gsub("[\\t\\r]"; " ");',
  '    def said: if (.message.content | type) == "string" then .message.content else ([.message.content[]? | select(.type == "text") | .text] | join("\\n")) end;',
  '    reduce (inputs | fromjson? | select(type == "object" and .isSidechain != true)) as $o (null;',
  '      if $o.type == "assistant" and (($o.message.stop_reason // "") as $r | $r == "tool_use" or $r == "pause_turn" or $r == "") then',
  '        {state: "busy", id: $o.uuid, at: $o.timestamp, text: ""}',
  '      elif $o.type == "assistant" then',
  '        if . != null and .state == "done" and .mid != null and .mid == $o.message.id then .text += "\\n" + ($o | said)',
  '        else {state: "done", id: $o.uuid, at: $o.timestamp, mid: $o.message.id, text: ($o | said)} end',
  '      elif $o.type == "user" and $o.isMeta != true and $o.isCompactSummary != true and ([$o.message.content[]?.type] | index("tool_result") | not) then',
  '        ($o | said) as $s',
  '        | if ($s | test("^\\\\[Request interrupted")) then {state: "done", id: $o.uuid, at: $o.timestamp, text: ""}',
  '          elif ($s | test("^\\\\s*<(command-name|command-message|local-command-|bash-input|bash-stdout|bash-stderr)")) then .',
  '          else {state: "busy", id: $o.uuid, at: $o.timestamp, text: ""} end',
  '      elif $o.type == "event_msg" and $o.payload.type == "task_complete" then {state: "done", id: $o.payload.turn_id, at: $o.timestamp, text: ($o.payload.last_agent_message // "")}',
  '      elif $o.type == "event_msg" and $o.payload.type == "turn_aborted" then {state: "done", id: $o.payload.turn_id, at: $o.timestamp, text: ""}',
  '      elif $o.type == "event_msg" and $o.payload.type == "task_started" then {state: "busy", id: $o.payload.turn_id, at: $o.timestamp, text: ""}',
  '      else . end)',
  '    | select(. != null) | [.state, .id, .at, ((.text // "") | cue)] | map(. // "" | tostring) | join("\\t")',
  "  ' 2>/dev/null",
  'done',
].join('\n')

export type Turn = { state: 'done' | 'busy'; id: string; at: number; cue?: Cue }

/** TURN_SCRIPT's answer: each file's last turn. */
export function parseTurns(stdout: string): Map<string, Turn> {
  const turns = new Map<string, Turn>()
  let file = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==> ')) {
      file = line.slice(4)
      continue
    }
    const [state, id = '', iso = '', cueLine = ''] = line.split('\t')
    const at = Date.parse(iso)
    if (file === '' || (state !== 'done' && state !== 'busy') || !/^[A-Za-z0-9-]{1,80}$/.test(id) || Number.isNaN(at)) continue
    const cue = state === 'done' ? cueOf(cueLine) : undefined
    turns.set(file, { state, id, at, ...(cue === undefined ? {} : { cue }) })
  }
  return turns
}

/** One agent of a workspace: its tmux pane, its last turn as its own records say, and whether it is at work. */
export type Side = { tool: Tool; pane: string; turn?: Turn; isBusy: boolean }

/**
 * What the relay does now. `key` is the step's own: done once, whichever
 * session takes it first.
 * - `pass`: type `line` into the agent `to`'s pane and press Enter.
 * - `tell`: tell the owner.
 */
export type Step =
  | { kind: 'pass'; key: string; to: Tool; pane: string; line: string }
  | { kind: 'tell'; key: string; text: string; isForOwner: boolean }

/**
 * The relay's steps for one workspace. An agent whose turn ended (since the
 * relay was turned on) with a cue for the other agent has it passed on once
 * that agent has finished a turn of its own (so it is past any question it
 * asks at its start) and is not at work; in `notify` mode, or after
 * RELAY_CAP passes in a row, the owner is told instead. A NEEDS USER or SCOPE CLOSED cue is the
 * owner's: they are told.
 */
export function relaySteps(ws: Pick<Workspace, 'name' | 'relay'>, sides: Partial<Record<Tool, Side>>, now: number, cap = RELAY_CAP): Step[] {
  const relay: Relay | undefined = ws.relay
  if (relay === undefined || relay.mode === 'off') return []
  const steps: Step[] = []
  for (const tool of ['claude', 'codex'] as const) {
    const side = sides[tool]
    const turn = side?.turn
    if (side === undefined || side.isBusy || turn?.state !== 'done' || turn.cue === undefined || turn.at < relay.since || now - turn.at > TURN_MAX_AGE_MS) continue
    const cue = turn.cue
    if (cue.kind !== 'ready') {
      const what = cue.kind === 'needs-user' ? 'needs you' : 'closed its scope and waits for you'
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, text: `${ws.name}: ${NAME[tool]} ${what}. ${cue.line}`, isForOwner: true })
      continue
    }
    if (cue.to === tool) continue
    const other = sides[cue.to]
    if (relay.mode === 'notify') {
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, text: `${ws.name}: ${NAME[tool]} handed over to ${NAME[cue.to]}. Paste: ${cue.line}`, isForOwner: false })
    } else if (other === undefined) {
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, text: `${ws.name}: ${NAME[tool]} handed over, but ${NAME[cue.to]} is not running in the workspace. Paste: ${cue.line}`, isForOwner: true })
    } else if (relay.streak >= cap) {
      steps.push({ kind: 'tell', key: `cap-${turn.id}`, text: `${ws.name}: the relay passed ${relay.streak} hand-offs in a row and waits for you; press continue in /sessions to pass the next.`, isForOwner: true })
    } else if (other.turn === undefined) {
      // an agent that has not finished a turn may be at a question of its own (trust, an update), which Enter would answer
      steps.push({ kind: 'tell', key: `wait-${turn.id}`, text: `${ws.name}: ${NAME[tool]} handed over; the relay passes it once ${NAME[cue.to]} has finished a turn. If ${NAME[cue.to]} is waiting at a question in its pane, answer it.`, isForOwner: false })
    } else if (!other.isBusy) {
      steps.push({ kind: 'pass', key: `pass-${turn.id}`, to: cue.to, pane: other.pane, line: cue.line })
    }
  }
  return steps
}

/** The agent a pane must have in its foreground for the relay to type into it: never only a shell. */
export const AGENT_COMMANDS: Record<Tool, string> = { claude: 'claude', codex: 'codex' }

/**
 * Does one relay step, once: "$1" pass or tell, "$2" the ledger folder, "$3"
 * the step's key (a folder made in the ledger, so a second session finds it
 * taken), "$4" the pane, "$5" the agent's command names (`a|b`), "$6" the
 * line or the text, "$7" a tmux socket name (tests: a private server that
 * reads no tmux.conf), "$8" the notification's title. A pass types the line
 * only while one of the pane's foreground processes is the agent (tmux
 * names only the group's leader, the shell that started it) and the pane is
 * not scrolled back (copy mode, where keys would go to tmux, not the agent),
 * and answers `passed`, `taken`, `gone`, `not-agent <the foreground
 * commands>`, `failed`, `in-mode` (the step is left untaken, to pass
 * later), or `unsent` (the pane went into copy mode while the line was
 * typed: it waits in the agent's input, for Enter). A `;` that ends the line goes as its key code: tmux takes an
 * argument ending in `;` as the end of a command and drops it.
 */
export const RELAY_SCRIPT = [
  'kind=$1; ledger=$2; key=$3; pane=$4; allow=$5; text=$6; sock=$7; title=$8',
  't() { if [ -n "$sock" ]; then tmux -L "$sock" -f /dev/null "$@"; else tmux "$@"; fi; }',
  'mkdir -p "$ledger" || exit 1',
  'find "$ledger" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rmdir {} + 2>/dev/null',
  'mkdir "$ledger/$key" 2>/dev/null || { echo taken; exit 0; }',
  'if [ "$kind" = tell ]; then',
  `  /usr/bin/osascript -l JavaScript -e 'function run(a) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayNotification(a[1], { withTitle: a[0] }) }' "$title" "$text" >/dev/null 2>&1`,
  '  echo told; exit 0',
  'fi',
  `tty=$(t display-message -p -t "$pane" '#{pane_tty}' 2>/dev/null) && [ -n "$tty" ] || { echo gone; exit 0; }`,
  `cmds=$(ps -t "\${tty#/dev/}" -o stat=,comm= 2>/dev/null | awk '$1 ~ /[+]/ { n = $2; sub(".*/", "", n); print n }' | sort -u)`,
  'ok=; for c in $cmds; do case "|$allow|" in *"|$c|"*) ok=1;; esac; done',
  '[ -n "$ok" ] || { printf \'not-agent %s\\n\' "$(echo $cmds)"; exit 0; }',
  `[ "$(t display-message -p -t "$pane" '#{pane_in_mode}' 2>/dev/null)" = 0 ] || { rmdir "$ledger/$key"; echo in-mode; exit 0; }`,
  'body=$text; semis=',
  'while [ "${body%;}" != "$body" ]; do body=${body%;}; semis="$semis;"; done',
  't send-keys -t "$pane" -l -- "$body" || { echo failed; exit 0; }',
  'while [ -n "$semis" ]; do t send-keys -t "$pane" -H 3b || { echo failed; exit 0; }; semis=${semis%;}; done',
  'sleep 0.5',
  `[ "$(t display-message -p -t "$pane" '#{pane_in_mode}' 2>/dev/null)" = 0 ] || { echo unsent; exit 0; }`,
  't send-keys -t "$pane" Enter && echo passed || echo failed',
].join('\n')

/**
 * Why a pass was not made, said for the owner; undefined when it was, or
 * will be (`in-mode`: it is passed once the pane leaves copy mode).
 */
export function passFailure(outcome: string): string | undefined {
  if (outcome === 'passed' || outcome === 'in-mode' || outcome === 'taken') return undefined
  if (outcome.startsWith('not-agent')) return `its pane runs ${outcome.slice(10) || 'something else'}, not the agent`
  if (outcome === 'gone') return 'its pane is gone'
  if (outcome === 'unsent') return 'its pane was scrolled back (copy mode) as the line was typed, so the line waits in its input: leave copy mode (q) and press Enter there'
  return 'tmux could not type into its pane'
}

/** The relay's state after a step: a pass counts toward the cap; a cue for the owner starts the count again. */
export function afterStep(relay: Relay, step: Step, outcome: string, now: number): Relay {
  if (step.kind === 'pass' && outcome === 'passed') return { ...relay, streak: relay.streak + 1, status: `passed to ${NAME[step.to]}`, at: now }
  if (step.kind === 'pass' && outcome === 'in-mode') return { ...relay, status: `waits: ${NAME[step.to]}'s pane is scrolled back (copy mode; q leaves it)`, at: now }
  if (step.kind === 'pass') return { ...relay, status: `could not pass to ${NAME[step.to]}`, at: now }
  if (step.key.startsWith('cap-')) return { ...relay, status: 'waits for you', at: now }
  if (step.key.startsWith('wait-')) return { ...relay, status: 'waits for the other agent\'s first turn', at: now }
  return step.isForOwner ? { ...relay, streak: 0, status: 'needs you', at: now } : { ...relay, status: 'told you', at: now }
}
