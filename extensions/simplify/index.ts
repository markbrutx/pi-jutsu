import { statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	truncateHead,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExecResult,
	type Theme,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const SIMPLIFY_COMMAND_DESCRIPTION =
	"Review changed code for reuse, quality, and efficiency, then fix any issues found.";

const REVIEW_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;
const MAX_RECENT_FILES = 20;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_DIFF_BYTES = 120 * 1024;
const MAX_SINGLE_UNTRACKED_DIFF_BYTES = 40 * 1024;
const UNTRACKED_DIFF_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 3;
const PROGRESS_EMIT_THROTTLE_MS = 100;

export const SUBAGENT_SYSTEM_PROMPT = `You are a focused /simplify review subagent.

Do not modify files. Use tools only to inspect code and verify findings.
Return concise, actionable findings with file paths and suggested fixes. If there are no actionable issues, return "No findings."`;

const SimplifyReviewParamsSchema = Type.Object({
	focus: Type.Optional(Type.String({ description: "Optional extra focus for the simplify review." })),
});

type SimplifyReviewParams = Static<typeof SimplifyReviewParamsSchema>;

export type ReviewAgentId = "reuse" | "quality" | "efficiency";
export type ReviewStatus = "pending" | "running" | "done" | "failed";
export type SimplifyReviewPhase = "identifying_changes" | "reviewing" | "done" | "failed";

export interface ReviewAgentSpec {
	id: ReviewAgentId;
	title: string;
	instruction: string;
}

export type ChangeContext =
	| {
			kind: "diff";
			diffCommand: string;
			diff: string;
	  }
	| {
			kind: "fallback";
			diffCommand: string;
			recentFiles: string[];
			diffError?: string;
	  };

export type SimplifyDisplayItem =
	| { type: "thinking"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

export type SimplifyReviewContextSummary =
	| { kind: "diff"; diffCommand: string; diffLines: number }
	| { kind: "fallback"; diffCommand: string; recentFiles: string[]; diffError?: string };

export interface ReviewAgentProgress {
	id: ReviewAgentId;
	title: string;
	status: ReviewStatus;
	lastActivity: string;
	output: string;
	stderr: string;
	items: SimplifyDisplayItem[];
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
}

export interface SimplifyReviewDetails {
	phase: SimplifyReviewPhase;
	focus: string;
	context?: SimplifyReviewContextSummary;
	agents: ReviewAgentProgress[];
	startedAt: number;
	updatedAt: number;
}

export interface ReviewAgentResult {
	spec: ReviewAgentSpec;
	exitCode: number;
	output: string;
	stderr: string;
	items: SimplifyDisplayItem[];
	stopReason?: string;
	errorMessage?: string;
}

export interface BuildFixPromptOptions {
	context: ChangeContext;
	focus: string;
	results: readonly ReviewAgentResult[];
}

export interface UntrackedFileDiff {
	path: string;
	diff: string;
	truncation?: UntrackedFileDiffTruncation;
}

export interface UntrackedFileDiffTruncation {
	outputLines: number;
	totalLines: number;
	outputBytes: number;
	totalBytes: number;
	maxBytes: number;
	maxLines: number;
}

export const REVIEW_AGENT_SPECS: readonly ReviewAgentSpec[] = [
	{
		id: "reuse",
		title: "Code Reuse Review",
		instruction: `For each change:

1. Search for existing utilities and helpers that could replace newly written code. Look for similar patterns elsewhere in the codebase, especially utility directories, shared modules, and files adjacent to the changed files.
2. Flag any new function that duplicates existing functionality. Suggest the existing function to use instead.
3. Flag inline logic that could use an existing utility, including hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns.`,
	},
	{
		id: "quality",
		title: "Code Quality Review",
		instruction: `Review the same changes for hacky patterns:

1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones.
3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction.
4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries.
5. Stringly-typed code: raw strings where constants, string unions, branded types, or existing enums already exist.
6. Unnecessary UI nesting: wrappers/elements that add no layout value when inner component props already provide the behavior.
7. Unnecessary comments: comments explaining WHAT the code does, narrating the change, or referencing the task/caller. Keep only non-obvious WHY.`,
	},
	{
		id: "efficiency",
		title: "Efficiency Review",
		instruction: `Review the same changes for efficiency:

1. Unnecessary work: redundant computations, repeated file reads, duplicate network/API calls, or N+1 patterns.
2. Missed concurrency: independent operations run sequentially when they could run in parallel.
3. Hot-path bloat: new blocking work added to startup, per-request, or per-render hot paths.
4. Recurring no-op updates: unconditional state/store updates inside polling loops, intervals, or event handlers. Add change-detection guards when needed.
5. Unnecessary existence checks: pre-checking file/resource existence before operating when direct operation plus error handling is safer.
6. Memory: unbounded data structures, missing cleanup, or event listener leaks.
7. Overly broad operations: reading whole files when only a portion is needed, or loading all items when filtering for one.`,
	},
];

interface RawUntrackedFileDiff {
	path: string;
	rawDiff: string;
}

interface RunReviewAgentOptions {
	ctx: ExtensionContext;
	spec: ReviewAgentSpec;
	task: string;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	signal: AbortSignal | undefined;
	onProgress: ReviewProgressCallback;
}

interface ThrottledEmitter {
	schedule(): void;
	flush(): void;
}

type ReviewProgressPatch = Partial<Omit<ReviewAgentProgress, "id" | "title">>;
type ReviewProgressCallback = (patch: ReviewProgressPatch) => void;

export function getDiffArgs(hasStagedChanges: boolean): string[] {
	return hasStagedChanges ? ["diff", "HEAD"] : ["diff"];
}

export function buildSimplifyCommandPrompt(focus: string): string {
	const focusText = focus.trim();
	const focusSection = focusText ? `\n\n## Additional Focus\n\n${focusText}` : "";

	return `# Simplify: Code Review and Cleanup

Call the \`simplify_review\` tool exactly once${focusText ? " with the additional focus below" : ""}. Wait for it to finish. Then fix concrete findings directly in the working tree.

Do not run separate review agents manually; the tool handles Phase 1 and Phase 2 and streams the three subagents in the UI.

After the tool returns:
- fix actionable findings directly;
- skip false positives or not-worth-changing findings and note why;
- if the tool reports no findings, do not edit files unless you independently identify a clear issue;
- keep the final summary concise.${focusSection}`;
}

export function appendUntrackedDiffs(baseDiff: string, untrackedDiffs: readonly UntrackedFileDiff[]): string {
	const included = untrackedDiffs.filter((entry) => entry.diff.trim().length > 0);
	if (included.length === 0) return baseDiff;

	const sections = included.map((entry) => {
		const truncated = entry.truncation ? `\n${formatUntrackedTruncation(entry.truncation)}` : "";
		return `## Untracked: ${entry.path}\n\n${entry.diff.trim()}${truncated}`;
	});
	const prefix = baseDiff.trim().length > 0 ? `${baseDiff.trim()}\n\n` : "";
	return `${prefix}# Untracked files included in this review\n\n${sections.join("\n\n")}`;
}

export function buildChangeContext(
	diff: string,
	diffCommand: string,
	recentFiles: readonly string[],
	diffError?: string,
): ChangeContext {
	if (diff.trim().length > 0) {
		return { kind: "diff", diffCommand, diff };
	}

	return {
		kind: "fallback",
		diffCommand,
		recentFiles: uniqueStrings(recentFiles).slice(0, MAX_RECENT_FILES),
		diffError: diffError?.trim() ? diffError.trim() : undefined,
	};
}

export function buildReviewTask(spec: ReviewAgentSpec, context: ChangeContext, focus: string): string {
	const focusText = focus.trim();
	const focusSection = focusText ? `\n\n## Additional Focus\n\n${focusText}` : "";

	return `# Simplify Review: ${spec.title}

You are one of three isolated review agents for /simplify. Review the complete change set below for your assigned concern and return concise findings only.

Do not modify files. Use tools only to inspect existing code when needed. For each finding, include:
- the affected file/path;
- the issue;
- why it matters;
- a concrete suggested fix.

If there are no actionable issues, return exactly: No findings.

${buildChangeSection(context)}

## Review Instructions

${spec.instruction}${focusSection}`;
}

export function buildFixPrompt(options: BuildFixPromptOptions): string {
	const focusText = options.focus.trim();
	const focusSection = focusText ? `\n\n## Additional Focus\n\n${focusText}` : "";
	const findings = options.results.map(formatReviewResult).join("\n\n");

	return `# Simplify: Fix Review Findings

The /simplify review phase completed. Aggregate the findings below and fix each concrete issue directly in the working tree.

${buildChangeSection(options.context)}${focusSection}

## Aggregated Findings

${findings || "No review findings were returned."}

## Phase 3: Fix Issues

- Read files as needed, then apply direct edits for actionable findings.
- If a finding is a false positive or not worth changing, skip it and note why in the final summary.
- If all reviews say "No findings" and you do not identify a clear issue, do not edit files; briefly confirm the code is already clean.
- Keep the final response concise: summarize what was fixed, or confirm no changes were needed.`;
}

export function createReviewDetails(context: ChangeContext | undefined, focus: string): SimplifyReviewDetails {
	const now = Date.now();
	return {
		phase: context ? "reviewing" : "identifying_changes",
		focus: focus.trim(),
		context: context ? summarizeChangeContext(context) : undefined,
		agents: REVIEW_AGENT_SPECS.map((spec) => ({
			id: spec.id,
			title: spec.title,
			status: "pending",
			lastActivity: "waiting",
			output: "",
			stderr: "",
			items: [],
		})),
		startedAt: now,
		updatedAt: now,
	};
}

export function summarizeReviewDetails(details: SimplifyReviewDetails): string {
	const lines = [`simplify_review: ${formatPhase(details.phase)}`];
	if (details.context) {
		lines.push(formatContextSummary(details.context));
	}
	for (const agent of details.agents) {
		const activity = agent.lastActivity ? ` - ${agent.lastActivity}` : "";
		lines.push(`[${formatStatus(agent.status)}] ${agent.title}${activity}`);
	}
	return lines.join("\n");
}

export function extractRecentFileCandidates(entries: readonly unknown[], cwd: string): string[] {
	const candidates: string[] = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "message") continue;
		collectFileCandidatesFromMessage(entry.message, candidates);
		if (candidates.length >= MAX_RECENT_FILES * 3) break;
	}

	const normalized = candidates
		.map((candidate) => normalizeCandidatePath(candidate, cwd))
		.filter((candidate): candidate is string => candidate !== undefined);

	return uniqueStrings(normalized).slice(0, MAX_RECENT_FILES);
}

