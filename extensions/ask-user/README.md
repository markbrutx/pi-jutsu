# ask-user

An `ask_user` tool the LLM can call to ask you 1-4 multiple-choice
questions mid-run — a port of Claude Code's AskUserQuestion, with upgrades:

- **multiSelect** with space toggles and checkbox UI
- **markdown previews** per option, rendered for the focused option
  (code snippets, ASCII mockups, config examples)
- **"Other"** free-text option with an inline editor, always available
- **notes** (`n`): attach free-text commentary to any answer; it is sent
  to the model alongside the selection
- **tab bar** for multiple questions with answered-state markers
- **idle timeout with countdown**: if you walk away, the tool auto-resolves
  with the answers so far and the model continues with its best judgment —
  the agent turn never blocks forever, and queued steering messages
  (e.g. shadow-clone reports) keep flowing. Any keypress resets the timer.

## Keys

`↑↓` move · `1-9` jump · `space` toggle (multi) · `⏎` select/confirm ·
`n` note · `tab`/`←→` switch question · `esc` decline (graceful: the model
is told not to re-ask)

## Tool schema

`questions[]`: `question`, `header` (short tab label), `options[]`
(`label`, `description?`, `preview?`), `multiSelect?`. Plus
`timeoutSeconds` (default 300, clamped 30–3600).
