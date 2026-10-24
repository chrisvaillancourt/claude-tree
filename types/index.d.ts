/** What a transcript row is, as the tree shows it. */
export type Kind =
  | 'prompt' // something the person typed
  | 'command' // a slash command the person ran
  | 'reply' // assistant text
  | 'tool' // an assistant tool call
  | 'tool-result' // a tool's result
  | 'thinking' // an assistant row holding only thinking (its text is never kept)
  | 'summary' // a compaction summary
  | 'compaction' // a compaction boundary
  | 'meta' // a hidden user row (reminders, command output, injected context)
  | 'attachment'
  | 'system'
  | 'other'

/** One transcript row with an id, reduced to what the tree needs. */
export type Row = {
  uuid: string
  /** parentUuid, or logicalParentUuid for a compaction boundary; null for a root. */
  parent: string | null
  /** 1-based line of the file (across incremental reads). */
  line: number
  kind: Kind
  /** The text kept for search, copy and drafts; previews are cut from it. */
  text: string
  /** True when `text` was cut short. */
  isCut: boolean
  /** The API message id of an assistant row. */
  messageId?: string
  /** The row was written by a subagent inline (older engines). */
  isSidechain: boolean
  /** ISO time as written; shown, never used for order. */
  timestamp?: string
}

export type Filter = 'default' | 'no-tools' | 'user-only' | 'labeled' | 'all'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  defaultFilter: Filter
  refreshOnTurn: boolean
  maxTranscriptMB: number
}

/** The template's on/off session record; removed with the template command. */
export type Session = { mode: 'on' | 'off' | null; turns: number }

export type Mode = 'browse' | 'label' | 'confirm-draft'

/** The pane's view of the session. Lives in $.state, so it survives a hot reload. */
export type View = {
  /** The session this view belongs to; another session's view reads as fresh. */
  sessionId: string | null
  filter: Filter
  query: string
  /** The selected row's uuid. */
  cursor: string | null
  /** Show the selected row's details. */
  isExpanded: boolean
  mode: Mode
  /** A one-line message for the person (an action's outcome, an error). */
  notice: string | null
  /** Bumped whenever the parsed tree changes, so the pane redraws. */
  rev: number
  /** Load status. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Labels for one session, mirrored from $.store. */
export type Labels = { sessionId: string | null; map: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'tree': { view: Shaped<View>; labels: Shaped<Labels>; session: Shaped<Session> }
  }
}