async function loadChangeContext(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<ChangeContext> {
	const stagedResult = await pi.exec("git", ["diff", "--cached", "--quiet", "--exit-code"], {
		cwd: ctx.cwd,
		timeout: 5000,
		signal,
	});
	const hasStagedChanges = stagedResult.code === 1;
	const diffArgs = getDiffArgs(hasStagedChanges);
	const diffCommand = `git ${diffArgs.join(" ")}`;
	const [diffResult, untrackedDiffs] = await Promise.all([
		pi.exec("git", diffArgs, { cwd: ctx.cwd, timeout: 30000, signal }),
		loadUntrackedDiffs(pi, ctx.cwd, signal),
	]);
	const combinedDiff = appendUntrackedDiffs(diffResult.stdout, untrackedDiffs);
	const effectiveDiffCommand = untrackedDiffs.length > 0 ? `${diffCommand} + untracked files` : diffCommand;
	const recentFiles = combinedDiff.trim().length === 0 ? extractRecentFileCandidates(ctx.sessionManager.getBranch(), ctx.cwd) : [];
	const diffError = [
		formatExecError(stagedResult, "git diff --cached --quiet --exit-code"),
		formatExecError(diffResult, diffCommand),
	]
		.filter((message): message is string => message !== undefined)
		.join("\n\n");

	return buildChangeContext(combinedDiff, effectiveDiffCommand, recentFiles, diffError);
}

async function loadUntrackedDiffs(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<UntrackedFileDiff[]> {
	const result = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], {
		cwd,
		timeout: 5000,
		signal,
	});
	if (result.code !== 0) return [];

	const files = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, MAX_UNTRACKED_FILES);

	const rawDiffs = await loadRawUntrackedDiffs(pi, cwd, files, signal);
	const diffs: UntrackedFileDiff[] = [];
	let remainingBytes = MAX_UNTRACKED_DIFF_BYTES;
	for (const entry of rawDiffs) {
		if (remainingBytes <= 0) break;
		const maxBytes = Math.min(MAX_SINGLE_UNTRACKED_DIFF_BYTES, remainingBytes);
		const truncation = truncateHead(entry.rawDiff, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes });
		if (!truncation.content.trim()) continue;
		diffs.push({
			path: entry.path,
			diff: truncation.content,
			truncation: truncation.truncated ? toUntrackedTruncation(truncation) : undefined,
		});
		remainingBytes -= truncation.outputBytes;
	}
	return diffs;
}

