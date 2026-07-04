import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	getAgentDir,
	type AgentSessionEvent,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export const STOP_REASON_ERROR = "error";
export const STOP_REASON_ABORTED = "aborted";

/**
 * Swarm/clone feature flags, toggled from the /agents-settings menu and persisted
 * in the agent dir. Every flag is OFF by default: parallel subagent fan-out
 * multiplies concurrent API calls and cost, so nothing spawns subagents until
 * explicitly enabled. Flags are read at extension load, so changes apply on the
 * next session.
 *
 * - workers: register the lead's worker_run tool and /workers command (one-shot leaf subagents).
 * - clones: register the shadow clone tools (summon/send/wait/status/dispel).
 * - cloneWorkers: additionally let clones call worker_run (deepest, costliest tier; needs clones).
 * - modelTiers: route clones to the architect model (cloneModel) and workers to the
 *   cheaper executor model (workerModel). Clones think and orchestrate; workers execute
 *   well-framed tasks. Each spec is "provider/model-id"; a tier silently falls back to
 *   the lead's model when the spec is empty (the default), unknown, or unauthenticated.
 */
export interface SwarmSettings {
	workers: boolean;
	clones: boolean;
	cloneWorkers: boolean;
	modelTiers: boolean;
	cloneModel: string;
	workerModel: string;
}

export const SWARM_SETTINGS_DEFAULTS: SwarmSettings = {
	workers: false,
	clones: false,
	cloneWorkers: false,
	modelTiers: false,
	// Empty by default: each tier uses the session's current model until a
	// "provider/model-id" spec is configured in swarm-settings.json.
	cloneModel: "",
	workerModel: "",
};
const SWARM_SETTINGS_FILE = "swarm-settings.json";

function swarmSettingsPath(): string {
	return join(getAgentDir(), SWARM_SETTINGS_FILE);
}

/** Coerce arbitrary JSON into SwarmSettings; anything not strictly true is off. */
export function parseSwarmSettings(raw: unknown): SwarmSettings {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const modelSpec = (value: unknown, fallback: string) =>
		typeof value === "string" && value.includes("/") ? value : fallback;
	// Back-compat: older configs used { swarm, cloneSwarm }; read them as workers/cloneWorkers.
	return {
		workers: obj.workers === true || obj.swarm === true,
		clones: obj.clones === true,
		cloneWorkers: obj.cloneWorkers === true || obj.cloneSwarm === true,
		modelTiers: obj.modelTiers === true,
		cloneModel: modelSpec(obj.cloneModel, SWARM_SETTINGS_DEFAULTS.cloneModel),
		workerModel: modelSpec(obj.workerModel, SWARM_SETTINGS_DEFAULTS.workerModel),
	};
}

export function readSwarmSettings(): SwarmSettings {
	try {
		return parseSwarmSettings(JSON.parse(readFileSync(swarmSettingsPath(), "utf8")));
	} catch {
		return { ...SWARM_SETTINGS_DEFAULTS };
	}
}

export function writeSwarmSettings(settings: SwarmSettings): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(swarmSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The registry surface tier resolution needs; structural so tests can stub it. */
export interface TierModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/**
 * Resolve a "provider/model-id" tier spec to a model with configured auth.
 * Returns undefined (caller falls back to the lead's model) when the spec is
 * malformed, the model is unknown, or its provider has no credentials — a tier
 * must never break spawning.
 */
export function resolveTierModel(registry: TierModelSource, spec: string): Model<Api> | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash >= spec.length - 1) return undefined;
	const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model || !registry.hasConfiguredAuth(model)) return undefined;
	return model;
}

/**
 * Resolve an explicit per-spawn model request from a tool call: a
 * "provider/model-id" spec, or the tier aliases "architect" (cloneModel) and
 * "executor" (workerModel). Returns undefined for no/unresolvable requests so
 * the caller falls back to its default — a bad spec must never block a spawn.
 */
export function resolveSpawnModel(
	registry: TierModelSource,
	spec: string | undefined,
	settings: SwarmSettings,
): Model<Api> | undefined {
	const trimmed = spec?.trim();
	if (!trimmed) return undefined;
	const target = trimmed === "architect" ? settings.cloneModel : trimmed === "executor" ? settings.workerModel : trimmed;
	return resolveTierModel(registry, target);
}

