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
 * A sixth field is how full a Codex conversation's context is, in percent,
 * from its last token count. A fifth field is when the owner last typed into the agent: a prompt (one
 * typed while it works too), a command (`/model`, `/peer-coding …`, `!ls`)
 * or a paste; not a line that starts with a cue and is all there is (the
 * relay's, pasted or not), a compaction (`/compact`, which the relay may
 * send), a background task's notice or an interrupt.
 * A subagent's records, and a line cut by `tail`, are skipped.
 */
export const TURN_SCRIPT = [
  'for f in "$@"; do',
  `  printf '==> %s\\n' "$f"`,
  "  tail -n 600 \"$f\" 2>/dev/null | /usr/bin/jq -R -n -r '",
  '    def cue: split("\\n") | map(select(test("^\\\\s*(?:[0-9]+\\\\.|[-*>])?\\\\s*[`*_]*(READY FOR (CLAUDE|CODEX)|NEEDS USER|SCOPE CLOSED) · "))) | (last // "") | gsub("[\\t\\r]"; " ");',
  '    def compacting: test("^\\\\s*/compact(\\\\s|$)|^\\\\s*(<command-message>compact</command-message>\\\\s*)?<command-name>/compact</command-name>");',
  // a compaction (`/compact`, which Claude Code also records as a prompt of that line) is never a turn, and never
  // the owner's presence: the relay sends it too
  '    def said: if (.message.content | type) == "string" then .message.content else ([.message.content[]? | select(.type == "text") | .text] | join("\\n")) end;',
  '    def step($o):',
  '      if $o.type == "assistant" and (($o.message.stop_reason // "") as $r | $r == "tool_use" or $r == "pause_turn" or $r == "") then',
  '        {state: "busy", id: $o.uuid, at: $o.timestamp, text: ""}',
  '      elif $o.type == "assistant" then',
  '        if . != null and .state == "done" and .mid != null and .mid == $o.message.id then .text += "\\n" + ($o | said)',
  '        else {state: "done", id: $o.uuid, at: $o.timestamp, mid: $o.message.id, text: ($o | said)} end',
  '      elif $o.type == "user" and $o.isMeta != true and $o.isCompactSummary != true and ([$o.message.content[]?.type] | index("tool_result") | not) then',
  '        ($o | said) as $s',
  '        | if ($s | test("^\\\\[Request interrupted")) then {state: "done", id: $o.uuid, at: $o.timestamp, text: ""}',
  '          elif ($s | test("^\\\\s*<(command-name|command-message|local-command-|bash-input|bash-stdout|bash-stderr)") or ($s | compacting)) then .',
  '          else {state: "busy", id: $o.uuid, at: $o.timestamp, text: ""} end',
  '      elif $o.type == "event_msg" and $o.payload.type == "task_complete" then {state: "done", id: $o.payload.turn_id, at: $o.timestamp, text: ($o.payload.last_agent_message // "")}',
  '      elif $o.type == "event_msg" and $o.payload.type == "turn_aborted" then {state: "done", id: $o.payload.turn_id, at: $o.timestamp, text: ""}',
  '      elif $o.type == "event_msg" and $o.payload.type == "task_started" then {state: "busy", id: $o.payload.turn_id, at: $o.timestamp, text: ""}',
  '      else . end;',
  '    def text: if (.content | type) == "string" then .content else ([.content[]? | select(.type == "text") | .text] | join("\\n")) end;',
  // the relay's own message is one line, a cue; a paste's wrapper is not the owner's words, so a cue pasted alone
  // is still only a cue (lines are split, not trimmed: a trim's regex slows on a long run of spaces)
  '    def typed: gsub("</?pasted_content[^>]*>"; "") | [splits("\\n") | select(test("\\\\S"))] | (length == 1 and (.[0] | cue) != "") | not;',
  '    def textOf: if type == "string" then . elif type == "array" then [.[]? | objects | select(.type == "text") | .text | strings] | join("\\n") else "" end;',
  '    def kindOf: if type == "object" then .kind else null end;',
  // what the person typed: Claude Code marks it `origin.kind: human` (a prompt, a skill or prompt command, a
  // paste; one typed while the agent works is kept as a queued_command attachment); a record from before
  // that mark is read by its text: not an interrupt, a background task's notice or another engine tag
  '    def keyed: test("^\\\\s*($|\\\\[Request interrupted|<(?!command-name>|command-message>|bash-input>|pasted_content))") | not;',
  '    def owner:',
  '      if .type == "user" then .isMeta != true and .isCompactSummary != true and ([.message.content[]?.type] | index("tool_result") | not)',
  '        and ((.origin | kindOf) as $k | if $k != null then $k == "human" else (said | keyed) end) and (said | typed) and (said | compacting | not)',
  '      elif .type == "attachment" and .attachment.type == "queued_command" then (.attachment.commandMode // "prompt") == "prompt"',
  '        and ((.attachment.origin | kindOf) // "human") == "human" and (.attachment.prompt | textOf | keyed and typed and (compacting | not))',
  '      elif .type == "event_msg" and .payload.type == "user_message" then .payload.message // "" | typed and (compacting | not)',
  '      elif .type == "event_msg" and .payload.type == "item_completed" and .payload.item.type == "UserMessage" then .payload.item | text | typed and (compacting | not)',
  '      else false end;',
  // how full Codex's context is: its last count of tokens against its model's window, as a whole percentage
  '    def filled: try (.payload.info | .model_context_window as $w | .last_token_usage.total_tokens as $t | if ($w | type) == "number" and $w > 0 and ($t | type) == "number" then ($t * 100 / $w | floor) else null end) catch null;',
  '    reduce (inputs | fromjson? | select(type == "object" and .isSidechain != true)) as $o ({t: null, o: null, c: null};',
  '      {t: (.t | step($o)), o: (if ($o | owner) then $o.timestamp else .o end),',
  '       c: (if $o.type == "event_msg" and $o.payload.type == "token_count" then ($o | filled) // .c else .c end)})',
  '    | .o as $typed | .c as $filled | .t | select(. != null) | [.state, .id, .at, ((.text // "") | cue), $typed, $filled] | map(. // "" | tostring) | join("\\t")',
  "  ' 2>/dev/null",
  'done',
].join('\n')

