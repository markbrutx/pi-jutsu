# simplify

A pi extension that runs a changed-code review with three parallel subagents,
then guides the agent through fixing what they find.

## Command

```
/simplify [optional focus text]
```

Anything after `/simplify` is passed through as additional focus for the
reviewers (e.g. `/simplify pay extra attention to error handling`).

## How it works

The command drives a single tool, `simplify_review`, through three phases.

### Phase 1: identify changed code

The tool determines what changed using git:

- Runs `git diff --cached --quiet --exit-code` to check whether anything is
  staged.
- Uses `git diff HEAD` if there are staged changes, otherwise `git diff`.
- Separately collects untracked files via
  `git ls-files --others --exclude-standard` and diffs each against
  `/dev/null` (bounded concurrency, capped total/per-file byte budget) so new
  files are included in the review, not just modifications to tracked files.
- If the diff is empty (e.g. nothing changed since the last commit), falls
  back to extracting recently touched file paths from the current session's
  conversation history (assistant text, tool calls, tool results) instead of
  reviewing the whole repository.

### Phase 2: parallel subagent review

Three isolated review subagents run concurrently, each seeing the same change
set and focus text but scoped to read-only tools (`read`, `grep`, `find`,
`ls`, `bash`). None of them can modify files.

- **Code Reuse** - looks for existing utilities/helpers that duplicate or
  could replace newly written code, and inline logic that should call an
  existing utility instead.
- **Code Quality** - flags hacky patterns: redundant state, parameter
  sprawl, copy-paste-with-variation, leaky abstractions, stringly-typed code,
  unnecessary UI nesting, and unnecessary comments.
- **Efficiency** - flags unnecessary work, missed concurrency, hot-path
  bloat, recurring no-op updates in loops/handlers, unnecessary existence
  checks, memory issues, and overly broad reads/loads.

Progress streams live in the UI: each subagent's status (pending/running/
done/failed), last activity, tool calls, and thinking are shown collapsed by
default, with full output and findings visible when the tool call is
expanded.

### Phase 3: fix findings

Once all three subagents finish, their findings are aggregated into a single
fix prompt handed back to the main agent, which:

- fixes actionable findings directly in the working tree;
- skips false positives or not-worth-changing findings and notes why;
- makes no edits if every reviewer reports "No findings" and no independent
  issue is identified;
- ends with a concise summary of what changed (or confirmation that nothing
  needed changing).

## Install

Point pi at this extension directory, either via the CLI flag:

```
pi -e /path/to/pi-jutsu/extensions/simplify
```

or by adding it to the `extensions` array in your pi settings:

```json
{
  "extensions": ["/path/to/pi-jutsu/extensions/simplify"]
}
```

## Requirements

- Runs inside a git repository (or a working tree with a `.git` directory);
  outside of one, it falls back to reviewing recently touched files from the
  session.
- Requires `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as
  provided by the pi harness.
