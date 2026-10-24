// Pure: what the pane shows. Filters, search, labels, the window, row text.
import type { Filter, Kind, Row } from '../types'
import type { Tree } from './tree'

export const FILTERS: readonly Filter[] = ['default', 'no-tools', 'user-only', 'labeled', 'all']

export const FILTER_NAMES: Record<Filter, string> = {
  default: 'default',
  'no-tools': 'no tools',
  'user-only': 'user only',
  labeled: 'labeled',
  all: 'all',
}

const BOOKKEEPING: ReadonlySet<Kind> = new Set<Kind>(['attachment', 'system', 'meta', 'thinking'])
const TOOLS: ReadonlySet<Kind> = new Set<Kind>(['tool', 'tool-result'])
const USER: ReadonlySet<Kind> = new Set<Kind>(['prompt', 'command'])

export function passes(row: Row, filter: Filter, label: string | undefined): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'labeled':
      return label !== undefined
    case 'user-only':
      return USER.has(row.kind)
    case 'no-tools':
      return !BOOKKEEPING.has(row.kind) && !TOOLS.has(row.kind)
    default:
      return !BOOKKEEPING.has(row.kind)
  }
}

export function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matches(row: Row, label: string | undefined, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const hay = `${label ?? ''} ${row.kind} ${row.text}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

/** The rows the pane lists, in tree order. */
export function visible(tree: Tree, filter: Filter, query: string, labels: Record<string, string>): string[] {
  const words = tokens(query)
  const out: string[] = []
  for (const id of tree.order) {
    const row = tree.rows.get(id)
    if (!row) continue
    const label = labels[id]
    if (passes(row, filter, label) && matches(row, label, words)) out.push(id)
  }
  return out
}

/** A label map with `uuid` set to the trimmed text, or removed when that is empty. */
export function setLabel(map: Record<string, string>, uuid: string, text: string): Record<string, string> {
  const next = { ...map }
  const t = text.trim()
  if (t === '') delete next[uuid]
  else next[uuid] = t
  return next
}

const indexes = new WeakMap<Tree, Map<string, number>>()
function indexOf(tree: Tree): Map<string, number> {
  let m = indexes.get(tree)
  if (!m) {
    m = new Map(tree.order.map((id, i) => [id, i]))
    indexes.set(tree, m)
  }
  return m
}

/**
 * The row the cursor stands on: itself when listed; else the nearest listed row
 * before it in tree order (after it, failing that); with no cursor, the newest
 * listed row on the current path, else the last listed.
 */
export function resolveCursor(tree: Tree, list: readonly string[], cursor: string | null): string | null {
  if (list.length === 0) return null
  if (cursor !== null && list.includes(cursor)) return cursor
  const idx = indexOf(tree)
  if (cursor !== null && idx.has(cursor)) {
    const at = idx.get(cursor) as number
    let before: string | null = null
    for (const id of list) {
      if ((idx.get(id) ?? -1) <= at) before = id
      else return before ?? id
    }
    return before
  }
  for (let i = list.length - 1; i >= 0; i--) if (tree.onPath.has(list[i] as string)) return list[i] as string
  return list[list.length - 1] as string
}

export function moveCursor(list: readonly string[], cursor: string | null, delta: number): string | null {
  if (list.length === 0) return null
  const at = cursor === null ? -1 : list.indexOf(cursor)
  const from = at < 0 ? (delta > 0 ? -1 : list.length) : at
  const to = Math.max(0, Math.min(list.length - 1, from + delta))
  return list[to] as string
}

/** `size` rows of `list` with the cursor as near the middle as the ends allow. */
export function windowAround(list: readonly string[], cursor: string | null, size: number): { start: number; ids: string[] } {
  const n = Math.max(1, size)
  const at = Math.max(0, cursor === null ? list.length - 1 : list.indexOf(cursor))
  const start = Math.max(0, Math.min(list.length - n, at - Math.floor(n / 2)))
  return { start, ids: list.slice(start, start + n) }
}

const TAG: Record<Kind, string> = {
  prompt: 'you:',
  command: 'cmd:',
  reply: 'claude:',
  tool: 'tool:',
  'tool-result': 'result:',
  thinking: '(thinking)',
  summary: 'summary:',
  compaction: '──',
  meta: 'meta:',
  attachment: 'attach:',
  system: 'system:',
  other: '?',
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function cut(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

const MAX_INDENT = 8

/** One row as the list draws it. */
export function rowLine(tree: Tree, id: string, label: string | undefined, width: number): string {
  const row = tree.rows.get(id)
  if (!row) return ''
  const depth = Math.min(MAX_INDENT, tree.depth.get(id) ?? 0)
  const head = `${'  '.repeat(depth)}${tree.forkHeads.has(id) ? '├ ' : ''}${tree.onPath.has(id) ? '●' : '○'} `
  const tag = label !== undefined ? `[${label}] ${TAG[row.kind]}` : TAG[row.kind]
  const preview = oneLine(row.text)
  return cut(preview ? `${head}${tag} ${preview}` : `${head}${tag}`, width)
}

export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId} --fork-session`
}