async function loadRawUntrackedDiffs(
	pi: ExtensionAPI,
	cwd: string,
	files: readonly string[],
	signal: AbortSignal | undefined,
): Promise<RawUntrackedFileDiff[]> {
	const results: Array<RawUntrackedFileDiff | undefined> = new Array(files.length);
	let nextIndex = 0;
	const workerCount = Math.min(UNTRACKED_DIFF_CONCURRENCY, files.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < files.length) {
			const index = nextIndex;
			nextIndex += 1;
			const file = files[index];
			if (!file) continue;
			const diffResult = await pi.exec("git", ["diff", "--no-index", "--", "/dev/null", file], {
				cwd,
				timeout: 10000,
				signal,
			});
			const rawDiff = diffResult.stdout.trim() || diffResult.stderr.trim();
			if (rawDiff) results[index] = { path: file, rawDiff };
		}
	});
	await Promise.all(workers);
	return results.filter((entry): entry is RawUntrackedFileDiff => entry !== undefined);
}

function toUntrackedTruncation(truncation: TruncationResult): UntrackedFileDiffTruncation {
	return {
		outputLines: truncation.outputLines,
		totalLines: truncation.totalLines,
		outputBytes: truncation.outputBytes,
		totalBytes: truncation.totalBytes,
		maxBytes: truncation.maxBytes,
		maxLines: truncation.maxLines,
	};
}

