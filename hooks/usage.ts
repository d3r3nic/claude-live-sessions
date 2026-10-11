import type { UsageLimit, UsageRow } from '../types'

// What each project costs of an account's plan: token counts from Claude Code transcripts and Codex rollouts, read
// by usage.pl (once, then only what was added), kept in 10-minute slots per account, tool and folder, and set
// against the limits each account last reported.

/** How long the slots are kept, and the longest window ranked. */
export const USAGE_KEEP_MS = 7 * 86_400_000 + 3_600_000
const SLOT_MS = 600_000

/**
 * The files usage.pl reads, under the config directories "$@": each Claude
 * transcript (subagents' too) and Codex rollout (archived too) written in
 * the last 8 days, one per line.
 */
export const USAGE_FILES_SCRIPT = [
  'for d in "$@"; do',
  '  [ -d "$d" ] || continue',
  '  /usr/bin/find "$d/projects" "$d/sessions" "$d/archived_sessions" -name "*.jsonl" -mtime -8 2>/dev/null',
  'done',
].join('\n')

/** Where a file read so far was left: the byte after its last whole line, and usage.pl's mark for it. */
export type FileMark = { offset: number; mark: string }

/** A Codex limit's reading, from the record that carried it. */
type CodexReading = { at: number; used: number; resetsAt?: number }

/**
 * What has been read: each file's mark (a Codex rollout by its name alone:
 * archived, it moves to another folder and is the same file); each Claude
 * reply counted, by id (its slot), so a continued conversation's copy of it
 * is not counted again; per `tool \t account \t folder`, each 10-minute
 * slot's cost (Claude: US dollars at API list prices; Codex: weighted
 * tokens, see codexUnits); and each Codex account's latest reading of each
 * limit window. Version 2: replies' whole output (version 1 counted a
 * reply's first record, written mid-stream).
 */
export type UsageState = {
  version: 2
  at: number
  files: Record<string, FileMark>
  seen: Record<string, number>
  slots: Record<string, Record<string, number>>
  codexLimits: Record<string, Record<string, CodexReading>>
}

export const EMPTY_USAGE: UsageState = { version: 2, at: 0, files: {}, seen: {}, slots: {}, codexLimits: {} }

