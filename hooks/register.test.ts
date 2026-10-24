import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { utf8Length } from './transcript'

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const HOME = '/h'
const ROOT = '/w/proj'
const SID = 'sess-1'
const PATH = `${HOME}/.claude/projects/-w-proj/${SID}.jsonl`

const PANE = {
  plugin: 'tree',
  component: 'Pane',
  requestId: 'tree',
  props: { title: 'Session tree', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// ---- transcript fixtures ----------------------------------------------------
const j = (o: object) => `${JSON.stringify(o)}\n`
const user = (uuid: string, parentUuid: string | null, text: string, extra: object = {}) =>
  j({ type: 'user', uuid, parentUuid, isSidechain: false, message: { role: 'user', content: text }, ...extra })
const reply = (uuid: string, parentUuid: string, text: string, id = `m-${uuid}`) =>
  j({ type: 'assistant', uuid, parentUuid, isSidechain: false, message: { id, role: 'assistant', content: [{ type: 'text', text }] } })

/** A rewound conversation: u1 > a1, then u2 > a2 (abandoned) and u3 > a3 (current). */
const BRANCHED =
  j({ type: 'mode', mode: 'x' }) +
  user('u1', null, 'Fix the parser') + reply('a1', 'u1', 'Which parser?') +
  user('u2', 'a1', 'The JSON one') + reply('a2', 'u2', 'Done with JSON') +
  user('u3', 'a1', 'The YAML one') + reply('a3', 'u3', 'Done with YAML')

/** Byte-exact `tail -c +N` over a JS string. */
function tailFrom(s: string, startByte: number): string {
  let bytes = 0
  let i = 0
  while (i < s.length && bytes < startByte - 1) {
    const cp = s.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    bytes += utf8Length(ch)
    i += ch.length
  }
  return s.slice(i)
}

type World = {
  files: Map<string, string>
  spawns: string[][]
  opened: object[]
  closed: string[]
  filled: { text: string; mode?: string }[]
  ran: string[]
  copied: string[]
  toasts: string[]
  focused: string[]
  composer: string
  fillOk: boolean
  sid: string
  chunk: number
  commands: string[]
  panes: string[]
  isInteractive: boolean
  delay: number
  store: Map<string, unknown>
  env: Record<string, string>
}

function world(on: On, init: Partial<World> = {}) {
  const w: World = {
    files: new Map([[PATH, BRANCHED]]), spawns: [], opened: [], closed: [], filled: [], ran: [], copied: [], toasts: [], focused: [],
    composer: '', fillOk: true, sid: SID, chunk: 1 << 20, commands: ['rewind', 'branch', 'tree'], panes: [], isInteractive: true, delay: 0, store: new Map(), env: { HOME }, ...init,
  }
  const clock = mock.clock(on)
  mock.env(on, w.env)
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: w.sid }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || [...w.files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.stat', ($, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: utf8Length(text), mtimeMs: 0, isLink: false } }
  })
  on('fs.list', ($, e) => {
    const names = new Set<string>()
    for (const k of w.files.keys()) if (k.startsWith(`${e.path}/`)) names.add(k.slice(e.path.length + 1).split('/')[0] as string)
    return { value: [...names].map(name => ({ name, kind: name.endsWith('.jsonl') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.spawn', async function* ($, e) {
    w.spawns.push([...e.argv])
    if (w.delay > 0) await clock.sleep(w.delay)
    const [, , from, path] = e.argv
    const text = w.files.get(path as string)
    if (text === undefined) {
      yield { stream: 'stderr' as const, text: 'No such file' }
      return { value: { code: 1, signal: null } }
    }
    const out = tailFrom(text, Number(String(from).slice(1)))
    for (let i = 0; i < out.length; i += w.chunk) yield { stream: 'stdout' as const, text: out.slice(i, i + w.chunk) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e)
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    w.panes = w.panes.filter(p => p !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.focus', ($, e) => {
    if (e.element) w.focused.push(e.element)
    return {}
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.read', () => ({ value: { text: w.composer, cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    w.filled.push({ text: e.text, mode: e.mode })
    return w.fillOk ? { isFilled: true, text: e.text, cursor: e.text.length } : { isFilled: false, refusal: 'dialog' as const, text: w.composer, cursor: 0 }
  })
  on('command.list', () => ({ value: w.commands.map(name => ({ name, description: name, source: 'builtin' as const })) }))
  on('command.run', ($, e) => {
    w.ran.push(e.command)
    return { text: '' }
  })
  return { w, clock }
}

async function open($: any, clock: { settle: () => Promise<void> }, interactive = true) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: interactive })
  const res = await $.command.run({ command: 'tree', args: '', ...COMMAND })
  await clock.settle()
  return res
}

const rowKeys = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('row:'))

// ---- tests --------------------------------------------------------------------

describe('/tree', () => {
  test('headless: answers that it needs an interactive session and reads nothing', async ($, on) => {
    const { w, clock } = world(on)
    const res = await open($, clock, false)
    expect(res.text).toContain('interactive')
    expect(w.spawns).toEqual([])
    expect(w.opened).toEqual([])
  })

  test('off by option: says so and reads nothing', { options: { enabled: false } }, async ($, on) => {
    const { w, clock } = world(on)
    const res = await open($, clock)
    expect(res.text).toContain('off')
    expect(w.spawns).toEqual([])
  })

  test('opens a focused pane and reads the transcript the session id names, read-only', async ($, on) => {
    const { w, clock } = world(on)
    const res = await open($, clock)
    expect(res.text).toBe('Opened the session tree.')
    expect(w.opened[0]).toMatchObject({ id: 'tree', focus: true, closeOnEscape: true })
    expect(w.spawns).toEqual([['tail', '-c', '+1', PATH]])
  })

  test('CLAUDE_CONFIG_DIR moves the projects folder', async ($, on) => {
    const path = `/cfg/projects/-w-proj/${SID}.jsonl`
    const { w, clock } = world(on, { files: new Map([[path, BRANCHED]]), env: { HOME, CLAUDE_CONFIG_DIR: '/cfg' } })
    await open($, clock)
    expect(w.spawns[0]?.[3]).toBe(path)
  })

  test('falls back to finding <id>.jsonl in any project folder', async ($, on) => {
    const path = `${HOME}/.claude/projects/-elsewhere/${SID}.jsonl`
    const { w, clock } = world(on, { files: new Map([[path, BRANCHED], [`${HOME}/.claude/projects/-other/x.jsonl`, '']]) })
    await open($, clock)
    expect(w.spawns[0]?.[3]).toBe(path)
  })

  test('no transcript found: the pane says so', async ($, on) => {
    const { clock } = world(on, { files: new Map() })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /No transcript/ }))?.text).toContain(SID)
    await ui.unmount()
  })

  test('a transcript over maxTranscriptMB is refused, not read', { options: { maxTranscriptMB: 0.0001 } }, async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    expect(w.spawns).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /maxTranscriptMB/ })).toBeDefined()
    await ui.unmount()
  })

  test('status reports what was read', async ($, on) => {
    const { clock } = world(on)
    await open($, clock)
    const res = await $.command.run({ command: 'tree', args: 'status', ...COMMAND })
    expect(res.text).toContain('6 entries, 1 fork')
  })
})