function formatUntrackedTruncation(truncation: UntrackedFileDiffTruncation): string {
	return `[Diff truncated for this untracked file. Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}).]`;
}

function formatExecError(result: ExecResult, command: string): string | undefined {
	if (result.code === 0 || result.code === 1) return undefined;
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const details = stderr || stdout || `exit code ${result.code}`;
	return `${command}: ${details}`;
}

function buildChangeSection(context: ChangeContext): string {
	if (context.kind === "diff") {
		return `## Change Set

Phase 1 identified changes with \`${context.diffCommand}\`. The full diff is below.

<diff command="${escapeAttribute(context.diffCommand)}">
${context.diff.trim()}
</diff>`;
	}

	const files = context.recentFiles.length > 0 ? context.recentFiles.map((file) => `- ${file}`).join("\n") : "- No recent file candidates could be extracted automatically.";
	const errorSection = context.diffError ? `\n\nGit diff diagnostics:\n\n\`\`\`\n${context.diffError}\n\`\`\`` : "";

	return `## Change Set

No git diff was available from \`${context.diffCommand}\`. Fallback: review the most recently modified files mentioned or edited in the conversation.

Recent file candidates extracted from this session:
${files}${errorSection}`;
}

function formatReviewResult(result: ReviewAgentResult): string {
	const diagnostics: string[] = [];
	if (result.exitCode !== 0) diagnostics.push(`Subagent exited with code ${result.exitCode}.`);
	if (result.stopReason) diagnostics.push(`Stop reason: ${result.stopReason}.`);
	if (result.errorMessage) diagnostics.push(`Error: ${result.errorMessage}`);
	if (result.stderr.trim()) diagnostics.push(`stderr:\n\`\`\`\n${result.stderr.trim()}\n\`\`\``);

	const diagnosticsText = diagnostics.length > 0 ? `${diagnostics.join("\n\n")}\n\n` : "";
	const output = result.output.trim() || "No findings.";
	return `### ${result.spec.title}\n\n${diagnosticsText}${output}`;
}

