import {
	createAgentSession,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	isToolCallEventType,
	SessionManager,
	truncateHead,
	truncateTail,
	type AgentSession,
	type AuthStorage,
	type ExtensionAPI,
	type ExtensionContext,
	type ResourceLoader,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isPolicyBlockedError, StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Input, Key, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { exec, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	createCloneAuthStorage,
	createCloneModelRegistry,
	createSubagentLoader,
	createThrottledEmitter,
	formatDisplayItem,
	formatModelSpec,
	getAccountCredential,
	getEventUpdate,
	getModelTransition,
	getToolPathArg,
	isRateLimitedError,
	listAccountProfiles,
	pinCloneAccount,
	readSwarmSettings,
	resolveAccountLabel,
	resolveSpawnModel,
	resolveSpawnThinkingLevel,
	SPAWN_THINKING_LEVELS,
	STOP_REASON_ERROR,
	truncateSingleLine,
	type SwarmDisplayItem,
} from "./shared.ts";
import { createSwarmTool, type SwarmAgentProgress, type SwarmDetails, type SwarmStatus } from "./index.ts";
import {
	clearWorkerRuns,
	dispelWorkerRun,
	listWorkerRuns,
	onWorkerRunsChange,
	type WorkerRunRecord,
} from "./registry.ts";

export const CLONE_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls", "report_to_lead", "wait_for", "worker_run"] as const;

/** Clone toolset; worker_run is dropped unless cloneWorkers is enabled so clones can't recurse by default. */
export function cloneToolNames(cloneWorkers: boolean): string[] {
	return cloneWorkers ? [...CLONE_TOOL_NAMES] : CLONE_TOOL_NAMES.filter((name) => name !== "worker_run");
}
const MAX_CLONES = 8;
// 24 = three full lead sessions at the per-session cap (3 x 8), so several leads
// (e.g. parallel pSEO waves) can each run a full clone batch concurrently.
const GLOBAL_MAX_CLONES = 24;
const WIDGET_THROTTLE_MS = 150;
const SHADOWCLONE_REPORT_TYPE = "shadowclone-report";
const TRANSCRIPT_MAX_ENTRIES = 300;
const ITEMS_MAX = 30;
const MEMORY_MIN_TRANSCRIPT_ENTRIES = 6;
const MEMORY_TRANSCRIPT_MAX_CHARS = 40_000;
const MEMORY_DISTILL_TIMEOUT_MS = 30_000;
const CLONE_REPORT_MAX_BYTES = 20 * 1024;
const CLONE_REPORT_BATCH_MAX_BYTES = 48 * 1024;
export const CLONE_ABORT_GRACE_MS = 2_000;
const LINGER_MINUTES = 5;
const LINGER_MS = LINGER_MINUTES * 60_000;
const WAIT_TIMEOUT_DEFAULT_S = 300;
const WAIT_TIMEOUT_MAX_S = 1800;
const WAIT_COMMAND_TIMEOUT_MS = 30_000;
const SLEEP_GUARD_MIN_S = 10;

export function truncateCloneReport(output: string, maxBytes: number = CLONE_REPORT_MAX_BYTES): string {
	const normalized = output.trim() || "(no report returned)";
	const budget = Math.max(0, Math.floor(maxBytes));
	const totalBytes = Buffer.byteLength(normalized, "utf8");
	if (totalBytes <= budget) return normalized;
	if (budget === 0) return "";

	const marker = `[Clone report truncated from ${formatSize(totalBytes)} to protect the lead context. The full report is preserved in the clone log.]`;
	const markerBytes = Buffer.byteLength(`\n\n${marker}\n\n`, "utf8");
	if (markerBytes >= budget) return truncateTail(marker, { maxBytes: budget, maxLines: 1 }).content;
	const contentBudget = budget - markerBytes;
	const headBudget = Math.max(1, Math.floor(contentBudget / 2));
	const tailBudget = Math.max(1, contentBudget - headBudget);
	const head = truncateHead(normalized, { maxBytes: headBudget, maxLines: 1000 }).content;
	const tail = truncateTail(normalized, { maxBytes: tailBudget, maxLines: 1000 }).content;
	return [head, marker, tail].filter(Boolean).join("\n\n");
}

export function truncateCloneReportBatch(
	reports: readonly string[],
	maxBytes: number = CLONE_REPORT_BATCH_MAX_BYTES,
): string {
	if (reports.length === 0) return "";
	if (reports.length === 1) return truncateCloneReport(reports[0], Math.min(maxBytes, CLONE_REPORT_MAX_BYTES));
	const prefix = `${reports.length} shadow clone reports:\n\n`;
	const separator = "\n\n———\n\n";
	const overhead = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(separator, "utf8") * (reports.length - 1);
	const perReportBudget = Math.max(1, Math.floor((Math.max(0, maxBytes) - overhead) / reports.length));
	return `${prefix}${reports.map((report) => truncateCloneReport(report, perReportBudget)).join(separator)}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** OS-native label for the dashboard hotkey: ⌥K on macOS, alt+k elsewhere. */
const HOTKEY_LABEL = process.platform === "darwin" ? "⌥K" : "alt+k";

/** One icon language everywhere: spinner = working, ? = waiting, ⏸ = paused, green check = ready, red cross = failed. */
function statusIcon(theme: Theme, status: CloneStatus, spinnerGlyph: string): string {
	if (status === "working") return theme.fg("warning", spinnerGlyph);
	if (status === "waiting") return theme.fg("warning", "?");
	if (status === "paused") return theme.fg("warning", "⏸");
	if (status === "idle") return theme.fg("success", "✔");
	return theme.fg("error", "✗");
}

function statusWord(theme: Theme, status: CloneStatus): string {
	if (status === "working") return theme.fg("dim", "working");
	if (status === "waiting") return theme.fg("warning", "waiting");
	if (status === "paused") return theme.fg("warning", "paused");
	if (status === "idle") return theme.fg("success", "ready");
	return theme.fg("error", "failed");
}

/** Worker-run phase glyph: spinner while active, green dot done, red cross failed. */
function workerPhaseIcon(theme: Theme, phase: string, spinnerGlyph: string): string {
	if (phase === "failed") return theme.fg("error", "✗");
	if (phase === "done") return theme.fg("success", "✔");
	return theme.fg("warning", spinnerGlyph);
}

/** Per-agent status bits shared by sidebar worker rows and the worker panes. */
function agentStatusBits(status: SwarmStatus): {
	icon: string;
	word: string;
	tone: "success" | "error" | "warning" | "muted";
} {
	if (status === "done") return { icon: "✔", word: "done", tone: "success" };
	if (status === "failed") return { icon: "✗", word: "failed", tone: "error" };
	if (status === "running") return { icon: "▸", word: "running", tone: "warning" };
	return { icon: "○", word: "queued", tone: "muted" };
}

/** Sidebar/pane icon for one worker agent: live spinner while running, static glyphs otherwise. */
function agentStatusIcon(theme: Theme, status: SwarmStatus, spinnerGlyph: string): string {
	if (status === "running") return theme.fg("warning", spinnerGlyph);
	const { icon, tone } = agentStatusBits(status);
	return theme.fg(tone, icon);
}

/** Settled (done|failed) and total agent counts for a worker run. */
function workerCounts(run: WorkerRunRecord): { total: number; done: number; running: number; failed: number } {
	const agents = run.details.agents;
	return {
		total: agents.length,
		done: agents.filter((a) => a.status === "done").length,
		running: agents.filter((a) => a.status === "running").length,
		failed: agents.filter((a) => a.status === "failed").length,
	};
}

type TranscriptKind = "thinking" | "clone" | "tool" | "lead" | "user" | "report" | "status" | "meta";

interface TranscriptEntry {
	kind: TranscriptKind;
	stamp: string;
	text: string;
	/** Header label shown above the body; defaults per kind (e.g. "thinking", "lead"). */
	label?: string;
}

const ENTRY_DEFAULT_LABELS: Partial<Record<TranscriptKind, string>> = {
	thinking: "thinking",
	clone: "clone",
	lead: "lead",
	user: "user",
};

/** Plain-text form of an entry: used for the on-disk log and memory distillation. */
function entryToLogText(entry: TranscriptEntry): string {
	const label = entry.label ?? ENTRY_DEFAULT_LABELS[entry.kind];
	return label ? `[${entry.stamp}] ${label}:\n${entry.text}` : `[${entry.stamp}] ${entry.text}`;
}

function statusTone(text: string): "error" | "success" | "warning" | "muted" {
	if (text.startsWith("error") || text.includes("failed") || text.includes("crash")) return "error";
	if (text.includes("ready") || text.includes("completed")) return "success";
	if (text.includes("waiting")) return "warning";
	return "muted";
}

const NAME_POOL = [
	// Team 7 + senseis
	"naruto",
	"sasuke",
	"sakura",
	"kakashi",
	"sai",
	"yamato",
	// Uchiha
	"itachi",
	"shisui",
	"obito",
	"madara",
	// Hokage & founders
	"minato",
	"kushina",
	"hashirama",
	"tobirama",
	"hiruzen",
	"tsunade",
	"danzo",
	// Sannin & co
	"jiraiya",
	"orochimaru",
	"kabuto",
	"shizune",
	// Konoha 11 + senseis
	"shikamaru",
	"ino",
	"choji",
	"asuma",
	"hinata",
	"neji",
	"hanabi",
	"kiba",
	"shino",
	"kurenai",
	"rock-lee",
	"tenten",
	"gai",
	"konohamaru",
	"iruka",
	"anko",
	"ibiki",
	"genma",
	"rin",
	// Suna
	"gaara",
	"temari",
	"kankuro",
	"chiyo",
	// Akatsuki
	"pain",
	"nagato",
	"konan",
	"yahiko",
	"kisame",
	"deidara",
	"sasori",
	"hidan",
	"kakuzu",
	"zetsu",
	// Kiri & rogue
	"zabuza",
	"haku",
	"kimimaro",
	"suigetsu",
	"karin",
	"jugo",
	"mei",
	"chojuro",
	"yagura",
	"utakata",
	// Kumo / Iwa / jinchuriki & kage
	"killer-bee",
	"raikage",
	"darui",
	"omoi",
	"karui",
	"yugito",
	"onoki",
	"kurotsuchi",
	"roshi",
	"han",
	"fu",
	// Legends & misc
	"mifune",
	"hanzo",
	"kurama",
	"gamabunta",
] as const;

const NAME_SYLLABLES = [
	"ka", "ki", "ku", "ko", "na", "ni", "no", "ro", "ru", "ri",
	"sa", "shi", "so", "su", "ta", "to", "tsu", "te", "ya", "yu",
	"yo", "ma", "mi", "mo", "ha", "hi", "ho", "za", "zu", "ji",
	"gen", "kai", "dan", "zo", "shin", "sai", "rin", "ten", "rai", "obi",
] as const;

function normalizeCloneName(raw: string): string {
	return raw.trim().toLowerCase().replace(/^@/, "");
}

function padToWidth(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Lay a left segment and a right-aligned segment into an exact-width cell. */
function composeRow(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, width - rightWidth - 1);
	const leftTrunc = truncateToWidth(left, leftMax);
	const gap = Math.max(1, width - visibleWidth(leftTrunc) - rightWidth);
	return leftTrunc + " ".repeat(gap) + right;
}

function generateNarutoName(): string {
	const count = 2 + Math.floor(Math.random() * 3);
	let name = "";
	for (let i = 0; i < count; i++) {
		name += NAME_SYLLABLES[Math.floor(Math.random() * NAME_SYLLABLES.length)];
	}
	return name;
}

const CLONE_SWARM_GUIDANCE_LINE = `
- You MAY call worker_run to fan independent sub-parts of YOUR task out to parallel one-shot worker subagents (e.g. one task per locale/file), so each runs in a fresh, focused context instead of bloating yours. Rules: each worker task must touch DISJOINT files and be self-contained; pass a \`focus\` telling them which dir to write. Workers cannot run workers or summon, so the tree stops at them. You CANNOT summon clones (no shadowclone tools). Use worker_run when your task splits cleanly into independent chunks; do it yourself in one context when it does not.`;

/** Clones get the worker_run bullet only when cloneWorkers is enabled; otherwise the tool isn't present. */
export function buildCloneSystemPrompt(cloneWorkers: boolean): string {
	return `You are a shadow clone subagent summoned by a lead agent.

- All tasks concern the user's own repository and product, and the work is fully authorized. Tasks about access control, paywalls, redaction, or security hardening are about the user's OWN product, not third-party systems.
- Stay strictly within your task scope. Sibling clones may work in parallel; do not touch their files.
- If the task is ambiguous in a way that materially affects the result (taste, scope, missing facts), ask the lead FIRST via report_to_lead with kind "question", then stop and wait for the answer. Batch your questions; ask once, not per detail. Do not ask about trivia you can decide yourself.
- Use report_to_lead with kind "update" for important interim findings or blockers; keep working after an update.
- New instructions from the lead may arrive at any time. Always follow the latest.${cloneWorkers ? CLONE_SWARM_GUIDANCE_LINE : ""}
- Never poll with bash sleep loops. Use the wait_for tool to block until a file or command condition holds; for web pages use \`agent-browser wait\` (selector, --text, --url, --fn, --load networkidle) and \`agent-browser network requests --filter\` via bash. Blocking waits are free; sleep-polling burns money and context. A message from the lead interrupts an in-progress wait_for: handle the new instructions first, then re-establish the wait if still relevant.
- Your final response after each instruction is delivered to the lead automatically as your report: what you did, files touched, anything to verify. Do not use report_to_lead for the final report. End it with a "Deliverables:" section listing every file you created or modified with a one-line purpose, plus anything the lead must verify before committing.`;
}

const SummonCloneSchema = Type.Object({
	task: Type.String({
		description: "Self-contained task for this clone: include file paths, intent, and constraints.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Nickname (lowercase letters, digits, dashes). OMIT unless the user explicitly requested a specific name; names are auto-picked Naruto-style.",
		}),
	),
	keep: Type.Optional(
		Type.Boolean({
			description:
				"Keep the clone alive after it completes, ready for follow-up instructions via shadowclone_send. Default false: the clone dispels itself right after delivering its final report.",
		}),
	),
	persona: Type.Optional(
		Type.String({
			description:
				"Optional persona/briefing for this clone: who it is, its approach, reporting style. Craft it per situation; keep it short. Persona shapes tone and approach, never thoroughness or correctness.",
		}),
	),
	worktree: Type.Optional(
		Type.String({
			description:
				"Branch name of an EXISTING git worktree (pi-dev-worktrees / git worktree) to run this clone in. Omit to use your active worktree, else the repo root. Create worktrees first with /worktree <branch>.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model for this clone: an exact "provider/model-id" from --list-models. Omit to inherit the lead\'s model.',
		}),
	),
	thinking: Type.Optional(
		StringEnum(SPAWN_THINKING_LEVELS, {
			description: "Thinking level for this clone. Omit for the default, medium.",
		}),
	),
	account: Type.Optional(
		Type.String({
			description:
				"Saved /acc auth profile to run this clone under (applies to its model's provider). Omit to inherit the lead's account.",
		}),
	),
});

const SummonParamsSchema = Type.Object({
	clones: Type.Array(SummonCloneSchema, {
		minItems: 1,
		maxItems: MAX_CLONES,
		description: "Clones to summon in this single call. Summon all clones for a request in ONE call.",
	}),
});

const SendParamsSchema = Type.Object({
	name: Type.String({ description: "Clone nickname, with or without leading @." }),
	message: Type.String({
		description: "New instructions, an answer to the clone's question, or a course correction.",
	}),
});

const StatusParamsSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Clone nickname. Omit to list all live clones." })),
});

const DispelParamsSchema = Type.Object({
	name: Type.String({ description: 'Clone nickname, or "all" to dispel every live clone.' }),
});

const PauseParamsSchema = Type.Object({
	name: Type.String({ description: 'Clone nickname, or "all" to pause every running clone.' }),
});