/**
 * An agent's last turn; `typedAt`, when the owner last typed into the agent (as far back as the pipeline
 * reads); `filled`, how full a Codex conversation's context is, in percent.
 */
export type Turn = { state: 'done' | 'busy'; id: string; at: number; cue?: Cue; typedAt?: number; filled?: number }

/** TURN_SCRIPT's answer: each file's last turn. */
export function parseTurns(stdout: string): Map<string, Turn> {
  const turns = new Map<string, Turn>()
  let file = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==> ')) {
      file = line.slice(4)
      continue
    }
    const [state, id = '', iso = '', cueLine = '', typedIso = '', filledText = ''] = line.split('\t')
    const at = Date.parse(iso)
    if (file === '' || (state !== 'done' && state !== 'busy') || !/^[A-Za-z0-9-]{1,80}$/.test(id) || Number.isNaN(at)) continue
    const cue = state === 'done' ? cueOf(cueLine) : undefined
    const typedAt = Date.parse(typedIso)
    const filled = /^\d{1,3}$/.test(filledText) ? Number(filledText) : undefined
    turns.set(file, { state, id, at, ...(cue === undefined ? {} : { cue }), ...(Number.isNaN(typedAt) ? {} : { typedAt }), ...(filled === undefined ? {} : { filled }) })
  }
  return turns
}

/** One agent of a workspace: its tmux pane, its last turn as its own records say, and whether it is at work. */
export type Side = { tool: Tool; pane: string; turn?: Turn; isBusy: boolean; filled?: number }

/**
 * What the relay does now. `key` is the step's own: done once, whichever
 * session takes it first.
 * - `pass`: type `line` into the agent `to`'s pane and press Enter.
 * - `tell`: tell the owner.
 */
export type Step =
  | { kind: 'pass'; key: string; from?: Tool; to: Tool; pane: string; line: string }
  | { kind: 'tell'; key: string; from?: Tool; text: string; isForOwner: boolean }
  | { kind: 'compact'; key: string; to: Tool; pane: string; line: string; filled: number }

/**
 * The relay's steps for one workspace. An agent whose turn ended (since the
 * relay was turned on) with a cue for the other agent has it passed on once
 * that agent has finished a turn of its own (so it is past any question it
 * asks at its start) and is not at work; in `notify` mode, or after
 * RELAY_CAP passes in a row with no prompt from the owner, the owner is told instead. A NEEDS USER or SCOPE CLOSED cue is the
 * owner's: they are told.
 */