async function runReviewAgent(options: RunReviewAgentOptions): Promise<ReviewAgentResult> {
	const { ctx, spec, task, thinkingLevel, signal, onProgress } = options;
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let lastAssistantText = "";
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = signal?.aborted ?? false;
	const items: SimplifyDisplayItem[] = [];

	const publish = (patch: ReviewProgressPatch) => {
		onProgress({
			status: "running",
			output: lastAssistantText,
			stderr,
			stopReason,
			errorMessage,
			...patch,
			items: [...items],
		});
	};

	const abort = () => {
		wasAborted = true;
		publish({ lastActivity: "aborting" });
		void session?.abort();
	};

	if (wasAborted) {
		return {
			spec,
			exitCode: 1,
			output: "",
			stderr: "",
			items: [],
			stopReason: "aborted",
		};
	}

	try {
		signal?.addEventListener("abort", abort, { once: true });
		publish({ lastActivity: "starting" });

		const agentDir = getAgentDir();
		const resourceLoader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir,
			appendSystemPrompt: [SUBAGENT_SYSTEM_PROMPT],
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		if (wasAborted) {
			return {
				spec,
				exitCode: 1,
				output: lastAssistantText,
				stderr,
				items: [...items],
				stopReason: "aborted",
				errorMessage,
			};
		}

		const created = await createAgentSession({
			cwd: ctx.cwd,
			agentDir,
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			thinkingLevel,
			tools: [...REVIEW_TOOL_NAMES],
			resourceLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		session = created.session;
		if (wasAborted) {
			return {
				spec,
				exitCode: 1,
				output: lastAssistantText,
				stderr,
				items: [...items],
				stopReason: "aborted",
				errorMessage,
			};
		}

		unsubscribe = session.subscribe((event) => {
			const update = getReviewEventUpdate(event, items);
			if (!update) return;
			if (update.output !== undefined) lastAssistantText = update.output;
			if (update.stopReason !== undefined) stopReason = update.stopReason;
			if (update.errorMessage !== undefined) errorMessage = update.errorMessage;
			publish({ lastActivity: update.lastActivity ?? "working" });
		});

		await session.prompt(task, { expandPromptTemplates: false, source: "extension" });
		const failed = wasAborted || stopReason === "error" || stopReason === "aborted";
		return {
			spec,
			exitCode: failed ? 1 : 0,
			output: lastAssistantText,
			stderr,
			items: [...items],
			stopReason: wasAborted ? "aborted" : stopReason,
			errorMessage,
		};
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
		return {
			spec,
			exitCode: 1,
			output: lastAssistantText,
			stderr,
			items: [...items],
			stopReason: wasAborted ? "aborted" : "error",
			errorMessage,
		};
	} finally {
		signal?.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
	}
}

interface ReviewEventUpdate {
	output?: string;
	stopReason?: string;
	errorMessage?: string;
	lastActivity?: string;
}

function getReviewEventUpdate(
	event: AgentSessionEvent,
	items: SimplifyDisplayItem[],
): ReviewEventUpdate | undefined {
	switch (event.type) {
		case "agent_start":
			return { lastActivity: "started" };
		case "agent_end":
			return { lastActivity: "completed" };
		case "message_update":
			if (event.message.role !== "assistant") return undefined;
			return getAssistantReviewUpdate(event.message);
		case "message_end":
			if (event.message.role !== "assistant") return undefined;
			return getFinalAssistantReviewUpdate(event.message, items);
		case "tool_execution_start": {
			const args = isRecord(event.args) ? event.args : {};
			items.push({ type: "tool", name: event.toolName, args });
			return { lastActivity: formatToolActivity(event.toolName, args) };
		}
		case "tool_execution_update":
			return { lastActivity: `${event.toolName} running` };
		case "tool_execution_end":
			return { lastActivity: `${event.toolName} finished` };
		default:
			return undefined;
	}
}

function getAssistantReviewUpdate(message: unknown): ReviewEventUpdate {
	const text = extractAssistantText(message);
	const thinking = extractAssistantThinking(message);
	return {
		output: text,
		lastActivity: formatAssistantActivity(text, thinking),
	};
}

function getFinalAssistantReviewUpdate(message: unknown, items: SimplifyDisplayItem[]): ReviewEventUpdate {
	const text = extractAssistantText(message);
	const thinking = extractAssistantThinking(message);
	if (thinking) items.push({ type: "thinking", text: thinking });
	return {
		output: text,
		stopReason: getStringProperty(message, "stopReason"),
		errorMessage: getStringProperty(message, "errorMessage"),
		lastActivity: formatAssistantActivity(text, thinking),
	};
}

function extractAssistantText(message: unknown): string {
	return extractAssistantContent(message, "text", "text");
}

function extractAssistantThinking(message: unknown): string {
	return extractAssistantContent(message, "thinking", "thinking");
}

function extractAssistantContent(message: unknown, type: string, field: string): string {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (isRecord(part) && part.type === type) {
			const value = part[field];
			if (typeof value === "string") parts.push(value);
		}
	}
	return parts.join("\n").trim();
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const property = value[key];
	return typeof property === "string" ? property : undefined;
}

function formatAssistantActivity(text: string, thinking: string): string {
	if (thinking) return `thinking: ${truncateSingleLine(thinking, 80)}`;
	if (text) return `writing findings: ${truncateSingleLine(text, 80)}`;
	return "working";
}

function summarizeChangeContext(context: ChangeContext): SimplifyReviewContextSummary {
	if (context.kind === "diff") {
		return {
			kind: "diff",
			diffCommand: context.diffCommand,
			diffLines: context.diff.trim() ? context.diff.trim().split("\n").length : 0,
		};
	}

	return {
		kind: "fallback",
		diffCommand: context.diffCommand,
		recentFiles: [...context.recentFiles],
		diffError: context.diffError,
	};
}

function cloneReviewDetails(details: SimplifyReviewDetails): SimplifyReviewDetails {
	return {
		...details,
		context: details.context ? cloneContextSummary(details.context) : undefined,
		agents: details.agents.map((agent) => ({
			...agent,
			items: agent.items.map(cloneDisplayItem),
		})),
	};
}

function cloneContextSummary(context: SimplifyReviewContextSummary): SimplifyReviewContextSummary {
	if (context.kind === "diff") return { ...context };
	return { ...context, recentFiles: [...context.recentFiles] };
}

function cloneDisplayItem(item: SimplifyDisplayItem): SimplifyDisplayItem {
	if (item.type === "tool") return { ...item, args: { ...item.args } };
	return { ...item };
}

function updateAgent(details: SimplifyReviewDetails, id: ReviewAgentId, patch: ReviewProgressPatch): void {
	const agent = details.agents.find((candidate) => candidate.id === id);
	if (!agent) return;
	Object.assign(agent, patch);
	details.updatedAt = Date.now();
}

function createThrottledEmitter(callback: () => void, intervalMs: number): ThrottledEmitter {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let lastEmitAt = 0;

	const emitNow = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		lastEmitAt = Date.now();
		callback();
	};

	return {
		schedule() {
			const now = Date.now();
			const waitMs = Math.max(0, intervalMs - (now - lastEmitAt));
			if (waitMs === 0) {
				emitNow();
				return;
			}
			if (!timeout) timeout = setTimeout(emitNow, waitMs);
		},
		flush: emitNow,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function collectFileCandidatesFromMessage(message: unknown, candidates: string[]): void {
	if (!isRecord(message)) return;

	if (typeof message.content === "string") {
		collectFileCandidatesFromText(message.content, candidates);
	} else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
				collectFileCandidatesFromText(part.text, candidates);
			}
			if (isRecord(part) && part.type === "toolCall") {
				collectFileCandidatesFromToolCall(part, candidates);
			}
		}
	}

	if (message.role === "toolResult") {
		for (const key of ["toolName", "content"] as const) {
			const value = message[key];
			if (typeof value === "string") collectFileCandidatesFromText(value, candidates);
		}
	}
}