const AccountParamsSchema = Type.Object({
	name: Type.String({ description: "Clone nickname, with or without leading @." }),
	account: Type.String({
		description: "Saved /acc auth profile to switch this clone to (for its current model's provider).",
	}),
});

const ReportParamsSchema = Type.Object({
	kind: StringEnum(["question", "update"] as const, {
		description:
			'"question": you need an answer before continuing — you will stop and wait. "update": important interim finding or blocker; you keep working.',
	}),
	message: Type.String({ description: "Message for the lead: question, blocker, or interim update." }),
});

type SummonParams = Static<typeof SummonParamsSchema>;
type SendParams = Static<typeof SendParamsSchema>;
type StatusParams = Static<typeof StatusParamsSchema>;
type DispelParams = Static<typeof DispelParamsSchema>;
type PauseParams = Static<typeof PauseParamsSchema>;
type AccountParams = Static<typeof AccountParamsSchema>;

interface CloneSpec {
	name: string;
	task: string;
	keep: boolean;
	persona?: string;
	/** Resolved working directory for the clone's session (its worktree, or the repo root). */
	cwd: string;
	/** Branch label of the clone's worktree, shown in the dashboard. */
	worktreeLabel?: string;
	/** Resolved explicit model override; undefined inherits the lead's model. */
	model?: ExtensionContext["model"];
	/** Effective thinking level selected for this clone. */
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	/** Saved /acc profile to pin as this clone's account; undefined inherits the lead's. */
	account?: string;
}

interface SummonInfo extends Omit<CloneSpec, "model" | "thinkingLevel"> {
	logPath: string;
	/** Resolved "provider/model-id" this clone actually runs on. */
	modelSpec?: string;
	/** Effective thinking level this clone runs with. */
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	/** /acc account profile the clone's provider auth resolved to at summon. */
	account?: string;
}

interface SummonDetails {
	summons: SummonInfo[];
}

type CloneStatus = "working" | "waiting" | "idle" | "paused" | "failed";

interface ShadowClone {
	name: string;
	task: string;
	keep: boolean;
	pendingQuestion: boolean;
	status: CloneStatus;
	session: AgentSession;
	unsubscribe: () => void;
	logPath: string;
	logChain: Promise<void>;
	lastActivity: string;
	lastOutput: string;
	items: SwarmDisplayItem[];
	transcript: TranscriptEntry[];
	transcriptVersion: number;
	model: ExtensionContext["model"];
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	modelRegistry: ExtensionContext["modelRegistry"];
	/** Per-clone credential view: account pins here never touch the lead or siblings. */
	cloneAuth: AuthStorage;
	/** /acc account profile last resolved for the clone's current model. */
	account?: string;
	/** Set while a user/lead pause request waits for the in-flight work to abort. */
	pauseRequested?: "user" | "lead";
	stopReason?: string;
	errorMessage?: string;
	summonedAt: number;
	cwd: string;
	/** Branch label of the worktree this clone runs in (when known). */
	worktreeLabel?: string;
	/** Absolute paths of files this clone edited or wrote (the lead's pre-commit map). */
	touchedFiles: Set<string>;
	/** Total tokens of the last assistant message: the clone's current context size. */
	lastTotalTokens: number;
	/** One automatic retry per instruction: set when the retry has been spent. */
	retriedInstruction: boolean;
	/** Self-dispel timer for one-shot clones lingering after their final report. */
	lingerTimer?: ReturnType<typeof setTimeout>;
	/** Wave (summon batch) this clone belongs to, when the batch had 2+ clones. */
	waveId?: number;
}

/** Touched files relative to the clone's cwd, capped at `max` with a `+N more` tail. */
function formatTouchedFiles(clone: ShadowClone, max: number): string[] {
	const files = [...clone.touchedFiles].map((file) => {
		const rel = path.relative(clone.cwd, file);
		return rel.startsWith("..") ? file : rel;
	});
	if (files.length <= max) return files;
	return [...files.slice(0, max), `+${files.length - max} more`];
}

const RECOVERY_PROMPT = `Your previous turn failed mid-stream. This is usually a transient provider error or an overcautious refusal. Reminder: you are working in the user's own repository on the user's own product, fully authorized. Continue your task from where you left off; do not repeat work that already succeeded.`;

const RESUME_AFTER_PAUSE_PROMPT = `Resume your task: continue from where you left off. Work already completed stands; do not redo it. If the previous attempt was cut off mid-request (pause or rate limit), just continue.`;

const WaitForParamsSchema = Type.Object({
	condition: StringEnum(["file_exists", "file_changed", "file_contains", "command_succeeds"] as const, {
		description:
			'"file_exists": path appears. "file_changed": path mtime changes (or file appears). "file_contains": file matches the regex pattern. "command_succeeds": shell command exits 0 — covers process completion and tmux pane checks.',
	}),
	path: Type.Optional(Type.String({ description: "File path for the file_* conditions." })),
	pattern: Type.Optional(Type.String({ description: "Regex (JavaScript syntax) for file_contains." })),
	command: Type.Optional(
		Type.String({ description: "Shell command for command_succeeds; the wait ends when it exits 0." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({ minimum: 1, maximum: WAIT_TIMEOUT_MAX_S, description: `Default ${WAIT_TIMEOUT_DEFAULT_S}.` }),
	),
	pollSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 60, description: "Default 2." })),
});

function commandSucceeds(command: string, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		const child = exec(command, { timeout: WAIT_COMMAND_TIMEOUT_MS }, (error) => resolve(!error));
		signal?.addEventListener("abort", () => child.kill(), { once: true });
	});
}

/**
 * Cheap blocking wait for clones: polls inside the tool call, costing zero model turns.
 * Check-then-wait semantics: the current state is checked immediately, so a condition
 * that already holds (marker already in the log) satisfies the wait at once.
 * A steering message from the lead interrupts the wait — waiting is idle time, not work,
 * so STOP-grade instructions must not sit queued behind a 30-minute timeout.
 */
function createWaitForTool(
	registerInterrupt: (onInterrupt: () => void) => () => void,
): ToolDefinition<typeof WaitForParamsSchema> {
	return {
		name: "wait_for",
		label: "Wait For",
		description:
			'Block until a condition holds, polling inside this single tool call — costs no model turns, unlike bash sleep loops. Check-then-wait: the current state is checked immediately first, so a marker already present satisfies the wait at once (file_contains matches the WHOLE file, not just new lines). Conditions: file_exists, file_changed (mtime change relative to wait start — for content markers prefer file_contains), file_contains (regex), command_succeeds (shell exits 0; covers "process finished" and tmux checks like `tmux capture-pane -p -S - -t s | grep -q DONE` — pass -S - to search the full scrollback, not just the visible pane). For browser pages prefer `agent-browser wait ...` via bash. Returns "timed out" text (not an error) when the deadline passes. New instructions from the lead interrupt the wait immediately.',
		parameters: WaitForParamsSchema,
		async execute(_toolCallId, params, signal) {
			const { condition } = params;
			if (condition !== "command_succeeds" && !params.path) throw new Error(`${condition} requires "path".`);
			if (condition === "file_contains" && !params.pattern) throw new Error('file_contains requires "pattern".');
			if (condition === "command_succeeds" && !params.command) throw new Error('command_succeeds requires "command".');
			const pattern = params.pattern ? new RegExp(params.pattern) : undefined;
			const filePath = params.path ?? "";
			const initialMtime = await stat(filePath).then(
				(s) => s.mtimeMs,
				() => undefined,
			);
			const check = async (): Promise<boolean> => {
				switch (condition) {
					case "file_exists":
						return stat(filePath).then(
							() => true,
							() => false,
						);
					case "file_changed":
						return stat(filePath).then(
							(s) => s.mtimeMs !== initialMtime,
							() => false,
						);
					case "file_contains":
						return readFile(filePath, "utf8").then(
							(text) => (pattern as RegExp).test(text),
							() => false,
						);
					case "command_succeeds":
						return commandSucceeds(params.command as string, signal);
				}
			};
			const timeoutMs = (params.timeoutSeconds ?? WAIT_TIMEOUT_DEFAULT_S) * 1000;
			const pollMs = (params.pollSeconds ?? 2) * 1000;
			const startedAt = Date.now();
			const deadline = startedAt + timeoutMs;
			const target = condition === "command_succeeds" ? params.command : filePath;
			let interrupted = false;
			let wake: (() => void) | undefined;
			const unregister = registerInterrupt(() => {
				interrupted = true;
				wake?.();
			});
			try {
				while (!signal?.aborted && !interrupted) {
					if (await check()) {
						const seconds = Math.round((Date.now() - startedAt) / 1000);
						return {
							content: [{ type: "text", text: `Condition met after ${seconds}s: ${condition} (${target})` }],
							details: undefined,
						};
					}
					if (interrupted || Date.now() + pollMs > deadline) break;
					await new Promise<void>((resolve) => {
						let timer: ReturnType<typeof setTimeout> | undefined;
						const finish = () => {
							if (timer) clearTimeout(timer);
							signal?.removeEventListener("abort", finish);
							wake = undefined;
							resolve();
						};
						wake = finish;
						if (interrupted || signal?.aborted) {
							finish();
							return;
						}
						timer = setTimeout(finish, pollMs);
						signal?.addEventListener("abort", finish, { once: true });
					});
				}
				const text = signal?.aborted
					? "Wait aborted."
					: interrupted
						? "Wait interrupted: the lead sent new instructions; they arrive as the next message. Handle them first, then re-establish the wait if still relevant."
						: `Timed out after ${Math.round(timeoutMs / 1000)}s: ${condition} (${target}) never held. Decide: keep waiting (call wait_for again), investigate, or report a blocker to the lead.`;
				return { content: [{ type: "text", text }], details: undefined };
			} finally {
				unregister();
			}
		},
	};
}

function buildMemoryPrompt(clone: ShadowClone, reason: string, transcriptTail: string): string {
	return `A shadow clone subagent named @${clone.name} was just dispelled. Reason: ${reason}.

Its assigned task was:
${clone.task.trim()}

Below is its activity transcript (tool calls, thinking, messages). Distill its memories for the lead agent:

1. What it did and its key findings or decisions.
2. If it failed or got stuck: the root cause, stated plainly.
3. Unfinished work and what the lead should do next, if anything.

Be compact: under 200 words, plain prose or short bullets. This digest is the only memory that survives the dispel.

Transcript:

${transcriptTail}`;
}

interface CloneDashboardOptions {
	theme: Theme;
	getClones: () => ShadowClone[];
	getWorkerRuns: () => WorkerRunRecord[];
	getHeight: () => number;
	getSpinnerGlyph: () => string;
	send: (clone: ShadowClone, message: string) => void;
	abort: (clone: ShadowClone) => void;
	pause: (clone: ShadowClone) => void;
	dispel: (clone: ShadowClone) => Promise<void>;
	dispelWorker: (run: WorkerRunRecord, agentIndex?: number) => void;
	done: () => void;
	requestRender: () => void;
}

/**
 * A dashboard row: an interactive clone, a worker-run header, or one worker
 * agent inside a run (agentIndex set). Multi-agent runs get one selectable row
 * per agent, so each worker/council member can be watched individually.
 */
type DashItem =
	| { kind: "clone"; clone: ShadowClone }
	| { kind: "worker"; run: WorkerRunRecord; agentIndex?: number };