describe('the pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws both branches, current path marked, on ${surface}`, async ($, on) => {
      const { clock } = world(on)
      await open($, clock)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await rowKeys(ui)).toEqual(['row:u1', 'row:a1', 'row:u2', 'row:a2', 'row:u3', 'row:a3'])
      expect((await ui.find({ key: 'row:u2' }))?.text).toContain('○')
      expect((await ui.find({ key: 'row:u3' }))?.text).toContain('●')
      expect((await ui.find({ key: 'row:u3' }))?.text).toContain('├')
      await ui.unmount()
    })
  }

  test('filters by hotkey button, and search narrows by words', async ($, on) => {
    const { clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'filter:user-only' })
    expect(await rowKeys(ui)).toEqual(['row:u1', 'row:u2', 'row:u3'])
    await ui.press({ key: 'search-open' })
    await ui.input({ key: 'search', text: 'yaml', kind: 'change' })
    expect(await rowKeys(ui)).toEqual(['row:u3'])
    await ui.input({ key: 'search', text: '' })
    await ui.press({ key: 'filter:all' })
    expect((await rowKeys(ui)).length).toBe(6)
    await ui.unmount()
  })

  test('while searching or labeling no hotkey is drawn, so typed letters reach the field', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const hotkeys = async () => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey !== undefined).map((b: any) => b.key)
    expect(await hotkeys()).toContain('branch')
    await ui.press({ key: 'search-open' })
    expect(await hotkeys()).toEqual([])
    await ui.input({ key: 'search', text: 'bravo yaml', kind: 'change' })
    await ui.input({ key: 'search', text: 'yaml' })
    expect(await ui.find({ key: 'search' })).toBeUndefined()
    expect(await rowKeys(ui)).toEqual(['row:u3', 'row:a3'])
    expect(await ui.find({ type: 'Text', text: /“yaml”/ })).toBeDefined()
    await ui.press({ key: 'row:u3' })
    await ui.press({ key: 'label-open' })
    expect(await hotkeys()).toEqual([])
    expect(w.ran).toEqual([])
    await ui.unmount()
  })

  test('mobile has no search field but draws the tree', async ($, on) => {
    const { clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect((await rowKeys(ui)).length).toBe(6)
    expect(await ui.find({ key: 'search' })).toBeUndefined()
    await ui.unmount()
  })

  test('only the visible window is drawn for a long session', async ($, on) => {
    let text = user('n0', null, 'start')
    for (let i = 1; i < 2000; i++) text += i % 2 ? reply(`n${i}`, `n${i - 1}`, `reply ${i}`) : user(`n${i}`, `n${i - 1}`, `prompt ${i}`)
    const { clock } = world(on, { files: new Map([[PATH, text]]) })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const keys = await rowKeys(ui)
    expect(keys.length).toBeLessThanOrEqual(30)
    expect(keys.length).toBeGreaterThan(5)
    expect(keys.at(-1)).toBe('row:n1999')
    await ui.unmount()
  })

  test('j/k move the cursor; a person moving the focus ring moves the cursor', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Starts on the newest row of the current path.
    expect((await ui.find({ key: 'row:a3' }))?.text).toContain('›')
    await ui.press({ key: 'prev' })
    expect((await ui.find({ key: 'row:u3' }))?.text).toContain('›')
    await $.ui.focus({ component: 'Pane', requestId: 'tree', plugin: 'tree', element: 'row:u1', origin: { kind: 'person' } })
    expect((await ui.find({ key: 'row:u1' }))?.text).toContain('›')
    await ui.unmount()
  })
})

