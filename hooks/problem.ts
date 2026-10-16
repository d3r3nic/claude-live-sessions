// The main problem a workspace works on, in plain words, for its owner coming back to it after a while: its own Claude
// is asked (a fork of its conversation, which its chat never shows) when the owner gives it something new, and the
// answer is kept on the workspace, shown in the ops screen's details and on a line of its own at the top of the
// workspace's window. Pure: no `$`, so the tests drive it directly.
import type { Workspace } from '../types'
import { CHECKIN_START, cueOf } from './relay'

/** The longest a problem is kept and shown, in characters. */
export const PROBLEM_MAX = 300
/** How long after an attempt (done or not) a workspace's Claude is asked again at the end of a turn. */
export const PROBLEM_RETRY_MS = 10 * 60_000
/** The longest part of the owner's new words the question carries. */
const OWNER_TEXT_MAX = 4000

/**
 * What its Claude is asked, as one more message after its conversation (a fork: its tools denied, its reply never
 * shown in its chat): the main problem, in one or two plain sentences. `ownerText`: what the owner has just typed,
 * which the conversation does not hold yet.
 */
export function problemAsk(ownerText?: string): string {
  const words = ownerText === undefined ? '' : [...ownerText.trim()].slice(0, OWNER_TEXT_MAX).join('')
  return [
    'A question from the workspace this conversation runs in, not from the owner. Answer it in plain text alone, with no tool, and do nothing else.',
    ...(words === '' ? [] : ['The owner has just written the message below, which you have not answered yet; take it into account:', JSON.stringify(words)]),
    'The owner runs several workspaces at once and comes back to this one later, having lost track of it. In one or two short sentences (at most 40 words), say what main problem is being worked on here: what is wrong or wanted, and why it matters to them.',
    'Write it in everyday words for someone who has not followed the work: no file, function, command or code names, and no jargon.',
    "Say the main problem the owner brought, not the step being taken now. If the owner's newest words go on with the same problem, say that same problem.",
    'If no work has been asked for yet, answer: none',
  ].join('\n')
}

// said to the owner: one line, no control characters (C0, C1), no invisible direction or joining controls
const oneLine = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim()

/** At most PROBLEM_MAX characters, cut at a word where it has to be, with `…`. */
function cutWords(text: string): string {
  const chars = [...text]
  if (chars.length <= PROBLEM_MAX) return text
  const kept = chars.slice(0, PROBLEM_MAX - 1).join('')
  const space = kept.lastIndexOf(' ')
  return `${space > PROBLEM_MAX / 2 ? kept.slice(0, space) : kept}…`
}

/**
 * The problem in Claude's reply, if it holds one: one line, a label it put first (`Main problem:`), quotes and marks
 * around it dropped, cut to PROBLEM_MAX; none for `none` or nothing.
 */
export function problemOf(reply: string): string | undefined {
  const text = oneLine(reply)
    .replace(/[`*_]+/g, '')
    .replace(/^(?:main problem|problem)\s*[:—–-]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
  // (`none`, alone or with a reason after a stop or a dash: never a problem that starts with the word, `None of …`)
  if (text === '' || /^none\s*(?:$|[.:;,—–-])/i.test(text)) return undefined
  return cutWords(text)
}

/** A saved problem, if it is one: one this does not read is dropped, never costs the workspace. */
export function problemFrom(raw: unknown): Workspace['problem'] | undefined {
  const o = raw as { text?: unknown; at?: unknown } | null
  if (typeof o !== 'object' || o === null || typeof o.text !== 'string' || typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
  const text = cutWords(oneLine(o.text))
  return text === '' ? undefined : { text, at: o.at }
}

/**
 * Whether a prompt typed at the agent's terminal gives it something: not what the relay types there (a hand-off, a cue
 * line alone, pasted or not, or a check-in), a command alone (`/model`, `/compact …`), an interrupt or an engine's own
 * message (`<task-notification>`; as the relay reads the owner's typing, TURN_SCRIPT's `keyed`).
 */
export function isOwnersPrompt(text: string): boolean {
  if (/^\s*(\[Request interrupted|<(?!command-name>|command-message>|bash-input>|pasted_content))/.test(text)) return false
  const lines = text.replace(/<\/?pasted_content[^>]*>/g, '').split('\n').filter(line => /\S/.test(line))
  if (lines.length === 0) return false
  if (/^\s*\/compact(\s|$)/.test(lines[0]!) || (lines.length === 1 && /^\s*\/\S+\s*$/.test(lines[0]!))) return false
  return !(lines.length === 1 && (cueOf(lines[0]!) !== undefined || lines[0]!.trim().startsWith(CHECKIN_START)))
}

/**
 * Whether its Claude is asked at the end of a turn: the workspace has no problem yet, or the owner has typed to one of
 * its agents since it was said (to Codex, say, the hand-offs since bringing it to Claude); never within
 * PROBLEM_RETRY_MS of the last attempt.
 */
export function isProblemDue(ws: Pick<Workspace, 'problem' | 'relay'>, now: number, triedAt = 0): boolean {
  if (now - triedAt < PROBLEM_RETRY_MS) return false
  return ws.problem === undefined || (ws.relay?.typedAt ?? 0) > ws.problem.at
}

/** The tmux session option holding the problem its window shows. */
export const PROBLEM_OPTION = '@live-sessions-problem'
/** The problem's line on the window's bar: dark on pale yellow, unlike the bar above it. */
export const PROBLEM_FORMAT = `#[fill=#ffe8a3 bg=#ffe8a3 fg=#1f1a00]#[bold] MAIN PROBLEM #[nobold] #{${PROBLEM_OPTION}} `

/**
 * tmux commands that show `problem` on a second line of the workspace session `name`'s bar, under the bar tmux.conf
 * draws (`firstLine`, tmux.conf's `status-format[0]`, which a session's own `status-format` would otherwise leave
 * out), or with no problem, or that first line not read, that take the line away. The problem is an option the
 * line's format names, so nothing in it is ever run; each `#` doubled, so none starts a style.
 */
export function problemLine(name: string, problem: string | undefined, firstLine: string | undefined): string[][] {
  if (problem === undefined || problem === '' || firstLine === undefined || firstLine === '') {
    return [['set-option', '-u', '-t', name, 'status'], ['set-option', '-u', '-t', name, 'status-format'], ['set-option', '-u', '-t', name, PROBLEM_OPTION]]
  }
  return [
    ['set-option', '-t', name, PROBLEM_OPTION, problem.replace(/#/g, '##')],
    ['set-option', '-t', name, 'status-format[0]', firstLine],
    ['set-option', '-t', name, 'status-format[1]', PROBLEM_FORMAT],
    ['set-option', '-t', name, 'status', '2'],
  ]
}