export function relaySteps(ws: Pick<Workspace, 'name' | 'relay'> & Partial<Pick<Workspace, 'threads'>>, sides: Partial<Record<Tool, Side>>, now: number, cap = RELAY_CAP): Step[] {
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
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, from: tool, text: `${ws.name}: ${NAME[tool]} ${what}. ${cue.line}`, isForOwner: true })
      continue
    }
    if (cue.to === tool) continue
    const other = sides[cue.to]
    if (relay.mode === 'notify') {
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, from: tool, text: `${ws.name}: ${NAME[tool]} handed over to ${NAME[cue.to]}. Paste: ${cue.line}`, isForOwner: false })
    } else if (other === undefined) {
      steps.push({ kind: 'tell', key: `tell-${turn.id}`, from: tool, text: `${ws.name}: ${NAME[tool]} handed over, but ${NAME[cue.to]} is not running in the workspace. Paste: ${cue.line}`, isForOwner: true })
    } else if (other.turn === undefined || other.turn.at < (ws.threads?.[cue.to]?.since ?? -Infinity)) {
      // an agent that has not finished a turn (one resuming its conversation: a turn in this workspace) may be at a
      // question of its own (trust, an update), which Enter would answer
      steps.push({ kind: 'tell', key: `wait-${turn.id}`, text: `${ws.name}: ${NAME[tool]} handed over; the relay passes it once ${NAME[cue.to]} has finished a turn. If ${NAME[cue.to]} is waiting at a question in its pane, answer it.`, isForOwner: false })
    } else if (other.isBusy) {
      continue
    } else if (relay.streak >= cap) {
      // a cue already passed is never held: the ledger takes this step when it has its pass (RELAY_SCRIPT)
      steps.push({ kind: 'tell', key: `cap-${turn.id}`, text: `${ws.name}: the relay passed ${relay.streak} hand-offs in a row and waits for you; type to either agent, or press continue in /sessions, to pass the next.`, isForOwner: true })
    } else {
      steps.push({ kind: 'pass', key: `pass-${turn.id}`, from: tool, to: cue.to, pane: other.pane, line: cue.line })
    }
  }
  return steps
}

/** How full an agent's context may get, in percent, before it is compacted once its cue is handed on. */
export const COMPACT_AT = 50

/**
 * Compacting Codex at a point that suits it: right after this session passed
 * its hand-off to Claude (typed and entered, so its cue is delivered and a
 * compaction, which Codex runs as a turn of its own, cannot lose it), when its
 * context is at least the workspace's `compactAt` percent full (COMPACT_AT
 * unless set; 0 is off): `/compact` typed into its pane, once for that turn.
 * Never into a pane typed into during this collection (it may be starting a
 * turn), never after a cue for the owner (it waits for the owner's answer).
 * Claude compacts itself, in its own session (compactAtHandOff).
 */
export function compactStep(ws: Pick<Workspace, 'compactAt'>, sides: Partial<Record<Tool, Side>>, handed: Step, outcome: string, typedInto: ReadonlySet<string>): Step | undefined {
  if (handed.kind !== 'pass' || handed.from !== 'codex' || outcome !== 'passed') return undefined
  const side = sides.codex
  const at = ws.compactAt ?? COMPACT_AT
  const turn = side?.turn
  if (side === undefined || at <= 0 || typedInto.has(side.pane) || turn?.state !== 'done' || turn.cue?.kind !== 'ready' || side.filled === undefined || side.filled < at) return undefined
  return { kind: 'compact', key: `compact-${turn.id}`, to: 'codex', pane: side.pane, line: '/compact', filled: side.filled }
}

/** What Claude is told to keep when it compacts in a workspace: the rest is in the peer-coding records. */
export function claudeKeep(name: string): string {
  // one line: no control character from the workspace's name
  return `Peer-coding workspace "${name.replace(/[\u0000-\u001f\u007f]/g, ' ')}": keep what it is for, the peer-coding branch and its worktree, the round, where the peer-coding records are (CURRENT.md), what the owner decided, and the cue you last sent; the details stay in those records.`
}

/** One line of the relay's event log, which the ops screen reads: what happened, in a workspace, at an agent. */
export type RelayEvent = { kind: string; text: string; workspace: string; agent?: Tool }

/**
 * What a step that was carried out is, for the event log (none for one taken
 * already, or waiting on a scrolled-back pane): a hand-off passed, one that
 * could not be, what is the owner's, a hold, a compaction.
 */
