# simplify

A pi extension that runs a changed-code review with a configurable council of
parallel subagents, then guides the agent through fixing what they find.

## Commands

```
/simplify [optional focus text]
/simplify-council
```

Anything after `/simplify` is passed through as additional focus for the
reviewers (e.g. `/simplify pay extra attention to error handling`).

On the first `/simplify` without saved preferences, a fullscreen picker
(alt-screen, like the agents dashboard) asks which model each review role
runs on; the choice is saved to `~/.pi/agent/simplify-settings.json` and
skipped afterwards. `/simplify-council` reopens the picker (preserving any
custom member ids, aspects, and instructions — it only reassigns models).
The picker has an idle timeout: walk away and the review proceeds with the
current defaults instead of blocking.

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

The configured council of isolated review subagents runs concurrently, each
seeing the same change set and focus text but scoped to read-only tools
(`read`, `grep`, `find`, `ls`, `bash`). None of them can modify files. The
default council is three role reviewers, each optionally on its own model:

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
done/failed), last activity, model/account attribution, tool calls, and
thinking are shown collapsed by default, with full output and findings
visible when the tool call is expanded. Runs are also published to the
swarm worker-run registry, so the council shows up in the swarm agents
dashboard while it reviews.

## Configuration

`~/.pi/agent/simplify-settings.json`:

```json
{
  "council": [
    { "id": "reuse", "aspect": "reuse", "model": "anthropic/claude-fable-5" },
    { "id": "quality", "aspect": "quality" },
    { "id": "deep", "instruction": "Custom review brief...", "model": "provider/model-id" }
  ]
}
```

Member fields: `id` (display name), `aspect` (`reuse` | `quality` |
`efficiency` | `full`; default `full`), `instruction` (custom review brief,
overrides aspect), `model` (exact `provider/model-id` from `--list-models`;
omit to run on the lead's model). Missing or invalid config = the classic
reuse/quality/efficiency trio on the lead's model.

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
- Requires the sibling [swarm](../swarm/) extension directory to be present
  in the same checkout (simplify imports its worker-run registry and shared
  helpers via relative paths; you do not have to enable swarm in settings).
- Requires `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as
  provided by the pi harness.