/** Where a file's mark is kept: a Codex rollout by its name (it is moved when archived), any other by its path. */
export function markKey(file: string): string {
  const name = /\/(rollout-[^/]+\.jsonl)$/.exec(file)?.[1]
  return name === undefined ? file : `rollout:${name}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A state read back from its file, if it is one (each part this does not read left out); else empty (read again from the start). */
export function usageFrom(raw: unknown): UsageState {
  const o = raw as Partial<UsageState> | null
  if (!isRecord(o) || o.version !== 2 || !isNumber(o.at)) return EMPTY_USAGE
  if (!isRecord(o.files) || !isRecord(o.seen) || !isRecord(o.slots) || !isRecord(o.codexLimits)) return EMPTY_USAGE
  const files = Object.fromEntries(Object.entries(o.files).filter((e): e is [string, FileMark] => {
    const m = e[1] as Partial<FileMark> | null
    return isRecord(m) && Number.isInteger(m.offset) && m.offset! >= 0 && typeof m.mark === 'string'
  }))
  const seen = Object.fromEntries(Object.entries(o.seen).filter((e): e is [string, number] => isNumber(e[1])))
  const slots = Object.fromEntries(Object.entries(o.slots).filter(([, v]) => isRecord(v)).map(([k, v]) =>
    [k, Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => isNumber(e[1])))]))
  const codexLimits = Object.fromEntries(Object.entries(o.codexLimits).filter(([, v]) => isRecord(v)).map(([account, windows]) =>
    [account, Object.fromEntries(Object.entries(windows as Record<string, unknown>).filter((e): e is [string, CodexReading] => {
      const r = e[1] as Partial<CodexReading> | null
      return isRecord(r) && isNumber(r.at) && isNumber(r.used) && (r.resetsAt === undefined || isNumber(r.resetsAt))
    }))]))
  return { version: 2, at: o.at, files, seen, slots, codexLimits }
}

/** usage.pl scan's standard input: each reply counted already, then one line per file, where it was left. */
export function scanInput(files: readonly string[], state: UsageState): string {
  return [
    ...Object.keys(state.seen).map(id => `S\t${id}\n`),
    ...files.map(f => `${f}\t${state.files[markKey(f)]?.offset ?? 0}\t${state.files[markKey(f)]?.mark ?? ''}\n`),
  ].join('')
}

/**
 * A run's output cut short (more than a run may print) to its last whole
 * file: the files before it are taken, the rest read again next time.
 */
export function wholeFiles(stdout: string): string {
  // the last `<== ` line that ends: one cut in the middle is not whole
  for (let from = stdout.length; ; ) {
    const at = stdout.lastIndexOf('\n<== ', from - 1)
    if (at < 0) return ''
    const end = stdout.indexOf('\n', at + 1)
    if (end >= 0) return stdout.slice(0, end + 1)
    from = at
  }
}

/** Dollars per million tokens: input, output and cache reads; cache writes are 1.25x input (5 minutes), 2x (an hour). */
type Price = { input: number; output: number; read: number }
/** API list prices by model (the claude-api reference, 2026-10); a model not named here is priced as Opus 5.5. */
const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/opus-5-5/, { input: 4, output: 20, read: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, read: 0.5 }],
  [/opus/, { input: 15, output: 75, read: 1.5 }],
  [/(fable|mythos)-5-1/, { input: 10, output: 50, read: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, read: 1 }],
  [/sonnet-5/, { input: 2, output: 10, read: 0.2 }],
  [/sonnet/, { input: 3, output: 15, read: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, read: 0.01 }],
  [/haiku/, { input: 1, output: 5, read: 0.1 }],
]
export const priceOf = (model: string): Price => PRICES.find(([match]) => match.test(model))?.[1] ?? PRICES[0]![1]

/** A Claude reply's cost at API list prices, in US dollars. */
export function claudeCost(model: string, n: { input: number; write5m: number; write1h: number; read: number; output: number }): number {
  const p = priceOf(model)
  return (n.input * p.input + n.write5m * p.input * 1.25 + n.write1h * p.input * 2 + n.read * p.read + n.output * p.output) / 1e6
}

/**
 * Codex's tokens weighed as OpenAI prices its GPT-5 family, relative to an
 * uncached input token: a cached one a tenth, an output token eight. Only
 * the shares between projects are shown, never a price.
 */
export function codexUnits(input: number, cached: number, output: number): number {
  return Math.max(0, input - cached) + cached * 0.1 + output * 8
}

/** A JSON string's raw spelling (escapes kept), as usage.pl prints a folder, read. */
function rawString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

const slotMs = (slot: string) => Date.parse(`${slot}:00Z`)

/**
 * usage.pl scan's output added to the state: each file's sums into its
 * account's slots, its mark kept; each Codex account's limits, the latest
 * reading of each window. `accountOf` names a file's account ('' for the
 * default), undefined for one that is not an account's. Slots older than
 * USAGE_KEEP_MS are dropped.
 */
export function applyScan(state: UsageState, stdout: string, now: number, accountOf: (file: string) => string | undefined): UsageState {
  const files = { ...state.files }
  const seen = { ...state.seen }
  const slots: UsageState['slots'] = Object.fromEntries(Object.entries(state.slots).map(([k, v]) => [k, { ...v }]))
  const codexLimits: UsageState['codexLimits'] = Object.fromEntries(Object.entries(state.codexLimits).map(([k, v]) => [k, { ...v }]))
  const add = (key: string, slot: string, value: number) => {
    const at = slotMs(slot)
    if (!Number.isFinite(at) || !Number.isFinite(value) || value <= 0) return
    const bySlot = (slots[key] ??= {})
    bySlot[String(at)] = (bySlot[String(at)] ?? 0) + value
  }
  let file: string | undefined
  let account: string | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==> ')) {
      file = line.slice(4)
      account = accountOf(file)
      continue
    }
    if (file === undefined || account === undefined) continue
    const f = line.split('\t')
    const n = (i: number) => Number(f[i] ?? '')
    if (f[0] === 'I' && f.length === 3) {
      const at = slotMs(f[2]!)
      if (Number.isFinite(at)) seen[f[1]!] = at
    } else if (f[0] === 'C' && f.length === 9) {
      add(`claude\t${account}\t${rawString(f[3]!)}`, f[1]!, claudeCost(f[2]!, { input: n(4), write5m: n(5), write1h: n(6), read: n(7), output: n(8) }))
    } else if (f[0] === 'X' && f.length === 6) {
      add(`codex\t${account}\t${rawString(f[2]!)}`, f[1]!, codexUnits(n(3), n(4), n(5)))
    } else if (f[0] === 'L' && f.length === 5) {
      const at = Date.parse(f[1]!)
      const window = windowOf(n(3))
      const known = codexLimits[account]?.[window ?? '']
      if (window === undefined || !Number.isFinite(at) || !Number.isFinite(n(2)) || (known !== undefined && known.at > at)) continue
      codexLimits[account] = { ...codexLimits[account], [window]: { at, used: n(2), ...(f[4] !== '' && Number.isFinite(n(4)) ? { resetsAt: n(4) * 1000 } : {}) } }
    } else if (line.startsWith('<== ')) {
      const [offset = '', ...mark] = line.slice(4).split('\t')
      if (/^\d+$/.test(offset)) files[markKey(file)] = { offset: Number(offset), mark: mark.join('\t') }
      file = undefined
    }
  }
  // what is past the longest window is forgotten
  for (const [key, bySlot] of Object.entries(slots)) {
    for (const at of Object.keys(bySlot)) if (Number(at) < now - USAGE_KEEP_MS) delete bySlot[at]
    if (Object.keys(bySlot).length === 0) delete slots[key]
  }
  for (const [id, at] of Object.entries(seen)) if (at < now - USAGE_KEEP_MS) delete seen[id]
  return { version: 2, at: now, files, seen, slots, codexLimits }
}

/** A limit window by its length in minutes: `5h`, `7d`; another is not shown. */
export function windowOf(minutes: number): '5h' | '7d' | undefined {
  return minutes === 300 ? '5h' : minutes === 10_080 ? '7d' : undefined
}
export const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 86_400_000 } as const

export type Limit = UsageLimit

/**
 * Claude's limits as a session reads them (`$.session.usage().rateLimits`):
 * `five_hour` and `seven_day`, used percent and reset time.
 */
export function claudeLimits(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], at: number): Partial<Record<'5h' | '7d', Limit>> {
  const out: Partial<Record<'5h' | '7d', Limit>> = {}
  for (const r of rateLimits) {
    const window = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : undefined
    if (window === undefined || !Number.isFinite(r.percentUsed)) continue
    const resetsAt = r.resetsAt === undefined ? Number.NaN : Date.parse(r.resetsAt)
    out[window] = { used: r.percentUsed, at, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }
  }
  return out
}

/**
 * An account's use of one tool in a window, by project: from when the limit
 * window began (its reset less its length; the window's length back from
 * now when the limit is not known) to now. Each project's share of what
 * that account used, and, with the limit's reading, about how much of the
 * limit that is. `placeOf` names a folder's project (its repository, else
 * the folder); the largest first.
 */
export function rankUsage(
  state: UsageState,
  o: { tool: 'claude' | 'codex'; account: string; window: '5h' | '7d'; limit?: Limit; now: number; placeOf: (dir: string) => { key: string; name: string } },
): { since: number; rows: UsageRow[]; total: number } {
  const since = o.limit?.resetsAt !== undefined && o.limit.resetsAt > o.now ? o.limit.resetsAt - WINDOW_MS[o.window] : o.now - WINDOW_MS[o.window]
  const prefix = `${o.tool}\t${o.account}\t`
  const byProject = new Map<string, { name: string; value: number }>()
  for (const [key, bySlot] of Object.entries(state.slots)) {
    if (!key.startsWith(prefix)) continue
    // a slot counts if it ends after the window began
    const value = Object.entries(bySlot).reduce((sum, [at, v]) => (Number(at) + SLOT_MS > since ? sum + v : sum), 0)
    if (value <= 0) continue
    const place = o.placeOf(key.slice(prefix.length))
    const known = byProject.get(place.key)
    byProject.set(place.key, { name: place.name, value: (known?.value ?? 0) + value })
  }
  const total = [...byProject.values()].reduce((sum, p) => sum + p.value, 0)
  const rows = [...byProject.entries()]
    .map(([key, p]) => ({ key, name: p.name, share: total > 0 ? p.value / total : 0, ...(o.limit === undefined ? {} : { ofLimit: (p.value / total) * o.limit.used }) }))
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))
  return { since, rows, total }
}

/** `date +%z`'s answer as minutes east of UTC (`-0700` is -420); 0 if it is not one. */
export function offsetOf(stdout: string): number {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(stdout.trim())
  return m === null ? 0 : (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A time as the Mac's clock shows it, each moment by its own offset from
 * UTC (minutes east; daylight saving may change it within the week):
 * `15:00` today, `Thu 14:00` within the next or last 6 days, else with its
 * date, `Sun 4 Oct 08:40`; with `isDated`, the date whenever it is not
 * today (a window's start is never read as the coming day of that name).
 */
export function clockSaid(at: number, now: number, offsets: { at: number; now: number }, isDated = false): string {
  const local = new Date(at + offsets.at * 60_000)
  const today = new Date(now + offsets.now * 60_000)
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  if (local.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)) return time
  const hasDate = isDated || Math.abs(at - now) >= 6 * 86_400_000
  return `${DAYS[local.getUTCDay()]}${hasDate ? ` ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}` : ''} ${time}`
}

/** A limit as one line: `5h 4% ↻15:00`, `7d 19% ↻Thu 14:00`. */
export function limitSaid(window: '5h' | '7d', limit: Limit, now: number, offsetAt: (ms: number) => number): string {
  const used = `${window} ${Math.round(limit.used)}%`
  return limit.resetsAt === undefined ? used : `${used} ↻${clockSaid(limit.resetsAt, now, { at: offsetAt(limit.resetsAt), now: offsetAt(now) })}`
}

/** A view's clock: each time said by the offset the Mac had or will have then (now's, for one not looked up). */
export function clockOf(view: { offset: number; offsets: Record<string, number> }, now: number) {
  const offsetAt = (ms: number) => view.offsets[String(ms)] ?? view.offset
  return { offsetAt, said: (ms: number, isDated = false) => clockSaid(ms, now, { at: offsetAt(ms), now: view.offset }, isDated) }
}

/** For each epoch second in "$@", the Mac's offset from UTC then (`-0700`), one per line. */
export const OFFSETS_SCRIPT = 'for t in "$@"; do /bin/date -r "$t" +%z; done'

/** usage.pl ctx's output: file → its last context, in tokens, and its window when the file says. */
export function parseContexts(stdout: string): Map<string, { tokens: number; window?: number }> {
  const out = new Map<string, { tokens: number; window?: number }>()
  let file: string | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==> ')) {
      file = line.slice(4)
      continue
    }
    const m = /^ctx (\d+)(?: (\d+))?$/.exec(line)
    if (file !== undefined && m !== null) out.set(file, { tokens: Number(m[1]), ...(m[2] === undefined ? {} : { window: Number(m[2]) }) })
  }
  return out
}

/** Which account a transcript or rollout is: '' for ~/.claude and ~/.codex, `work` for ~/.claude-work; else none. */
export function accountOfFile(home: string, file: string): string | undefined {
  if (!file.startsWith(`${home}/.`)) return undefined
  const m = /^(?:claude|codex)(?:-([^/]+))?\//.exec(file.slice(home.length + 2))
  return m === null ? undefined : (m[1] ?? '')
}

/**
 * Claude's limits as each account's sessions last read them, kept where
 * every account's sessions read them (a session reads only its own
 * account's): account → window → reading. One this does not read is left out.
 */
export function sharedLimitsFrom(raw: unknown): Record<string, Partial<Record<'5h' | '7d', Limit>>> {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isRecord(raw)) return {}
  const out: Record<string, Partial<Record<'5h' | '7d', Limit>>> = {}
  for (const [account, windows] of Object.entries(raw)) {
    if (!isRecord(windows)) continue
    for (const window of ['5h', '7d'] as const) {
      const l = windows[window] as Partial<Limit> | undefined
      if (!isRecord(l) || typeof l.used !== 'number' || typeof l.at !== 'number' || !Number.isFinite(l.used)) continue
      out[account] = { ...out[account], [window]: { used: l.used, at: l.at, ...(typeof l.resetsAt === 'number' ? { resetsAt: l.resetsAt } : {}) } }
    }
  }
  return out
}

/**
 * Two readings of an account's Claude limits (another session's, this
 * one's) as one: per window the later window's (by its reset), and within
 * one window the higher use, which only rises until it resets; a session
 * idle for a while still holds the lower reading its last response gave.
 */
export function mergeLimits(a: Partial<Record<'5h' | '7d', Limit>> | undefined, b: Partial<Record<'5h' | '7d', Limit>> | undefined): Partial<Record<'5h' | '7d', Limit>> {
  const out: Partial<Record<'5h' | '7d', Limit>> = {}
  for (const window of ['5h', '7d'] as const) {
    const x = a?.[window]
    const y = b?.[window]
    const pick = x === undefined ? y : y === undefined ? x
      : (x.resetsAt ?? 0) !== (y.resetsAt ?? 0) ? ((x.resetsAt ?? 0) > (y.resetsAt ?? 0) ? x : y)
      : x.used > y.used ? x : y
    if (pick !== undefined) out[window] = pick
  }
  return out
}

/** Readings still true: one whose window has reset since is not (what is used now is not known). */
export function currentLimits(limits: Partial<Record<'5h' | '7d', Limit>> | undefined, now: number): Partial<Record<'5h' | '7d', Limit>> {
  return Object.fromEntries(Object.entries(limits ?? {}).filter(([, l]) => l !== undefined && (l.resetsAt === undefined || l.resetsAt > now)))
}
