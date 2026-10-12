// Names the owner keeps off the screens (a company's, a customer's), for a screen shown to others: listed in the
// plugin's folder, and hidden while its switch is on. Every screen reads the same file, the pane and its toasts and the
// ops screen, so one press hides them on all of them. Pure: no `$`, so the tests drive it directly.
import type { RenderNode } from 'claude-code'

/** The list and its switch: `{ "names": ["…"], "hidden": true }`. */
export const namesPath = (home: string) => `${home}/Library/Application Support/live-sessions/names.json`

export type Hiding = { names: string[]; isHidden: boolean }
export const NO_HIDING: Hiding = { names: [], isHidden: false }

/** Longest a name may be; how many may be listed. */
const NAME_MAX = 64
const NAMES_MAX = 50

const isListed = (n: string) => n !== '' && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f-\u009f]/.test(n)

/**
 * What the file says: its names (each a line of text of up to 64 characters, at most 50 of them) and whether they are
 * hidden. Listed names are hidden unless it says `"hidden": false`; a file that cannot be read hides nothing.
 */
export function hidingFrom(raw: unknown): Hiding {
  const o = raw as { names?: unknown; hidden?: unknown } | null
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return NO_HIDING
  const listed = Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === 'string').map(n => n.trim().normalize('NFC')) : []
  return { names: [...new Set(listed.filter(isListed))].slice(0, NAMES_MAX), isHidden: o.hidden !== false }
}

/**
 * What is wrong with the file as a list of names, said when its switch is pressed; undefined when nothing is. A file
 * that is not one is never written over.
 */
export function namesProblem(raw: unknown): { isList: boolean; said: string } | undefined {
  const o = raw as { names?: unknown } | null
  if (typeof o !== 'object' || o === null || Array.isArray(o) || (o.names !== undefined && !Array.isArray(o.names))) {
    return { isList: false, said: 'is not a list of names (as {"names": ["…"]})' }
  }
  const all = Array.isArray(o.names) ? o.names : []
  const usable = all.filter((n): n is string => typeof n === 'string' && isListed(n.trim()))
  const left = all.length - usable.length + Math.max(0, new Set(usable.map(n => n.trim())).size - NAMES_MAX)
  return left > 0 ? { isList: true, said: `leaves out ${left} of its names (each is text of up to ${NAME_MAX} characters, at most ${NAMES_MAX} of them)` } : undefined
}

/** The file with its switch set: everything else in it kept as it is. */
export function turned(raw: unknown, isHidden: boolean): string {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return `${JSON.stringify({ ...o, names: o.names ?? [], hidden: isHidden }, null, 2)}\n`
}

/** The names hidden now: none while the switch is off. */
export const hiddenNames = (hiding: Hiding): readonly string[] => (hiding.isHidden ? hiding.names : [])

/** What separates the words of a name as names are written in folders, branches and ids: `Acme Corp`, `acme-corp`, `acme_corp`, `AcmeCorp`. */
const SEPARATORS = '[\\s._/-]*'
const escaped = (s: string) => s.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&')
/** A name's words, any separator or none between them. */
const spellings = (name: string) => {
  const words = name.split(/[\s._/-]+/).filter(w => w !== '')
  return words.length === 0 ? escaped(name) : words.map(escaped).join(SEPARATORS)
}

let cached: { key: string; whole: RegExp; cut: RegExp | undefined } | undefined
/**
 * Every name, in any letter case and spelling, the longest first (so a longer name that holds a shorter one goes
 * whole); and the start of one (three characters or more) where text ends or is cut (`…`): what is left of a name a
 * text was cut inside.
 */
