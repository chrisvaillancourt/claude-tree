import { describe, expect, test } from 'claude-code/testing'

import { buildTree } from './tree'
import type { Kind, Row } from '../types'

let line = 0
const row = (uuid: string, parent: string | null, kind: Kind = 'prompt', extra: Partial<Row> = {}): Row => ({
  uuid, parent, line: ++line, kind, text: uuid, isCut: false, isSidechain: false, ...extra,
})
const reset = () => { line = 0 }

describe('buildTree', () => {
  test('a linear conversation has no forks and the whole path is current', async () => {
    reset()
    const t = buildTree([row('u1', null), row('a1', 'u1', 'reply'), row('u2', 'a1'), row('a2', 'u2', 'reply')])
    expect(t.order).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(t.order.map(id => t.depth.get(id))).toEqual([0, 0, 0, 0])
    expect(t.leaf).toBe('a2')
    expect([...t.onPath].sort()).toEqual(['a1', 'a2', 'u1', 'u2'])
    expect(t.forkHeads.size).toBe(0)
  })

  test('a rewound prompt leaves a branch; the newer one is current, the old one off-path', async () => {
    reset()
    const t = buildTree([
      row('u1', null), row('a1', 'u1', 'reply'),
      row('u2', 'a1'), row('a2', 'u2', 'reply'),
      row('u3', 'a1'), row('a3', 'u3', 'reply'),
    ])
    expect(t.order).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect([...t.forkHeads].sort()).toEqual(['u2', 'u3'])
    expect(t.depth.get('u2')).toBe(1)
    expect(t.depth.get('a3')).toBe(1)
    expect(t.leaf).toBe('a3')
    expect(t.onPath.has('u2')).toBe(false)
    expect(t.onPath.has('u3')).toBe(true)
  })

  test('parallel tool calls of one message fold into one line of history', async () => {
    reset()
    // As the engine writes them: the second tool_use hangs off the first, its
    // result off itself (a dead end); the first result continues the chain.
    const t = buildTree([
      row('u1', null),
      row('th', 'u1', 'thinking', { messageId: 'M' }),
      row('t1', 'th', 'tool', { messageId: 'M' }),
      row('t2', 't1', 'tool', { messageId: 'M' }),
      row('r2', 't2', 'tool-result'),
      row('r1', 't1', 'tool-result'),
      row('t3', 'r1', 'tool', { messageId: 'M' }),
      row('r3', 't3', 'tool-result'),
      row('a1', 'r3', 'reply', { messageId: 'N' }),
    ])
    expect(t.forkHeads.size).toBe(0)
    expect(t.order).toEqual(['u1', 'th', 't1', 't2', 'r2', 'r1', 't3', 'r3', 'a1'])
    expect(t.onPath.has('r2')).toBe(true)
    expect(t.order.every(id => t.depth.get(id) === 0)).toBe(true)
  })

  test('the other parallel pattern: earlier results dead-end off their own calls', async () => {
    reset()
    // Calls chain one after another; each result but the last hangs off its call.
    const t = buildTree([
      row('u1', null),
      row('t1', 'u1', 'tool', { messageId: 'M' }),
      row('t2', 't1', 'tool', { messageId: 'M' }),
      row('t3', 't2', 'tool', { messageId: 'M' }),
      row('r1', 't1', 'tool-result'),
      row('r2', 't2', 'tool-result'),
      row('r3', 't3', 'tool-result'),
      row('a1', 'r3', 'reply', { messageId: 'N' }),
    ])
    expect(t.forkHeads.size).toBe(0)
    expect(t.order).toEqual(['u1', 't1', 'r1', 't2', 'r2', 't3', 'r3', 'a1'])
    expect(t.onPath.size).toBe(8)
  })

  test('a dead-end branch that holds a prompt is a real fork, not a fragment', async () => {
    reset()
    const t = buildTree([row('u1', null), row('a1', 'u1', 'reply', { messageId: 'M' }), row('u2', 'a1'), row('u3', 'a1')])
    expect([...t.forkHeads].sort()).toEqual(['u2', 'u3'])
  })

  test('a compaction boundary bridges to the history before it', async () => {
    reset()
    const t = buildTree([
      row('u1', null), row('a1', 'u1', 'reply'),
      row('cb', 'a1', 'compaction'), row('s', 'cb', 'summary'), row('u2', 's'),
    ])
    expect(t.roots).toEqual(['u1'])
    expect(t.order).toEqual(['u1', 'a1', 'cb', 's', 'u2'])
    expect(t.onPath.has('u1')).toBe(true)
  })

  test('sidechain rows are left out and counted', async () => {
    reset()
    const t = buildTree([row('u1', null), row('x', 'u1', 'prompt', { isSidechain: true }), row('a1', 'u1', 'reply')])
    expect(t.order).toEqual(['u1', 'a1'])
    expect(t.diagnostics.sidechain).toBe(1)
  })

  test('order and the current leaf follow the file line, never the timestamp', async () => {
    reset()
    const t = buildTree([
      row('u1', null, 'prompt', { timestamp: '2026-01-03T00:00:00Z' }),
      row('b1', 'u1', 'reply', { timestamp: '2026-01-02T00:00:00Z' }),
      row('b2', 'u1', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }),
    ])
    expect(t.order).toEqual(['u1', 'b1', 'b2'])
    expect(t.leaf).toBe('b2')
  })

  test('rows arrive out of line order and are sorted by line', async () => {
    reset()
    const a = row('u1', null), b = row('a1', 'u1', 'reply'), c = row('u2', 'a1')
    const t = buildTree([c, a, b])
    expect(t.order).toEqual(['u1', 'a1', 'u2'])
  })

  test('a missing parent makes a root; a duplicate uuid keeps its first row', async () => {
    reset()
    const t = buildTree([row('u1', null), row('o', 'gone'), row('u1', null, 'reply')])
    expect(t.roots).toEqual(['u1', 'o'])
    expect(t.diagnostics.orphans).toBe(1)
    expect(t.diagnostics.duplicates).toBe(1)
    expect(t.rows.get('u1')?.kind).toBe('prompt')
  })

  test('a cycle is broken at its earliest line and reported, nothing dropped', async () => {
    reset()
    const t = buildTree([row('u1', null), row('x', 'y'), row('y', 'x')])
    expect(t.diagnostics.cycles).toBe(1)
    expect(t.order.sort()).toEqual(['u1', 'x', 'y'])
  })

  test('a very long chain builds without recursion limits', async () => {
    reset()
    const rows: Row[] = [row('n0', null)]
    for (let i = 1; i < 50_000; i++) rows.push(row(`n${i}`, `n${i - 1}`, i % 2 ? 'reply' : 'prompt'))
    const t = buildTree(rows)
    expect(t.order.length).toBe(50_000)
    expect(t.leaf).toBe('n49999')
    expect(t.onPath.size).toBe(50_000)
  })

  test('an empty transcript is an empty tree', async () => {
    const t = buildTree([])
    expect(t.order).toEqual([])
    expect(t.leaf).toBeNull()
  })
})
