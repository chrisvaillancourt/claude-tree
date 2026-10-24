import { describe, expect, test } from 'claude-code/testing'

import { parseChunk, rowFrom, utf8Length, projectSlug, LONG_CAP, SHORT_CAP } from './transcript'

const user = (uuid: string, parentUuid: string | null, content: unknown, extra: object = {}) =>
  ({ type: 'user', uuid, parentUuid, isSidechain: false, message: { role: 'user', content }, ...extra })
const assistant = (uuid: string, parentUuid: string | null, content: unknown[], id = 'msg_1') =>
  ({ type: 'assistant', uuid, parentUuid, isSidechain: false, message: { id, role: 'assistant', content } })

describe('rowFrom', () => {
  test('a typed prompt, as a string or as text blocks', async () => {
    expect(rowFrom(user('u1', null, 'fix the bug'), 3)).toMatchObject({ uuid: 'u1', parent: null, line: 3, kind: 'prompt', text: 'fix the bug' })
    expect(rowFrom(user('u2', 'u1', [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 1)?.text).toBe('a\n[image]\nb')
  })

  test('tool results are not prompts', async () => {
    const r = rowFrom(user('u3', 'a1', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok done' }] }]), 1)
    expect(r?.kind).toBe('tool-result')
    expect(r?.text).toBe('ok done')
  })

  test('meta rows, command records and command output', async () => {
    expect(rowFrom(user('m', null, 'reminder', { isMeta: true }), 1)?.kind).toBe('meta')
    const cmd = rowFrom(user('c', null, '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>'), 1)
    expect(cmd).toMatchObject({ kind: 'command', text: '/model haiku' })
    expect(rowFrom(user('o', null, '<local-command-stdout>Set model</local-command-stdout>'), 1)).toMatchObject({ kind: 'meta', text: 'Set model' })
  })

  test('compaction boundary links through logicalParentUuid; the summary is its own kind', async () => {
    const b = rowFrom({ type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null, logicalParentUuid: 'x', isSidechain: false, compactMetadata: { trigger: 'manual', preTokens: 1200 } }, 9)
    expect(b).toMatchObject({ kind: 'compaction', parent: 'x' })
    expect(b?.text).toContain('manual')
    expect(rowFrom(user('s', 'b', 'This session is being continued', { isCompactSummary: true }), 10)?.kind).toBe('summary')
  })

  test('assistant rows: text, tool call, thinking alone (text never kept)', async () => {
    expect(rowFrom(assistant('a1', 'u1', [{ type: 'text', text: 'Done.' }]), 1)).toMatchObject({ kind: 'reply', text: 'Done.', messageId: 'msg_1' })
    expect(rowFrom(assistant('a2', 'u1', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }]), 1)).toMatchObject({ kind: 'tool', text: 'Bash ls -la' })
    const t = rowFrom(assistant('a3', 'u1', [{ type: 'thinking', thinking: 'secret plan' }]), 1)
    expect(t?.kind).toBe('thinking')
    expect(t?.text).not.toContain('secret')
  })

  test('attachments, system rows, unknown kinds, rows without an id', async () => {
    expect(rowFrom({ type: 'attachment', uuid: 'at', parentUuid: 'u', attachment: { type: 'skill_listing' } }, 1)).toMatchObject({ kind: 'attachment', text: 'skill_listing' })
    expect(rowFrom({ type: 'system', subtype: 'turn_duration', uuid: 'sy', parentUuid: 'u' }, 1)?.kind).toBe('system')
    expect(rowFrom({ type: 'brand-new', uuid: 'n', parentUuid: 'u' }, 1)).toMatchObject({ kind: 'other', text: 'brand-new' })
    expect(rowFrom({ type: 'last-prompt', leafUuid: 'u' }, 1)).toBeNull()
    expect(rowFrom({ type: 'user', uuid: 7 }, 1)).toBeNull()
  })

  test('long text is cut and flagged; prompts keep far more than tool rows', async () => {
    const big = 'x'.repeat(LONG_CAP + 5)
    const p = rowFrom(user('u', null, big), 1)
    expect(p?.text.length).toBe(LONG_CAP)
    expect(p?.isCut).toBe(true)
    const r = rowFrom(user('r', 'a', [{ type: 'tool_result', content: 'y'.repeat(SHORT_CAP + 1) }]), 1)
    expect(r?.text.length).toBe(SHORT_CAP)
    expect(rowFrom(user('s', null, 'short'), 1)?.isCut).toBe(false)
  })

  test('a sidechain row says so', async () => {
    expect(rowFrom(user('u', null, 'hi', { isSidechain: true }), 1)?.isSidechain).toBe(true)
  })
})

describe('parseChunk', () => {
  test('complete lines become rows; a trailing partial line is left over', async () => {
    const a = JSON.stringify(user('u1', null, 'one'))
    const b = JSON.stringify(user('u2', 'u1', 'two'))
    const res = parseChunk(`${a}\n{"type":"mode"}\n${b.slice(0, 10)}`, 1)
    expect(res.rows.map(r => r.uuid)).toEqual(['u1'])
    expect(res.lines).toBe(2)
    expect(res.rest).toBe(b.slice(0, 10))
    expect(res.consumed).toBe(`${a}\n{"type":"mode"}\n`)
  })

  test('line numbers continue from firstLine; malformed complete lines are counted, not fatal', async () => {
    const a = JSON.stringify(user('u1', null, 'one'))
    const res = parseChunk(`not json\n${a}\n\n`, 5)
    expect(res.bad).toBe(1)
    expect(res.rows[0]?.line).toBe(6)
    expect(res.lines).toBe(3)
  })
})

describe('helpers', () => {
  test('utf8Length counts bytes as UTF-8 does', async () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
    expect(utf8Length('a\n')).toBe(2)
  })

  test('projectSlug turns every non-alphanumeric character into a dash', async () => {
    expect(projectSlug('/tmp/my.proj/a_b')).toBe('-tmp-my-proj-a-b')
  })
})
