# tree

A Claude Code mod that shows the current session as a tree: every branch the transcript keeps, including the ones `/rewind` and edited prompts leave behind. You can filter it, search it, bookmark entries with labels, and pick an entry up again: put an old prompt back in the prompt box, copy an entry, or hand off to `/rewind` and `/branch`. It is a browser, not a time machine: Claude Code has no API for moving the conversation to an arbitrary entry, so the mod never claims to.

## Behavior

- `/tree` opens a pane beside the transcript (fullscreen layout) or above the prompt (main screen). It reads this session's transcript file and draws it as a tree.
- Rows are linked by their parent ids, in file order. Compaction boundaries are bridged, so the history before a `/compact` stays attached. Parallel tool calls are folded into one line of history; only real forks (an edited or rewound prompt) branch.
- The path to the newest entry in the file is the **current path** (marked `●`); entries off it are drawn dim (`○`). Claude Code does not expose its own position, so right after `/rewind` the marker still shows the old leaf until you send the next message.
- Who sent a row decides how it shows: the transcript's recorded origin, then its type. Your typed and queued prompts are `you:`, kept word for word even when they quote transcript markup; a background task's notification or a plugin's prompt is tagged with its sender.
- If a read fails, the pane says so on its own first line and marks the rows below as stale (from the last good read). If the transcript has moved to another project folder, a refresh looks for it once more before giving up.
- Repairs the reader made to a damaged file (duplicate ids, cycles, missing parents) are counted in the pane and in `/tree status`; the affected rows are kept.
- Only the visible window is drawn, so long sessions stay responsive. The pane refreshes itself after each main-conversation turn while it is open (`refreshOnTurn`), reading only the bytes added since the last read.
- Main conversation only. Subagent rows (sidechains and `subagents/` transcripts) are not shown.
- **It costs no model calls and no tokens**, apart from the one-line output of `/tree` itself, which joins the transcript. Reading a transcript costs local CPU: a 50 MB transcript is read in full once when the pane first opens, then only the new bytes.
- **It never writes to transcripts** or anything under `~/.claude/projects/`. It never submits a prompt, never moves the conversation, and never restores files.

### Keys

The pane takes the keyboard when it opens (if the prompt box is empty). Tab walks the focus ring; Enter on a row selects it and shows more of it. Every action has a hotkey:

| Key | What it does |
| --- | --- |
| `j` / `k` | Next / previous row |
| `n` / `p` | Page down / page up |
| `1`–`5` | Filter: default, no tools, user only, labeled, all |
| `s` | Search: type words (every word must appear; case ignored), Enter when done. While the field is open no hotkey is active, so letters only type. |
| `l` | Label the selected entry, Enter to save (an empty label removes it). The entry is fixed when the editor opens: the rows are not selectable and no hotkey is active until you save or cancel. |
| `e` | Put the selected prompt in the prompt box as a draft (asks first if the box holds text) and close the pane |
| `c` | Copy the selected entry's text |
| `w` | Asks, then (`1`) closes the pane and opens `/rewind` (Claude Code's own picker; choose the entry there). `3` cancels. |
| `b` | Asks, then (`1`) closes the pane and runs `/branch` (branches the conversation as it stands now, not at the selected entry). `3` cancels. |
| `o` | Copy the shell command that resumes this session as a fork in another terminal: `claude --resume <id> --fork-session` |
| `r` | Read new entries now |
| Esc | Close the pane |

### Filters

| Filter | Shows |
| --- | --- |
| default | Prompts, slash commands, replies, tool calls and results, messages from machines (task notifications, a plugin's prompt; tagged with the sender, never `you:`), compaction boundaries and summaries. Hides attachments, system notices, hidden (meta) rows and thinking-only rows. |
| no tools | Default, less tool calls and tool results |
| user only | What you sent: typed prompts, prompts queued while a turn ran, and slash commands (including locally recorded ones). Never a task notification or a plugin's prompt. |
| labeled | Entries with a label |
| all | Every row with an id |

## Command

`/tree [open|refresh|close|status|help]`: `open` (the default) opens the pane, `refresh` reads new entries, `close` closes it, `status` says what was read.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on. Off, `/tree` answers that it is off, nothing reads the transcript, and a pane left open from before is closed (or shows that it is off). |
| `defaultFilter` | `default` | The filter the pane opens with: `default`, `no-tools`, `user-only`, `labeled` or `all`. |
| `refreshOnTurn` | `true` | Read new entries after each main-conversation turn while the pane is open. |
| `maxTranscriptMB` | `256` | Refuse to read a transcript larger than this. |

## Limitations

- No jump-to-entry. The engine has no call that moves the conversation to an entry. `/rewind` (Claude Code's own picker) is the way back; the mod opens it but cannot preselect the entry. `/branch` branches from where the conversation stands now.
- The current-path marker follows the newest row in the file, not the engine's own pointer (see Behavior).
- Drafts restore text only: images and pasted files are not put back. An entry whose text the reader cut (over 200,000 characters) is not offered as a draft.
- Labels are kept per session id. A `/branch` or `--fork-session` starts a new id, so labels don't follow. `$.store` holds all labels for all sessions in one file capped at 4 MiB.
- Subagent transcripts are not shown. Rows from older versions that stored subagent turns inline (`isSidechain`) are left out.
- The transcript location is worked out from the session id and folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`, then `projects/<folder slug>/<id>.jsonl`), with a search of every project folder as the fallback. Reading uses `tail`, so the mod needs macOS or Linux.
- Search matches words as substrings, not omp's fuzzy match, and covers each entry's kept text (prompts and replies in full up to the cut, tool rows by their first 300 characters).
- Cut from omp's `/tree`: summaries of abandoned branches, re-answering a past question, branch-to-branch jumps and omp's exact key bindings.
- Mobile has no text fields, so no search and no labeling there; the rest works by button.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-tree
claude plugin install tree@tree --scope user
```

Or from inside Claude Code: `/plugin install tree --marketplace chrisvaillancourt/claude-tree`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update tree
claude plugin update tree@tree
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