export type SwarmDisplayItem =
	| { type: "thinking"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

interface EventUpdate {
	output?: string;
	stopReason?: string;
	errorMessage?: string;
	lastActivity?: string;
}

interface ThrottledEmitter {
	schedule(): void;
	flush(): void;
}

/** Resource loader for isolated subagent sessions (swarm tasks and shadow clones). */
export async function createSubagentLoader(cwd: string, systemPrompt: string): Promise<ResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		appendSystemPrompt: [systemPrompt],
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	return loader;
}

export function getEventUpdate(event: AgentSessionEvent, items: SwarmDisplayItem[]): EventUpdate | undefined {
	switch (event.type) {
		case "agent_start":
			return { lastActivity: "started" };
		case "agent_end":
			return { lastActivity: "completed" };
		case "message_update":
			if (event.message.role !== "assistant") return undefined;
			return getAssistantUpdate(event.message);
		case "message_end": {
			if (event.message.role !== "assistant") return undefined;
			const update = getAssistantUpdate(event.message);
			if (event.message.content.some((part) => part.type === "thinking")) {
				const thinking = event.message.content
					.filter((part): part is Extract<AssistantMessage["content"][number], { type: "thinking" }> => part.type === "thinking")
					.map((part) => part.thinking)
					.join("\n")
					.trim();
				if (thinking) items.push({ type: "thinking", text: thinking });
			}
			return {
				...update,
				stopReason: event.message.stopReason,
				errorMessage: event.message.errorMessage,
			};
		}
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

function getAssistantUpdate(message: AssistantMessage): EventUpdate {
	let text = "";
	let thinking = "";
	for (const part of message.content) {
		if (part.type === "text") text += (text ? "\n" : "") + part.text;
		else if (part.type === "thinking") thinking += (thinking ? "\n" : "") + part.thinking;
	}
	text = text.trim();
	thinking = thinking.trim();
	return {
		output: text,
		lastActivity: thinking
			? `thinking: ${truncateSingleLine(thinking, 80)}`
			: text
				? `writing: ${truncateSingleLine(text, 80)}`
				: "working",
	};
}

function formatToolActivity(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash") {
		const command = getStringArg(args, "command") ?? "command";
		// 200, not 80: the lead reads these in status to spot resource collisions
		// (e.g. a clone's db:reset buried at the end of a compound command).
		return `$ ${truncateSingleLine(command, 200)}`;
	}
	if (toolName === "read") return `read ${getPathArg(args) ?? "file"}`;
	if (toolName === "write") return `write ${getPathArg(args) ?? "file"}`;
	if (toolName === "edit") return `edit ${getPathArg(args) ?? "file"}`;
	if (toolName === "grep") {
		const pattern = getStringArg(args, "pattern") ?? "pattern";
		return `grep ${truncateSingleLine(pattern, 60)}`;
	}
	if (toolName === "find") {
		const pattern = getStringArg(args, "pattern") ?? "*";
		return `find ${truncateSingleLine(pattern, 60)}`;
	}
	if (toolName === "ls") return `ls ${getPathArg(args) ?? "."}`;
	return toolName;
}

export function formatDisplayItem(item: SwarmDisplayItem): string {
	if (item.type === "tool") return formatToolActivity(item.name, item.args);
	return `thinking: ${truncateSingleLine(item.text, 100)}`;
}

export function createThrottledEmitter(callback: () => void, intervalMs: number): ThrottledEmitter {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let lastEmitAt = 0;
	let dirty = false;

	const emitNow = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		if (!dirty) return;
		dirty = false;
		lastEmitAt = Date.now();
		callback();
	};

	return {
		schedule() {
			dirty = true;
			const now = Date.now();
			const waitMs = Math.max(0, intervalMs - (now - lastEmitAt));
			if (waitMs === 0) {
				emitNow();
				return;
			}
			if (!timeout) timeout = setTimeout(emitNow, waitMs);
		},
		flush() {
			dirty = true;
			emitNow();
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Extract the file path argument from a tool call's raw args, if present. */
export function getToolPathArg(args: unknown): string | undefined {
	return isRecord(args) ? getPathArg(args) : undefined;
}

function getPathArg(args: Record<string, unknown>): string | undefined {
	return getStringArg(args, "path") ?? getStringArg(args, "file_path") ?? getStringArg(args, "filePath");
}

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

export function truncateSingleLine(value: string, maxLength: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (line.length <= maxLength) return line;
	return `${line.slice(0, Math.max(0, maxLength - 3))}...`;
}
