// Pure: the conversation tree from transcript rows. No `$`, no I/O.
import type { Kind, Row } from '../types'

export type Diagnostics = {
  /** Rows whose uuid an earlier row already had (the first is kept). */
  duplicates: number
  /** Cycles broken (each at its earliest line). */
  cycles: number
  /** Rows whose parent is not in the file; they are roots. */
  orphans: number
  /** Inline subagent rows left out. */
  sidechain: number
}

export type Tree = {
  rows: Map<string, Row>
  /** Logical children (parallel-tool fragments spliced in), in display order. */
  children: Map<string, string[]>
  /** Logical parent; absent for a root. */
  parent: Map<string, string>
  roots: string[]
  /** Every row once, depth first, children in order. */
  order: string[]
  /** Indentation: one step per fork above the row. */
  depth: Map<string, number>
  /** The newest row in the file, by line. */
  leaf: string | null
  /** The leaf and its ancestors. */
  onPath: Set<string>
  /** Rows that start a branch (their parent has more than one child). */
  forkHeads: Set<string>
  diagnostics: Diagnostics
}

const FRAGMENT_KINDS: ReadonlySet<Kind> = new Set<Kind>(['tool', 'thinking', 'reply', 'tool-result', 'attachment'])
const ASSISTANT_KINDS: ReadonlySet<Kind> = new Set<Kind>(['tool', 'thinking', 'reply'])

export function buildTree(input: readonly Row[]): Tree {
  const diagnostics: Diagnostics = { duplicates: 0, cycles: 0, orphans: 0, sidechain: 0 }
  const sorted = [...input].sort((a, b) => a.line - b.line)
  const rows = new Map<string, Row>()
  for (const r of sorted) {
    if (r.isSidechain) {
      diagnostics.sidechain++
      continue
    }
    if (rows.has(r.uuid)) {
      diagnostics.duplicates++
      continue
    }
    rows.set(r.uuid, r)
  }

  // Raw links, children in line order (rows are inserted in line order).
  const parent = new Map<string, string>()
  const raw = new Map<string, string[]>()
  const roots: string[] = []
  for (const r of rows.values()) {
    const p = r.parent
    if (p !== null && p !== r.uuid && rows.has(p)) {
      parent.set(r.uuid, p)
      const list = raw.get(p)
      if (list) list.push(r.uuid)
      else raw.set(p, [r.uuid])
    } else {
      if (p !== null && p !== r.uuid) diagnostics.orphans++
      roots.push(r.uuid)
    }
  }

  // Cycles: whatever no root reaches. Cut the earliest unreached row loose, again.
  const reached = new Set<string>()
  const reach = (start: string) => {
    const stack = [start]
    while (stack.length) {
      const id = stack.pop() as string
      if (reached.has(id)) continue
      reached.add(id)
      for (const c of raw.get(id) ?? []) stack.push(c)
    }
  }
  for (const r of roots) reach(r)
  if (reached.size < rows.size) {
    for (const r of rows.values()) {
      if (reached.has(r.uuid)) continue
      const p = parent.get(r.uuid)
      if (p !== undefined) {
        const siblings = raw.get(p) ?? []
        raw.set(p, siblings.filter(c => c !== r.uuid))
        parent.delete(r.uuid)
      }
      roots.push(r.uuid)
      diagnostics.cycles++
      reach(r.uuid)
    }
    roots.sort((a, b) => (rows.get(a)?.line ?? 0) - (rows.get(b)?.line ?? 0))
  }

  // Parallel tool calls: splice linear dead-end fragments before the continuing child.
  const children = new Map<string, string[]>()
  for (const [p, list] of raw) children.set(p, [...list])
  // A fragment stays inside one API message: an assistant row of another message ends it.
  const chainEnd = (start: string, msg: string): string | null => {
    let id = start
    for (;;) {
      const r = rows.get(id)
      if (!r || !FRAGMENT_KINDS.has(r.kind)) return null
      if (ASSISTANT_KINDS.has(r.kind) && r.messageId !== msg) return null
      const kids = raw.get(id) ?? []
      if (kids.length === 0) return id
      if (kids.length > 1) return null
      id = kids[0] as string
    }
  }
  for (const [p, list] of raw) {
    if (list.length < 2) continue
    const pRow = rows.get(p)
    const msg = pRow?.messageId
    if (msg === undefined) continue
    const frags: { head: string; end: string }[] = []
    const rest: string[] = []
    for (const c of list) {
      const cRow = rows.get(c)
      const isHead = cRow !== undefined && (cRow.kind === 'tool-result' || (ASSISTANT_KINDS.has(cRow.kind) && cRow.messageId === msg))
      const end = isHead ? chainEnd(c, msg) : null
      if (end !== null) frags.push({ head: c, end })
      else rest.push(c)
    }
    if (frags.length === 0) continue
    if (rest.length === 0) rest.push((frags.pop() as { head: string }).head)
    children.set(p, [frags[0]!.head])
    for (let i = 0; i < frags.length; i++) {
      const next = i + 1 < frags.length ? [frags[i + 1]!.head] : rest
      children.set(frags[i]!.end, next)
      for (const n of next) parent.set(n, frags[i]!.end)
    }
  }

  // Depth-first order and depth, iteratively.
  const order: string[] = []
  const depth = new Map<string, number>()
  const forkHeads = new Set<string>()
  const stack: { id: string; d: number }[] = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ id: roots[i] as string, d: 0 })
  const seen = new Set<string>()
  while (stack.length) {
    const { id, d } = stack.pop() as { id: string; d: number }
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    depth.set(id, d)
    const kids = children.get(id) ?? []
    const step = kids.length > 1 ? 1 : 0
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i] as string
      if (step) forkHeads.add(k)
      stack.push({ id: k, d: d + step })
    }
  }

  let leaf: string | null = null
  let best = -Infinity
  for (const r of rows.values()) if (r.line > best) ((best = r.line), (leaf = r.uuid))
  const onPath = new Set<string>()
  for (let id: string | undefined = leaf ?? undefined; id !== undefined && !onPath.has(id); id = parent.get(id)) onPath.add(id)

  return { rows, children, parent, roots, order, depth, leaf, onPath, forkHeads, diagnostics }
}