function patternsOf(names: readonly string[]) {
  const key = names.join('\n')
  if (cached?.key !== key) {
    const byLength = [...names].sort((a, b) => b.length - a.length)
    const starts = [...new Set(byLength.flatMap(n => [...Array(Math.max(0, [...n].length - 3))].map((_, k) => [...n].slice(0, k + 3).join(''))))]
      .sort((a, b) => b.length - a.length)
    cached = {
      key,
      whole: new RegExp(byLength.map(spellings).join('|'), 'giu'),
      cut: starts.length === 0 ? undefined : new RegExp(`(?:${starts.map(spellings).join('|')})(?=…|$)`, 'giu'),
    }
  }
  return cached
}

const dots = (found: string) => '•'.repeat([...found].length)
/** A run of text with the names out of sight; the same string when none is in it. */
function hideIn(text: string, names: readonly string[]): string {
  const { whole, cut } = patternsOf(names)
  const hide = (s: string) => {
    const once = s.replace(whole, dots)
    return cut === undefined ? once : once.replace(cut, dots)
  }
  const hidden = hide(text)
  if (hidden !== text) return hidden
  // a name written with its accents apart (as macOS can write a folder's name): looked for as it reads
  if (!/[\u0300-\u036f]/.test(text)) return text
  const joined = text.normalize('NFC')
  const again = hide(joined)
  return again === joined ? text : again
}

/**
 * `text` with each name in it, in any letter case and spelling (`Acme Corp`, `acme-corp`, `AcmeCorp`) and inside other
 * words too, put out of sight: a dot for each of its characters, so a row keeps its length; and the start of one where
 * the text ends or is cut. A terminal's colour codes in it are left as they are.
 */
export function hideNames(text: string, names: readonly string[]): string {
  if (names.length === 0 || text === '') return text
  return text
    .split(/(\x1b\[[0-9;?]*[A-Za-z])/)
    .map(part => (part.startsWith('\x1b[') ? part : hideIn(part, names)))
    .join('')
}

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
/** The props that are text a person reads, by element: never a key, a value, what is typed or where a link goes. */
const SHOWN_PROPS: Record<string, readonly string[]> = { Code: ['source', 'path'], Markdown: ['text'] }
const SHOWN_EVERYWHERE = ['label', 'placeholder', 'submitLabel', 'alt'] as const
/**
 * A drawing with the names out of sight wherever it shows text: its strings, a button's label, an input's label,
 * placeholder and submit label (never what is typed in it), a choice's text, an image's alt text, code and markdown.
 * Keys, values, links' targets and what a press does stay as they are.
 */
export function hideInTree<T extends RenderNode | null | undefined>(node: T, names: readonly string[]): T {
  if (names.length === 0) return node
  // an element copied only where a name shows in it; the rest is the drawing as it was
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') return hideNames(n, names)
    if (typeof n !== 'object' || n === null) return n
    const el = n as Node
    const props: Record<string, unknown> = { ...el.props }
    let isChanged = false
    for (const field of [...SHOWN_EVERYWHERE, ...(SHOWN_PROPS[String(el.type)] ?? [])]) {
      const text = props[field]
      if (typeof text !== 'string') continue
      props[field] = hideNames(text, names)
      isChanged ||= props[field] !== text
    }
    // a choice without its own text shows its value
    if (Array.isArray(props.options)) {
      const options = props.options.map((o: unknown) => {
        if (typeof o !== 'object' || o === null) return o
        const option = o as { value?: unknown; label?: unknown }
        const shown = typeof option.label === 'string' ? option.label : typeof option.value === 'string' ? option.value : undefined
        return shown === undefined || hideNames(shown, names) === shown ? o : { ...option, label: hideNames(shown, names) }
      })
      if (options.some((o, k) => o !== (props.options as unknown[])[k])) {
        props.options = options
        isChanged = true
      }
    }
    const children = Array.isArray(el.children) ? el.children.map(walk) : undefined
    const hasNewChildren = children !== undefined && children.some((c, k) => c !== (el.children as unknown[])[k])
    if (!isChanged && !hasNewChildren) return n
    return { ...el, ...(isChanged ? { props } : {}), ...(hasNewChildren ? { children } : {}) }
  }
  return walk(node) as T
}
