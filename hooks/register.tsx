// Wiring: the /tree command, the transcript reader, the pane and its actions.
// Decisions live in transcript.ts, tree.ts, view.ts and policy.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import { USAGE, configFrom, parseArgs, readResult } from './policy'
import { parseChunk, projectSlug, utf8Length } from './transcript'
import { buildTree } from './tree'
import type { Tree } from './tree'
import { FILTERS, FILTER_NAMES, cut, moveCursor, oneLine, resolveCursor, resumeCommand, rowLine, setLabel, visible, windowAround } from './view'
import type { Config, Filter, Labels, Row, View } from '../types'

const PANE = 'tree'
const TITLE = 'Session tree'

const FRESH: View = {
  sessionId: null, filter: 'default', query: '', cursor: null, pending: null, isExpanded: false,
  mode: 'browse' as const, notice: null, rev: 0, status: 'idle', error: null,
}

// Change a shape tag when its type changes: an older stored value then reads as the initial one.
const viewAtom = atom({ plugin: 'tree', key: 'view' } as const, FRESH, { shape: 'view-1' })
const labelsAtom = atom({ plugin: 'tree', key: 'labels' } as const, { sessionId: null, map: {} } as Labels, { shape: 'labels-1' })

/** What one read of a transcript holds. A module variable: a hot reload drops it and session.start reads again. */
type Cache = {
  sessionId: string
  path: string
  /** Bytes of complete lines parsed. */
  bytes: number
  /** Complete lines parsed. */
  lines: number
  rows: Row[]
  bad: number
  tree: Tree
}

let config: Config = configFrom({})
let isInteractive = false
let cache: Cache | null = null
/** Bumped by every load and by /clear; a load whose number is stale drops its result. */
let generation = 0
/** Loads run one at a time, in order. */
let loads: Promise<void> = Promise.resolve()
/** Label writes run one at a time, in order. */
let labelWrites: Promise<void> = Promise.resolve()
let projection: { key: string; list: string[] } | null = null

/** Best effort: reporting must never throw out of a hook, a handler or a timer. */
function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // nothing to do
  }
}

async function setNotice($: EngineInterface, notice: string | null) {
  await update($, viewAtom, v => ({ ...v, notice }))
}

// ---- finding and reading the transcript ---------------------------------------

async function projectsDir($: EngineInterface): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return `${dir.replace(/\/+$/, '')}/projects`
  const home = await $.env.get('HOME')
  return home ? `${home.replace(/\/+$/, '')}/.claude/projects` : null
}

async function findTranscript($: EngineInterface, sessionId: string): Promise<string | null> {
  const projects = await projectsDir($)
  if (!projects) return null
  const file = `${sessionId}.jsonl`
  const tried = new Set<string>()
  for (const dir of [await $.session.root(), await $.session.cwd()]) {
    const path = `${projects}/${projectSlug(dir)}/${file}`
    if (tried.has(path)) continue
    tried.add(path)
    if (await $.fs.exists(path)) return path
  }
  if (!(await $.fs.exists(projects))) return null
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== 'dir') continue
    const path = `${projects}/${entry.name}/${file}`
    if (!tried.has(path) && (await $.fs.exists(path))) return path
  }
  return null
}

/** `tail -c +from path`: the file from byte `from` (1-based) on. Read-only. */
async function readFrom($: EngineInterface, path: string, from: number): Promise<string> {
  let out = ''
  let err = ''
  const stream = $.process.spawn({ argv: ['tail', '-c', `+${from}`, path] })
  for (;;) {
    const step = await stream.next()
    if (step.done) {
      if (step.value.code !== 0) throw new Error(`tail exited ${step.value.code ?? step.value.signal}: ${err.trim().slice(0, 200)}`)
      return out
    }
    if (step.value.stream === 'stdout') out += step.value.text
    else err += step.value.text
  }
}

