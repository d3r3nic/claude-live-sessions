// Names the owner keeps off the screens (a company's, a customer's), for a screen shown to others: listed in the
// plugin's folder, and hidden while its switch is on. Every screen reads the same file, the pane and its toasts and the
// ops screen, so one press hides them on all of them. Pure: no `$`, so the tests drive it directly.
import type { RenderNode } from 'claude-code'

/** The list and its switch: `{ "names": ["…"], "hidden": true }`. */
export const namesPath = (home: string) => `${home}/Library/Application Support/live-sessions/names.json`

export type Hiding = { names: string[]; isHidden: boolean }
export const NO_HIDING: Hiding = { names: [], isHidden: false }

/**
 * What the file says: its names (each a line of text of up to 64 characters, at most 50 of them) and whether they are
 * hidden. Listed names are hidden unless it says `"hidden": false`; a file that cannot be read hides nothing.
 */
export function hidingFrom(raw: unknown): Hiding {
  const o = raw as { names?: unknown; hidden?: unknown } | null
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return NO_HIDING
  const listed = Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === 'string').map(n => n.trim()) : []
  const names = [...new Set(listed.filter(n => n !== '' && n.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(n)))].slice(0, 50)
  return { names, isHidden: o.hidden !== false }
}

/** The file with its switch turned: its names kept as they are. */
export function turned(raw: unknown, isHidden: boolean): string {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return `${JSON.stringify({ ...o, names: Array.isArray(o.names) ? o.names : [], hidden: isHidden }, null, 2)}\n`
}

/** The names hidden now: none while the switch is off. */
export const hiddenNames = (hiding: Hiding): readonly string[] => (hiding.isHidden ? hiding.names : [])

let cached: { key: string; pattern: RegExp } | undefined
/** Every name, in any letter case, the longest first (so a longer name that holds a shorter one goes whole). */
function patternOf(names: readonly string[]): RegExp {
  const key = names.join('\n')
  if (cached?.key !== key) {
    const escaped = [...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&'))
    cached = { key, pattern: new RegExp(escaped.join('|'), 'giu') }
  }
  return cached.pattern
}

/**
 * `text` with each name in it, in any letter case, put out of sight: a dot for each of its characters, so a row keeps
 * its length. A terminal's colour codes in it are left as they are.
 */
export function hideNames(text: string, names: readonly string[]): string {
  if (names.length === 0 || text === '') return text
  const pattern = patternOf(names)
  return text
    .split(/(\x1b\[[0-9;?]*[A-Za-z])/)
    .map(part => (part.startsWith('\x1b[') ? part : part.replace(pattern, found => '•'.repeat([...found].length))))
    .join('')
}

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }
/**
 * A drawing with the names out of sight wherever it shows text: its strings, a button's label, an input's label and
 * placeholder (never what is typed in it), a choice's text. Keys, values and what a press does stay as they are.
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
    for (const field of ['label', 'placeholder'] as const) {
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