export function eventOf(ws: Pick<Workspace, 'id' | 'name'>, step: Step, outcome: string): RelayEvent | undefined {
  const event = eventFor(ws, step, outcome)
  // its line well under 1 KB (any script): an append that size is one write, never split or mixed with another's
  return event === undefined ? undefined : { ...event, text: cutBytes(event.text, 600) }
}

/** Text cut to at most `max` bytes as it is written in a JSON line (UTF-8, escapes counted), whole characters kept. */
export function cutBytes(text: string, max: number): string {
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const n = ch.codePointAt(0)!
    bytes += ch === '"' || ch === '\\' ? 2 : n < 0x20 ? 6 : n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4
    if (bytes > max) break
    out += ch
  }
  return out
}

function eventFor(ws: Pick<Workspace, 'id' | 'name'>, step: Step, outcome: string): RelayEvent | undefined {
  if (outcome === 'taken' || outcome === 'in-mode') return undefined
  const at = { workspace: ws.id }
  if (step.kind === 'compact') return outcome === 'passed' ? { ...at, kind: 'compact', text: `${ws.name}: ${NAME[step.to]} compacting (its context ${step.filled}% full)`, agent: step.to } : undefined
  if (step.kind === 'pass') {
    const why = passFailure(outcome)
    return why === undefined
      ? { ...at, kind: 'relay', text: `${ws.name}: ${step.from === undefined ? '' : `${NAME[step.from]} → `}${NAME[step.to]}: ${step.line}`, agent: step.to }
      : { ...at, kind: 'failed', text: `${ws.name}: not passed to ${NAME[step.to]}: ${why}`, agent: step.to }
  }
  // a tell that did not happen (its ledger step could not be made) is no event
  if (outcome !== 'told') return undefined
  const kind = step.key.startsWith('cap-') || step.key.startsWith('wait-') ? 'waits' : step.isForOwner ? 'needs' : 'notify'
  return { ...at, kind, text: step.text, ...(step.from === undefined ? {} : { agent: step.from }) }
}

/**
 * Adds the JSON event "$2" (a few hundred characters at most, so one append
 * that is never split or mixed with another session's) as a line of the
 * event log "$1", made if need be. Past 1000 lines the log is renamed to
 * "$1.1" (the one before it dropped) and a new one begun: a rename, so a
 * session appending meanwhile adds to the old one and nothing is lost; one
 * session at a time does it.
 */