function collectFileCandidatesFromToolCall(toolCall: Record<string, unknown>, candidates: string[]): void {
	const args = toolCall.arguments;
	if (!isRecord(args)) return;

	for (const key of ["path", "file_path", "filePath"] as const) {
		const value = args[key];
		if (typeof value === "string") candidates.push(value);
	}

	const command = args.command;
	if (typeof command === "string") collectFileCandidatesFromText(command, candidates);
}

function collectFileCandidatesFromText(text: string, candidates: string[]): void {
	const pathPattern = /(?:^|[\s("'`])(@?(?:(?:\.{1,2}|~)?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9][A-Za-z0-9_-]*(?::\d+(?::\d+)?)?)/g;
	let match = pathPattern.exec(text);
	while (match) {
		const candidate = match[1];
		if (candidate) candidates.push(candidate);
		match = pathPattern.exec(text);
	}
}

function normalizeCandidatePath(candidate: string, cwd: string): string | undefined {
	let value = candidate.trim().replace(/[),.;\]}'"]+$/g, "");
	value = value.replace(/:\d+(?::\d+)?$/g, "");
	if (!value || value.includes("://") || value.startsWith("node:")) return undefined;

	const expanded = value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
	const absolute = path.resolve(cwd, expanded);
	try {
		if (!statSync(absolute).isFile()) return undefined;
	} catch {
		return undefined;
	}

	const relative = path.relative(cwd, absolute);
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || path.basename(absolute);
	return absolute;
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function queueInstructionMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	pi.sendMessage(
		{
			customType: "simplify-command",
			content: prompt,
			display: false,
		},
		{ triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" },
	);
}

function formatPhase(phase: SimplifyReviewPhase): string {
	switch (phase) {
		case "identifying_changes":
			return "identifying changes";
		case "reviewing":
			return "reviewing";
		case "done":
			return "done";
		case "failed":
			return "failed";
	}
}

function formatStatus(status: ReviewStatus): string {
	switch (status) {
		case "pending":
			return "WAIT";
		case "running":
			return "RUN";
		case "done":
			return "OK";
		case "failed":
			return "ERR";
	}
}

function formatContextSummary(context: SimplifyReviewContextSummary): string {
	if (context.kind === "diff") return `change set: ${context.diffCommand}, ${context.diffLines} diff lines`;
	const files = context.recentFiles.length > 0 ? `${context.recentFiles.length} recent files` : "no recent files detected";
	return `change set: no diff from ${context.diffCommand}, fallback to ${files}`;
}

function formatToolActivity(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash") {
		const command = getStringArg(args, "command") ?? "command";
		return `$ ${truncateSingleLine(command, 80)}`;
	}
	if (toolName === "read") {
		return `read ${getPathArg(args) ?? "file"}`;
	}
	if (toolName === "grep") {
		const pattern = getStringArg(args, "pattern") ?? "pattern";
		return `grep ${truncateSingleLine(pattern, 60)}`;
	}
	if (toolName === "find") {
		const pattern = getStringArg(args, "pattern") ?? "*";
		return `find ${truncateSingleLine(pattern, 60)}`;
	}
	return toolName;
}

function getPathArg(args: Record<string, unknown>): string | undefined {
	return getStringArg(args, "path") ?? getStringArg(args, "file_path") ?? getStringArg(args, "filePath");
}

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (line.length <= maxLength) return line;
	return `${line.slice(0, Math.max(0, maxLength - 3))}...`;
}

function renderStatus(status: ReviewStatus, theme: Theme): string {
	const label = formatStatus(status);
	if (status === "done") return theme.fg("success", label);
	if (status === "failed") return theme.fg("error", label);
	if (status === "running") return theme.fg("warning", label);
	return theme.fg("muted", label);
}

function firstTextContent(content: readonly { type: string; text?: string }[]): string {
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

function formatDisplayItem(item: SimplifyDisplayItem): string {
	if (item.type === "tool") return formatToolActivity(item.name, item.args);
	return `thinking: ${truncateSingleLine(item.text, 100)}`;
}

function hasActionableSubagentFailure(results: readonly ReviewAgentResult[]): boolean {
	return results.some((result) => result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
}

export default function simplifyExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof SimplifyReviewParamsSchema, SimplifyReviewDetails>({
		name: "simplify_review",
		label: "Simplify Review",
		description: "Run /simplify Phase 1 and Phase 2: identify changed code and stream three parallel review subagents.",
		promptSnippet: "Run three parallel review subagents for code reuse, code quality, and efficiency before fixing findings.",
		promptGuidelines: [
			"Use simplify_review exactly once when the user invokes /simplify or asks for simplify-style changed-code review.",
		],
		parameters: SimplifyReviewParamsSchema,
		async execute(_toolCallId, params: SimplifyReviewParams, signal, onUpdate, ctx) {
			const focus = params.focus?.trim() ?? "";
			const details = createReviewDetails(undefined, focus);
			const emitNow = () => {
				onUpdate?.({ content: [{ type: "text", text: summarizeReviewDetails(details) }], details: cloneReviewDetails(details) });
			};
			const emitter = createThrottledEmitter(emitNow, PROGRESS_EMIT_THROTTLE_MS);

			emitter.flush();
			const context = await loadChangeContext(pi, ctx, signal);
			details.phase = "reviewing";
			details.context = summarizeChangeContext(context);
			details.updatedAt = Date.now();
			emitter.flush();

			const thinkingLevel = pi.getThinkingLevel();
			const results = await Promise.all(
				REVIEW_AGENT_SPECS.map(async (spec) => {
					updateAgent(details, spec.id, { status: "running", lastActivity: "starting", output: "", stderr: "" });
					emitter.flush();
					const result = await runReviewAgent({
						ctx,
						spec,
						task: buildReviewTask(spec, context, focus),
						thinkingLevel,
						signal,
						onProgress: (patch) => {
							updateAgent(details, spec.id, patch);
							emitter.schedule();
						},
					});
					const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					updateAgent(details, spec.id, {
						status: failed ? "failed" : "done",
						lastActivity: failed ? "failed" : "completed",
						output: result.output,
						stderr: result.stderr,
						items: result.items,
						exitCode: result.exitCode,
						stopReason: result.stopReason,
						errorMessage: result.errorMessage,
					});
					emitter.flush();
					return result;
				}),
			);

			details.phase = hasActionableSubagentFailure(results) ? "failed" : "done";
			details.updatedAt = Date.now();
			emitter.flush();

			return {
				content: [{ type: "text", text: buildFixPrompt({ context, focus, results }) }],
				details: cloneReviewDetails(details),
			};
		},
		renderCall(args, theme) {
			const focus = args.focus?.trim();
			const focusText = focus ? theme.fg("dim", ` ${truncateSingleLine(focus, 80)}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("simplify_review")) + focusText, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (!details) return new Text(firstTextContent(result.content), 0, 0);

			const header = `${theme.fg("toolTitle", theme.bold("simplify_review"))} ${theme.fg(
				details.phase === "failed" ? "error" : details.phase === "done" ? "success" : "warning",
				formatPhase(details.phase),
			)}`;

			if (!expanded) {
				let text = header;
				if (details.context) text += `\n${theme.fg("muted", formatContextSummary(details.context))}`;
				for (const agent of details.agents) {
					const activity = agent.lastActivity ? ` ${theme.fg("dim", truncateSingleLine(agent.lastActivity, 100))}` : "";
					text += `\n${renderStatus(agent.status, theme)} ${theme.fg("accent", agent.title)}${activity}`;
					for (const item of agent.items.slice(-COLLAPSED_ITEM_COUNT)) {
						text += `\n  ${theme.fg("muted", formatDisplayItem(item))}`;
					}
				}
				text += `\n${theme.fg("muted", "expand tool output for full subagent findings")}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			if (details.context) container.addChild(new Text(theme.fg("muted", formatContextSummary(details.context)), 0, 0));
			if (details.focus) container.addChild(new Text(theme.fg("muted", `focus: ${details.focus}`), 0, 0));

			const markdownTheme = getMarkdownTheme();
			for (const agent of details.agents) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${renderStatus(agent.status, theme)} ${theme.fg("accent", theme.bold(agent.title))}`, 0, 0),
				);
				if (agent.lastActivity) container.addChild(new Text(theme.fg("dim", agent.lastActivity), 0, 0));
				for (const item of agent.items) {
					container.addChild(new Text(theme.fg("muted", `- ${formatDisplayItem(item)}`), 0, 0));
				}
				if (agent.output.trim()) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(agent.output.trim(), 0, 0, markdownTheme));
				}
				if (agent.stderr.trim()) {
					container.addChild(new Text(theme.fg("error", agent.stderr.trim()), 0, 0));
				}
			}
			return container;
		},
	});

	pi.registerCommand("simplify", {
		description: SIMPLIFY_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			queueInstructionMessage(pi, ctx, buildSimplifyCommandPrompt(args));
		},
	});
}
