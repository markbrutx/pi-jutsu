/**
 * /simplify — changed-code review and cleanup with a configurable review council.
 *
 * Phase 1 identifies the change set (git diff + untracked files, with a
 * recent-files fallback), Phase 2 fans it out to parallel read-only review
 * subagents (the "council"), Phase 3 lets the lead fix aggregated findings.
 *
 * The council is configured in <agentDir>/simplify-settings.json:
 *
 *   {
 *     "council": [
 *       { "id": "review-a", "model": "provider-a/model-a" },
 *       { "id": "review-b", "model": "provider-b/model-b" }
 *     ]
 *   }
 *
 * Member fields: id (display name), aspect ("reuse" | "quality" |
 * "efficiency" | "full"; default "full"), instruction (custom review brief,
 * overrides aspect), model (an exact "provider/model-id" from --list-models;
 * unknown or unauthenticated selections fail explicitly). Missing or invalid
 * config = the classic reuse/quality/efficiency trio on the lead's model. Runs
 * are published to the swarm worker-run registry, so the council is visible in
 * the clone dashboard while it reviews.
 *
 * When no simplify-settings.json exists, /simplify first opens a fullscreen
 * council picker (alt-screen, like the agents dashboard) to assign a model to
 * each of the three roles; the choice is saved and skipped on later runs.
 * /simplify-council reopens the picker to reconfigure. The picker has an idle
 * timeout: if the user is away it closes without saving and the review
 * proceeds with the current defaults, so the command never blocks forever.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { StringEnum, type Api, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	resolveReadPath,
	SessionManager,
	truncateHead,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExecResult,
	type ResourceLoader,
	type Theme,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { SwarmDetails } from "../swarm/index.ts";
import { finishWorkerRun, startWorkerRun, updateWorkerRun } from "../swarm/registry.ts";
import {
	createLinkedAbortControllers,
	createSubagentLoader,
	createThrottledEmitter,
	formatDisplayItem,
	formatModelSpec,
	getEventUpdate,
	getModelTransition,
	resolveAccountLabel,
	resolveSpawnModel,
	resolveSpawnThinkingLevel,
	SPAWN_THINKING_LEVELS,
	truncateSingleLine,
	type SwarmDisplayItem,
} from "../swarm/shared.ts";

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
const MAX_COUNCIL = 6;
const SIMPLIFY_SETTINGS_FILE = "simplify-settings.json";
const COUNCIL_PICKER_TIMEOUT_MS = 120_000;

/** Models offered in the council picker, besides "lead" (the current model). */
const COUNCIL_MODEL_SHORTLIST = [
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-4-8",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
] as const;

export const SUBAGENT_SYSTEM_PROMPT = `You are a focused /simplify review subagent.

Do not modify files. Use tools only to inspect code and verify findings.
Return concise, actionable findings with file paths and suggested fixes. If there are no actionable issues, return "No findings."`;

const SimplifyReviewParamsSchema = Type.Object({
	focus: Type.Optional(Type.String({ description: "Optional extra focus for the simplify review." })),
	thinking: Type.Optional(
		StringEnum(SPAWN_THINKING_LEVELS, {
			description: "Thinking level for the council members. Omit for the default, medium.",
		}),
	),
});

type SimplifyReviewParams = Static<typeof SimplifyReviewParamsSchema>;

export type ReviewAspect = "reuse" | "quality" | "efficiency" | "full";
export type ReviewStatus = "pending" | "running" | "done" | "failed";
export type SimplifyReviewPhase = "identifying_changes" | "reviewing" | "done" | "failed";

/** A configured council member (see the module doc for simplify-settings.json). */
export interface CouncilMember {
	id: string;
	aspect: ReviewAspect;
	instruction?: string;
	model?: string;
}

