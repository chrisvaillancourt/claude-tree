import { describe, expect, test } from 'claude-code/testing'

import { configFrom, parseArgs, readResult } from './policy'

describe('policy', () => {
  test('configFrom fills defaults and rejects values outside the options', async () => {
    expect(configFrom({})).toEqual({ enabled: true, defaultFilter: 'default', refreshOnTurn: true, maxTranscriptMB: 256 })
    expect(configFrom({ enabled: false, defaultFilter: 'user-only', refreshOnTurn: false, maxTranscriptMB: 10 }))
      .toEqual({ enabled: false, defaultFilter: 'user-only', refreshOnTurn: false, maxTranscriptMB: 10 })
    expect(configFrom({ defaultFilter: 'bogus', maxTranscriptMB: -3 })).toMatchObject({ defaultFilter: 'default', maxTranscriptMB: 256 })
  })

  test('parseArgs: open by default, the subcommands, help on the rest', async () => {
    expect(parseArgs('')).toEqual({ kind: 'open' })
    expect(parseArgs(' Refresh ')).toEqual({ kind: 'refresh' })
    expect(parseArgs('close')).toEqual({ kind: 'close' })
    expect(parseArgs('status')).toEqual({ kind: 'status' })
    expect(parseArgs('help')).toEqual({ kind: 'help' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('readResult says what a read found, malformed lines included', async () => {
    expect(readResult({ rows: 12, forks: 1, bad: 0, mb: 1.24 })).toBe('12 entries, 1 fork, 1.2 MB read.')
    expect(readResult({ rows: 3, forks: 2, bad: 2, mb: 0 })).toBe('3 entries, 2 forks, 0.0 MB read; 2 lines were not JSON and were skipped.')
  })
})