describe('labels', () => {
  test('label, find by the labeled filter, clear; stored per session', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:u2' })
    await ui.press({ key: 'label-open' })
    // The field's key is its own: the ring moved onto a same-keyed Button live and typing went to the prompt.
    expect((await ui.findAll({ key: 'label' })).map((el: any) => el.type)).toEqual(['Input'])
    await ui.input({ key: 'label', text: '  json try  ' })
    expect((await ui.find({ key: 'row:u2' }))?.text).toContain('[json try]')
    expect(w.store.get(`labels:${SID}`)).toEqual({ u2: 'json try' })
    await ui.press({ key: 'filter:labeled' })
    expect(await rowKeys(ui)).toEqual(['row:u2'])
    await ui.press({ key: 'row:u2' })
    await ui.press({ key: 'label-open' })
    await ui.input({ key: 'label', text: ' ' })
    expect(w.store.get(`labels:${SID}`)).toEqual({})
    await ui.unmount()
  })

  test('labels from the store show after a reopen; another session does not see them', async ($, on) => {
    const { w, clock } = world(on, { store: new Map([[`labels:${SID}`, { u1: 'start' }]]) })
    await open($, clock)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'row:u1' }))?.text).toContain('[start]')
    await ui.unmount()
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
    w.sid = 'sess-2'
    w.files.set(`${HOME}/.claude/projects/-w-proj/sess-2.jsonl`, BRANCHED)
    await $.command.run({ command: 'tree', args: '', ...COMMAND })
    await clock.settle()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'row:u1' }))?.text).not.toContain('[start]')
    await ui.unmount()
  })
})

