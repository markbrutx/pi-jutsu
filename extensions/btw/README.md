# btw

`/btw <question>` — ask a side question about the current session without
polluting it. Opens a fullscreen alt-screen UI (the chat behind never
repaints): pick a model, get a streamed answer with the full conversation
as context, ask follow-ups in the same side thread. Nothing is stored in
the main session.

## Usage

```
/btw why did that test fail?
```

- **Picker**: `↑↓`/`1-4` choose a model, `⏎` ask, `esc` close. The cursor
  remembers the last used model.
- **Answer view**: `⏎`/`f` follow-up (continues the side thread with
  context), `y` copy the answer to the clipboard, `r` re-ask, `↑↓`
  `PgUp/PgDn` scroll, `esc` close (aborts an in-flight request).

Completed answers are appended to `~/.pi/agent/btw-history.jsonl`.
`/btw-history` browses them in the same fullscreen UI (`⏎` view, `y` copy).

## Configuration

The model shortlist is the `BTW_MODELS` constant at the top of `index.ts` —
edit it to your providers. Conversation context is serialized through the
harness pipeline (compaction-aware) and capped at 150k characters.

Requires the [pif fork](../../README.md#compatibility) for the alt-screen
fullscreen overlay; on upstream pi the overlay renders without the
alternate buffer.