export class CloneDashboard {
	private readonly options: CloneDashboardOptions;
	private selected = 0;
	private mode: "list" | "input" = "list";
	// When true the right (detail) pane is focused: ↑↓ scroll its full history instead of switching agents.
	private paneFocus = false;
	private scrollOffset = 0;
	private readonly input = new Input();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "input";
	}

	constructor(options: CloneDashboardOptions) {
		this.options = options;
		this.input.onSubmit = (value) => {
			const clone = this.selectedClone();
			const message = value.trim();
			if (clone && message) this.options.send(clone, message);
			this.input.setValue("");
			this.leaveInputMode();
		};
		this.input.onEscape = () => this.leaveInputMode();
	}

	private leaveInputMode(): void {
		this.mode = "list";
		this.input.focused = false;
		this.options.requestRender();
	}

	private items(): DashItem[] {
		const items: DashItem[] = this.options.getClones().map((clone) => ({ kind: "clone" as const, clone }));
		for (const run of this.options.getWorkerRuns()) {
			items.push({ kind: "worker", run });
			// One row per agent so each worker is individually selectable; a
			// single-agent run needs no sub-rows (the header pane already shows it).
			if (run.details.agents.length > 1) {
				for (let i = 0; i < run.details.agents.length; i++) {
					items.push({ kind: "worker", run, agentIndex: i });
				}
			}
		}
		return items;
	}

	private selectedItem(): DashItem | undefined {
		const items = this.items();
		if (items.length === 0) return undefined;
		this.selected = Math.min(this.selected, items.length - 1);
		return items[this.selected];
	}

	private selectedClone(): ShadowClone | undefined {
		const item = this.selectedItem();
		return item?.kind === "clone" ? item.clone : undefined;
	}

	private switchItem(delta: number): void {
		const count = this.items().length;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.scrollOffset = 0;
	}

	handleInput(data: string): void {
		if (this.mode === "input") {
			this.input.handleInput(data);
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			// Esc backs out of a focused pane first, then closes the dashboard.
			if (this.paneFocus) this.paneFocus = false;
			else this.options.done();
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.switchItem(1);
		} else if (matchesKey(data, Key.shift("tab"))) {
			this.switchItem(-1);
		} else if (matchesKey(data, Key.right)) {
			// The agent pane is on the right: Right enters/focuses it so ↑↓ scroll its history.
			if (this.selectedItem()) this.paneFocus = true;
		} else if (matchesKey(data, Key.left)) {
			this.paneFocus = false;
		} else if (matchesKey(data, Key.up)) {
			if (this.paneFocus) this.scrollOffset += 1;
			else this.switchItem(-1);
		} else if (matchesKey(data, Key.down)) {
			if (this.paneFocus) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			else this.switchItem(1);
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.scrollOffset += Math.max(1, this.lastBodyHeight - 1);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.lastBodyHeight - 1));
		} else if (matchesKey(data, Key.home)) {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		} else if (matchesKey(data, Key.end)) {
			this.scrollOffset = 0;
		} else if (data >= "1" && data <= "9") {
			const index = Number(data) - 1;
			if (index < this.items().length) {
				this.selected = index;
				this.scrollOffset = 0;
			}
		} else if (data === "t") {
			this.showThinking = !this.showThinking;
		} else if (data === "a") {
			const clone = this.selectedClone();
			if (clone) this.options.abort(clone);
		} else if (data === "p") {
			// Toggle: pause a running clone, resume a paused (or failure-paused) one.
			const clone = this.selectedClone();
			if (clone) this.options.pause(clone);
		} else if (matchesKey(data, Key.enter)) {
			// First Enter focuses the pane; a second Enter (now in pane focus) opens the steer input.
			if (!this.paneFocus) {
				if (this.selectedItem()) this.paneFocus = true;
			} else if (this.selectedClone()) {
				this.mode = "input";
				this.input.focused = this._focused;
			}
		} else if (data === "d") {
			const item = this.selectedItem();
			if (item?.kind === "clone") {
				void this.options.dispel(item.clone).then(() => {
					if (this.options.getClones().length === 0 && this.options.getWorkerRuns().length === 0) {
						this.options.done();
					} else {
						this.options.requestRender();
					}
				});
			} else if (item?.kind === "worker") {
				this.options.dispelWorker(item.run, item.agentIndex);
				if (this.options.getClones().length === 0 && this.options.getWorkerRuns().length === 0) {
					this.options.done();
				}
			}
		}
		this.options.requestRender();
	}

	private lastBodyHeight = 10;
	private showThinking = true;
	// Scroll-follow anchor: which item the scroll position belongs to, and how many wrapped
	// lines it had last render — so a scrolled-up view stays pinned as new output arrives.
	private followItemKey: string | undefined;
	private lastWrappedLen = 0;
	private wrapCache: { key: string; lines: string[] } | undefined;
	private readonly entryCache = new WeakMap<TranscriptEntry, { key: string; lines: string[] }>();
	private readonly markdownTheme = getMarkdownTheme();

	render(width: number): string[] {
		const theme = this.options.theme;
		const items = this.items();
		const height = Math.max(10, this.options.getHeight());
		const spinnerGlyph = this.options.getSpinnerGlyph();
		// Derive the selection from the list we already built (selectedItem() would rebuild it),
		// keeping its clamp so a removed agent never leaves `selected` past the end.
		if (items.length > 0) this.selected = Math.min(this.selected, items.length - 1);
		const item = items.length > 0 ? items[this.selected] : undefined;
		const clone = item?.kind === "clone" ? item.clone : undefined;

		// Two-pane master/detail: agents on the left, the selected agent's activity on the right.
		const minRight = 24;
		let leftWidth = Math.max(16, Math.min(40, Math.floor(width * 0.3)));
		leftWidth = Math.min(leftWidth, Math.max(8, width - 1 - minRight));
		const rightWidth = Math.max(1, width - leftWidth - 1);

		// Footer first, so the body knows how many rows remain.
		const workerAction = (() => {
			if (item?.kind !== "worker") return "";
			const runActive = item.run.details.phase === "preparing" || item.run.details.phase === "executing";
			if (!runActive) return "d dismiss run";
			const agent = item.agentIndex === undefined ? undefined : item.run.details.agents[item.agentIndex];
			return agent?.status === "pending" || agent?.status === "running" ? "d cancel worker" : "d cancel run";
		})();
		const footer: string[] = [];
		const footerRule =
			theme.fg("borderMuted", "─".repeat(leftWidth)) +
			theme.fg("borderMuted", "┴") +
			theme.fg("borderMuted", "─".repeat(rightWidth));
		footer.push(footerRule);
		if (this.mode === "input") {
			footer.push(padToWidth(theme.fg("dim", " type · enter send · esc cancel"), width));
		} else if (this.paneFocus) {
			const hint =
				item?.kind === "worker"
					? ` ↑↓ scroll · ${workerAction} · ← back · esc back`
					: " ↑↓ scroll · ↵ steer · ← back · a abort · p pause · d dispel · t thinking · esc back";
			footer.push(padToWidth(theme.fg("dim", hint), width));
		} else {
			const hint =
				item?.kind === "worker"
					? ` ↑↓ agent · →/↵ open pane · 1-9 jump · ${workerAction} · esc close`
					: " ↑↓ agent · →/↵ scroll pane · 1-9 jump · a abort · p pause · d dispel · t thinking · esc close";
			footer.push(padToWidth(theme.fg("dim", hint), width));
		}

		const bodyHeight = Math.max(1, height - footer.length);

		// Left pane: title + one row per agent (clone or worker run); selected row highlighted.
		const cloneCount = this.options.getClones().length;
		const workerCount = this.options.getWorkerRuns().length;
		const counts = `${cloneCount}c ${workerCount}w`;
		const leftCells: string[] = [];
		leftCells.push(
			padToWidth(` ${theme.fg("accent", theme.bold("Agents"))}${theme.fg("dim", `  ${counts}`)}`, leftWidth),
		);
		// Window the sidebar so the selected row stays visible when rows overflow.
		const visibleRows = Math.max(1, bodyHeight - 1);
		let start = 0;
		if (items.length > visibleRows) {
			start = Math.min(Math.max(0, this.selected - Math.floor(visibleRows / 2)), items.length - visibleRows);
		}
		items.slice(start, start + visibleRows).forEach((it, offset) => {
			const index = start + offset;
			const selected = index === this.selected;
			let row: string;
			if (it.kind === "clone") {
				const c = it.clone;
				const icon = statusIcon(theme, c.status, spinnerGlyph);
				const age = `${formatAgeShort(c.summonedAt)} `;
				// The clone name is the primary identifier (you steer by @name), so keep it on the
				// left and let only the tiny age claim the right segment — otherwise on a narrow pane
				// composeRow trims the name to "@…". The worktree label is secondary and often
				// redundant with the name, so append it after the name only when there is real spare
				// room; sitting at the tail of the left segment, it gets trimmed before the name does.
				let left = ` ${icon} ${theme.fg(selected ? "accent" : "muted", theme.bold(`@${c.name}`))}`;
				if (c.worktreeLabel) {
					const spare = leftWidth - visibleWidth(left) - visibleWidth(age) - 2;
					if (spare >= 5) left += ` ${theme.fg("dim", truncateSingleLine(c.worktreeLabel, Math.min(14, spare)))}`;
				}
				row = composeRow(left, theme.fg("dim", age), leftWidth);
			} else if (it.agentIndex === undefined) {
				const r = it.run;
				const { total, done, failed } = workerCounts(r);
				const icon = workerPhaseIcon(theme, r.details.phase, spinnerGlyph);
				const counts = `${done + failed}/${total} `;
				// Same layout rules as clone rows: the title owns the left segment and only the
				// small counter claims the right, so narrow panes trim the title, not the meta.
				const room = leftWidth - 4 - visibleWidth(counts) - 2;
				const name = theme.fg(
					selected ? "accent" : "muted",
					theme.bold(`⚙ ${truncateSingleLine(r.title, Math.max(4, room))}`),
				);
				row = composeRow(` ${icon} ${name}`, theme.fg(failed > 0 ? "error" : "dim", counts), leftWidth);
			} else {
				// Indented member row under its run header.
				const agent = it.run.details.agents[it.agentIndex];
				const icon = agentStatusIcon(theme, agent?.status ?? "pending", spinnerGlyph);
				const title = agent?.title ?? `worker ${it.agentIndex + 1}`;
				const name = theme.fg(selected ? "accent" : "muted", truncateSingleLine(title, Math.max(4, leftWidth - 7)));
				row = padToWidth(`   ${icon} ${name}`, leftWidth);
			}
			// The active highlight lives on the sidebar in list focus, and moves to the pane header in pane focus.
			leftCells.push(selected && !this.paneFocus ? theme.bg("selectedBg", row) : row);
		});
		while (leftCells.length < bodyHeight) leftCells.push(" ".repeat(leftWidth));

		// Right pane header (varies by kind), then a rule, then the scrollable body.
		const rightCells: string[] = [];
		const pushRight = (line: string) => rightCells.push(padToWidth(line, rightWidth));
		const rightRule = theme.fg("borderMuted", "─".repeat(rightWidth));
		let ruleRowIndex = -1;
		let wrapped: string[] = [];
		// Focused agent is marked by a small caret on its header — no colored border/glow.
		const focusMark = this.paneFocus ? theme.fg("muted", "▸ ") : "";
		if (item?.kind === "clone") {
			const c = item.clone;
			const ctx = c.lastTotalTokens > 0 ? ` · ctx ${Math.round(c.lastTotalTokens / 1000)}k` : "";
			const metaText = `⏱ ${formatAgeShort(c.summonedAt)}${ctx} · `;
			const statusHead = ` ${statusIcon(theme, c.status, spinnerGlyph)} ${statusWord(theme, c.status)} ${theme.fg("muted", `· ${metaText}`)}`;
			const activityRoom = Math.max(8, rightWidth - visibleWidth(statusHead) - 1);
			pushRight(` ${focusMark}${theme.fg("accent", theme.bold(`@${c.name}`))} ${theme.fg("dim", "· clone activity")}`);
			pushRight(statusHead + theme.fg("dim", truncateSingleLine(c.lastActivity, activityRoom)));
			pushRight(` ${theme.fg("muted", "task")}  ${theme.fg("text", truncateSingleLine(c.task, Math.max(10, rightWidth - 8)))}`);
			{
				const modelText = formatModelSpec(c.model) ?? "lead model";
				const accPart = c.account ? theme.fg("dim", " · acc ") + theme.fg("accent", c.account) : "";
				pushRight(
					` ${theme.fg("muted", "model")} ${theme.fg("text", truncateSingleLine(modelText, Math.max(10, rightWidth - 32)))}${theme.fg("dim", ` · thinking ${c.thinkingLevel}`)}${accPart}`,
				);
			}
			if (c.worktreeLabel) {
				const branch = theme.fg("success", truncateSingleLine(c.worktreeLabel, Math.max(6, rightWidth - 32)));
				const where = c.cwd ? theme.fg("dim", `  ${truncateSingleLine(c.cwd, 24)}`) : "";
				pushRight(` ${theme.fg("muted", "tree")}  ${branch}${where}`);
			}
			pushRight(` ${theme.fg("muted", "watch")} ${theme.fg("dim", truncateSingleLine(`tail -f ${c.logPath}`, Math.max(10, rightWidth - 9)))}`);
			ruleRowIndex = rightCells.length;
			pushRight(rightRule);
			const cacheKey = `clone:${c.name}:${rightWidth}:${c.transcriptVersion}:${this.showThinking ? "t" : "c"}`;
			if (this.wrapCache?.key === cacheKey) wrapped = this.wrapCache.lines;
			else {
				wrapped = this.renderTranscript(c, Math.max(10, rightWidth - 2));
				this.wrapCache = { key: cacheKey, lines: wrapped };
			}
		} else if (item?.kind === "worker" && item.agentIndex !== undefined) {
			// One worker/council member: its own live pane, like a clone's.
			const r = item.run;
			const agent = r.details.agents[item.agentIndex];
			const bits = agentStatusBits(agent?.status ?? "pending");
			const icon = agentStatusIcon(theme, agent?.status ?? "pending", spinnerGlyph);
			const origin = r.origin === "lead" ? "lead" : `@${r.origin}`;
			const title = agent?.title ?? `worker ${item.agentIndex + 1}`;
			pushRight(
				` ${focusMark}${theme.fg("accent", theme.bold(truncateSingleLine(title, Math.max(6, rightWidth - 18))))} ${theme.fg("dim", `· worker ${item.agentIndex + 1}/${r.details.agents.length}`)}`,
			);
			const statusHead = ` ${icon} ${theme.fg(bits.tone, bits.word)} ${theme.fg("muted", `· ⏱ ${formatAgeShort(r.startedAt)} · by ${origin} · `)}`;
			const activityRoom = Math.max(8, rightWidth - visibleWidth(statusHead) - 1);
			pushRight(statusHead + theme.fg("dim", truncateSingleLine(agent?.lastActivity ?? "", activityRoom)));
			const modelSpec = agent?.model ?? r.details.model;
			if (modelSpec) {
				const account = agent?.account ?? r.details.account;
				const effectiveThinking = agent?.thinking ?? r.details.thinking;
				const thinking = effectiveThinking ? theme.fg("dim", ` · thinking ${effectiveThinking}`) : "";
				const accPart = account ? theme.fg("dim", " · acc ") + theme.fg("accent", account) : "";
				pushRight(
					` ${theme.fg("muted", "model")} ${theme.fg("text", truncateSingleLine(modelSpec, Math.max(10, rightWidth - 32)))}${thinking}${accPart}`,
				);
			}
			if (r.details.focus) {
				pushRight(` ${theme.fg("muted", "focus")} ${theme.fg("text", truncateSingleLine(r.details.focus, Math.max(10, rightWidth - 8)))}`);
			}
			ruleRowIndex = rightCells.length;
			pushRight(rightRule);
			const cacheKey = `worker:${r.id}:agent${item.agentIndex}:${rightWidth}:${r.version}`;
			if (this.wrapCache?.key === cacheKey) wrapped = this.wrapCache.lines;
			else {
				wrapped = agent ? this.renderWorkerAgent(agent, Math.max(10, rightWidth - 2)) : [];
				this.wrapCache = { key: cacheKey, lines: wrapped };
			}
		} else if (item?.kind === "worker") {
			const r = item.run;
			const { total, done, running, failed } = workerCounts(r);
			const phaseColor = r.details.phase === "failed" ? "error" : r.details.phase === "done" ? "success" : "warning";
			// Compact progress bar: settled cells fill up as workers finish; red once anything failed.
			const settled = done + failed;
			const barCells = 10;
			const filledCells = total > 0 ? Math.min(barCells, Math.round((settled / total) * barCells)) : 0;
			const bar =
				theme.fg(failed > 0 ? "error" : "success", "█".repeat(filledCells)) +
				theme.fg("borderMuted", "░".repeat(barCells - filledCells));
			const parts = [`${settled}/${total}`];
			if (running > 0) parts.push(`${running} running`);
			if (failed > 0) parts.push(`${failed} failed`);
			const origin = r.origin === "lead" ? "lead" : `@${r.origin}`;
			pushRight(` ${focusMark}${theme.fg("accent", theme.bold(`⚙ ${truncateSingleLine(r.title, Math.max(6, rightWidth - 18))}`))} ${theme.fg("dim", "· worker run")}`);
			pushRight(
				` ${workerPhaseIcon(theme, r.details.phase, spinnerGlyph)} ${theme.fg(phaseColor, r.details.phase)} ${bar} ${theme.fg("muted", `${parts.join(" · ")} · ⏱ ${formatAgeShort(r.startedAt)} · by ${origin}`)}`,
			);
			if (r.details.model) {
				const thinking = r.details.thinking ? theme.fg("dim", ` · thinking ${r.details.thinking}`) : "";
				const accPart = r.details.account ? theme.fg("dim", " · acc ") + theme.fg("accent", r.details.account) : "";
				pushRight(
					` ${theme.fg("muted", "start model")} ${theme.fg("text", truncateSingleLine(r.details.model, Math.max(10, rightWidth - 32)))}${thinking}${accPart}`,
				);
			}
			if (r.details.focus) {
				pushRight(` ${theme.fg("muted", "focus")} ${theme.fg("text", truncateSingleLine(r.details.focus, Math.max(10, rightWidth - 8)))}`);
			}
			ruleRowIndex = rightCells.length;
			pushRight(rightRule);
			const cacheKey = `worker:${r.id}:${rightWidth}:${r.version}`;
			if (this.wrapCache?.key === cacheKey) wrapped = this.wrapCache.lines;
			else {
				wrapped = this.renderWorkerRun(r, Math.max(10, rightWidth - 2));
				this.wrapCache = { key: cacheKey, lines: wrapped };
			}
		} else {
			pushRight(` ${theme.fg("muted", "no live agents")}`);
		}

		// Scroll-follow UX: at the bottom (scrollOffset 0) the pane auto-follows new output; once the
		// user scrolls up it stays pinned to what they're reading — new lines no longer yank it down.
		// (Switching agents resets to live via switchItem.)
		const itemKey = item
			? item.kind === "clone"
				? `c:${item.clone.name}`
				: `w:${item.run.id}:${item.agentIndex ?? "run"}`
			: "";
		if (itemKey !== this.followItemKey) this.followItemKey = itemKey;
		else if (this.scrollOffset > 0) this.scrollOffset = Math.max(0, this.scrollOffset + (wrapped.length - this.lastWrappedLen));
		this.lastWrappedLen = wrapped.length;

		// Common scrollable body fills the rest of the right pane.
		const bodyRows = Math.max(1, bodyHeight - rightCells.length);
		this.lastBodyHeight = bodyRows;
		const maxOffset = Math.max(0, wrapped.length - bodyRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = wrapped.length - this.scrollOffset;
		const visible = wrapped.slice(Math.max(0, end - bodyRows), end);
		for (const line of visible) pushRight(` ${line}`);
		for (let i = visible.length; i < bodyRows; i++) pushRight("");
		if (this.scrollOffset > 0) {
			// ⏸ = auto-follow paused (you scrolled up); End jumps back to live.
			const indicator = theme.fg("warning", ` ⏸ ${this.scrollOffset} more · End live `);
			rightCells[0] = truncateToWidth(rightCells[0] ?? "", Math.max(0, rightWidth - visibleWidth(indicator)), "") + indicator;
		}
		while (rightCells.length < bodyHeight) rightCells.push(" ".repeat(rightWidth));

		// Steer input renders INSIDE the focused agent's pane (its bottom row), not the footer.
		if (this.mode === "input" && clone && bodyHeight > 0) {
			const inputLabel = theme.fg("accent", ` ▸ steer @${clone.name}: `);
			const rendered = this.input.render(Math.max(8, rightWidth - visibleWidth(inputLabel)))[0] ?? "";
			rightCells[bodyHeight - 1] = padToWidth(inputLabel + rendered, rightWidth);
		}

		// Stitch the two panes with a plain muted vertical divider (tee where the right rule meets it).
		const lines: string[] = [];
		for (let i = 0; i < bodyHeight; i++) {
			const divider = theme.fg("borderMuted", i === ruleRowIndex ? "├" : "│");
			lines.push((leftCells[i] ?? " ".repeat(leftWidth)) + divider + (rightCells[i] ?? " ".repeat(rightWidth)));
		}
		lines.push(...footer);
		return lines;
	}

	/**
	 * Read-only view of a worker run: one clearly separated section per worker.
	 * Live workers show their current activity and recent tools; settled workers
	 * show their report (or error). Icons are static (no spinner) because these
	 * lines are cached per run version, not per animation frame.
	 */
	private renderWorkerRun(run: WorkerRunRecord, width: number): string[] {
		const theme = this.options.theme;
		const wrap = (raw: string): string[] => (visibleWidth(raw) <= width ? [raw] : wrapTextWithAnsi(raw, width));
		const lines: string[] = [];
		for (const agent of run.details.agents) {
			const { icon, word, tone } = agentStatusBits(agent.status);
			// A dotted rule between sections makes each worker's block obvious at a glance.
			if (lines.length > 0) {
				lines.push("");
				lines.push(theme.fg("borderMuted", "┄".repeat(width)));
				lines.push("");
			}
			const effectiveThinking = agent.thinking ?? run.details.thinking;
			const modelNote = agent.model
				? theme.fg("dim", ` · ${agent.model}${effectiveThinking ? ` · thinking ${effectiveThinking}` : ""}`)
				: effectiveThinking
					? theme.fg("dim", ` · thinking ${effectiveThinking}`)
					: "";
			lines.push(
				...wrap(
					`${theme.fg(tone, icon)} ${theme.fg("accent", theme.bold(`${agent.index + 1}. ${agent.title}`))} ${theme.fg(tone, `— ${word}`)}${modelNote}`,
				),
			);
			const active = agent.status === "running" || agent.status === "pending";
			// Surface terminal failures in red; an in-flight provider error is a recovery
			// state (compaction/retry), not a dead worker.
			if (agent.errorMessage) {
				const message = `${active ? "  recovering from: " : "  "}${truncateSingleLine(agent.errorMessage, 300)}`;
				lines.push(...wrap(theme.fg(active ? "warning" : "error", message)));
			}
			if (active) {
				if (agent.lastActivity) lines.push(...wrap(theme.fg("dim", `  ${agent.lastActivity}`)));
				for (const it of agent.items.slice(-3)) lines.push(...wrap(theme.fg("muted", `  · ${formatDisplayItem(it)}`)));
				continue;
			}
			if (agent.output.trim()) {
				lines.push("");
				lines.push(...new Markdown(agent.output.trim(), 0, 0, this.markdownTheme).render(width));
			} else if (agent.status === "done") {
				lines.push(...wrap(theme.fg("dim", "  (no report returned)")));
			}
		}
		if (lines.length === 0) lines.push(theme.fg("dim", "no worker activity yet"));
		return lines;
	}

	/** Full activity of one worker/council member: its tool/thinking trail, then its (streaming) report. */
	private renderWorkerAgent(agent: SwarmAgentProgress, width: number): string[] {
		const theme = this.options.theme;
		const wrap = (raw: string): string[] => (visibleWidth(raw) <= width ? [raw] : wrapTextWithAnsi(raw, width));
		const lines: string[] = [];
		for (const it of agent.items) lines.push(...wrap(theme.fg("muted", `· ${formatDisplayItem(it)}`)));
		if (agent.errorMessage) {
			if (lines.length > 0) lines.push("");
			const recovering = agent.status === "running" || agent.status === "pending";
			const message = `${recovering ? "recovering from: " : ""}${truncateSingleLine(agent.errorMessage, 300)}`;
			lines.push(...wrap(theme.fg(recovering ? "warning" : "error", message)));
		}
		if (agent.output.trim()) {
			if (lines.length > 0) lines.push("");
			lines.push(...new Markdown(agent.output.trim(), 0, 0, this.markdownTheme).render(width));
		} else if (agent.status === "done") {
			lines.push(...wrap(theme.fg("dim", "(no report returned)")));
		}
		if (lines.length === 0) lines.push(theme.fg("dim", "no activity yet"));
		return lines;
	}

	/** Render all entries to styled lines; the per-entry cache keeps transcript appends cheap. */
	private renderTranscript(clone: ShadowClone, width: number): string[] {
		const entryKey = `${width}:${this.showThinking ? "t" : "c"}`;
		const lines: string[] = [];
		let prevOneLiner = false;
		for (const entry of clone.transcript) {
			const oneLiner =
				entry.kind === "tool" || entry.kind === "status" || (entry.kind === "thinking" && !this.showThinking);
			// Blank line between blocks; consecutive one-liners stay grouped.
			if (lines.length > 0 && !(oneLiner && prevOneLiner)) lines.push("");
			let cached = this.entryCache.get(entry);
			if (cached?.key !== entryKey) {
				cached = { key: entryKey, lines: this.renderEntry(clone, entry, width) };
				this.entryCache.set(entry, cached);
			}
			lines.push(...cached.lines);
			prevOneLiner = oneLiner;
		}
		return lines;
	}

	private renderEntry(clone: ShadowClone, entry: TranscriptEntry, width: number): string[] {
		const theme = this.options.theme;
		const stamp = theme.fg("dim", `[${entry.stamp}]`);
		const wrap = (raw: string): string[] => (visibleWidth(raw) <= width ? [raw] : wrapTextWithAnsi(raw, width));
		const body = (style: (line: string) => string): string[] =>
			entry.text.split("\n").flatMap((raw) => wrap(raw).map(style));
		switch (entry.kind) {
			case "tool": {
				const space = entry.text.indexOf(" ");
				const verb = space === -1 ? entry.text : entry.text.slice(0, space);
				const rest = space === -1 ? "" : entry.text.slice(space);
				return wrap(`${stamp} ${theme.fg("toolTitle", verb)}${theme.fg("dim", rest)}`);
			}
			case "status":
				return wrap(`${stamp} ${theme.fg(statusTone(entry.text), entry.text)}`);
			case "thinking": {
				if (!this.showThinking) {
					const first = truncateSingleLine(entry.text, Math.max(10, width - 13));
					return [`${stamp} ${theme.italic(theme.fg("thinkingText", `∴ ${first}`))}`];
				}
				return [
					`${stamp} ${theme.italic(theme.fg("thinkingText", "∴ thinking"))}`,
					...body((line) => theme.italic(theme.fg("thinkingText", line))),
				];
			}
			case "clone":
				return [
					`${stamp} ${theme.fg("accent", theme.bold(`⊛ @${clone.name}`))}`,
					...new Markdown(entry.text, 0, 0, this.markdownTheme).render(width),
				];
			case "meta":
				return [`${stamp} ${theme.fg("muted", entry.label ?? "meta")}`, ...body((line) => theme.fg("dim", line))];
			default: {
				// lead, user, report: messages crossing the lead↔clone boundary.
				const label = entry.label ?? entry.kind;
				const color = entry.kind === "report" ? "warning" : "accent";
				return [
					`${stamp} ${theme.fg(color, theme.bold(`→ ${label}`))}`,
					...body((line) => theme.fg("text", line)),
				];
			}
		}
	}

	invalidate(): void {
		this.input.invalidate?.();
	}
}