/** A council member resolved against the model registry, ready to run. */
export interface ReviewAgentSpec {
	id: string;
	title: string;
	instruction: string;
	/** Resolved model override; undefined = the lead's model. */
	model?: Model<Api>;
	/** "provider/model-id" the member actually runs on, for display. */
	modelSpec?: string;
	/** /acc account profile of the member's provider auth, when known. */
	account?: string;
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

export type SimplifyDisplayItem = SwarmDisplayItem;

export type SimplifyReviewContextSummary =
	| { kind: "diff"; diffCommand: string; diffLines: number }
	| { kind: "fallback"; diffCommand: string; recentFiles: string[]; diffError?: string };

export interface ReviewAgentProgress {
	id: string;
	title: string;
	/** "provider/model-id" this member runs on, for display. */
	model?: string;
	/** /acc account profile of the member's provider auth, when known. */
	account?: string;
	status: ReviewStatus;
	lastActivity: string;
	output: string;
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

const REUSE_INSTRUCTION = `For each change:

1. Search for existing utilities and helpers that could replace newly written code. Look for similar patterns elsewhere in the codebase, especially utility directories, shared modules, and files adjacent to the changed files.
2. Flag any new function that duplicates existing functionality. Suggest the existing function to use instead.
3. Flag inline logic that could use an existing utility, including hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns.`;

const QUALITY_INSTRUCTION = `Review the same changes for hacky patterns:

1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones.
3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction.
4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries.
5. Stringly-typed code: raw strings where constants, string unions, branded types, or existing enums already exist.
6. Unnecessary UI nesting: wrappers/elements that add no layout value when inner component props already provide the behavior.
7. Unnecessary comments: comments explaining WHAT the code does, narrating the change, or referencing the task/caller. Keep only non-obvious WHY.`;

const EFFICIENCY_INSTRUCTION = `Review the same changes for efficiency:

1. Unnecessary work: redundant computations, repeated file reads, duplicate network/API calls, or N+1 patterns.
2. Missed concurrency: independent operations run sequentially when they could run in parallel.
3. Hot-path bloat: new blocking work added to startup, per-request, or per-render hot paths.
4. Recurring no-op updates: unconditional state/store updates inside polling loops, intervals, or event handlers. Add change-detection guards when needed.
5. Unnecessary existence checks: pre-checking file/resource existence before operating when direct operation plus error handling is safer.
6. Memory: unbounded data structures, missing cleanup, or event listener leaks.
7. Overly broad operations: reading whole files when only a portion is needed, or loading all items when filtering for one.`;

const ASPECT_TITLES: Record<ReviewAspect, string> = {
	reuse: "Code Reuse Review",
	quality: "Code Quality Review",
	efficiency: "Efficiency Review",
	full: "Full Review",
};

const ASPECT_INSTRUCTIONS: Record<ReviewAspect, string> = {
	reuse: REUSE_INSTRUCTION,
	quality: QUALITY_INSTRUCTION,
	efficiency: EFFICIENCY_INSTRUCTION,
	full: `Review the changes for ALL of the following concerns.

### Code reuse

${REUSE_INSTRUCTION}

### Code quality

${QUALITY_INSTRUCTION}

### Efficiency

${EFFICIENCY_INSTRUCTION}`,
};

export const DEFAULT_COUNCIL: readonly CouncilMember[] = [
	{ id: "reuse", aspect: "reuse" },
	{ id: "quality", aspect: "quality" },
	{ id: "efficiency", aspect: "efficiency" },
];

/** Coerce arbitrary JSON into a council; anything unusable falls back to the default trio. */
export function parseCouncil(raw: unknown): CouncilMember[] {
	if (!isRecord(raw) || !Array.isArray(raw.council)) return [...DEFAULT_COUNCIL];
	const members: CouncilMember[] = [];
	const seen = new Set<string>();
	for (const entry of raw.council.slice(0, MAX_COUNCIL)) {
		if (!isRecord(entry)) continue;
		const aspect: ReviewAspect =
			entry.aspect === "reuse" || entry.aspect === "quality" || entry.aspect === "efficiency" ? entry.aspect : "full";
		const instruction =
			typeof entry.instruction === "string" && entry.instruction.trim() ? entry.instruction.trim() : undefined;
		const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined;
		const base = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : aspect;
		let id = base;
		for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
		seen.add(id);
		members.push({ id, aspect, instruction, model });
	}
	return members.length > 0 ? members : [...DEFAULT_COUNCIL];
}

function councilSettingsPath(): string {
	return path.join(getAgentDir(), SIMPLIFY_SETTINGS_FILE);
}

/** Parsed council from simplify-settings.json, or undefined when the file is missing or invalid. */
function loadCouncilSettings(): CouncilMember[] | undefined {
	try {
		return parseCouncil(JSON.parse(readFileSync(councilSettingsPath(), "utf8")));
	} catch {
		return undefined;
	}
}

function readCouncil(): CouncilMember[] {
	return loadCouncilSettings() ?? [...DEFAULT_COUNCIL];
}

function memberTitle(member: CouncilMember): string {
	if (member.instruction) return member.id;
	const aspectTitle = ASPECT_TITLES[member.aspect];
	if (member.id.toLowerCase() === member.aspect) return aspectTitle;
	return `${member.id} · ${aspectTitle}`;
}

/** Resolve a council member to its display title and review instruction (no registry access). */
export function memberSpec(member: CouncilMember): ReviewAgentSpec {
	return {
		id: member.id,
		title: memberTitle(member),
		instruction: member.instruction ?? ASPECT_INSTRUCTIONS[member.aspect],
	};
}

/** Resolve the configured council against the registry: per-member models, display specs, /acc labels. */
function resolveCouncil(ctx: ExtensionContext): ReviewAgentSpec[] {
	// resolveAccountLabel re-reads the catalog file on every call; members usually share a provider.
	const accountLabels = new Map<string, string | undefined>();
	const accountLabel = (provider: string): string | undefined => {
		if (!accountLabels.has(provider)) {
			accountLabels.set(provider, resolveAccountLabel(ctx.modelRegistry.authStorage, provider));
		}
		return accountLabels.get(provider);
	};
	return readCouncil().map((member) => {
		const override = resolveSpawnModel(ctx.modelRegistry, member.model);
		const model = override ?? ctx.model;
		return {
			...memberSpec(member),
			model: override,
			modelSpec: formatModelSpec(model),
			account: model ? accountLabel(model.provider) : undefined,
		};
	});
}

/** Map review details onto the worker-run shape so the clone dashboard can show the council. */
export function toSwarmDetails(details: SimplifyReviewDetails): SwarmDetails {
	return {
		phase:
			details.phase === "identifying_changes"
				? "preparing"
				: details.phase === "reviewing"
					? "executing"
					: details.phase,
		focus: details.focus,
		agents: details.agents.map((agent, index) => ({
			index,
			title: agent.title,
			model: agent.model,
			account: agent.account,
			status: agent.status,
			lastActivity: agent.lastActivity,
			output: agent.output,
			items: agent.items.map(cloneDisplayItem),
			exitCode: agent.exitCode,
			stopReason: agent.stopReason,
			errorMessage: agent.errorMessage,
		})),
		startedAt: details.startedAt,
		updatedAt: details.updatedAt,
	};
}

interface RawUntrackedFileDiff {
	path: string;
	rawDiff: string;
}

interface RunReviewAgentOptions {
	ctx: ExtensionContext;
	spec: ReviewAgentSpec;
	task: string;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	resourceLoader: ResourceLoader;
	signal: AbortSignal | undefined;
	onProgress: ReviewProgressCallback;
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

Do not run separate review agents manually; the tool handles Phase 1 and Phase 2 and streams the review council subagents in the UI.

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

export function buildReviewTask(spec: ReviewAgentSpec, context: ChangeContext, focus: string, total: number): string {
	const focusText = focus.trim();
	const focusSection = focusText ? `\n\n## Additional Focus\n\n${focusText}` : "";
	const role =
		total === 1
			? "You are the isolated review agent for /simplify."
			: `You are council member "${spec.id}", one of ${total} isolated review agents for /simplify.`;

	return `# Simplify Review: ${spec.title}

${role} Review the complete change set below for your assigned concern and return concise findings only.

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

${
		options.results.length > 1
			? "- Findings from different council members may overlap; deduplicate and fix each issue once.\n"
			: ""
	}- Read files as needed, then apply direct edits for actionable findings.
- If a finding is a false positive or not worth changing, skip it and note why in the final summary.
- If all reviews say "No findings" and you do not identify a clear issue, do not edit files; briefly confirm the code is already clean.
- Keep the final response concise: summarize what was fixed, or confirm no changes were needed.`;
}

export function createReviewDetails(
	context: ChangeContext | undefined,
	focus: string,
	specs: readonly ReviewAgentSpec[],
): SimplifyReviewDetails {
	const now = Date.now();
	return {
		phase: context ? "reviewing" : "identifying_changes",
		focus: focus.trim(),
		context: context ? summarizeChangeContext(context) : undefined,
		agents: specs.map((spec) => ({
			id: spec.id,
			title: spec.title,
			model: spec.modelSpec,
			account: spec.account,
			status: "pending",
			lastActivity: "waiting",
			output: "",
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
		lines.push(`[${formatStatus(agent.status)}] ${agent.title}${formatAgentAttribution(agent)}${activity}`);
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

	const diagnosticsText = diagnostics.length > 0 ? `${diagnostics.join("\n\n")}\n\n` : "";
	const output = result.output.trim() || "No findings.";
	const attribution = result.spec.modelSpec ? ` (${result.spec.modelSpec})` : "";
	return `### ${result.spec.title}${attribution}\n\n${diagnosticsText}${output}`;
}

async function runReviewAgent(options: RunReviewAgentOptions): Promise<ReviewAgentResult> {
	const { ctx, spec, task, thinkingLevel, resourceLoader, signal, onProgress } = options;
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let lastAssistantText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = signal?.aborted ?? false;
	const items: SimplifyDisplayItem[] = [];

	const publish = (patch: ReviewProgressPatch) => {
		onProgress({
			status: "running",
			output: lastAssistantText,
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
			items: [],
			stopReason: "aborted",
		};
	}

	try {
		signal?.addEventListener("abort", abort, { once: true });
		publish({ lastActivity: "starting" });

		const created = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model: spec.model ?? ctx.model,
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
				items: [...items],
				stopReason: "aborted",
				errorMessage,
			};
		}

		unsubscribe = session.subscribe((event) => {
			const transition = getModelTransition(event);
			if (transition) {
				publish({
					model: formatModelSpec(transition.model),
					account: resolveAccountLabel(ctx.modelRegistry.authStorage, transition.model.provider),
					lastActivity: transition.activity,
				});
				return;
			}
			const update = getEventUpdate(event, items);
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

function updateAgent(details: SimplifyReviewDetails, id: string, patch: ReviewProgressPatch): void {
	const agent = details.agents.find((candidate) => candidate.id === id);
	if (!agent) return;
	Object.assign(agent, patch);
	details.updatedAt = Date.now();
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

	const absolute = resolveReadPath(value, cwd);
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

// ─────────────────────────────────────────────
// Fullscreen council picker (alt-screen, like the agents dashboard)
// ─────────────────────────────────────────────

/** Shortlist entries that resolve to an authenticated model; undefined = lead's model. */
function councilModelChoices(ctx: ExtensionContext): (string | undefined)[] {
	const choices: (string | undefined)[] = [undefined];
	for (const spec of COUNCIL_MODEL_SHORTLIST) {
		try {
			if (resolveSpawnModel(ctx.modelRegistry, spec)) choices.push(spec);
		} catch {
			// unknown or unauthenticated — leave it out of the picker
		}
	}
	return choices;
}

function formatPickerCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

interface CouncilPickerOptions {
	theme: Theme;
	/** Council members whose models are being assigned; metadata is preserved on save. */
	members: readonly CouncilMember[];
	choices: readonly (string | undefined)[];
	leadModel?: string;
	getHeight: () => number;
	requestRender: () => void;
	/** Chosen model spec per role on save; undefined = cancelled or timed out (no save). */
	done: (models: (string | undefined)[] | undefined) => void;
}

class CouncilPicker {
	focused = false;

	private readonly options: CouncilPickerOptions;
	private readonly selection: number[];
	private row = 0;
	private deadline = Date.now() + COUNCIL_PICKER_TIMEOUT_MS;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: CouncilPickerOptions) {
		this.options = options;
		// Seed each row from the member's saved model (0 = lead when absent/unknown).
		this.selection = options.members.map((member) => Math.max(0, options.choices.indexOf(member.model)));
		// Idle timeout: if the user is away, close without saving so /simplify
		// continues with the current defaults instead of blocking forever.
		this.timer = setInterval(() => {
			if (Date.now() >= this.deadline) {
				this.dispose();
				this.options.done(undefined);
				return;
			}
			this.options.requestRender();
		}, 1000);
	}

	private choiceLabel(index: number): string {
		const spec = this.options.choices[index];
		if (spec) return spec;
		return this.options.leadModel ? `lead (${this.options.leadModel})` : "lead (current model)";
	}

	handleInput(data: string): void {
		this.deadline = Date.now() + COUNCIL_PICKER_TIMEOUT_MS;
		const roleCount = this.options.members.length;
		const choiceCount = this.options.choices.length;

		if (matchesKey(data, "escape")) {
			this.dispose();
			this.options.done(undefined);
			return;
		}
		if (matchesKey(data, "return")) {
			this.dispose();
			this.options.done(this.selection.map((index) => this.options.choices[index]));
			return;
		}
		if (matchesKey(data, "up")) {
			this.row = (this.row + roleCount - 1) % roleCount;
		} else if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			this.row = (this.row + 1) % roleCount;
		} else if (matchesKey(data, "left")) {
			this.selection[this.row] = (this.selection[this.row]! + choiceCount - 1) % choiceCount;
		} else if (matchesKey(data, "right") || data === " ") {
			this.selection[this.row] = (this.selection[this.row]! + 1) % choiceCount;
		} else {
			return;
		}
		this.options.requestRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const height = Math.max(10, this.options.getHeight());
		const lines: string[] = [];
		const bar = (content: string) => truncateToWidth(content, width, "...", true);

		lines.push(bar(` ${theme.bold(theme.fg("warning", "/simplify"))}  ${theme.fg("muted", "council setup")}`));
		lines.push(bar(theme.fg("border", "─".repeat(width))));
		lines.push(bar(""));
		lines.push(bar(` ${theme.fg("text", "Assign a model to each review role. Saved to simplify-settings.json.")}`));
		lines.push(bar(""));

		const titles = this.options.members.map(memberTitle);
		const titleWidth = Math.max(24, ...titles.map((title) => title.length));
		for (let i = 0; i < titles.length; i++) {
			const title = titles[i]!.padEnd(titleWidth);
			const choice = ` ◂ ${this.choiceLabel(this.selection[i]!)} ▸ `;
			const rowText = ` ${title} ${i === this.row ? theme.bg("selectedBg", theme.bold(theme.fg("accent", choice))) : theme.fg("dim", choice)}`;
			lines.push(bar(`${i === this.row ? theme.fg("accent", " ▶") : "  "}${rowText}`));
		}

		while (lines.length < height - 2) lines.push(bar(""));
		lines.push(bar(theme.fg("border", "─".repeat(width))));
		const remaining = this.deadline - Date.now();
		const countdown = theme.fg(remaining < 30_000 ? "warning" : "dim", `⏱ auto-skip ${formatPickerCountdown(remaining)}`);
		lines.push(bar(theme.fg("dim", ` ↑↓ role · ←→ model · ⏎ save · esc skip · `) + countdown));
		return lines.slice(0, height);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

/**
 * Open the fullscreen picker and persist the council on save. Assigns models to
 * the SAVED council members (preserving custom ids, aspects, and instructions);
 * without saved settings it configures the default reuse/quality/efficiency trio.
 * Returns true if saved.
 */
async function configureCouncil(ctx: ExtensionCommandContext, saved: CouncilMember[] | undefined): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	const members = saved ?? [...DEFAULT_COUNCIL];
	const choices = councilModelChoices(ctx);
	const models = await ctx.ui.custom<(string | undefined)[] | undefined>(
		(tui, theme, _kb, done) =>
			new CouncilPicker({
				theme,
				members,
				choices,
				leadModel: formatModelSpec(ctx.model),
				getHeight: () => tui.terminal.rows,
				requestRender: () => tui.requestRender(),
				done,
			}),
		// altScreen: the picker owns the terminal's alternate buffer, so the chat
		// behind never repaints or jumps (same as the agents dashboard).
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", altScreen: true } },
	);
	if (!models) return false;

	const council = members.map((member, index) => ({
		id: member.id,
		aspect: member.aspect,
		...(member.instruction ? { instruction: member.instruction } : {}),
		...(models[index] ? { model: models[index] } : {}),
	}));
	writeFileSync(councilSettingsPath(), `${JSON.stringify({ council }, null, "\t")}\n`);
	ctx.ui.notify(
		`Simplify council saved: ${council.map((member) => `${member.id}=${member.model ?? "lead"}`).join(", ")}`,
		"info",
	);
	return true;
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

/** "model · acc" attribution for a council member: themed bracket form for the TUI, plain parens for text. */
function formatAgentAttribution(agent: ReviewAgentProgress, theme?: Theme): string {
	if (!agent.model) return "";
	const label = `${agent.model}${agent.account ? ` · acc: ${agent.account}` : ""}`;
	return theme ? theme.fg("dim", ` [${label}]`) : ` (${label})`;
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

function hasActionableSubagentFailure(results: readonly ReviewAgentResult[]): boolean {
	return results.some((result) => result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
}

export default function simplifyExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof SimplifyReviewParamsSchema, SimplifyReviewDetails>({
		name: "simplify_review",
		label: "Simplify Review",
		description:
			"Run /simplify Phase 1 and Phase 2: identify changed code and stream the configured review council of parallel read-only subagents.",
		promptSnippet:
			"Run the configured council of parallel review subagents (default: code reuse, code quality, efficiency) before fixing findings.",
		promptGuidelines: [
			"Use simplify_review exactly once when the user invokes /simplify or asks for simplify-style changed-code review.",
		],
		parameters: SimplifyReviewParamsSchema,
		async execute(_toolCallId, params: SimplifyReviewParams, signal, onUpdate, ctx) {
			const focus = params.focus?.trim() ?? "";
			const specs = resolveCouncil(ctx);
			// Resolve thinking per member up front so a bad explicit level fails before the run starts.
			const thinkingLevels = specs.map((spec) => resolveSpawnThinkingLevel(spec.model ?? ctx.model, params.thinking));
			const details = createReviewDetails(undefined, focus, specs);
			const aborts = createLinkedAbortControllers(specs.length, signal);
			// Publish to the swarm registry so the council shows up in the clone dashboard.
			let runId = "";
			const emitNow = () => {
				onUpdate?.({ content: [{ type: "text", text: summarizeReviewDetails(details) }], details: cloneReviewDetails(details) });
				updateWorkerRun(runId, toSwarmDetails(details));
			};
			const emitter = createThrottledEmitter(emitNow, PROGRESS_EMIT_THROTTLE_MS);
			const cancel = (agentIndex?: number) => {
				const indices = agentIndex === undefined ? details.agents.map((_, index) => index) : [agentIndex];
				for (const index of indices) {
					const agent = details.agents[index];
					if (agent?.status === "pending" || agent?.status === "running") {
						updateAgent(details, agent.id, { lastActivity: "aborting" });
					}
				}
				aborts.abort(agentIndex);
				emitter.flush();
			};
			runId = startWorkerRun("simplify", focus || "review council", toSwarmDetails(details), cancel);

			try {
				emitter.flush();
				const context = await loadChangeContext(pi, ctx, signal);
				details.phase = "reviewing";
				details.context = summarizeChangeContext(context);
				details.updatedAt = Date.now();
				emitter.flush();

				const resourceLoader = await createSubagentLoader(ctx.cwd, SUBAGENT_SYSTEM_PROMPT);
				const results = await Promise.all(
					specs.map(async (spec, index) => {
						updateAgent(details, spec.id, { status: "running", lastActivity: "starting", output: "" });
						emitter.flush();
						const result = await runReviewAgent({
							ctx,
							spec,
							task: buildReviewTask(spec, context, focus, specs.length),
							thinkingLevel: thinkingLevels[index],
							resourceLoader,
							signal: aborts.signals[index],
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
			} catch (error) {
				details.phase = "failed";
				details.updatedAt = Date.now();
				emitter.flush();
				throw error;
			} finally {
				aborts.dispose();
				// Always settle the registry run, or the dashboard would show it as live forever.
				finishWorkerRun(runId, toSwarmDetails(details));
			}
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
					text += `\n${renderStatus(agent.status, theme)} ${theme.fg("accent", agent.title)}${formatAgentAttribution(agent, theme)}${activity}`;
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
					new Text(
						`${renderStatus(agent.status, theme)} ${theme.fg("accent", theme.bold(agent.title))}${formatAgentAttribution(agent, theme)}`,
						0,
						0,
					),
				);
				if (agent.lastActivity) container.addChild(new Text(theme.fg("dim", agent.lastActivity), 0, 0));
				for (const item of agent.items) {
					container.addChild(new Text(theme.fg("muted", `- ${formatDisplayItem(item)}`), 0, 0));
				}
				if (agent.output.trim()) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(agent.output.trim(), 0, 0, markdownTheme));
				}
			}
			return container;
		},
	});

	pi.registerCommand("simplify", {
		description: SIMPLIFY_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			// First run without saved preferences: ask which model each role uses
			// (configureCouncil is a no-op outside the TUI).
			if (!loadCouncilSettings()) await configureCouncil(ctx, undefined);
			queueInstructionMessage(pi, ctx, buildSimplifyCommandPrompt(args));
		},
	});

	pi.registerCommand("simplify-council", {
		description: "Configure which model each /simplify council role runs on",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("simplify-council requires interactive mode", "error");
				return;
			}
			await configureCouncil(ctx, loadCouncilSettings());
		},
	});
}