async function loadOnce($: EngineInterface, isFull: boolean): Promise<void> {
  const mine = ++generation
  const sessionId = await $.session.id()
  const stale = async () => mine !== generation || (await $.session.id()) !== sessionId
  try {
    const own = cache !== null && cache.sessionId === sessionId ? cache : null
    if (!own) await update($, viewAtom, v => ({ ...(v.sessionId === sessionId ? v : { ...FRESH, filter: config.defaultFilter, sessionId }), status: 'loading' as const, error: null }))
    const path = own?.path ?? (await findTranscript($, sessionId))
    if (await stale()) return
    if (!path) throw new Error(`No transcript found for session ${sessionId}.`)
    const stat = await $.fs.stat(path)
    if (stat.size > config.maxTranscriptMB * 1024 * 1024) {
      throw new Error(`The transcript is ${(stat.size / 1048576).toFixed(1)} MB, over maxTranscriptMB (${config.maxTranscriptMB}).`)
    }
    let base = own && !isFull && own.path === path && own.bytes > 0 && stat.size >= own.bytes ? own : null
    if (base && stat.size === base.bytes) {
      await update($, viewAtom, v => ({ ...v, status: 'ready' as const, error: null }))
      return
    }
    let text = await readFrom($, path, base ? base.bytes : 1)
    if (base) {
      if (text.startsWith('\n')) text = text.slice(1)
      else {
        base = null
        text = await readFrom($, path, 1)
      }
    }
    if (await stale()) return
    const parsed = parseChunk(text, base ? base.lines + 1 : 1)
    const rows = base ? base.rows.concat(parsed.rows) : parsed.rows
    const next: Cache = {
      sessionId,
      path,
      bytes: (base?.bytes ?? 0) + utf8Length(parsed.consumed),
      lines: (base?.lines ?? 0) + parsed.lines,
      rows,
      bad: (base?.bad ?? 0) + parsed.bad,
      tree: base && parsed.rows.length === 0 ? base.tree : buildTree(rows),
    }
    cache = next
    await syncLabels($, sessionId)
    await update($, viewAtom, v => ({
      ...(v.sessionId === sessionId ? v : { ...FRESH, filter: config.defaultFilter, sessionId }),
      status: 'ready' as const, error: null, rev: v.rev + 1,
    }))
  } catch (err) {
    if (await stale().catch(() => true)) return
    const message = err instanceof Error ? err.message : String(err)
    await update($, viewAtom, v => ({ ...v, status: 'error' as const, error: message })).catch(() => undefined)
  }
}

/** Queues a load; resolves when it has run. Never rejects. */
function load($: EngineInterface, isFull = false): Promise<void> {
  loads = loads.then(() => loadOnce($, isFull)).catch(() => undefined)
  return loads
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

// ---- labels ---------------------------------------------------------------------

async function syncLabels($: EngineInterface, sessionId: string) {
  const held = await read($, labelsAtom)
  if (held.sessionId === sessionId) return
  const stored = await $.store.get(`labels:${sessionId}`)
  const map = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, string>) : {}
  await update($, labelsAtom, () => ({ sessionId, map }))
}