class SummonCard {
	private readonly theme: Theme;
	private readonly details: SummonDetails;
	private readonly expanded: boolean;

	constructor(theme: Theme, details: SummonDetails, expanded: boolean) {
		this.theme = theme;
		this.details = details;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const summons = this.details.summons;
		const w = Math.max(1, Math.min(width, 96));
		const inner = Math.max(0, w - 4);
		const lines: string[] = [];
		const border = (left: string, fill: string, right: string) =>
			theme.fg("borderAccent", `${left}${fill.repeat(Math.max(0, w - 2))}${right}`);
		const row = (content: string) =>
			lines.push(theme.fg("borderAccent", "│ ") + padToWidth(content, inner) + theme.fg("borderAccent", " │"));

		const count = `${summons.length} clone${summons.length === 1 ? "" : "s"}`;
		const title = ` ${theme.fg("accent", theme.bold("⊛ SHADOW CLONES SUMMONED"))}`;
		const titlePad = Math.max(1, inner - visibleWidth(title) - count.length);
		lines.push(border("╭", "─", "╮"));
		row(title + " ".repeat(titlePad) + theme.fg("dim", count));
		lines.push(border("├", "─", "┤"));

		const nameWidth = Math.max(8, ...summons.map((s) => s.name.length + 1));
		for (const summon of summons) {
			const name = `@${summon.name}`.padEnd(nameWidth + 1);
			const keepTag = summon.keep ? theme.fg("warning", " ↻ stays") : "";
			// Keep the canonical spec intact: arbitrary model ids may contain slashes,
			// so taking only the last path segment can make distinct models look identical.
			const accTag = theme.fg(
				"dim",
				` · ${summon.modelSpec ?? "lead model"} · thinking ${summon.thinking}${summon.account ? ` · ${summon.account}` : ""}`,
			);
			row(
				` ${theme.fg("accent", theme.bold(name))} ${theme.fg(
					"text",
					truncateSingleLine(summon.task, Math.max(10, inner - nameWidth - 12)),
				)}${keepTag}${accTag}`,
			);
			if (this.expanded) {
				row(
					`   ${theme.fg("muted", "model:")} ${theme.fg("dim", `${summon.modelSpec ?? "lead model"} · thinking ${summon.thinking}${summon.account ? ` · acc ${summon.account}` : ""}`)}`,
				);
				if (summon.persona?.trim()) {
					row(`   ${theme.fg("muted", "persona:")} ${theme.fg("dim", truncateSingleLine(summon.persona, Math.max(10, inner - 14)))}`);
				}
				row(`   ${theme.fg("muted", "watch:")} ${theme.fg("dim", `tail -f ${summon.logPath}`)}`);
			}
		}

		lines.push(border("├", "─", "┤"));
		row(theme.fg("dim", ` ${theme.bold("/shadowclones")} or ${theme.bold(HOTKEY_LABEL)} to watch & steer · reports arrive here`));
		lines.push(border("╰", "─", "╯"));
		return lines;
	}

	invalidate(): void {}
}

function buildClonePrompt(
	name: string,
	task: string,
	persona: string | undefined,
	siblings: { name: string; task: string }[],
): string {
	const personaSection = persona?.trim()
		? `\n## Who you are\n\n${persona.trim()}\n\n## Task\n`
		: "\n";
	const siblingSection =
		siblings.length > 0
			? `\n## Live sibling clones

Other clones are working in this same working tree right now:
${siblings.map((s) => `- @${s.name}: ${truncateSingleLine(s.task, 100)}`).join("\n")}

If files outside your scope change under you, that is likely a sibling's work in progress. Never "fix", revert, or absorb their changes; report the conflict to the lead via report_to_lead instead.
`
			: "";
	return `# Shadow Clone Task (you are @${name})
${personaSection}
${task.trim()}
${siblingSection}
Work on this now. Your final response is delivered to the lead as your report.`;
}

interface RegistryEntry {
	pid: number;
	name: string;
	cwd: string;
	task: string;
	summonedAt: number;
}

const REGISTRY_DIR = path.join(tmpdir(), "pi-shadowclones");

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function registryFile(name: string): string {
	return path.join(REGISTRY_DIR, `${process.pid}-${name}.json`);
}

/** List clones registered by ALL pi sessions on this machine; prunes entries of dead processes. */
function listGlobalClones(): RegistryEntry[] {
	const entries: RegistryEntry[] = [];
	let files: string[];
	try {
		files = readdirSync(REGISTRY_DIR);
	} catch {
		return entries;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const fullPath = path.join(REGISTRY_DIR, file);
		try {
			const entry = JSON.parse(readFileSync(fullPath, "utf8")) as RegistryEntry;
			if (typeof entry.pid !== "number" || !isPidAlive(entry.pid)) {
				unlinkSync(fullPath);
				continue;
			}
			entries.push(entry);
		} catch {
			try {
				unlinkSync(fullPath);
			} catch {
				// Another session may have pruned it first.
			}
		}
	}
	return entries;
}

function registerGlobal(name: string, cwd: string, task: string): void {
	try {
		mkdirSync(REGISTRY_DIR, { recursive: true });
		const entry: RegistryEntry = { pid: process.pid, name, cwd, task: task.slice(0, 200), summonedAt: Date.now() };
		writeFileSync(registryFile(name), JSON.stringify(entry));
	} catch {
		// Registry is best-effort; a clone must not fail to summon over bookkeeping.
	}
}

function unregisterGlobal(name: string): void {
	try {
		unlinkSync(registryFile(name));
	} catch {
		// Already gone or never registered.
	}
}

function formatAge(summonedAt: number): string {
	const minutes = Math.floor((Date.now() - summonedAt) / 60_000);
	if (minutes < 1) return "just summoned";
	return `${minutes}m alive`;
}

/** Compact age for the sidebar/detail header: "<1m", "3m". */
function formatAgeShort(summonedAt: number): string {
	const minutes = Math.floor((Date.now() - summonedAt) / 60_000);
	return minutes < 1 ? "<1m" : `${minutes}m`;
}

/**
 * Lead's active worktree, read from the pi-dev-worktrees session state (the custom entry
 * that extension persists). Decoupled: if pi-dev-worktrees is not installed this is undefined
 * and clones fall back to the repo root.
 */
function readLeadWorktree(ctx: ExtensionContext): { branch: string; path: string } | undefined {
	try {
		let last: { worktree?: { branch?: string; path?: string } } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "pi-dev-worktrees:state") {
				last = entry.data as { worktree?: { branch?: string; path?: string } };
			}
		}
		if (last?.worktree?.path && last.worktree.branch) {
			return { branch: last.worktree.branch, path: last.worktree.path };
		}
	} catch {
		// No pi-dev-worktrees state, or session entries unreadable.
	}
	return undefined;
}

/** All git worktrees of the repo at cwd, as branch -> path. Empty when not a git repo. */
function listGitWorktrees(cwd: string): { branch: string; path: string }[] {
	try {
		const out = execSync("git worktree list --porcelain", { cwd, encoding: "utf8" });
		const result: { branch: string; path: string }[] = [];
		let current = "";
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
			else if (line.startsWith("branch ") && current) {
				result.push({ branch: line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""), path: current });
			}
		}
		return result;
	} catch {
		return [];
	}
}