describe('actions', () => {
  test('draft: an empty composer takes the exact prompt; the pane closes first; nothing is sent', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:u2' })
    await ui.press({ key: 'draft' })
    expect(w.closed).toEqual(['tree'])
    expect(w.filled).toEqual([{ text: 'The JSON one', mode: 'replace' }])
    expect(w.ran).toEqual([])
    await ui.unmount()
  })

  test('draft: text in the composer needs a choice; cancel fills nothing', async ($, on) => {
    const { w, clock } = world(on, { composer: 'half typed' })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:u2' })
    await ui.press({ key: 'draft' })
    expect(w.filled).toEqual([])
    await ui.press({ key: 'draft-cancel' })
    expect(w.filled).toEqual([])
    await ui.press({ key: 'draft' })
    await ui.press({ key: 'draft-append' })
    expect(w.filled).toEqual([{ text: 'The JSON one', mode: 'append' }])
    await ui.unmount()
  })

  test('draft: a refused fill is reported, never claimed, never submitted', async ($, on) => {
    const { w, clock } = world(on, { fillOk: false })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:u1' })
    await ui.press({ key: 'draft' })
    expect(w.toasts.at(-1)).toContain('not')
    expect(w.ran).toEqual([])
    await ui.unmount()
  })

  test('draft is offered only for prompts and commands', async ($, on) => {
    const { clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:a1' })
    expect(await ui.find({ key: 'draft' })).toBeUndefined()
    await ui.unmount()
  })

  test('copy puts the entry text on the clipboard', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:a2' })
    await ui.press({ key: 'copy' })
    expect(w.copied).toEqual(['Done with JSON'])
    expect((await ui.find({ key: 'notice' }))?.text ?? (await ui.find({ type: 'Text', text: /Copied/ }))?.text).toContain('Copied')
    await ui.unmount()
  })

  test('branch: asks first, then runs /branch and says it branches from now, not the selected entry', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:u2' })
    await ui.press({ key: 'branch' })
    expect(w.ran).toEqual([])
    await ui.press({ key: 'handoff-run' })
    await clock.settle()
    expect(w.closed).toEqual(['tree'])
    expect(w.ran).toEqual(['branch'])
    expect(w.toasts.at(-1)).toContain('not at the selected entry')
    await ui.unmount()
  })

  test('rewind: asks first, then hands off to /rewind; a missing built-in is reported and nothing runs', async ($, on) => {
    const { w, clock } = world(on, { commands: ['tree'] })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'rewind' })
    await clock.settle()
    expect(w.ran).toEqual([])
    expect(w.closed).toEqual([])
    expect(await ui.find({ type: 'Text', text: /not available/ })).toBeDefined()
    w.commands.push('rewind')
    await ui.press({ key: 'rewind' })
    await ui.press({ key: 'handoff-cancel' })
    expect(w.ran).toEqual([])
    await ui.press({ key: 'rewind' })
    await ui.press({ key: 'handoff-run' })
    await clock.settle()
    expect(w.ran).toEqual(['rewind'])
    await ui.unmount()
  })

  test('resume: copies the fork command for another terminal', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'resume' })
    expect(w.copied).toEqual([`claude --resume ${SID} --fork-session`])
    await ui.unmount()
  })
})