function saveLabel($: EngineInterface, sessionId: string, uuid: string, text: string): Promise<void> {
  labelWrites = labelWrites
    .then(async () => {
      const stored = await $.store.get(`labels:${sessionId}`)
      const map = typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {}
      const next = setLabel(map, uuid, text)
      await $.store.set(`labels:${sessionId}`, next)
      await update($, labelsAtom, held => (held.sessionId === sessionId ? { sessionId, map: next } : held))
      await update($, viewAtom, v => ({ ...v, mode: 'browse' as const, notice: text.trim() ? `Labeled “${text.trim()}”.` : 'Label removed.' }))
    })
    .catch(async err => {
      await setNotice($, `The label was not saved: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined)
    })
  return labelWrites
}

// ---- what the pane lists ------------------------------------------------------------

function listFor(view: View, labels: Record<string, string>): string[] {
  if (!cache || cache.sessionId !== view.sessionId) return []
  const key = `${view.rev}|${view.filter}|${view.query}|${JSON.stringify(labels)}`
  if (projection?.key !== key) projection = { key, list: visible(cache.tree, view.filter, view.query, labels) }
  return projection.list
}

async function current($: EngineInterface) {
  const view = await read($, viewAtom)
  const labels = await read($, labelsAtom)
  const map = labels.sessionId === view.sessionId ? labels.map : {}
  const list = listFor(view, map)
  const cursor = cache ? resolveCursor(cache.tree, list, view.cursor) : null
  return { view, map, list, cursor }
}

async function moveBy($: EngineInterface, delta: number) {
  const { list, cursor } = await current($)
  const to = moveCursor(list, cursor, delta)
  if (to === null) return
  await update($, viewAtom, v => ({ ...v, cursor: to, notice: null }))
  // Best effort: the ring follows only while the pane holds the keys.
  await $.ui.focus({ requestId: PANE, key: `row:${to}` }).catch(() => undefined)
}

async function setFilter($: EngineInterface, filter: Filter) {
  const { cursor } = await current($)
  await update($, viewAtom, v => ({ ...v, filter, cursor: cursor ?? v.cursor, notice: null }))
}

// ---- actions ----------------------------------------------------------------------

async function selectedRow($: EngineInterface): Promise<Row | null> {
  const { cursor } = await current($)
  return cursor && cache ? (cache.tree.rows.get(cursor) ?? null) : null
}

async function startDraft($: EngineInterface) {
  const row = await selectedRow($)
  if (!row || (row.kind !== 'prompt' && row.kind !== 'command')) return setNotice($, 'Only a prompt or a command can be a draft.')
  if (row.isCut) return setNotice($, 'This prompt was cut short when read, so it is not offered as a draft. Copy it instead.')
  const box = await $.prompt.read()
  if (box.text.trim() !== '') {
    await update($, viewAtom, v => ({ ...v, mode: 'confirm-draft' as const, pending: row.uuid, notice: null }))
    return
  }
  await fillDraft($, row.uuid, 'replace')
}

async function fillDraft($: EngineInterface, uuid: string, mode: 'replace' | 'append') {
  const row = cache?.tree.rows.get(uuid)
  await update($, viewAtom, v => ({ ...v, mode: 'browse' as const, pending: null }))
  if (!row) return setNotice($, 'That entry is no longer in the tree.')
  // The pane holds the keys; close it first so the prompt box can take the draft.
  await $.ui.close({ id: PANE })
  const filled = await $.prompt.fill({ text: row.text, mode })
  toast($, filled.isFilled
    ? 'Draft in the prompt box. Nothing was sent; the conversation did not move.'
    : `The draft was not put in the prompt box (${filled.refusal ?? 'refused by a hook'}).`)
}

async function copyRow($: EngineInterface, surface: RenderSurface) {
  const row = await selectedRow($)
  if (!row) return
  if (!row.text) return setNotice($, 'This entry has no text to copy.')
  const done = await $.ui.copy({ text: row.text, surface })
  await setNotice($, done.isCopied
    ? `Copied ${row.text.length} characters${row.isCut ? ' (the entry was cut short when read)' : ''}.`
    : `Not copied (${done.reason}).`)
}

async function copyResume($: EngineInterface, surface: RenderSurface) {
  const command = resumeCommand(await $.session.id())
  const done = await $.ui.copy({ text: command, surface })
  await setNotice($, done.isCopied ? `Copied: ${command}` : `Run in another terminal: ${command}`)
}

const HANDOFF: Record<'rewind' | 'branch', string> = {
  rewind: 'Opened /rewind: pick the entry there. The tree only browses; it cannot move the conversation.',
  branch: 'Ran /branch: it branches the conversation as it stands now, not at the selected entry.',
}

async function handOff($: EngineInterface, command: 'rewind' | 'branch') {
  const names = (await $.command.list()).map(c => c.name)
  if (!names.includes(command)) return setNotice($, `/${command} is not available in this session.`)
  await $.ui.close({ id: PANE })
  try {
    await $.command.run({ command })
    toast($, HANDOFF[command])
  } catch (err) {
    toast($, `/${command} did not run: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function openPane($: EngineInterface) {
  await update($, viewAtom, v => ({ ...v, mode: 'browse' as const, pending: null, notice: null }))
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 30, columns: 72 })
}

/** Starts a load after the calling hook returns, so a long read never holds a hook. */
function loadSoon($: EngineInterface, isFull = false) {
  $.clock.after(0, () => void load($, isFull))
}

// ---- drawing -----------------------------------------------------------------------

const KEYS: { key: string; hotkey: string; label: string }[] = [
  { key: 'next', hotkey: 'j', label: 'down' },
  { key: 'prev', hotkey: 'k', label: 'up' },
  { key: 'pagedown', hotkey: 'n', label: 'page↓' },
  { key: 'pageup', hotkey: 'p', label: 'page↑' },
  { key: 'refresh', hotkey: 'r', label: 'refresh' },
]

/** Rows the pane spends on everything but the list. */
const CHROME = 11

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: 'Browse this session as a tree: branches, labels, drafts from old prompts',
      argumentHint: '[open|refresh|close|status]',
    })
    isInteractive = e.isInteractive
    const started = await next(e)
    // After a hot reload the pane may still be up while the parsed tree is gone.
    if (config.enabled && e.isInteractive && (await isPaneOpen($).catch(() => false))) loadSoon($)
    return started
  })

  on('command.run', { command: 'tree' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (!config.enabled) return { text: 'tree is off (the enabled option). Nothing was read.' }
    if (!isInteractive) return { text: 'tree needs an interactive session: it draws a pane. Nothing was read.' }
    if (cmd.kind === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the session tree.' }
    }
    if (cmd.kind === 'status') {
      const sid = await $.session.id()
      if (!cache || cache.sessionId !== sid) return { text: 'Nothing read yet. /tree opens the pane and reads the transcript.' }
      const forks = [...cache.tree.children.values()].filter(c => c.length > 1).length
      return { text: readResult({ rows: cache.tree.rows.size, forks, bad: cache.bad, mb: cache.bytes / 1048576 }) }
    }
    if (cmd.kind === 'refresh') {
      loadSoon($)
      return { text: 'Reading new entries.' }
    }
    const opened = await openPane($)
    loadSoon($)
    return { text: opened.isPlaced ? 'Opened the session tree.' : `The session tree is waiting for room: ${opened.reason}` }
  })

  on('turn.complete', async ($, e, next) => {
    // Main conversation only: subagent turns write to their own transcripts.
    if (e.agentId === undefined && config.enabled && config.refreshOnTurn && isInteractive && (await isPaneOpen($).catch(() => false))) loadSoon($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A new conversation: drop the old tree and any read still running.
      generation++
      cache = null
      projection = null
      await update($, viewAtom, () => ({ ...FRESH, filter: config.defaultFilter })).catch(() => undefined)
      await update($, labelsAtom, () => ({ sessionId: null, map: {} })).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element
    if (e.origin.kind === 'person' && element?.startsWith('row:')) {
      await update($, viewAtom, v => ({ ...v, cursor: element.slice(4) }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: the ring moves whatever the cursor did

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const width = Math.max(20, e.props.bodyColumns)
    const { view, map, list, cursor } = await current($)
    const tree = cache && cache.sessionId === view.sessionId ? cache.tree : null

    const header = tree
      ? `${list.length} of ${tree.rows.size} shown · ${FILTER_NAMES[view.filter]}${view.query ? ` · “${view.query}”` : ''}${cache && cache.bad > 0 ? ` · ${cache.bad} line${cache.bad === 1 ? '' : 's'} skipped (not JSON)` : ''}${view.status === 'loading' ? ' · reading…' : ''}`
      : view.status === 'error' ? (view.error ?? 'Could not read the transcript.') : 'Reading the transcript…'

    const keyButtons = KEYS.map(k => (
      <Button key={k.key} plain hotkey={k.hotkey} onPress={() => {
        if (k.key === 'refresh') return load($)
        const room = Math.max(3, e.props.scroll.bodyRows - CHROME)
        return moveBy($, k.key === 'next' ? 1 : k.key === 'prev' ? -1 : k.key === 'pagedown' ? room : -room)
      }}>{k.label}</Button>
    ))

    if (!tree) {
      return (
        <Box flexDirection="column">
          <Text dimColor={view.status !== 'error'}>{cut(header, width)}</Text>
          <Box flexDirection="row" gap={2}>{keyButtons[4]}</Box>
        </Box>
      )
    }

    const row = cursor ? tree.rows.get(cursor) : undefined
    const room = Math.max(3, e.props.scroll.bodyRows - CHROME)
    const win = windowAround(list, cursor, room)

    if (view.mode === 'confirm-draft') {
      const pending = view.pending
      return (
        <Box flexDirection="column">
          <Text>The prompt box already holds text. Put the selected prompt:</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="draft-replace" hotkey="1" onPress={() => pending && fillDraft($, pending, 'replace')}>replace the draft</Button>
            <Button key="draft-append" hotkey="2" onPress={() => pending && fillDraft($, pending, 'append')}>after the draft</Button>
            <Button key="draft-cancel" hotkey="3" onPress={() => update($, viewAtom, v => ({ ...v, mode: 'browse' as const, pending: null }))}>cancel</Button>
          </Box>
        </Box>
      )
    }

    const isLabeling = view.mode === 'label' && row !== undefined
    const sessionId = view.sessionId
    const detail = row
      ? `${row.kind} · line ${row.line}${row.timestamp ? ` · ${row.timestamp.replace('T', ' ').slice(0, 19)}` : ''}${tree.onPath.has(row.uuid) ? ' · current path' : ' · off the current path'}`
      : 'No entry selected.'
    const previewLines = row ? row.text.split('\n').map(oneLine).filter(Boolean).slice(0, view.isExpanded ? 8 : 2) : []
    const canDraft = row !== undefined && (row.kind === 'prompt' || row.kind === 'command')

    return (
      <Box flexDirection="column">
        <Text dimColor>{cut(header, width)}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {FILTERS.map((f, i) => (
            <Button key={`filter:${f}`} plain hotkey={String(i + 1)} onPress={() => setFilter($, f)}>
              {f === view.filter ? <Text bold>{FILTER_NAMES[f]}</Text> : FILTER_NAMES[f]}
            </Button>
          ))}
        </Box>
        {Input && !isLabeling && (
          <Input key="search" label="search " placeholder="words to find" value={view.query} submitLabel="find"
            onInput={(value: string) => update($, viewAtom, v => ({ ...v, query: value }))}
            onSubmit={(value: string) => update($, viewAtom, v => ({ ...v, query: value }))} />
        )}
        {list.length === 0 && <Text dimColor>{tree.rows.size === 0 ? 'The transcript has no entries yet.' : 'Nothing matches.'}</Text>}
        {win.ids.map(id => {
          const isCursor = id === cursor
          const text = `${isCursor ? '›' : ' '}${rowLine(tree, id, map[id], width - 1)}`
          return (
            <Button key={`row:${id}`} plain dimColor={!tree.onPath.has(id)} onPress={() =>
              update($, viewAtom, v => ({ ...v, cursor: id, isExpanded: v.cursor === id ? !v.isExpanded : true, notice: null }))}>
              {isCursor ? <Text inverse>{text}</Text> : text}
            </Button>
          )
        })}
        <Text dimColor>{cut(detail, width)}</Text>
        {previewLines.map(l => <Text>{cut(l, width)}</Text>)}
        {isLabeling && Input && row && sessionId && (
          <Box flexDirection="row" gap={1}>
            <Input key="label" label="label " autoFocus value={map[row.uuid] ?? ''} submitLabel="save"
              onSubmit={(value: string) => saveLabel($, sessionId, row.uuid, value)} />
            <Button key="label-cancel" onPress={() => update($, viewAtom, v => ({ ...v, mode: 'browse' as const }))}>cancel</Button>
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {row && !isLabeling && Input && <Button key="label" plain hotkey="l" onPress={() => update($, viewAtom, v => ({ ...v, mode: 'label' as const, cursor: row.uuid }))}>label</Button>}
          {canDraft && <Button key="draft" plain hotkey="e" onPress={() => startDraft($)}>draft</Button>}
          {row && <Button key="copy" plain hotkey="c" onPress={press => copyRow($, press.surface)}>copy</Button>}
          <Button key="rewind" plain hotkey="w" onPress={() => handOff($, 'rewind')}>/rewind</Button>
          <Button key="branch" plain hotkey="b" onPress={() => handOff($, 'branch')}>/branch</Button>
          <Button key="resume" plain hotkey="o" onPress={press => copyResume($, press.surface)}>fork cmd</Button>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">{keyButtons}</Box>
        {view.notice && <Text key="notice">{cut(view.notice, width * 2)}</Text>}
      </Box>
    )
  })
}
