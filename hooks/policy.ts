// Pure: options, /tree arguments, small text. No `$`, no I/O.
import type { Config, Filter } from '../types'
import { FILTERS } from './view'

export const DEFAULTS: Config = { enabled: true, defaultFilter: 'default', refreshOnTurn: true, maxTranscriptMB: 256 }

export function configFrom(options: Record<string, unknown>): Config {
  const f = options.defaultFilter
  const mb = options.maxTranscriptMB
  return {
    enabled: options.enabled !== false,
    defaultFilter: typeof f === 'string' && (FILTERS as readonly string[]).includes(f) ? (f as Filter) : DEFAULTS.defaultFilter,
    refreshOnTurn: options.refreshOnTurn !== false,
    maxTranscriptMB: typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : DEFAULTS.maxTranscriptMB,
  }
}

export type Command = { kind: 'open' | 'refresh' | 'close' | 'status' } | { kind: 'help'; error?: string }

export function parseArgs(args: string): Command {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'open') return { kind: 'open' }
  if (word === 'refresh' || word === 'close' || word === 'status' || word === 'help') return { kind: word }
  return { kind: 'help', error: `Unknown argument: ${args.trim()}` }
}

export const USAGE = 'Usage: /tree [open|refresh|close|status|help]. Opens a pane with this session as a tree.'

export function readResult(r: { rows: number; forks: number; bad: number; mb: number }): string {
  const base = `${r.rows} entries, ${r.forks} fork${r.forks === 1 ? '' : 's'}, ${r.mb.toFixed(1)} MB read`
  const was = r.bad === 1 ? 'was' : 'were'
  return r.bad > 0 ? `${base}; ${r.bad} line${r.bad === 1 ? '' : 's'} ${was} not JSON and ${was} skipped.` : `${base}.`
}
