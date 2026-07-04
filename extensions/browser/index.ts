/**
 * Browser automation extension for the harness.
 *
 * Wraps the `agent-browser` CLI as a single tool named `browser`. The LLM
 * passes raw CLI args; the underlying daemon keeps Chrome alive between calls,
 * so refs from `snapshot` stay valid across tool invocations.
 *
 * Two things are handled natively, so the LLM never has to think about them:
 *
 *   1. Stealth Chrome. A separate CloakBrowser Chromium build (fingerprint
 *      patches compiled into the binary) is used instead of system Chrome.
 *      Auto-detected under ~/.cloakbrowser/chromium-*. Override the path with
 *      CLOAKBROWSER_BINARY_PATH, or disable with PI_BROWSER_STEALTH=0.
 *
 *   2. Persistent profiles. Each profile is its own Chrome user-data-dir under
 *      ~/.pi/browser-profiles/<name>, so cookies, history, logins and settings
 *      survive restarts. Defaults to the `work` profile; override per call with
 *      the `profile` param or globally with PI_BROWSER_PROFILE.
 *
 * Bootstrap: the agent should run `browser ["skills", "get", "core"]` once to
 * learn the snapshot/ref workflow, then drive the browser normally.
 *
 * Override the CLI binary with the BROWSER_CLI_BIN environment variable.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BIN = "agent-browser";
const DEFAULT_TIMEOUT_MS = 60_000;
// The agent-browser daemon is a detached, persistent Chrome that reparents to
// launchd and outlives the pi process. Without an idle timeout it lingers
// forever after pi is killed (incl. kill -9). With one, it self-terminates once
// nothing has driven it for this long - which, after pi dies, means it goes away
// on its own. Multi-session-safe: any activity from any live session resets the
// timer, so a shared daemon only dies when ALL of them are gone. Override via env.
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const PROFILES_DIR = path.join(homedir(), ".pi", "browser-profiles");
const DEFAULT_PROFILE = process.env.PI_BROWSER_PROFILE || "work";
const STEALTH_ENABLED = !["0", "false", "no"].includes((process.env.PI_BROWSER_STEALTH ?? "").toLowerCase());

// Cached once per process. `null` = looked, not found; `undefined` = not looked yet.
let cachedStealthBinary: string | null | undefined;
// Tracks the profile the live daemon was launched with, so a switch can restart it.
let activeProfile: string | null = null;

export default function browserExtension(harness: ExtensionAPI) {
	const bin = process.env.BROWSER_CLI_BIN ?? DEFAULT_BIN;

	// Export the stealth engine into the process env so child shells (the lead's bash
	// tool AND subagent/clone shells) inherit the same engine as the browser tool.
	// Without this, `agent-browser` run from bash silently uses vanilla Chromium — a
	// different binary and fingerprint than the harness browser tool.
	if (STEALTH_ENABLED && !process.env.AGENT_BROWSER_EXECUTABLE_PATH) {
		const binary = findStealthBinary();
		if (binary) process.env.AGENT_BROWSER_EXECUTABLE_PATH = binary;
	}

	// Make every daemon (this tool's and clones' bash `agent-browser` calls, which
	// inherit this env) auto-reap on inactivity, so killing pi never leaves an
	// orphaned browser daemon. A user-set value wins.
	if (!process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS) {
		process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(DEFAULT_IDLE_TIMEOUT_MS);
	}

	harness.registerTool({
		name: "browser",
		label: "Browser",
		description: [
			"Drive a stealth Chrome browser via the agent-browser CLI.",
			"Pass raw CLI arguments as `args` (without the binary name).",
			"",
			"Stealth Chromium and a persistent profile are wired in automatically:",
			"cookies, logins and history survive across calls and sessions. Default",
			`profile is "${DEFAULT_PROFILE}"; pass \`profile\` to use a different one.`,
			"",
			'First call MUST be: args = ["skills", "get", "core"]',
			"This returns the snapshot/ref workflow you need to interact with pages.",
			"",
			"Common patterns:",
			'  ["open", "https://example.com"]',
			'  ["snapshot", "-i"]                 // accessibility tree, interactive only',
			'  ["click", "@e3"]                   // ref from snapshot',
			'  ["fill", "@e1", "user@example.com"]',
			'  ["screenshot", "page.png"]',
			'  ["eval", "document.title"]',
			'  ["close"]',
			"",
			"The Chrome daemon persists between calls; refs from the last `snapshot` stay",
			"valid until the page changes (navigation, click that re-renders, etc.).",
			'Re-snapshot after any page change. Run ["<command>", "--help"] for per-command flags.',
			"",
			"Waiting and network inspection are built in — NEVER poll with sleep+eval:",
			'  ["wait", "--text", "Done"]            // also: <selector>, --url, --fn <expr>',
			'  ["wait", "--load", "networkidle"]     // blocks until network settles',
			'  ["network", "requests", "--filter", "api/"]   // recent requests/responses',
		].join("\n"),
		promptSnippet:
			"Drive a stealth Chrome browser with persistent profiles (open URLs, click, fill forms, screenshot, eval JS).",
		promptGuidelines: [
			'Before using browser for the first time in a session, call browser with args=["skills","get","core"] and follow the snapshot+ref workflow it describes.',
			'Always re-run ["snapshot","-i"] after any action that changes the page; old @eN refs become stale.',
			"Stealth Chromium and the persistent profile are automatic. Do not pass --executable-path or --profile yourself; use the `profile` param to switch profiles.",
			'Never poll a page with sleep+eval loops: use ["wait", ...] (selector, --text, --url, --fn, --load networkidle) and ["network", "requests", "--filter", ...] — they block without burning turns.',
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), {
				description:
					'CLI arguments for agent-browser (without the binary). Example: ["open","example.com"] or ["snapshot","-i"].',
			}),
			profile: Type.Optional(
				Type.String({
					description: `Persistent profile name (user-data-dir under ~/.pi/browser-profiles). Default "${DEFAULT_PROFILE}".`,
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
					minimum: 1000,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const args = params.args ?? [];
			if (args.length === 0) {
				return {
					content: [
						{ type: "text", text: 'error: args is empty. Try args=["skills","get","core"] first.' },
					],
					details: { isError: true },
					isError: true,
				};
			}

			const profile = params.profile ?? DEFAULT_PROFILE;
			const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			// connect/--cdp attach to an external Chrome; profile + executable must not be set.
			const usesCdp = args.includes("--cdp") || args[0] === "connect";

			// Switching profiles requires restarting the daemon, otherwise the new
			// profile is silently ignored ("daemon already running").
			if (!usesCdp && activeProfile !== null && activeProfile !== profile) {
				await runCli(bin, ["close", "--all"], { timeoutMs: 15_000, env: process.env });
			}

			const env = usesCdp ? process.env : buildEnv(profile);
			if (!usesCdp) activeProfile = profile;

			const cmdLine = `${bin} ${args.map(quoteArg).join(" ")}`;
			onUpdate?.({ content: [{ type: "text", text: `$ ${cmdLine}` }], details: undefined });

			const result = await runCli(bin, args, { signal, timeoutMs, env });
			const text = formatResult(cmdLine, result);

			return {
				content: [{ type: "text", text }],
				details: {
					command: cmdLine,
					profile: usesCdp ? undefined : profile,
					stealth: usesCdp ? undefined : Boolean(env.AGENT_BROWSER_EXECUTABLE_PATH),
					exitCode: result.code,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: result.timedOut,
				},
				isError: result.code !== 0 || result.timedOut,
			};
		},
	});
}

/** Build the env for a profiled, stealth agent-browser invocation. */
function buildEnv(profile: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };

	const profileDir = path.join(PROFILES_DIR, profile);
	mkdirSync(profileDir, { recursive: true });
	env.AGENT_BROWSER_PROFILE = profileDir;

	if (STEALTH_ENABLED) {
		const binary = findStealthBinary();
		if (binary) env.AGENT_BROWSER_EXECUTABLE_PATH = binary;
	}
	return env;
}