describe('reading', () => {
  test('refresh reads only new bytes, starting at the newline that ended the last line', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    w.files.set(PATH, BRANCHED + user('u4', 'a3', 'and TOML'))
    await $.command.run({ command: 'tree', args: 'refresh', ...COMMAND })
    await clock.settle()
    expect(w.spawns[1]).toEqual(['tail', '-c', `+${utf8Length(BRANCHED)}`, PATH])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await rowKeys(ui)).at(-1)).toBe('row:u4')
    await ui.unmount()
  })

  test('a replaced file (offset no longer on a newline) is read again in full', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    w.files.set(PATH, user('z1', null, 'x'.repeat(utf8Length(BRANCHED))) + reply('z2', 'z1', 'new'))
    await $.command.run({ command: 'tree', args: 'refresh', ...COMMAND })
    await clock.settle()
    expect(w.spawns.at(-1)).toEqual(['tail', '-c', '+1', PATH])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await rowKeys(ui)).toEqual(['row:z1', 'row:z2'])
    await ui.unmount()
  })

  test('a partial last line waits for the next read; chunks split lines and characters', async ($, on) => {
    const full = BRANCHED + user('u4', 'a3', 'naïve café 😀 done')
    const { w, clock } = world(on, { files: new Map([[PATH, full.slice(0, -20)]]), chunk: 7 })
    await open($, clock)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await rowKeys(ui)).at(-1)).toBe('row:a3')
    await ui.unmount()
    w.files.set(PATH, full)
    await $.command.run({ command: 'tree', args: 'refresh', ...COMMAND })
    await clock.settle()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'row:u4' }))?.text).toContain('naïve café 😀 done')
    await ui.unmount()
  })

  test('a shrunken file is read again in full', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    w.files.set(PATH, user('s1', null, 'short'))
    await $.command.run({ command: 'tree', args: 'refresh', ...COMMAND })
    await clock.settle()
    expect(w.spawns.at(-1)).toEqual(['tail', '-c', '+1', PATH])
  })

  test('malformed lines are counted and shown; the rest of the tree stands', async ($, on) => {
    const { clock } = world(on, { files: new Map([[PATH, `${BRANCHED}{not json\n`]]) })
    await open($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await rowKeys(ui)).length).toBe(6)
    expect(await ui.find({ type: 'Text', text: /1 line skipped/ })).toBeDefined()
    await ui.unmount()
  })

  test('a main turn refreshes the open pane; a subagent turn does not', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    w.files.set(PATH, BRANCHED + user('u4', 'a3', 'more'))
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', agentId: 'sub', reason: 'answer' })
    await clock.settle()
    expect(w.spawns.length).toBe(1)
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await clock.settle()
    expect(w.spawns.length).toBe(2)
  })

  test('after a hot reload with the pane still up, session.start reads the transcript again', async ($, on) => {
    const { w, clock } = world(on, { panes: ['tree'] })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(w.spawns).toEqual([['tail', '-c', '+1', PATH]])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await rowKeys(ui)).length).toBe(6)
    await ui.unmount()
  })

  test('a closed pane is not refreshed', async ($, on) => {
    const { w, clock } = world(on)
    await open($, clock)
    await $.command.run({ command: 'tree', args: 'close', ...COMMAND })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await clock.settle()
    expect(w.spawns.length).toBe(1)
  })

  test('a read still running when /clear ends the session never lands', async ($, on) => {
    const { w, clock } = world(on, { delay: 1000 })
    await open($, clock)
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await rowKeys(ui)).toEqual([])
    await ui.unmount()
    expect(w.spawns.length).toBe(1)
  })
})