export const EVENT_SCRIPT = [
  'f=$1; line=$2',
  'mkdir -p "$(dirname "$f")" || exit 0',
  `printf '%s\n' "$line" >> "$f"`,
  'n=$(/usr/bin/wc -l < "$f" 2>/dev/null | /usr/bin/tr -d " ")',
  '[ "${n:-0}" -gt 1000 ] || exit 0',
  // one session moves it, under a lock (one left by a session that died goes after a minute), counting again first:
  // two moving it at once would put the new, short log over the one just moved
  'lock="$f.lock"',
  'if /bin/mkdir "$lock" 2>/dev/null; then',
  '  n=$(/usr/bin/wc -l < "$f" 2>/dev/null | /usr/bin/tr -d " ")',
  '  if [ "${n:-0}" -gt 1000 ]; then /bin/mv -f "$f" "$f.1"; fi',
  '  /bin/rmdir "$lock"',
  'elif [ -n "$(/usr/bin/find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then',
  '  /bin/rmdir "$lock" 2>/dev/null',
  'fi',
  'exit 0',
].join('\n')

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
 * later), or `unsent` (the pane went into copy mode after the line was
 * typed: it waits in the agent's input, for Enter). The check for copy
 * mode and the typing are one step of the tmux server, so a scroll between
 * them cannot turn the line into copy-mode keys; the line goes through a
 * tmux buffer, so tmux parses none of it.
 */
export const RELAY_SCRIPT = [
  'kind=$1; ledger=$2; key=$3; pane=$4; allow=$5; text=$6; sock=$7; title=$8',
  't() { if [ -n "$sock" ]; then tmux -L "$sock" -f /dev/null "$@"; else tmux "$@"; fi; }',
  'mkdir -p "$ledger" || exit 1',
  'find "$ledger" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rmdir {} + 2>/dev/null',
  // a cue held at the cap that was passed before the cap was reached is taken already
  'case $key in cap-*) [ -d "$ledger/pass-${key#cap-}" ] && { echo taken; exit 0; };; esac',
  'mkdir "$ledger/$key" 2>/dev/null || { echo taken; exit 0; }',
  'if [ "$kind" = tell ]; then',
  `  /usr/bin/osascript -l JavaScript -e 'function run(a) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayNotification(a[1], { withTitle: a[0] }) }' "$title" "$text" >/dev/null 2>&1`,
  '  echo told; exit 0',
  'fi',
  `tty=$(t display-message -p -t "$pane" '#{pane_tty}' 2>/dev/null) && [ -n "$tty" ] || { echo gone; exit 0; }`,
  `cmds=$(ps -t "\${tty#/dev/}" -o stat=,comm= 2>/dev/null | awk '$1 ~ /[+]/ { n = $0; sub(/^[ \\t]*[^ \\t]+[ \\t]+/, "", n); sub(".*/", "", n); print n }' | sort -u)`,
  // one command name a line (a name may hold a space): each matched whole
  'ok=; while IFS= read -r c; do case "|$allow|" in *"|$c|"*) ok=1;; esac; done <<EOF\n$cmds\nEOF',
  '[ -n "$ok" ] || { printf \'not-agent %s\\n\' "$(echo $cmds)"; exit 0; }',
  // typed only while the pane is not scrolled back, checked and done in one step of the tmux server; the
  // line goes through a buffer, so tmux reads none of it (a `;` that ends it stays)
  'case $key in *[!A-Za-z0-9-]*) echo failed; exit 0;; esac',
  'case $pane in %*[!0-9]*|%) echo gone; exit 0;; %*) ;; *) echo gone; exit 0;; esac',
  'buf="relay-$key"',
  `printf '%s' "$text" | t load-buffer -b "$buf" - || { echo failed; exit 0; }`,
  `r=$(t if-shell -F -t "$pane" '#{pane_in_mode}' 'display-message -p in-mode' "paste-buffer -p -d -b $buf -t $pane ; display-message -p typed" 2>/dev/null)`,
  'case $r in',
  '  typed) ;;',
  '  in-mode) t delete-buffer -b "$buf" 2>/dev/null; rmdir "$ledger/$key"; echo in-mode; exit 0;;',
  '  *) t delete-buffer -b "$buf" 2>/dev/null; echo failed; exit 0;;',
  'esac',
  'sleep 0.5',
  `r=$(t if-shell -F -t "$pane" '#{pane_in_mode}' 'display-message -p in-mode' "send-keys -t $pane Enter ; display-message -p sent" 2>/dev/null)`,
  'case $r in sent) echo passed;; in-mode) echo unsent;; *) echo failed;; esac',
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

/**
 * The relay's state once the owner has typed into either agent since the
 * count last started over (or since the relay was turned on): the count of
 * hand-offs in a row starts over, as the owner is there. Undefined when
 * there is nothing new.
 */
export function afterOwner(relay: Relay, sides: Partial<Record<Tool, Side>>): Relay | undefined {
  const typedAt = Math.max(0, ...Object.values(sides).map(s => s?.turn?.typedAt ?? 0))
  if (typedAt <= (relay.typedAt ?? relay.since)) return undefined
  return { ...relay, streak: 0, typedAt, ...(relay.status === 'waits for you' ? { status: 'going on' } : {}) }
}

/** The relay's state after a step: a pass counts toward the cap; a cue for the owner starts the count again. */
export function afterStep(relay: Relay, step: Step, outcome: string, now: number): Relay {
  // said after what the pass said, which it follows
  if (step.kind === 'compact') return outcome === 'passed' ? { ...relay, status: `${relay.status ?? ''}${relay.status === undefined ? '' : '; '}${NAME[step.to]} compacting (its context ${step.filled}% full)`, at: now } : relay
  if (step.kind === 'pass' && outcome === 'passed') return { ...relay, streak: relay.streak + 1, status: `passed to ${NAME[step.to]}`, at: now }
  if (step.kind === 'pass' && outcome === 'in-mode') return { ...relay, status: `waits: ${NAME[step.to]}'s pane is scrolled back (copy mode; q leaves it)`, at: now }
  if (step.kind === 'pass') return { ...relay, status: `could not pass to ${NAME[step.to]}`, at: now }
  if (step.key.startsWith('cap-')) return { ...relay, status: 'waits for you', at: now }
  // a cue held at the cap stays held while the other agent starts again: what the row says, and its continue, stay
  if (step.key.startsWith('wait-')) return { ...relay, status: relay.status === 'waits for you' ? relay.status : 'waits for the other agent\'s first turn', at: now }
  return step.isForOwner ? { ...relay, streak: 0, status: 'needs you', at: now } : { ...relay, status: 'told you', at: now }
}