/** Short branch name at a path, used to label a clone's worktree. */
function gitBranchAt(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Count leaf agents in a terminal state (done or failed). */
export function countSettledAgents(details: SwarmDetails): number {
	return details.agents.filter((agent) => agent.status === "done" || agent.status === "failed").length;
}

/** Compact one-line view of a clone's nested worker_run progress, for the log and dashboard. */
export function formatNestedSwarmActivity(details: SwarmDetails): string {
	const total = details.agents.length;
	const done = details.agents.filter((agent) => agent.status === "done").length;
	const running = details.agents.filter((agent) => agent.status === "running").length;
	const failed = details.agents.filter((agent) => agent.status === "failed").length;
	const parts = [`${done}/${total} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	return `worker_run ${details.phase}: ${parts.join(", ")}`;
}

/** Narrow a tool-update payload's `details` to SwarmDetails (clone swarm_run results only). */
export function asSwarmDetails(value: unknown): SwarmDetails | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Partial<SwarmDetails>;
	return Array.isArray(details.agents) && typeof details.phase === "string" ? (details as SwarmDetails) : undefined;
}

/** Abort clone work without letting an abort-ignoring provider block dispel or shutdown forever. */
export async function abortCloneSession(
	session: Pick<AgentSession, "abortCompaction" | "abort">,
	graceMs: number = CLONE_ABORT_GRACE_MS,
): Promise<boolean> {
	try {
		session.abortCompaction();
	} catch {
		// Continue to the bounded abort attempt even if compaction cleanup itself failed.
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve()
				.then(() => session.abort())
				.then(
					() => true,
					() => true,
				),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), graceMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function registerShadowClones(pi: ExtensionAPI): void {
	const settings = readSwarmSettings();
	// Opt-in deepest tier: only when enabled do clones get worker_run (and its prompt bullet).
	const cloneWorkers = settings.cloneWorkers;
	// Settled leaf count per in-flight clone worker_run (keyed by toolCallId), to log only on change.
	const nestedSwarmProgress = new Map<string, number>();
	const clones = new Map<string, ShadowClone>();
	const reservedNames = new Set<string>();
	// Names are never recycled within a session: a late report from a dispelled "sakura"
	// must not be attributable to a newly summoned "sakura".
	const usedNames = new Set<string>();
	const logDir = path.join(tmpdir(), `shadowclones-${process.pid}`);
	let ui: ExtensionContext["ui"] | undefined;
	let loaderPromise: Promise<ResourceLoader> | undefined;
	let dashboardRefresh: (() => void) | undefined;
	// Live read of the lead's streaming state, captured at session_start. Used to decide
	// whether a buffered report flush can trigger a fresh turn now (idle) or must wait for
	// the lead's current run to end (agent_end).
	let isLeadIdle: (() => boolean) | undefined;

	const getLoader = (cwd: string): Promise<ResourceLoader> => {
		loaderPromise ??= createSubagentLoader(cwd, buildCloneSystemPrompt(cloneWorkers));
		return loaderPromise;
	};

	// Single stable-width line, same icon language as the dashboard: spinner while a
	// clone works (alive = spinning), green dot + "done" when finished, red cross when
	// failed. Aggregates into counts when many clones so the line always fits.
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIntervalMs = 0;
	let lastWidgetLine: string | undefined;
	// Keyboard launcher state for the bottom agents tray: Down focuses it, Down/Enter
	// opens the dashboard, Up/Escape returns to the editor. While focused we capture keys
	// via a temporary input listener (installed only then, so editing is never disturbed).
	let trayFocused = false;
	let trayInputUnsub: (() => void) | undefined;
	const spinnerGlyph = () => SPINNER_FRAMES[spinnerFrame] ?? "⠋";

	const updateSpinnerTimer = () => {
		const anyWorking =
			[...clones.values()].some((clone) => clone.status === "working") ||
			listWorkerRuns().some((r) => r.details.phase === "preparing" || r.details.phase === "executing");
		// The spinner is the sole repaint driver while clones run in the background, and each
		// tick forces a full-UI repaint. Animate fast (200ms) only while the dashboard is open
		// — its spinners are the main view — and slow to a calm 400ms when just the one-line
		// widget shows it, halving background repaints during long runs nobody is watching.
		const desired = anyWorking ? (dashboardRefresh ? 200 : 400) : 0;
		if (desired === spinnerIntervalMs) return;
		spinnerIntervalMs = desired;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		if (desired > 0) {
			spinnerTimer = setInterval(() => {
				spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				renderWidget();
				dashboardRefresh?.();
			}, desired);
			spinnerTimer.unref?.();
		}
	};

	const WIDGET_MAX_NAMED_CLONES = 4;

	const renderWidget = () => {
		if (!ui) return;
		updateSpinnerTimer();
		const runs = listWorkerRuns();
		if (clones.size === 0 && runs.length === 0) {
			// No agents left: drop any tray focus and clear the widget.
			if (trayFocused) {
				trayFocused = false;
				trayInputUnsub?.();
				trayInputUnsub = undefined;
			}
			if (lastWidgetLine !== undefined) {
				lastWidgetLine = undefined;
				ui.setWidget("shadowclones", undefined);
			}
			return;
		}
		const theme = ui.theme;
		const anyWorking =
			[...clones.values()].some((clone) => clone.status === "working") ||
			runs.some((r) => r.details.phase === "preparing" || r.details.phase === "executing");
		let parts: string[];
		if (clones.size === 0) {
			parts = [];
		} else if (clones.size <= WIDGET_MAX_NAMED_CLONES) {
			parts = [...clones.values()].map(
				(clone) =>
					`${statusIcon(theme, clone.status, spinnerGlyph())} ${theme.fg("accent", `@${clone.name}`)} ${statusWord(
						theme,
						clone.status,
					)}`,
			);
		} else {
			const counts: Record<CloneStatus, number> = { working: 0, waiting: 0, idle: 0, paused: 0, failed: 0 };
			for (const clone of clones.values()) counts[clone.status]++;
			parts = [
				theme.fg("accent", `⊛ ${clones.size} clones`),
				...(Object.keys(counts) as CloneStatus[])
					.filter((status) => counts[status] > 0)
					.map(
						(status) => `${statusIcon(theme, status, spinnerGlyph())} ${counts[status]} ${statusWord(theme, status)}`,
					),
			];
		}
		if (runs.length > 0) {
			const active = runs.filter((r) => r.details.phase === "preparing" || r.details.phase === "executing").length;
			parts.push(
				theme.fg("toolTitle", `⚙ ${runs.length} worker${runs.length === 1 ? "" : "s"}${active > 0 ? ` (${active} running)` : ""}`),
			);
		}
		// Make it explicit the chat stays usable while agents run — no blocking wait needed.
		if (anyWorking) parts.push(theme.fg("dim", "keep chatting — they report back"));
		const status = parts.join("   ");
		// Launcher row: a calm affordance to open the unified agents dashboard. Down focuses
		// it (it lights up), Down/Enter opens it, Up/Escape returns to the editor; ⌥K opens
		// it directly from anywhere.
		const launcher = trayFocused
			? `${theme.bold(theme.fg("accent", "▸ open agents dashboard"))}   ${theme.fg("dim", "↓ / ⏎ open · ↑ back")}`
			: theme.fg("dim", `↓ agents dashboard · ${HOTKEY_LABEL}`);
		const lines = [status, launcher];
		const joined = lines.join("\n");
		if (joined === lastWidgetLine) return;
		lastWidgetLine = joined;
		// Above the editor, like CC's grey status line — a calm glance-up indicator that
		// never blocks or clutters the transcript with a tool call.
		ui.setWidget("shadowclones", lines, { placement: "aboveEditor" });
	};
	const widgetEmitter = createThrottledEmitter(() => {
		renderWidget();
		dashboardRefresh?.();
	}, WIDGET_THROTTLE_MS);
	// Worker runs live in a shared registry; mirror their changes into the widget and dashboard.
	const unsubscribeWorkerRuns = onWorkerRunsChange(() => {
		renderWidget();
		dashboardRefresh?.();
	});

	const log = (clone: ShadowClone, kind: TranscriptKind, text: string, label?: string) => {
		const stamp = new Date().toISOString().slice(11, 19);
		const entry: TranscriptEntry = { kind, stamp, text, label };
		// Async per-clone write chain: keeps line order without blocking the lead's
		// event loop on disk I/O for every clone event. Errors never break the clone.
		clone.logChain = clone.logChain.then(() => appendFile(clone.logPath, `${entryToLogText(entry)}\n`)).catch(() => {});
		clone.transcript.push(entry);
		if (clone.transcript.length > TRANSCRIPT_MAX_ENTRIES) {
			clone.transcript.splice(0, clone.transcript.length - TRANSCRIPT_MAX_ENTRIES);
		}
		clone.transcriptVersion++;
	};

	// In-progress wait_for calls, keyed by clone name: a steering message wakes them
	// so lead instructions (STOP included) land immediately instead of after the timeout.
	const waitInterrupts = new Map<string, Set<() => void>>();
	const interruptCloneWaits = (name: string) => {
		for (const interrupt of [...(waitInterrupts.get(name) ?? [])]) interrupt();
	};

	const sendToClone = async (
		clone: ShadowClone,
		message: string,
		from: "lead" | "user",
	): Promise<"steered" | "started"> => {
		if (clone.lingerTimer) {
			// A follow-up arrived during the post-report linger window: the clone is
			// engaged again, so it stops being one-shot and stays for orders.
			clearTimeout(clone.lingerTimer);
			clone.lingerTimer = undefined;
			clone.keep = true;
			log(clone, "status", "status: follow-up during linger — staying alive (keep)");
		}
		clone.pendingQuestion = false;
		clone.pauseRequested = undefined; // new instructions cancel a pending pause
		log(clone, from, message.trim());
		if (from === "user") {
			pi.sendMessage(
				{
					customType: SHADOWCLONE_REPORT_TYPE,
					content: `User sent instructions directly to shadow clone @${clone.name} via the shadow clone dashboard:\n\n${message}`,
					display: false,
					details: { name: clone.name, kind: "user-send" },
				},
				{ deliverAs: "nextTurn" },
			);
		}
		if (clone.session.isStreaming) {
			await clone.session.prompt(message, {
				expandPromptTemplates: false,
				source: "extension",
				streamingBehavior: "steer",
			});
			// The steer is queued; if the clone is idling inside wait_for, cut the wait short.
			interruptCloneWaits(clone.name);
			return "steered";
		}
		runInstruction(clone, message);
		return "started";
	};

	// Report delivery has two lanes:
	//   urgent (questions, failures): steer — the clone is blocked, so interrupting the lead is justified.
	//   non-urgent (updates, completions, wave-settled): buffered, then flushed as ONE
	//     consolidated message. Sending each as its own followUp fragmented a finishing wave
	//     into N lead turns (the followUp queue drains one-at-a-time), so the full reports
	//     trickled in for minutes, interleaved and out of order. Coalescing keeps them to a
	//     single turn at the next boundary: when the lead is idle a deferred flush triggers a
	//     fresh batched turn; while it streams, agent_end flushes and the post-run continuation
	//     drains the one queued message.
	const bufferedReports: { content: string; details: Record<string, unknown> }[] = [];
	let flushScheduled = false;

	const flushBufferedReports = () => {
		if (bufferedReports.length === 0) return;
		const batch = bufferedReports.splice(0, bufferedReports.length);
		const [content, details]: [string, Record<string, unknown>] =
			batch.length === 1
				? [batch[0].content, batch[0].details]
				: [
						truncateCloneReportBatch(batch.map((report) => report.content)),
						// Carry the contributing clone names so the session_start re-seed can still
						// recover them after a resume (a coalesced batch has no single details.name).
						{
							kind: "report-batch",
							count: batch.length,
							names: batch.map((r) => r.details.name).filter((n): n is string => typeof n === "string"),
						},
					];
		pi.sendMessage(
			{ customType: SHADOWCLONE_REPORT_TYPE, content, display: true, details },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const scheduleReportFlush = () => {
		if (flushScheduled) return;
		flushScheduled = true;
		// Defer a tick so a burst of near-simultaneous completions coalesces into one message.
		const timer = setTimeout(() => {
			flushScheduled = false;
			if (bufferedReports.length === 0) return;
			// While the lead streams, sending now would just queue a followUp that drains
			// one-at-a-time; let agent_end flush instead. When idle, flush a fresh batched turn.
			if (isLeadIdle && !isLeadIdle()) return;
			flushBufferedReports();
		}, 0);
		timer.unref?.();
	};

	const bufferReport = (content: string, details: Record<string, unknown>) => {
		bufferedReports.push({ content, details });
		scheduleReportFlush();
	};

	const deliverReport = (name: string, kind: string, body: string, urgent: boolean) => {
		const content = truncateCloneReport(`Shadow clone @${name} ${kind}:\n\n${body}`);
		if (urgent) {
			pi.sendMessage(
				{ customType: SHADOWCLONE_REPORT_TYPE, content, display: true, details: { name, kind } },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} else {
			bufferReport(content, { name, kind });
		}
	};

	// A "wave" is one summon batch of 2+ clones. When the last member settles (completes,
	// pauses, or is dispelled), ONE aggregate notification is buffered alongside the member
	// reports so the lead stops tallying "5/8 landed" by hand. It rides the same coalescing
	// flush, so the summary lands in the same batched turn as the completions it summarizes.
	interface WaveState {
		total: number;
		startedAt: number;
		outcomes: Map<string, { outcome: string; files: number }>;
	}
	const waves = new Map<number, WaveState>();
	let waveCounter = 0;

	const markSettled = (clone: ShadowClone, outcome: string) => {
		if (clone.waveId === undefined) return;
		const wave = waves.get(clone.waveId);
		if (!wave || wave.outcomes.has(clone.name)) return;
		wave.outcomes.set(clone.name, { outcome, files: clone.touchedFiles.size });
		if (wave.outcomes.size < wave.total) return;
		waves.delete(clone.waveId);
		const minutes = Math.max(1, Math.round((Date.now() - wave.startedAt) / 60_000));
		const lines = [...wave.outcomes.entries()].map(
			([name, o]) =>
				`@${name} — ${o.outcome}${o.files > 0 ? `, ${o.files} file${o.files === 1 ? "" : "s"}` : ""}`,
		);
		bufferReport(
			`Shadow clone wave settled: ${wave.total} clones in ~${minutes}m\n${lines.join("\n")}`,
			{ kind: "wave-settled" },
		);
	};

	const createReportTool = (name: string): ToolDefinition<typeof ReportParamsSchema> => ({
		name: "report_to_lead",
		label: "Report to Lead",
		description:
			'Send an immediate message to the lead agent that summoned you. kind "question" when you need an answer before continuing (you will stop and wait); kind "update" for interim findings or blockers (you keep working). Your final response is delivered automatically, so never use this for the final report.',
		parameters: ReportParamsSchema,
		async execute(_toolCallId, params) {
			const clone = clones.get(name);
			const isQuestion = params.kind === "question";
			if (clone) {
				log(clone, "report", params.message, `report_to_lead (${params.kind})`);
				if (isQuestion) clone.pendingQuestion = true;
			}
			deliverReport(
				name,
				isQuestion ? "asks (and waits for your answer)" : "reports",
				params.message,
				isQuestion,
			);
			return {
				content: [
					{
						type: "text",
						text: isQuestion
							? "Question delivered to the lead. Stop here and end your turn; the answer arrives as a new message."
							: "Update delivered to the lead. Continue your task.",
					},
				],
				details: undefined,
			};
		},
	});

	const isNameTaken = (name: string): boolean =>
		clones.has(name) || reservedNames.has(name) || usedNames.has(name);

	const resolveName = (requested: string | undefined): string => {
		const base = requested
			? normalizeCloneName(requested)
					.replace(/[^a-z0-9-]+/g, "-")
					.replace(/^-+|-+$/g, "")
			: undefined;
		if (base && !isNameTaken(base)) return base;
		if (base) {
			let i = 2;
			while (isNameTaken(`${base}-${i}`)) i++;
			return `${base}-${i}`;
		}
		// Random pick, so waves don't always open with the same names.
		const available = NAME_POOL.filter((name) => !isNameTaken(name));
		if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
		for (let attempt = 0; attempt < 50; attempt++) {
			const name = generateNarutoName();
			if (!isNameTaken(name)) return name;
		}
		let i = 2;
		while (isNameTaken(`bunshin-${i}`)) i++;
		return `bunshin-${i}`;
	};

	const lookupClone = (rawName: string): ShadowClone => {
		const name = normalizeCloneName(rawName);
		const clone = clones.get(name);
		if (!clone) {
			const live = [...clones.keys()].map((n) => `@${n}`).join(", ") || "none";
			const hint = usedNames.has(name)
				? ` @${name} existed but has dispelled; its memories were delivered with its final report (check the transcript above).`
				: "";
			throw new Error(`No shadow clone named @${name}. Live clones: ${live}.${hint}`);
		}
		return clone;
	};

	/**
	 * Distill the clone's transcript into a compact memory digest via a separate model call.
	 * Synchronous by design: callers await it so memories never arrive as late surprises.
	 * Best-effort with a hard timeout; returns undefined when skipped or failed.
	 */
	const distillMemories = async (
		clone: ShadowClone,
		reason: string,
		force: boolean,
	): Promise<string | undefined> => {
		if (!clone.model) return undefined;
		if (!force && clone.transcript.length < MEMORY_MIN_TRANSCRIPT_ENTRIES) return undefined;
		const model = clone.model;
		try {
			const auth = await clone.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) return undefined;
			const transcriptText = clone.transcript.map(entryToLogText).join("\n");
			const tail =
				transcriptText.length > MEMORY_TRANSCRIPT_MAX_CHARS
					? transcriptText.slice(-MEMORY_TRANSCRIPT_MAX_CHARS)
					: transcriptText;
			// Abort the request on timeout so an orphaned model call does not keep burning tokens.
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Clone memory distillation timed out."));
				}, MEMORY_DISTILL_TIMEOUT_MS);
				timer.unref?.();
			});
			let response: Awaited<ReturnType<typeof complete>>;
			try {
				response = await Promise.race([
					complete(
						model,
						{
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: buildMemoryPrompt(clone, reason, tail) }],
									timestamp: Date.now(),
								},
							],
						},
						{ apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
					),
					timeout,
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			const digest = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (digest) log(clone, "meta", digest, `memory digest (${reason})`);
			return digest || undefined;
		} catch {
			// Memory transfer is best-effort; the raw log file still exists on disk.
			return undefined;
		}
	};

	const runInstruction = (clone: ShadowClone, prompt: string, isRetry = false) => {
		clone.status = "working";
		clone.lastActivity = isRetry ? "retrying after failure" : "starting";
		clone.stopReason = undefined;
		clone.errorMessage = undefined;
		clone.pauseRequested = undefined;
		if (!isRetry) clone.retriedInstruction = false;
		widgetEmitter.schedule();
		void clone.session
			.prompt(prompt, { expandPromptTemplates: false, source: "extension" })
			.then(() => {
				if (clones.get(clone.name) !== clone) return;
				// A deliberate pause aborted the in-flight work; unless the turn managed to
				// finish anyway, park the clone quietly instead of treating it as a failure.
				const pausedBy = clone.pauseRequested;
				if (pausedBy && clone.stopReason !== "stop") {
					enterManualPause(clone, pausedBy);
					return;
				}
				clone.pauseRequested = undefined;
				const failed = clone.stopReason !== "stop";
				if (failed) {
					const reason = clone.errorMessage
						? `failed: ${clone.errorMessage}`
						: `failed (${clone.stopReason ?? "no terminal response"})`;
					// Rate/usage limits: retrying into the same window just burns it, and
					// falling back to another model is against policy — auto-pause instead.
					if (isRateLimitedError(clone.errorMessage)) {
						pauseClone(clone, reason, "rate-limit");
						return;
					}
					// Provider errors are mostly transient capacity blips; one automatic retry
					// usually recovers. Two exceptions: deliberate aborts, and safety/policy
					// classifier blocks — the flagged content stays in the clone's context, so
					// an identical retry just re-triggers the classifier and burns the attempt.
					const policyBlocked = !!clone.errorMessage && isPolicyBlockedError(clone.errorMessage);
					if (clone.stopReason === STOP_REASON_ERROR && !clone.retriedInstruction && !policyBlocked) {
						clone.retriedInstruction = true;
						log(clone, "status", `status: ${reason} — retrying once`);
						runInstruction(clone, RECOVERY_PROMPT, true);
						return;
					}
					pauseClone(clone, reason);
					return;
				}
				if (clone.pendingQuestion) {
					// The clone asked the lead and is blocked on the answer. No completion
					// report (the question was already delivered) and no one-shot dispel.
					clone.status = "waiting";
					clone.lastActivity = "waiting for the lead's answer";
					widgetEmitter.flush();
					log(clone, "status", "status: waiting for answer");
					return;
				}
				const report = clone.lastOutput.trim() || "(no report text)";
				// Deterministic deliverables footer: the lead commits clones' work, so the
				// created/modified file list must never depend on the clone remembering to list it.
				const reportBody = [
					report,
					clone.touchedFiles.size > 0
						? `Files touched (edit/write): ${formatTouchedFiles(clone, 20).join(", ")}`
						: "",
					`Full log: ${clone.logPath}`,
				]
					.filter(Boolean)
					.join("\n\n");
				if (!clone.keep) {
					log(clone, "status", `status: completed (one-shot) — lingering ${LINGER_MINUTES}m for follow-ups`);
					deliverReport(
						clone.name,
						`completed its task (one-shot; dispels in ${LINGER_MINUTES}m unless you shadowclone_send a follow-up)`,
						reportBody,
						false,
					);
					markSettled(clone, "completed");
					clone.status = "idle";
					clone.lastActivity = `lingering ${LINGER_MINUTES}m — follow-up or self-dispel`;
					widgetEmitter.flush();
					clone.lingerTimer = setTimeout(() => void dispelClone(clone), LINGER_MS);
					clone.lingerTimer.unref?.();
					return;
				}
				clone.status = "idle";
				clone.lastActivity = "ready, awaiting orders";
				widgetEmitter.flush();
				log(clone, "status", "status: ready");
				deliverReport(clone.name, "completed its instruction (staying for orders)", reportBody, false);
				markSettled(clone, "completed (kept alive)");
			})
			.catch((error: unknown) => {
				if (clones.get(clone.name) !== clone) return;
				clone.errorMessage = error instanceof Error ? error.message : String(error);
				log(clone, "status", `error: ${clone.errorMessage}`);
				const pausedBy = clone.pauseRequested;
				if (pausedBy) {
					enterManualPause(clone, pausedBy);
					return;
				}
				if (isRateLimitedError(clone.errorMessage)) {
					pauseClone(clone, `failed: ${clone.errorMessage}`, "rate-limit");
					return;
				}
				if (!clone.retriedInstruction && !isPolicyBlockedError(clone.errorMessage)) {
					clone.retriedInstruction = true;
					log(clone, "status", "status: retrying once after error");
					runInstruction(clone, RECOVERY_PROMPT, true);
					return;
				}
				pauseClone(clone, `failed: ${clone.errorMessage}`);
			});
	};

	/** Paused-on-request state: nothing running, session and context intact, no urgent lead report. */
	const enterManualPause = (clone: ShadowClone, by: "user" | "lead"): void => {
		clone.pauseRequested = undefined;
		clone.status = "paused";
		clone.pendingQuestion = false;
		clone.stopReason = undefined;
		clone.errorMessage = undefined;
		clone.lastActivity = "paused — resume via shadowclone_send or the dashboard (p)";
		widgetEmitter.flush();
		log(clone, "status", `status: paused by ${by} (session intact)`);
	};

	/**
	 * Temporarily pause a clone: any in-flight work is aborted (that turn's spend is
	 * lost) but the session and its context stay intact, so a later shadowclone_send
	 * (or shadowclone_account switch) resumes exactly where it stopped.
	 */
	const requestClonePause = (clone: ShadowClone, by: "user" | "lead"): "paused" | "pausing" | "noop" => {
		if (clone.status === "paused" || clone.status === "failed" || clone.status === "idle" || clone.lingerTimer) {
			return "noop";
		}
		clone.pauseRequested = by;
		if (clone.session.isStreaming) {
			log(clone, "status", `── pause requested by ${by}; aborting in-flight work`);
			clone.session.abortCompaction();
			void clone.session.abort();
			return "pausing";
		}
		enterManualPause(clone, by);
		return "paused";
	};

	/**
	 * A clone that failed twice pauses instead of dying: its session and prompt cache stay
	 * alive so the lead can rephrase via shadowclone_send (cheap) instead of restarting a
	 * fresh clone from a digest (expensive). Rate/usage-limit errors (429) pause on the
	 * FIRST hit — no retry, no fallback model — since only time or another account fixes them.
	 */
	const pauseClone = (clone: ShadowClone, reason: string, cause: "failure" | "rate-limit" = "failure"): void => {
		const rateLimited = cause === "rate-limit";
		clone.status = rateLimited ? "paused" : "failed";
		clone.pendingQuestion = false;
		clone.pauseRequested = undefined;
		clone.lastActivity = rateLimited
			? "auto-paused: rate limit — switch account or resume later"
			: "paused after failure — steer or dispel";
		widgetEmitter.flush();
		log(clone, "status", `status: ${rateLimited ? "auto-paused on rate limit" : "paused"} (${reason})`);
		const recentTools = clone.items
			.filter((item) => item.type === "tool")
			.slice(-5)
			.map((item) => `  ${formatDisplayItem(item)}`);
		// Policy classifier blocks poison the session: the flagged content stays in
		// context and re-triggers the block, so "resend and affirm" is the wrong
		// advice — a fresh context (or another provider) is the way out.
		const provider = clone.model?.provider;
		const otherAccounts = rateLimited && provider ? listAccountProfiles(provider).filter((name) => name !== clone.account) : [];
		const advice = rateLimited
			? `A provider rate/usage limit was hit. By design there is no automatic retry and no fallback model: the clone auto-paused with its session and context intact. Options: switch it to another saved /acc account with shadowclone_account {name: "${clone.name}", account: "<profile>"} — it resumes automatically${otherAccounts.length > 0 ? ` (saved ${provider} profiles: ${otherAccounts.join(", ")})` : ""}; wait for the limit window to reset and resume via shadowclone_send; or shadowclone_dispel @${clone.name} to collect memories.`
			: !!clone.errorMessage && isPolicyBlockedError(clone.errorMessage)
				? `A provider safety classifier blocked the request (likely a false positive; the work is on the user's own product). The flagged content stays in this clone's context, so resending into this session will most likely be blocked again. Instead: shadowclone_dispel @${clone.name} to collect its memories, then resummon a FRESH clone with a rephrased task that avoids pasting the trigger content (optionally pass model: "provider/model-id" to use another provider). When retry.fallbackModels is configured in settings, sessions reroute blocked requests to the fallback model automatically.`
				: `The session and its context are intact. Refusals are usually transient provider errors or overcautious safety — resend instructions via shadowclone_send, affirming the work is on the user's own product. Or shadowclone_dispel @${clone.name} to collect memories.`;
		const body = [
			`Reason: ${reason}`,
			clone.touchedFiles.size > 0
				? `Files touched so far:\n${formatTouchedFiles(clone, 10)
						.map((file) => `  ${file}`)
						.join("\n")}`
				: "",
			recentTools.length > 0 ? `Last tool calls:\n${recentTools.join("\n")}` : "",
			advice,
		]
			.filter(Boolean)
			.join("\n\n");
		deliverReport(
			clone.name,
			rateLimited ? "hit a provider rate limit and auto-paused (session intact)" : "hit a failure and paused (session intact)",
			body,
			true,
		);
		markSettled(clone, rateLimited ? "auto-paused (rate limit)" : "paused after failure");
	};

	const dispelClone = async (clone: ShadowClone): Promise<void> => {
		if (clone.lingerTimer) {
			clearTimeout(clone.lingerTimer);
			clone.lingerTimer = undefined;
		}
		markSettled(clone, "dispelled");
		clones.delete(clone.name);
		clone.unsubscribe();
		try {
			await abortCloneSession(clone.session);
		} finally {
			clone.session.dispose();
		}
		unregisterGlobal(clone.name);
		waitInterrupts.delete(clone.name);
		log(clone, "status", "── dispelled");
		widgetEmitter.flush();
	};

	/**
	 * Memories that survive a dispel: model digest when worthwhile, otherwise a
	 * deterministic fallback (last output + raw transcript tail). Touched files and the
	 * log path are appended deterministically so they survive even when the digest
	 * happens to omit them.
	 */
	const collectMemories = async (clone: ShadowClone, reason: string, force: boolean): Promise<string> => {
		let memories = await distillMemories(clone, reason, force);
		if (!memories) {
			const tail = clone.transcript.slice(-15).map(entryToLogText).join("\n").trim();
			const output = clone.lastOutput.trim();
			memories = [
				output ? `Last output:\n${output}` : "",
				tail ? `Recent activity (raw transcript tail):\n${tail}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
		}
		const footer = [
			clone.touchedFiles.size > 0 ? `Files touched (edit/write): ${formatTouchedFiles(clone, 20).join(", ")}` : "",
			`Full log: ${clone.logPath}`,
		]
			.filter(Boolean)
			.join("\n");
		return [memories, footer].filter(Boolean).join("\n\n");
	};

	const formatCloneStatus = (clone: ShadowClone): string => {
		const modelTag = `, ${formatModelSpec(clone.model) ?? "lead model"}, thinking ${clone.thinkingLevel}`;
		// The clone's account is pinned in its own credential view, so the label
		// cannot drift under a lead /acc switch; shadowclone_account changes it.
		const accTag = clone.account ? ` · acc ${clone.account}` : "";
		const lines = [
			`@${clone.name} — ${clone.status} (${formatAge(clone.summonedAt)}, ctx ${Math.round(clone.lastTotalTokens / 1000)}k${modelTag}${accTag})`,
			`  task: ${truncateSingleLine(clone.task, 120)}`,
			`  last: ${truncateSingleLine(clone.lastActivity, 200)}`,
			`  watch: tail -f ${clone.logPath}`,
		];
		if (clone.touchedFiles.size > 0) {
			lines.push(`  files: ${formatTouchedFiles(clone, 8).join(", ")}`);
		}
		for (const item of clone.items.slice(-3)) {
			lines.push(`  - ${formatDisplayItem(item)}`);
		}
		if (clone.errorMessage) lines.push(`  error: ${clone.errorMessage}`);
		return lines.join("\n");
	};

	const summonWithName = async (
		spec: CloneSpec,
		ctx: ExtensionContext,
		siblings: { name: string; task: string }[],
		waveId: number | undefined,
	): Promise<SummonInfo> => {
		const { name, task, keep, persona, cwd: cloneCwd, worktreeLabel, thinkingLevel } = spec;
		mkdirSync(logDir, { recursive: true });
		const logPath = path.join(logDir, `${name}.log`);
		const resourceLoader = await getLoader(ctx.cwd);
		let currentCloneModel = spec.model ?? ctx.model;
		let currentCloneThinking = thinkingLevel;
		// Per-clone auth view: the clone inherits the lead's live account by default,
		// but its pins are isolated, so a summon-time `account` override or a later
		// shadowclone_account switch never touches the lead or sibling clones.
		const cloneAuth = createCloneAuthStorage(ctx.modelRegistry.authStorage);
		const cloneRegistry = createCloneModelRegistry(ctx.modelRegistry, cloneAuth);
		if (spec.account) {
			if (!currentCloneModel) {
				throw new Error(`Clone @${name}: account "${spec.account}" requires a resolved model provider.`);
			}
			await pinCloneAccount(cloneAuth, currentCloneModel.provider, spec.account);
		}
		// Pin the attribution at summon: which model and which /acc account this clone
		// starts under, so every surface (card, dashboard, status, log) can show it.
		const modelSpec = formatModelSpec(currentCloneModel);
		const account = currentCloneModel
			? resolveAccountLabel(cloneAuth, currentCloneModel.provider)
			: undefined;
		const { session } = await createAgentSession({
			cwd: cloneCwd,
			agentDir: getAgentDir(),
			model: currentCloneModel,
			modelRegistry: cloneRegistry,
			thinkingLevel,
			tools: cloneToolNames(cloneWorkers),
			customTools: [
				createReportTool(name),
				createWaitForTool((onInterrupt) => {
					let interrupts = waitInterrupts.get(name);
					if (!interrupts) {
						interrupts = new Set();
						waitInterrupts.set(name, interrupts);
					}
					interrupts.add(onInterrupt);
					return () => interrupts.delete(onInterrupt);
				}),
				...(cloneWorkers
					? [
							createSwarmTool(
								() => ({
									cwd: cloneCwd,
									model: currentCloneModel,
									// Nested workers inherit the clone's account, not the lead's.
									modelRegistry: cloneRegistry,
									thinkingLevel: currentCloneThinking,
								}),
								() => name,
							),
						]
					: []),
			],
			resourceLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		currentCloneThinking = session.thinkingLevel;
		const clone: ShadowClone = {
			name,
			task,
			keep,
			pendingQuestion: false,
			status: "working",
			session,
			unsubscribe: () => {},
			logPath,
			logChain: Promise.resolve(),
			lastActivity: "summoning",
			lastOutput: "",
			items: [],
			transcript: [],
			transcriptVersion: 0,
			model: currentCloneModel,
			thinkingLevel: currentCloneThinking,
			modelRegistry: cloneRegistry,
			cloneAuth,
			account,
			summonedAt: Date.now(),
			cwd: cloneCwd,
			worktreeLabel,
			touchedFiles: new Set(),
			lastTotalTokens: 0,
			retriedInstruction: false,
			waveId,
		};
		clone.unsubscribe = session.subscribe((event) => {
			if (event.type === "thinking_level_changed") {
				currentCloneThinking = event.level;
				clone.thinkingLevel = event.level;
				clone.lastActivity = `thinking level: ${event.level}`;
				log(clone, "status", `status: thinking level ${event.level}`);
				widgetEmitter.flush();
				return;
			}
			const transition = getModelTransition(event);
			if (transition) {
				currentCloneModel = transition.model;
				clone.model = transition.model;
				clone.account = resolveAccountLabel(cloneAuth, transition.model.provider);
				clone.lastActivity = transition.activity;
				log(
					clone,
					"status",
					`status: ${transition.activity}${clone.account ? ` · acc ${clone.account}` : ""}`,
				);
				widgetEmitter.flush();
				return;
			}
			if (event.type === "tool_execution_start" && (event.toolName === "edit" || event.toolName === "write")) {
				const filePath = getToolPathArg(event.args);
				if (filePath) clone.touchedFiles.add(path.resolve(cloneCwd, filePath));
			}
			// Nested swarm: a clone's swarm_run streams leaf progress as partialResult.details,
			// otherwise invisible. Mirror it into lastActivity (dashboard) and the log (tail -f).
			if (
				(event.type === "tool_execution_update" || event.type === "tool_execution_end") &&
				event.toolName === "worker_run"
			) {
				const details = asSwarmDetails(
					event.type === "tool_execution_end" ? event.result?.details : event.partialResult?.details,
				);
				if (details) {
					const settled = countSettledAgents(details);
					clone.lastActivity = formatNestedSwarmActivity(details);
					if (nestedSwarmProgress.get(event.toolCallId) !== settled) {
						nestedSwarmProgress.set(event.toolCallId, settled);
						log(clone, "tool", clone.lastActivity);
					}
					if (event.type === "tool_execution_end") nestedSwarmProgress.delete(event.toolCallId);
					widgetEmitter.schedule();
				}
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				clone.lastTotalTokens = event.message.usage.totalTokens;
				for (const part of event.message.content) {
					if (part.type === "thinking" && part.thinking.trim()) log(clone, "thinking", part.thinking.trim());
					else if (part.type === "text" && part.text.trim()) log(clone, "clone", part.text.trim());
				}
			}
			const update = getEventUpdate(event, clone.items);
			if (clone.items.length > ITEMS_MAX) clone.items.splice(0, clone.items.length - ITEMS_MAX);
			if (!update) return;
			if (update.output !== undefined) clone.lastOutput = update.output;
			// message_end deliberately carries own properties with undefined values on
			// success; use property presence so a recovered turn clears stale failures.
			if ("stopReason" in update) clone.stopReason = update.stopReason;
			if ("errorMessage" in update) clone.errorMessage = update.errorMessage;
			if (event.type === "tool_execution_start" && update.lastActivity) log(clone, "tool", update.lastActivity);
			clone.lastActivity = update.lastActivity ?? "working";
			widgetEmitter.schedule();
		});
		clones.set(name, clone);
		registerGlobal(name, cloneCwd, task);
		log(clone, "lead", task.trim(), "summoned for task");
		log(
			clone,
			"status",
			`status: model ${modelSpec ?? "lead default"} · thinking ${currentCloneThinking}${account ? ` · acc ${account}` : ""}`,
		);
		runInstruction(clone, buildClonePrompt(name, task, persona, siblings));
		return {
			name,
			task,
			keep,
			persona,
			cwd: cloneCwd,
			worktreeLabel,
			logPath,
			modelSpec,
			thinking: currentCloneThinking,
			account,
		};
	};

	pi.registerTool<typeof SummonParamsSchema, SummonDetails>({
		name: "shadowclone_summon",
		label: "Shadow Clones: Summon",
		description:
			"Summon persistent shadow clone subagents that work on tasks in the background. Summon ALL clones for a request in one call (clones array). Returns immediately; clones report back when done or when they need the lead. Steer them anytime with shadowclone_send.",
		promptSnippet:
			"Summon persistent named shadow clone subagents to work on tasks in the background while you continue.",
		promptGuidelines: [
			settings.workers
				? "Use shadowclone_summon for long-running or parallel work; use worker_run for one-shot fire-and-forget fan-out. Summon all clones for a request in ONE shadowclone_summon call."
				: "Use shadowclone_summon for long-running or parallel work. Summon all clones for a request in ONE shadowclone_summon call.",
			"By default a shadow clone dispels itself after delivering its final report. Pass keep: true only for clones the user will want to steer with follow-up instructions afterwards.",
			"Do not pass clone names to shadowclone_summon unless the user explicitly requested specific nicknames; names are auto-picked.",
			"You are the lead of your summoned shadow clones. When the user mentions @<clone-name>, relay their instructions to that clone with shadowclone_send and confirm to the user.",
			"Messages starting with 'Shadow clone @<name>' are reports from your clones. A clone that 'asks' is blocked waiting for your answer: reply promptly via shadowclone_send. Verify completed work, and dispel kept clones that are done via shadowclone_dispel.",
			"A clone that hits a provider failure retries once automatically; if it fails again it pauses with its session intact. Steer it with shadowclone_send (for refusals, affirm the work is on the user's own product), or dispel it to collect memories.",
			`One-shot clones linger ~${LINGER_MINUTES}m after their final report; shadowclone_send within that window keeps them alive for follow-ups.`,
			"Clones run in your active git worktree by default; pass worktree: <branch> to place a clone in a different existing worktree (create it first with /worktree <branch>).",
			...(cloneWorkers
				? [
						"worker_run BLOCKS its caller for the entire run. To fan work out without freezing yourself, summon a clone whose task is to run the worker_run — it blocks only that clone, in the background, and reports back when the workers are done.",
					]
				: []),
			"Give a clone a persona only when approach or style matters for its task; keep personas short and situation-specific.",
			'Model and thinking are yours to choose per clone: pass an exact "provider/model-id" from --list-models and a thinking level when you judge the task needs them. Omitted model inherits yours; omitted thinking defaults to medium.',
			'Per-clone auth: pass account: "<saved /acc profile>" at summon, or switch a live clone with shadowclone_account — the lead and sibling clones keep their own accounts.',
			"On a 429/rate-limit error a clone auto-pauses (no retry, no fallback model) with its session intact: switch its account via shadowclone_account (it resumes automatically) or resume later with shadowclone_send. shadowclone_pause pauses a clone manually.",
			"While clones work the chat stays usable: end your turn and keep working — clone reports arrive as messages that wake you automatically, and the bottom status line tracks live clones. Don't sleep-poll with bash or spin on shadowclone_status; there is nothing to wait on by hand.",
		],
		parameters: SummonParamsSchema,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as SummonParams;
			const input = args as {
				clones?: SummonParams["clones"];
				task?: unknown;
				name?: unknown;
				keep?: unknown;
				persona?: unknown;
				worktree?: unknown;
				model?: unknown;
				thinking?: unknown;
				account?: unknown;
			};
			if (input.clones === undefined && typeof input.task === "string") {
				const thinking = SPAWN_THINKING_LEVELS.find((level) => level === input.thinking);
				return {
					clones: [
						{
							task: input.task,
							...(typeof input.name === "string" ? { name: input.name } : {}),
							...(typeof input.keep === "boolean" ? { keep: input.keep } : {}),
							...(typeof input.persona === "string" ? { persona: input.persona } : {}),
							...(typeof input.worktree === "string" ? { worktree: input.worktree } : {}),
							...(typeof input.model === "string" ? { model: input.model } : {}),
							...(thinking ? { thinking } : {}),
							...(typeof input.account === "string" ? { account: input.account } : {}),
						},
					],
				};
			}
			return args as SummonParams;
		},
		async execute(_toolCallId, params: SummonParams, _signal, _onUpdate, ctx) {
			// Lingering one-shots already delivered their reports; flush them so a finished
			// wave never blocks the next one on the clone limit.
			const lingering = [...clones.values()].filter((clone) => clone.lingerTimer);
			await Promise.all(lingering.map((clone) => dispelClone(clone)));
			if (clones.size + reservedNames.size + params.clones.length > MAX_CLONES) {
				throw new Error(
					`Clone limit would be exceeded (max ${MAX_CLONES} per session). Dispel clones first with shadowclone_dispel.`,
				);
			}
			const global = listGlobalClones();
			if (global.length + params.clones.length > GLOBAL_MAX_CLONES) {
				const bySession = new Map<number, number>();
				for (const entry of global) bySession.set(entry.pid, (bySession.get(entry.pid) ?? 0) + 1);
				const breakdown = [...bySession.entries()]
					.map(([pid, count]) => `pid ${pid}: ${count}`)
					.join(", ");
				throw new Error(
					`Machine-wide clone limit would be exceeded (max ${GLOBAL_MAX_CLONES} across all pi sessions; live now: ${breakdown}). Dispel clones somewhere first.`,
				);
			}
			const liveSiblings = [...clones.values()].map((c) => ({ name: c.name, task: c.task }));
			// Resolve each clone's worktree up front so a bad branch fails before any name is reserved.
			// Default: the lead's active worktree (pi-dev-worktrees), else the repo root.
			const leadWt = readLeadWorktree(ctx);
			const defaultCwd = leadWt?.path && existsSync(leadWt.path) ? leadWt.path : ctx.cwd;
			const defaultLabel = leadWt?.branch ?? gitBranchAt(defaultCwd);
			const knownWorktrees = params.clones.some((c) => c.worktree) ? listGitWorktrees(ctx.cwd) : [];
			const placements = params.clones.map((spec) => {
				if (!spec.worktree) return { cwd: defaultCwd, worktreeLabel: defaultLabel };
				const wanted = spec.worktree.trim().replace(/^refs\/heads\//, "");
				const match = knownWorktrees.find((w) => w.branch === wanted);
				if (!match) {
					const avail = knownWorktrees.map((w) => w.branch).join(", ") || "none";
					throw new Error(
						`No git worktree for branch '${wanted}'. Create it first with /worktree ${wanted} (or the worktree tool). Available worktrees: ${avail}.`,
					);
				}
				return { cwd: match.path, worktreeLabel: match.branch };
			});
			// Validate the whole batch before reserving names or starting sessions, so one
			// bad explicit model cannot leave a partially summoned wave behind.
			const selectedModels = params.clones.map((spec) => resolveSpawnModel(ctx.modelRegistry, spec.model));
			const selectedThinking = params.clones.map((spec, index) =>
				resolveSpawnThinkingLevel(selectedModels[index] ?? ctx.model, spec.thinking),
			);
			// Validate explicit accounts up front too: an unknown /acc profile must fail
			// before any name is reserved or session started.
			for (const [index, spec] of params.clones.entries()) {
				if (!spec.account) continue;
				const provider = (selectedModels[index] ?? ctx.model)?.provider;
				if (!provider) {
					throw new Error(`Clone ${index + 1}: account "${spec.account}" requires a resolvable model provider.`);
				}
				getAccountCredential(provider, spec.account); // throws with the available profiles when unknown
			}
			const assignments: CloneSpec[] = params.clones.map((spec, index) => {
				const name = resolveName(spec.name);
				reservedNames.add(name);
				usedNames.add(name);
				return {
					name,
					task: spec.task,
					keep: spec.keep ?? false,
					persona: spec.persona,
					cwd: placements[index].cwd,
					worktreeLabel: placements[index].worktreeLabel,
					model: selectedModels[index],
					thinkingLevel: selectedThinking[index],
					account: spec.account,
				};
			});
			let waveId: number | undefined;
			if (assignments.length > 1) {
				waveId = ++waveCounter;
				waves.set(waveId, { total: assignments.length, startedAt: Date.now(), outcomes: new Map() });
			}
			try {
				const summons = await Promise.all(
					assignments.map((spec) =>
						summonWithName(
							spec,
							ctx,
							[
								...liveSiblings,
								...assignments.filter((a) => a.name !== spec.name).map((a) => ({ name: a.name, task: a.task })),
							],
							waveId,
						),
					),
				);
				const lines = [
					`Summoned ${summons.length} shadow clone${summons.length === 1 ? "" : "s"}.`,
					"",
					...summons.map(
						(s) =>
							`@${s.name}${s.keep ? " (stays for orders)" : ""}${s.worktreeLabel ? ` [worktree: ${s.worktreeLabel}]` : ""} [${s.modelSpec ?? "lead model"} · thinking ${s.thinking}${s.account ? ` · acc ${s.account}` : ""}] — ${truncateSingleLine(s.task, 140)}\n  watch: tail -f ${s.logPath}`,
					),
					"",
					"One-shot clones report and dispel themselves; clones marked keep stay alive for shadowclone_send.",
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { summons },
				};
			} catch (error) {
				if (waveId !== undefined) waves.delete(waveId);
				throw error;
			} finally {
				for (const { name } of assignments) reservedNames.delete(name);
			}
		},
		renderCall(args, theme) {
			const count = args.clones?.length ?? 0;
			const label = count > 0 ? ` summoning ${count} clone${count === 1 ? "" : "s"}...` : " summoning...";
			return new Text(
				theme.fg("toolTitle", theme.bold("shadowclone_summon")) + theme.fg("dim", label),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (!details?.summons) {
				const text = result.content.find((part) => part.type === "text")?.text ?? "";
				return new Text(text, 0, 0);
			}
			return new SummonCard(theme, details, expanded);
		},
	});

	pi.registerTool<typeof SendParamsSchema, undefined>({
		name: "shadowclone_send",
		label: "Shadow Clones: Send",
		description:
			"Send new instructions, answers, or course corrections to a live shadow clone. If the clone is busy, the message is delivered as a steering interrupt (it also cuts short an in-progress wait_for); if idle, it starts working on it. Also revives paused clones, and sending to a lingering one-shot clone cancels its self-dispel (it stays for orders).",
		promptSnippet: "Send new instructions or answers to a live shadow clone by name.",
		parameters: SendParamsSchema,
		async execute(_toolCallId, params: SendParams) {
			const clone = lookupClone(params.name);
			const delivery = await sendToClone(clone, params.message, "lead");
			return {
				content: [
					{
						type: "text",
						text:
							delivery === "steered"
								? `Steering message queued for @${clone.name} (currently working).`
								: `Sent to @${clone.name}. It will report back when done.`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const name = args.name ? ` @${normalizeCloneName(args.name)}` : "";
			const message = args.message ? theme.fg("dim", ` ${truncateSingleLine(args.message, 70)}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("shadowclone_send")) + theme.fg("accent", name) + message, 0, 0);
		},
	});

	pi.registerTool<typeof StatusParamsSchema, undefined>({
		name: "shadowclone_status",
		label: "Shadow Clones: Status",
		description:
			"Check status, last activity, and recent actions of live shadow clones. Do not poll it in a loop to wait for clones; just end your turn — clone reports arrive as messages and wake you.",
		promptSnippet: "Check status and recent activity of live shadow clones.",
		parameters: StatusParamsSchema,
		async execute(_toolCallId, params: StatusParams) {
			if (params.name) {
				return { content: [{ type: "text", text: formatCloneStatus(lookupClone(params.name)) }], details: undefined };
			}
			const sections: string[] = [];
			if (clones.size > 0) {
				sections.push([...clones.values()].map(formatCloneStatus).join("\n\n"));
			} else {
				sections.push("No live shadow clones in this session.");
			}
			const foreign = listGlobalClones().filter((entry) => entry.pid !== process.pid);
			if (foreign.length > 0) {
				sections.push(
					`Other pi sessions on this machine (${foreign.length} clone${foreign.length === 1 ? "" : "s"}):\n` +
						foreign
							.map(
								(entry) =>
									`  @${entry.name} (pid ${entry.pid}, ${entry.cwd}) — ${truncateSingleLine(entry.task, 80)}`,
							)
							.join("\n"),
				);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: undefined };
		},
		renderCall(args, theme) {
			const name = args.name ? ` @${normalizeCloneName(args.name)}` : " all";
			return new Text(theme.fg("toolTitle", theme.bold("shadowclone_status")) + theme.fg("accent", name), 0, 0);
		},
	});

	pi.registerTool<typeof DispelParamsSchema, undefined>({
		name: "shadowclone_dispel",
		label: "Shadow Clones: Dispel",
		description:
			'Dispel a shadow clone by name (or "all"), aborting any in-progress work. Returns the clone\'s memories: a distilled digest of everything it did (for clones with substantial activity), or its final output. May take a few seconds while memories are distilled.',
		promptSnippet: "Dispel a shadow clone (or all), collecting its final report.",
		parameters: DispelParamsSchema,
		async execute(_toolCallId, params: DispelParams) {
			const raw = normalizeCloneName(params.name);
			const targets = raw === "all" ? [...clones.values()] : [lookupClone(raw)];
			if (targets.length === 0) {
				return { content: [{ type: "text", text: "No live shadow clones to dispel." }], details: undefined };
			}
			const separator = "\n\n";
			const perTargetBudget = Math.min(
				CLONE_REPORT_MAX_BYTES,
				Math.max(
					1024,
					Math.floor(
						(CLONE_REPORT_BATCH_MAX_BYTES - Buffer.byteLength(separator, "utf8") * (targets.length - 1)) /
							targets.length,
					),
				),
			);
			const reports = await Promise.all(
				targets.map(async (clone) => {
					const wasWorking = clone.session.isStreaming;
					await dispelClone(clone);
					const memories = await collectMemories(
						clone,
						wasWorking ? "dispelled by the lead mid-work" : "dispelled by the lead",
						false,
					);
					return truncateCloneReport(
						`@${clone.name} dispelled${wasWorking ? " (work aborted)" : ""}. Memories returned:\n${memories}`,
						perTargetBudget,
					);
				}),
			);
			return { content: [{ type: "text", text: reports.join(separator) }], details: undefined };
		},
		renderCall(args, theme) {
			const name = args.name ? ` @${normalizeCloneName(args.name)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("shadowclone_dispel")) + theme.fg("accent", name), 0, 0);
		},
	});

	pi.registerTool<typeof PauseParamsSchema, undefined>({
		name: "shadowclone_pause",
		label: "Shadow Clones: Pause",
		description:
			'Temporarily pause a shadow clone by name (or "all"). In-flight work is aborted, but the session and its context stay fully intact and cost nothing while paused. Resume with shadowclone_send (new instructions or just "resume"), or with shadowclone_account to switch its auth account and continue.',
		promptSnippet: "Temporarily pause a shadow clone (or all); resume later with shadowclone_send.",
		parameters: PauseParamsSchema,
		async execute(_toolCallId, params: PauseParams) {
			const raw = normalizeCloneName(params.name);
			const targets = raw === "all" ? [...clones.values()] : [lookupClone(raw)];
			if (targets.length === 0) {
				return { content: [{ type: "text", text: "No live shadow clones to pause." }], details: undefined };
			}
			const lines = targets.map((clone) => {
				const result = requestClonePause(clone, "lead");
				return result === "noop"
					? `@${clone.name}: nothing to pause (${clone.status}).`
					: `@${clone.name}: paused (session intact). Resume via shadowclone_send.`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
		renderCall(args, theme) {
			const name = args.name ? ` @${normalizeCloneName(args.name)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("shadowclone_pause")) + theme.fg("accent", name), 0, 0);
		},
	});

	pi.registerTool<typeof AccountParamsSchema, undefined>({
		name: "shadowclone_account",
		label: "Shadow Clones: Switch Account",
		description:
			"Switch a live shadow clone to another saved /acc auth profile — per clone: the lead and sibling clones keep their own accounts. Takes effect on the clone's next request; a clone paused by a rate limit or failure resumes automatically. Use this after a rate-limit auto-pause to continue the work on another account.",
		promptSnippet: "Switch a shadow clone to another saved /acc auth account (per-clone; auto-resumes paused clones).",
		parameters: AccountParamsSchema,
		async execute(_toolCallId, params: AccountParams) {
			const clone = lookupClone(params.name);
			const provider = clone.model?.provider;
			if (!provider) throw new Error(`@${clone.name} has no resolved model, so there is no provider to switch the account for.`);
			await pinCloneAccount(clone.cloneAuth, provider, params.account);
			clone.account = resolveAccountLabel(clone.cloneAuth, provider) ?? params.account;
			log(clone, "status", `status: account switched to ${clone.account} (${provider})`);
			widgetEmitter.flush();
			if (!clone.session.isStreaming && (clone.status === "paused" || clone.status === "failed")) {
				runInstruction(clone, RESUME_AFTER_PAUSE_PROMPT);
				return {
					content: [{ type: "text", text: `@${clone.name} switched to acc ${clone.account} and resumed its task.` }],
					details: undefined,
				};
			}
			return {
				content: [
					{ type: "text", text: `@${clone.name} switched to acc ${clone.account}; it applies from the clone's next request.` },
				],
				details: undefined,
			};
		},
		renderCall(args, theme) {
			const name = args.name ? ` @${normalizeCloneName(args.name)}` : "";
			const account = args.account ? theme.fg("dim", ` → acc ${args.account}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("shadowclone_account")) + theme.fg("accent", name) + account, 0, 0);
		},
	});

	pi.registerMessageRenderer(SHADOWCLONE_REPORT_TYPE, (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const newline = content.indexOf("\n");
		const header = newline === -1 ? content : content.slice(0, newline);
		const body = newline === -1 ? "" : content.slice(newline + 1).trim();
		let text = theme.fg("customMessageLabel", theme.bold(`⊛ ${header.replace(/:$/, "")}`));
		if (body) {
			if (options.expanded) {
				text += `\n${theme.fg("customMessageText", body)}`;
			} else {
				const preview = body
					.split("\n")
					.filter((line) => line.trim())
					.slice(0, 2)
					.map((line) => theme.fg("dim", `  ${truncateSingleLine(line, 100)}`));
				text += `\n${preview.join("\n")}`;
				text += `\n${theme.fg("dim", "  … expand tool output for the full report")}`;
			}
		}
		return new Text(text, 0, 0);
	});

	const openDashboard = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (clones.size === 0 && listWorkerRuns().length === 0) {
			ctx.ui.notify("No live agents (clones or workers).", "info");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify([...clones.values()].map(formatCloneStatus).join("\n"), "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const dashboard = new CloneDashboard({
					theme,
					getClones: () => [...clones.values()],
					getWorkerRuns: () => listWorkerRuns(),
					getHeight: () => tui.terminal.rows,
					send: (clone, message) => {
						void sendToClone(clone, message, "user");
					},
					abort: (clone) => {
						if (clone.session.isStreaming) {
							log(clone, "status", "── aborted by user (dashboard)");
							clone.session.abortCompaction();
							void clone.session.abort();
						}
					},
					pause: (clone) => {
						if (clone.status === "paused" || clone.status === "failed") {
							// Resume: goes through the normal user-send path so the lead sees it.
							void sendToClone(clone, RESUME_AFTER_PAUSE_PROMPT, "user");
							return;
						}
						if (requestClonePause(clone, "user") === "noop") return;
						// Quiet nextTurn note (no fresh lead turn): the lead must know this clone
						// will stay silent until resumed, without burning tokens on the pause itself.
						pi.sendMessage(
							{
								customType: SHADOWCLONE_REPORT_TYPE,
								content: `Shadow clone @${clone.name} was paused by the user via the dashboard. Its session stays intact; it reports nothing until resumed (shadowclone_send, shadowclone_account, or dashboard p).`,
								display: true,
								details: { name: clone.name, kind: "user-pause" },
							},
							{ deliverAs: "nextTurn" },
						);
					},
					dispel: async (clone) => {
						await dispelClone(clone);
						void collectMemories(clone, "dispelled by the user via the shadow clone dashboard", false).then(
							(memories) => {
								pi.sendMessage(
									{
										customType: SHADOWCLONE_REPORT_TYPE,
										content: truncateCloneReport(
											`Shadow clone @${clone.name} dispelled by the user via the dashboard. Any in-progress work was aborted.\n\nMemories returned:\n${memories}`,
										),
										display: true,
										details: { name: clone.name, kind: "user-dispel" },
									},
									{ deliverAs: "nextTurn" },
								);
							},
						);
					},
					dispelWorker: (run, agentIndex) => dispelWorkerRun(run.id, agentIndex),
					done: () => done(undefined),
					requestRender: () => tui.requestRender(),
					getSpinnerGlyph: spinnerGlyph,
				});
				dashboardRefresh = () => tui.requestRender();
				updateSpinnerTimer(); // switch to the smooth in-dashboard spinner cadence
				return dashboard;
			},
			// altScreen: the dashboard owns the terminal's alternate buffer, so the chat
			// (scrollback, inline images) can neither be scrolled into view nor bleed
			// through it; the main screen is restored exactly on close.
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", altScreen: true } },
		);
		dashboardRefresh = undefined;
		updateSpinnerTimer(); // back to the calm background cadence now the dashboard is closed
	};

	pi.registerCommand("shadowclones", {
		description: "Open the agents dashboard (steer/dispel clones, cancel/dismiss workers, watch)",
		handler: async (_args, ctx) => openDashboard(ctx),
	});

	pi.registerCommand("shadowclone-pop", {
		description: "Debug: crash a working clone to test the failure-pause path (e.g. /shadowclone-pop itachi)",
		handler: async (args, ctx) => {
			const name = normalizeCloneName(args);
			const clone = clones.get(name);
			if (!clone) {
				if (ctx.hasUI) ctx.ui.notify(`No live clone @${name || "?"}.`, "warning");
				return;
			}
			if (!clone.session.isStreaming) {
				if (ctx.hasUI) ctx.ui.notify(`@${name} is idle; pop only works mid-work.`, "warning");
				return;
			}
			log(clone, "status", "── simulated crash (/shadowclone-pop)");
			clone.session.abortCompaction();
			void clone.session.abort();
		},
	});

	pi.registerShortcut("alt+k", {
		description: "Open the shadow clone dashboard",
		handler: async (ctx) => openDashboard(ctx),
	});

	// Bottom agents tray: keyboard launch for the dashboard without leaving the editor.
	const liveAgentCount = () => clones.size + listWorkerRuns().length;
	const exitTray = () => {
		if (!trayFocused) return;
		trayFocused = false;
		trayInputUnsub?.();
		trayInputUnsub = undefined;
		renderWidget();
	};
	const enterTray = (ctx: ExtensionContext) => {
		if (trayFocused || liveAgentCount() === 0 || !ctx.hasUI) return;
		trayFocused = true;
		// Capture keys only while the tray holds focus. It is only entered from an empty,
		// focused editor, so this temporary listener never competes with normal editing or
		// another overlay's own navigation.
		trayInputUnsub = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				exitTray();
				void openDashboard(ctx);
				return { consume: true };
			}
			if (matchesKey(data, Key.up) || matchesKey(data, Key.escape)) {
				exitTray();
				return { consume: true };
			}
			// Any other key hands focus back to the editor and is processed normally.
			exitTray();
			return undefined;
		});
		renderWidget();
	};
	// Down from an empty chat editor focuses the tray (the editor only routes Down here
	// when there is no text to navigate); a second Down or Enter opens the dashboard. No-op
	// with no live agents so an empty-editor Down keeps its normal behavior.
	pi.registerShortcut("down", {
		description: "Focus the agents tray; press again (or Enter) to open the dashboard",
		// Down is a built-in editor key, but the editor only routes it here from an empty
		// editor, so this override is deliberate; opt out of the startup conflict diagnostic.
		allowBuiltinOverride: true,
		handler: async (ctx) => {
			if (liveAgentCount() === 0) return;
			if (trayFocused) {
				exitTray();
				await openDashboard(ctx);
			} else {
				enterTray(ctx);
			}
		},
	});

	pi.on("agent_end", async () => {
		// The lead just finished a run. Flush any buffered clone reports as one consolidated
		// followUp; _handlePostAgentRun sees the queued message and runs a single continuation
		// turn, instead of the reports trickling out one lead turn at a time.
		flushBufferedReports();
	});
	pi.on("agent_settled", async () => {
		// A report can land after the final agent_end while retry/compaction cleanup is
		// still active. Flush again at the true idle boundary so it cannot remain stuck
		// until an unrelated future user prompt.
		flushBufferedReports();
	});

	// Guard for the lead's own bash tool: leading `sleep N` is sleep-polling, the exact
	// pattern blocking waits exist to replace. Behavioral rules about tools belong in the
	// tool, not in per-project instructions.
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const match = /^\s*sleep\s+(\d+(?:\.\d+)?)\b/.exec(event.input.command ?? "");
		if (!match || Number(match[1]) < SLEEP_GUARD_MIN_S) return;
		return {
			block: true,
			reason: `Blocked: leading "sleep ${match[1]}" is sleep-polling. To wait: end your turn (clone/subagent reports arrive as messages and wake you), use \`agent-browser wait\` for pages, or a blocking check (tmux wait-for, until-loop on the dependent command). Short delays (<${SLEEP_GUARD_MIN_S}s) inside a compound command are allowed.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		isLeadIdle = () => ctx.isIdle();
		widgetEmitter.flush();
		// Re-seed used names from session history: after a restart + resume the in-memory
		// set is empty, and recycling a name that appears earlier in the transcript makes
		// old reports attributable to the wrong clone.
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				const message = entry.message as {
					role?: string;
					customType?: string;
					details?: { name?: unknown; names?: unknown };
				};
				if (message.role !== "custom" || message.customType !== SHADOWCLONE_REPORT_TYPE) continue;
				if (typeof message.details?.name === "string") usedNames.add(message.details.name);
				if (Array.isArray(message.details?.names)) {
					for (const name of message.details.names) if (typeof name === "string") usedNames.add(name);
				}
			}
		} catch {
			// Best-effort: worst case a name recycles, as before.
		}
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["@"],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = beforeCursor.match(/(?:^|\s)@([a-z0-9-]*)$/i);
				if (match && clones.size > 0) {
					const prefix = (match[1] ?? "").toLowerCase();
					const items = [...clones.values()]
						.filter((clone) => clone.name.startsWith(prefix))
						.map((clone) => ({
							value: `@${clone.name}`,
							label: `@${clone.name}`,
							description: `${clone.status} — ${truncateSingleLine(clone.task, 60)}`,
						}));
					if (items.length > 0) return { prefix: `@${match[1] ?? ""}`, items };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});

	pi.on("session_shutdown", async () => {
		unsubscribeWorkerRuns();
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		trayFocused = false;
		trayInputUnsub?.();
		trayInputUnsub = undefined;
		for (const clone of [...clones.values()]) {
			try {
				await dispelClone(clone);
			} catch {
				// Best-effort cleanup on shutdown.
			}
		}
		clearWorkerRuns();
		ui?.setWidget("shadowclones", undefined);
	});
}
