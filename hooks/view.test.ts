import { describe, expect, test } from 'claude-code/testing'

import { buildTree } from './tree'
import { FILTERS, moveCursor, resolveCursor, resumeCommand, rowLine, setLabel, visible, windowAround } from './view'
import type { Kind, Row } from '../types'

let line = 0
const row = (uuid: string, parent: string | null, kind: Kind, text = uuid): Row => ({
  uuid, parent, line: ++line, kind, text, isCut: false, isSidechain: false,
})

// u1 > a1(tool) > r1 > re1(reply); then two branches from re1: u2 > x2, u3 > m3(meta) > re3
function sample() {
  line = 0
  return buildTree([
    row('u1', null, 'prompt', 'Fix the parser bug'),
    row('t1', 'u1', 'tool', 'Bash ls'),
    row('r1', 't1', 'tool-result', 'file.ts'),
    row('re1', 'r1', 'reply', 'Found the Parser issue'),
    row('u2', 're1', 'prompt', 'try approach A'),
    row('x2', 'u2', 'attachment', 'skill_listing'),
    row('u3', 're1', 'prompt', 'try approach B'),
    row('m3', 'u3', 'meta', 'reminder'),
    row('re3', 'm3', 'reply', 'B works'),
    row('c4', 're3', 'command', '/model haiku'),
  ])
}

describe('filters', () => {
  test('the five filters, in cycle order', async () => {
    expect(FILTERS).toEqual(['default', 'no-tools', 'user-only', 'labeled', 'all'])
  })

  test('default hides bookkeeping; no-tools also hides calls and results', async () => {
    const t = sample()
    expect(visible(t, 'default', '', {})).toEqual(['u1', 't1', 'r1', 're1', 'u2', 'u3', 're3', 'c4'])
    expect(visible(t, 'no-tools', '', {})).toEqual(['u1', 're1', 'u2', 'u3', 're3', 'c4'])
  })

  test('user-only shows prompts and commands; tool results never count as prompts', async () => {
    expect(visible(sample(), 'user-only', '', {})).toEqual(['u1', 'u2', 'u3', 'c4'])
  })

  test('labeled shows labeled rows in tree order; all shows everything', async () => {
    const t = sample()
    expect(visible(t, 'labeled', '', { u3: 'B', x2: 'skills' })).toEqual(['x2', 'u3'])
    expect(visible(t, 'all', '', {})).toHaveLength(10)
  })
})

describe('machine messages', () => {
  test('a task notification shows by default but never as user input', async () => {
    line = 0
    const t = buildTree([row('u1', null, 'prompt', 'go'), { ...row('n1', 'u1', 'message', 'task done'), origin: 'task-notification' }])
    expect(visible(t, 'default', '', {})).toEqual(['u1', 'n1'])
    expect(visible(t, 'user-only', '', {})).toEqual(['u1'])
    expect(rowLine(t, 'n1', undefined, 80)).toBe('● task-notification: task done')
  })
})

describe('search', () => {
  test('every word must appear, case ignored, tree order kept', async () => {
    const t = sample()
    expect(visible(t, 'all', 'PARSER', {})).toEqual(['u1', 're1'])
    expect(visible(t, 'all', 'parser fix', {})).toEqual(['u1'])
    expect(visible(t, 'all', 'approach', {})).toEqual(['u2', 'u3'])
  })

  test('labels are searched and a new label is found at once', async () => {
    const t = sample()
    expect(visible(t, 'default', 'milestone', {})).toEqual([])
    expect(visible(t, 'default', 'milestone', { re3: 'Milestone' })).toEqual(['re3'])
  })
})

describe('labels', () => {
  test('setLabel trims, sets, and clears on empty', async () => {
    expect(setLabel({}, 'u1', '  keep  ')).toEqual({ u1: 'keep' })
    expect(setLabel({ u1: 'keep', u2: 'x' }, 'u1', '   ')).toEqual({ u2: 'x' })
  })
})

describe('cursor and window', () => {
  test('with no cursor, start at the newest visible row on the current path', async () => {
    const t = sample()
    expect(resolveCursor(t, visible(t, 'default', '', {}), null)).toBe('c4')
  })

  test('a cursor hidden by the filter lands on the nearest visible row before it', async () => {
    const t = sample()
    const v = visible(t, 'no-tools', '', {})
    expect(resolveCursor(t, v, 'r1')).toBe('u1')
    expect(resolveCursor(t, v, 're1')).toBe('re1')
    expect(resolveCursor(t, [], 'r1')).toBeNull()
  })

  test('moveCursor clamps at the ends', async () => {
    const v = ['a', 'b', 'c']
    expect(moveCursor(v, 'b', 1)).toBe('c')
    expect(moveCursor(v, 'c', 5)).toBe('c')
    expect(moveCursor(v, 'b', -9)).toBe('a')
  })

  test('the window centres on the cursor and stays inside the list', async () => {
    const v = Array.from({ length: 100 }, (_, i) => `n${i}`)
    expect(windowAround(v, 'n50', 10)).toEqual({ start: 45, ids: v.slice(45, 55) })
    expect(windowAround(v, 'n1', 10).start).toBe(0)
    expect(windowAround(v, 'n99', 10).start).toBe(90)
    expect(windowAround(['a'], 'a', 10)).toEqual({ start: 0, ids: ['a'] })
  })
})

describe('text', () => {
  test('a row line shows depth, path marker, label, kind and a one-line preview, cut to width', async () => {
    const t = sample()
    expect(rowLine(t, 'u1', undefined, 80)).toBe('● you: Fix the parser bug')
    expect(rowLine(t, 'u2', 'A', 80)).toBe('  ├ ○ [A] you: try approach A')
    expect(rowLine(t, 'u3', undefined, 80)).toBe('  ├ ● you: try approach B')
    const narrow = rowLine(t, 'u1', undefined, 12)
    expect(narrow.length).toBe(12)
    expect(narrow.endsWith('…')).toBe(true)
  })

  test('the resume command forks the session by id', async () => {
    expect(resumeCommand('abc-123')).toBe('claude --resume abc-123 --fork-session')
  })
})