/** Locate the newest CloakBrowser Chromium build, or null if not installed. */
function findStealthBinary(): string | null {
	if (cachedStealthBinary !== undefined) return cachedStealthBinary;

	const override = process.env.CLOAKBROWSER_BINARY_PATH;
	if (override && existsSync(override)) {
		cachedStealthBinary = override;
		return override;
	}

	const root = path.join(homedir(), ".cloakbrowser");
	let dirs: string[];
	try {
		dirs = readdirSync(root).filter((d) => d.startsWith("chromium-"));
	} catch {
		cachedStealthBinary = null;
		return null;
	}
	dirs.sort((a, b) => compareVersionDesc(a.slice("chromium-".length), b.slice("chromium-".length)));

	// Relative executable paths across platforms.
	const candidates = [
		"Chromium.app/Contents/MacOS/Chromium", // macOS
		"chrome-linux/chrome", // Linux
		"chrome",
		"chromium",
		"chrome.exe", // Windows
	];
	for (const dir of dirs) {
		for (const rel of candidates) {
			const p = path.join(root, dir, rel);
			if (existsSync(p)) {
				cachedStealthBinary = p;
				return p;
			}
		}
	}
	cachedStealthBinary = null;
	return null;
}

/** Compare dotted version strings, descending (newest first). */
function compareVersionDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (diff) return diff;
	}
	return 0;
}

interface CliResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

interface RunOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

function runCli(bin: string, args: string[], opts: RunOptions): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: opts.env,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code, timedOut });
		};

		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});
		child.on("error", (err) => {
			stderr += `${stderr ? "\n" : ""}spawn error: ${err.message}`;
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 0));

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
		}, opts.timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function formatResult(cmd: string, r: CliResult): string {
	const parts: string[] = [`$ ${cmd}`];
	if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
	if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
	if (r.timedOut) parts.push("[timed out]");
	if (r.code !== 0 && !r.timedOut) parts.push(`[exit code ${r.code}]`);
	if (parts.length === 1) parts.push("(no output)");
	return parts.join("\n");
}

function quoteArg(arg: string): string {
	if (arg === "" || /[\s"'\\$`]/.test(arg)) {
		return `'${arg.replace(/'/g, "'\\''")}'`;
	}
	return arg;
}
