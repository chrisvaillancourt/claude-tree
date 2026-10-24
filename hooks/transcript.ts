// Pure: transcript JSONL text to compact rows. No `$`, no I/O.
import type { Kind, Row } from '../types'

/** Prompts, commands, replies and summaries keep this much text. */
export const LONG_CAP = 200_000
/** Every other row keeps this much. */
export const SHORT_CAP = 300

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function cap(text: string, kind: Kind): { text: string; isCut: boolean } {
  const limit = kind === 'prompt' || kind === 'command' || kind === 'reply' || kind === 'summary' ? LONG_CAP : SHORT_CAP
  return text.length > limit ? { text: text.slice(0, limit), isCut: true } : { text, isCut: false }
}

/** The text of a content value: a string, or blocks (text kept, images and the rest named). */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (!isObj(b)) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool_result') parts.push(blocksText(b.content))
    else if (typeof b.type === 'string' && b.type !== 'thinking' && b.type !== 'redacted_thinking') parts.push(`[${b.type}]`)
  }
  return parts.join('\n')
}

const TAG = (name: string, text: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

function userKind(o: Obj, content: unknown, text: string): { kind: Kind; text: string } {
  if (o.isCompactSummary === true) return { kind: 'summary', text }
  if (Array.isArray(content) && content.some(b => isObj(b) && b.type === 'tool_result')) return { kind: 'tool-result', text }
  if (o.isMeta === true) return { kind: 'meta', text }
  const name = TAG('command-name', text)
  if (name !== undefined) {
    const args = TAG('command-args', text) ?? ''
    const slash = name.startsWith('/') ? name : `/${name}`
    return { kind: 'command', text: args ? `${slash} ${args}` : slash }
  }
  for (const t of ['local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'bash-stdout', 'bash-stderr']) {
    const inner = TAG(t, text)
    if (inner !== undefined) return { kind: 'meta', text: inner }
  }
  return { kind: 'prompt', text }
}

function toolText(b: Obj): string {
  const name = str(b.name) ?? 'tool'
  const input = isObj(b.input) ? b.input : {}
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']) {
    const v = str(input[k])
    if (v) return `${name} ${v}`
  }
  const json = JSON.stringify(input)
  return json === '{}' ? name : `${name} ${json}`
}

function assistantKind(content: unknown): { kind: Kind; text: string } {
  const blocks = Array.isArray(content) ? content.filter(isObj) : []
  if (typeof content === 'string') return { kind: 'reply', text: content }
  const texts = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string)
  if (texts.length > 0) return { kind: 'reply', text: texts.join('\n') }
  const tools = blocks.filter(b => b.type === 'tool_use' || b.type === 'server_tool_use')
  if (tools.length > 0) return { kind: 'tool', text: tools.map(toolText).join('\n') }
  return { kind: 'thinking', text: '' }
}

/** One parsed JSON line to a Row; null for lines without a string uuid. */
export function rowFrom(o: unknown, line: number): Row | null {
  if (!isObj(o) || typeof o.uuid !== 'string' || o.uuid === '') return null
  const type = str(o.type) ?? ''
  const message = isObj(o.message) ? o.message : {}
  const content = message.content ?? o.content
  let parent = str(o.parentUuid) ?? null
  let found: { kind: Kind; text: string }
  let messageId: string | undefined
  if (type === 'user') {
    found = userKind(o, content, blocksText(content))
  } else if (type === 'assistant') {
    found = assistantKind(content)
    messageId = str(message.id)
  } else if (type === 'attachment') {
    const a = isObj(o.attachment) ? o.attachment : {}
    found = { kind: 'attachment', text: str(a.type) ?? 'attachment' }
  } else if (type === 'system') {
    const subtype = str(o.subtype) ?? 'system'
    if (subtype === 'compact_boundary') {
      parent = parent ?? str(o.logicalParentUuid) ?? null
      const m = isObj(o.compactMetadata) ? o.compactMetadata : {}
      const bits = [str(m.trigger), typeof m.preTokens === 'number' ? `${m.preTokens} tokens before` : undefined].filter(Boolean)
      found = { kind: 'compaction', text: `compacted${bits.length ? ` (${bits.join(', ')})` : ''}` }
    } else {
      const body = blocksText(content)
      found = { kind: 'system', text: body ? `${subtype}: ${body}` : subtype }
    }
  } else {
    found = { kind: 'other', text: type || 'row' }
  }
  const capped = cap(found.text, found.kind)
  const row: Row = {
    uuid: o.uuid,
    parent: parent === o.uuid ? null : parent,
    line,
    kind: found.kind,
    text: capped.text,
    isCut: capped.isCut,
    isSidechain: o.isSidechain === true,
  }
  if (messageId !== undefined) row.messageId = messageId
  const ts = str(o.timestamp)
  if (ts !== undefined) row.timestamp = ts
  return row
}

export type Parsed = {
  rows: Row[]
  /** Complete lines that were not JSON. */
  bad: number
  /** Complete lines seen (blank ones included). */
  lines: number
  /** The text of the complete lines, newlines included. */
  consumed: string
  /** A trailing partial line, left for the next read. */
  rest: string
}

/** Parses the complete lines of `text`; `firstLine` is the 1-based number of its first line. */
export function parseChunk(text: string, firstLine: number): Parsed {
  const end = text.lastIndexOf('\n')
  const consumed = end < 0 ? '' : text.slice(0, end + 1)
  const rest = end < 0 ? text : text.slice(end + 1)
  const rows: Row[] = []
  let bad = 0
  let lines = 0
  if (consumed !== '') {
    const parts = consumed.split('\n')
    parts.pop()
    for (const part of parts) {
      const line = firstLine + lines
      lines++
      if (part.trim() === '') continue
      let o: unknown
      try {
        o = JSON.parse(part)
      } catch {
        bad++
        continue
      }
      const row = rowFrom(o, line)
      if (row) rows.push(row)
    }
  }
  return { rows, bad, lines, consumed, rest }
}

/** Bytes `s` takes as UTF-8 (a lone surrogate as U+FFFD's three). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** The projects folder name Claude Code uses for a directory. */
export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}
