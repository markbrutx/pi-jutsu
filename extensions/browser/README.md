# browser

A `browser` tool for the [pi coding agent](https://github.com/earendil-works/pi) that wraps the
[`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI ([agent-browser.dev](https://agent-browser.dev)),
a browser-automation CLI built for AI agents (Playwright-based, CDP support, snapshot/ref driven interaction). The
model passes raw CLI arguments to a single tool call; a long-running `agent-browser` daemon keeps Chrome alive
between calls so element refs returned by `snapshot` stay valid across tool invocations.

## External dependency

This extension does not bundle a browser or automation engine. It shells out to the `agent-browser` binary, which
must be installed and resolvable on `PATH` (or pointed to via `BROWSER_CLI_BIN`):

```bash
npm install -g agent-browser
```

See [github.com/vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) for CLI installation and
command reference. Without it installed, every `browser` tool call fails with a spawn error.

## Install

```bash
pi -e /path/to/pi-jutsu/extensions/browser/index.ts
```

or in settings:

```json
{
  "extensions": ["/path/to/pi-jutsu/extensions/browser/index.ts"]
}
```

## Usage

The tool takes:

- `args` (string array, required): CLI arguments for `agent-browser`, without the binary name, e.g.
  `["open", "https://example.com"]` or `["snapshot", "-i"]`.
- `profile` (string, optional): persistent profile name. Defaults to `work` (or `PI_BROWSER_PROFILE`).
- `timeoutMs` (number, optional): per-call timeout in milliseconds. Default 60000.

Recommended first call in a session: `args = ["skills", "get", "core"]`, which returns the CLI's own
snapshot/ref workflow documentation. From there:

```
["open", "https://example.com"]
["snapshot", "-i"]                 // accessibility tree, interactive elements only
["click", "@e3"]                   // ref from the last snapshot
["fill", "@e1", "user@example.com"]
["screenshot", "page.png"]
["eval", "document.title"]
["close"]
```

Refs (`@e1`, `@e2`, ...) from the last `snapshot` stay valid until the page changes; re-snapshot after
navigation or any action that re-renders the page.

Waiting and network inspection are first-class, so the model should never poll with sleep+eval loops:

```
["wait", "--text", "Done"]                  // also: <selector>, --url, --fn <expr>
["wait", "--load", "networkidle"]
["network", "requests", "--filter", "api/"]
```

## Persistent profiles

Each profile is its own Chrome user-data-dir under `~/.pi/browser-profiles/<name>`, so cookies, history, logins
and settings survive process restarts. The default profile is `work` (override globally with
`PI_BROWSER_PROFILE`, or per call with the tool's `profile` parameter). Switching profiles between calls closes
and restarts the underlying daemon, since `agent-browser` only picks up a user-data-dir at daemon start.

Calls that attach to an external Chrome instead of launching one (`args` containing `--cdp`, or `args[0] ===
"connect"`) skip the profile/executable wiring entirely.

## Stealth Chromium (optional)

If a [CloakBrowser](https://cloakbrowser.com) Chromium build is present under `~/.cloakbrowser/chromium-*`
(newest version wins), the extension points `agent-browser` at it via `AGENT_BROWSER_EXECUTABLE_PATH` instead of
system Chrome, for fingerprint-hardened automation. This is entirely optional: if no CloakBrowser build is found,
`agent-browser` falls back to its own default browser resolution.

- Disable with `PI_BROWSER_STEALTH=0` (or `false`/`no`).
- Override the binary path directly with `CLOAKBROWSER_BINARY_PATH`.
- When enabled and detected, the resolved path is also exported into `AGENT_BROWSER_EXECUTABLE_PATH` for the
  current process, so any `agent-browser` invocation from a plain shell (not just this tool) inherits the same
  browser build and fingerprint.

## Idle timeout

`agent-browser` runs as a detached daemon that can outlive the pi process. The extension sets
`AGENT_BROWSER_IDLE_TIMEOUT_MS` (default 300000ms / 5 minutes) unless already set, so the daemon self-terminates
after that much inactivity instead of lingering indefinitely. Any active `agent-browser` process, not just this
one, resets the timer, so a daemon shared across sessions only exits once all of them are idle or gone.

## Environment variables

| Variable | Effect |
|---|---|
| `BROWSER_CLI_BIN` | Override the `agent-browser` binary name/path. Default `agent-browser`. |
| `PI_BROWSER_PROFILE` | Default profile name. Default `work`. |
| `PI_BROWSER_STEALTH` | Set to `0`/`false`/`no` to disable CloakBrowser detection. |
| `CLOAKBROWSER_BINARY_PATH` | Explicit path to a CloakBrowser Chromium binary. |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | Daemon idle-shutdown timeout in ms. Default 300000. Respected if already set by the user. |
| `AGENT_BROWSER_EXECUTABLE_PATH` | Set by this extension when stealth is enabled and a build is found; also read/respected if already set. |
| `AGENT_BROWSER_PROFILE` | Set by this extension per call to the resolved profile directory. |

## Result shape

Each tool call returns the formatted `stdout`/`stderr` as text content, plus a `details` object with `command`,
`profile`, `stealth`, `exitCode`, `stdout`, `stderr`, and `timedOut`. The call is marked as an error if the
process exits non-zero or times out.
