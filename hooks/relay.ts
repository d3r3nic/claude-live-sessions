// The relay: in a workspace, passes each agent's peer-coding cue to the
// other agent, as the owner did by copy and paste, and tells the owner when
// a cue is for them. Pure: no `$`, so the tests drive it directly.
import type { Relay, Workspace } from '../types'

/** Cues passed on in a row before the relay waits for the owner. */
export const RELAY_CAP = 10

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
 * way. Claude's transcript ends a turn with an `end_turn` reply and starts one
 * with a prompt; a Codex rollout with `task_complete` and `task_started`.
 * Nothing else of what was said leaves the pipeline.
 */
export const TURN_SCRIPT = [
  'for f in "$@"; do',
  `  printf '==> %s\\n' "$f"`,
  '  tail -n 600 "$f" 2>/dev/null | /usr/bin/jq -r -c \'',
  '    def cue: split("\\n") | map(select(test("^\\\\s*(?:[0-9]+\\\\.|[-*>])?\\\\s*[`*_]*(READY FOR (CLAUDE|CODEX)|NEEDS USER|SCOPE CLOSED) · "))) | (last // "") | gsub("[\\t\\r]"; " ");',
  '    if .isSidechain == true then empty',
  '    elif .type == "assistant" and .message.stop_reason == "end_turn" then',
  '      ["done", .uuid, .timestamp, ([.message.content[]? | select(.type == "text") | .text] | join("\\n") | cue)]',
  '    elif .type == "user" and .isMeta != true and ((.message.content | type) == "string" or ([.message.content[]?.type] | index("tool_result") | not)) then',
  '      ["busy", .uuid, .timestamp, ""]',
  '    elif .type == "event_msg" and .payload.type == "task_complete" then',
  '      ["done", .payload.turn_id, .timestamp, ((.payload.last_agent_message // "") | cue)]',
  '    elif .type == "event_msg" and .payload.type == "task_started" then ["busy", .payload.turn_id, .timestamp, ""]',
  '    else empty end',
  '    | map(. // "" | tostring) | join("\\t")',
  "  ' 2>/dev/null | tail -n 1",
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
export function relaySteps(ws: Pick<Workspace, 'name' | 'relay'>, sides: Partial<Record<Tool, Side>>, cap = RELAY_CAP): Step[] {
  const relay: Relay | undefined = ws.relay
  if (relay === undefined || relay.mode === 'off') return []
  const steps: Step[] = []
  for (const tool of ['claude', 'codex'] as const) {
    const side = sides[tool]
    const turn = side?.turn
    if (side === undefined || side.isBusy || turn?.state !== 'done' || turn.cue === undefined || turn.at < relay.since) continue
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

/** What a pane must be running for the relay to type into it: the agent, never a shell. */
export const AGENT_COMMANDS: Record<Tool, string> = { claude: 'claude', codex: 'node|codex' }

/**
 * Does one relay step, once: "$1" pass or tell, "$2" the ledger folder, "$3"
 * the step's key (a folder made in the ledger, so a second session finds it
 * taken), "$4" the pane, "$5" the commands it may be running (`a|b`), "$6"
 * the line or the text, "$7" a tmux socket name (tests: a private server
 * that reads no tmux.conf), "$8" the
 * notification's title. A pass types the line only while the pane runs the
 * agent, and answers `passed`, `taken`, `gone` or `not-agent <command>`.
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
  `cmd=$(t display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null) && [ -n "$cmd" ] || { echo gone; exit 0; }`,
  'case "|$allow|" in *"|$cmd|"*) ;; *) printf \'not-agent %s\\n\' "$cmd"; exit 0;; esac',
  't send-keys -t "$pane" -l -- "$text" && sleep 0.5 && t send-keys -t "$pane" Enter && echo passed',
].join('\n')

/** The relay's state after a step: a pass counts toward the cap; a cue for the owner starts the count again. */
export function afterStep(relay: Relay, step: Step, outcome: string, now: number): Relay {
  if (step.kind === 'pass' && outcome === 'passed') return { ...relay, streak: relay.streak + 1, status: `passed to ${NAME[step.to]}`, at: now }
  if (step.kind === 'pass') return { ...relay, status: `could not pass to ${NAME[step.to]}`, at: now }
  if (step.key.startsWith('cap-')) return { ...relay, status: 'waits for you', at: now }
  if (step.key.startsWith('wait-')) return { ...relay, status: 'waits for the other agent\'s first turn', at: now }
  return step.isForOwner ? { ...relay, streak: 0, status: 'needs you', at: now } : { ...relay, status: 'told you', at: now }
}
