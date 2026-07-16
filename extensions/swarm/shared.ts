import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	getAgentDir,
	type AgentSessionEvent,
	type AuthCredential,
	type AuthStorage,
	type ModelRegistry,
	type OAuthCredential,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { getOAuthProvider, type OAuthProviderId } from "@earendil-works/pi-ai/oauth";
import {
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export const STOP_REASON_ERROR = "error";
export const STOP_REASON_ABORTED = "aborted";

export const SPAWN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SPAWN_THINKING_DEFAULT: ModelThinkingLevel = "medium";

/**
 * Resolve the thinking level a spawned agent actually receives. Explicit choices
 * must be supported by the selected model. Omitted choices default to medium —
 * the caller decides when a task deserves more — falling back to the nearest
 * supported level when the model does not expose medium.
 */
export function resolveSpawnThinkingLevel(
	model: Model<Api> | undefined,
	requested: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
	if (!model) return requested ?? SPAWN_THINKING_DEFAULT;

	const supported = getSupportedThinkingLevels(model);
	if (requested) {
		if (!supported.includes(requested)) {
			throw new Error(
				`Thinking level "${requested}" is not supported by ${formatModelSpec(model)}. Available: ${supported.join(", ") || "none"}.`,
			);
		}
		return requested;
	}
	if (supported.includes(SPAWN_THINKING_DEFAULT)) return SPAWN_THINKING_DEFAULT;
	return (
		(["high", "low", "minimal", "off"] as const).find((level) => supported.includes(level)) ??
		supported[0] ??
		SPAWN_THINKING_DEFAULT
	);
}

/**
 * Swarm/clone feature flags, toggled from the /swarm-settings menu and persisted
 * in the agent dir. Every flag is OFF by default: parallel subagent fan-out
 * multiplies concurrent API calls and cost, so nothing spawns subagents until
 * explicitly enabled. Flags are read at extension load, so changes apply on the
 * next session.
 *
 * - workers: register the lead's worker_run tool and /workers command (one-shot leaf subagents).
 * - clones: register the shadow clone tools (summon/send/wait/status/dispel).
 * - cloneWorkers: additionally let clones call worker_run (deepest, costliest tier; needs clones).
 *
 * Model policy is intentionally absent. A spawn may name any exact model from the
 * registry; otherwise it inherits its caller's model.
 */
export interface SwarmSettings {
	workers: boolean;
	clones: boolean;
	cloneWorkers: boolean;
}

export const SWARM_SETTINGS_DEFAULTS: SwarmSettings = {
	workers: false,
	clones: false,
	cloneWorkers: false,
};
const SWARM_SETTINGS_FILE = "swarm-settings.json";

function swarmSettingsPath(): string {
	return join(getAgentDir(), SWARM_SETTINGS_FILE);
}

/** Coerce arbitrary JSON into SwarmSettings; anything not strictly true is off. */
export function parseSwarmSettings(raw: unknown): SwarmSettings {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	// Back-compat: older configs used { swarm, cloneSwarm }; read them as workers/cloneWorkers.
	return {
		workers: obj.workers === true || obj.swarm === true,
		clones: obj.clones === true,
		cloneWorkers: obj.cloneWorkers === true || obj.cloneSwarm === true,
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

/** The model-registry surface spawn resolution needs; structural so tests can stub it. */
export interface SpawnModelSource {
	getAll(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/**
 * Resolve an optional canonical "provider/model-id" selection. Model ids may
 * themselves contain slashes, so matching uses the complete canonical string
 * instead of splitting it. Invalid, ambiguous, and unauthenticated explicit
 * selections fail rather than silently running on a different model.
 */
export function resolveSpawnModel(
	registry: SpawnModelSource,
	spec: string | undefined,
): Model<Api> | undefined {
	const trimmed = spec?.trim();
	if (!trimmed) return undefined;
	const matches = registry.getAll().filter((model) => formatModelSpec(model) === trimmed);
	const model = matches.length === 1 ? matches[0] : undefined;
	if (!model) {
		throw new Error(`Model "${trimmed}" did not resolve exactly. Use a full provider/model-id from --list-models.`);
	}
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(`Model "${trimmed}" has no configured authentication.`);
	}
	return model;
}

/** "provider/model-id" spec for display; undefined model reads as the lead's default. */
export function formatModelSpec(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

interface AccountProviderEntry {
	active?: string;
	profiles?: Record<string, AuthCredential>;
	meta?: Record<string, { uuid?: string }>;
}

// Same catalog the /acc extension (pi-auth-profiles) maintains. Swarm reads it to
// name/pin the account a spawn runs under, and writes it only to persist OAuth
// token rotations of clone-pinned accounts (so other sessions can adopt them).
function accountStorePath(): string {
	return (
		process.env.PI_ACC_STORE ?? process.env.PIF_ACC_STORE ?? join(homedir(), ".pi", "agent", "auth-profiles.json")
	);
}

function loadAccountCatalog(): Record<string, AccountProviderEntry> | undefined {
	try {
		return JSON.parse(readFileSync(accountStorePath(), "utf8")) as Record<string, AccountProviderEntry>;
	} catch {
		return undefined;
	}
}

function credentialField(cred: AuthCredential, key: string): string | undefined {
	const value = (cred as unknown as Record<string, unknown>)[key];
	return typeof value === "string" && value ? value : undefined;
}

/** Durable per-account secret: refresh token for OAuth, the key for API keys. */
function credentialSecret(cred: AuthCredential): string | undefined {
	return cred.type === "oauth" ? credentialField(cred, "refresh") : credentialField(cred, "key");
}

/**
 * Catalog profile holding the same account as `cred`: stable account uuid first
 * (refresh tokens rotate), then the raw secret. Matches the pi-auth-profiles logic.
 */
function findCatalogProfile(entry: AccountProviderEntry, cred: AuthCredential): string | undefined {
	if (!entry.profiles) return undefined;
	const id = credentialField(cred, "accountId");
	const secret = credentialSecret(cred);
	for (const [name, profileCred] of Object.entries(entry.profiles)) {
		if (id && (credentialField(profileCred, "accountId") === id || entry.meta?.[name]?.uuid === id)) return name;
		if (secret && credentialSecret(profileCred) === secret) return name;
	}
	return undefined;
}

/** True when both credentials belong to the same account (uuid, else exact secret). */
function sameAccount(a: AuthCredential, b: AuthCredential): boolean {
	const aId = credentialField(a, "accountId");
	const bId = credentialField(b, "accountId");
	if (aId && bId) return aId === bId;
	const aSecret = credentialSecret(a);
	return !!aSecret && aSecret === credentialSecret(b);
}

/** The auth surface account resolution needs; structural so tests can stub it. */
export interface LiveAuthSource {
	get(provider: string): AuthCredential | undefined;
}

/**
 * Resolve the /acc profile name of the live credential for `provider`, so every
 * clone/worker spawn can be pinned to a visible account label. Stable account
 * uuid first (refresh tokens rotate), then the raw secret, then the catalog's
 * `active` pointer as a last resort. Best-effort: undefined when there is no
 * catalog, provider, or match.
 */
export function resolveAccountLabel(auth: LiveAuthSource, provider: string): string | undefined {
	const entry = loadAccountCatalog()?.[provider];
	if (!entry?.profiles) return undefined;
	const live = auth.get(provider);
	if (live) {
		const match = findCatalogProfile(entry, live);
		if (match) return match;
	}
	return entry.active;
}

/** Saved /acc profile names for a provider (empty when there is no catalog). */
export function listAccountProfiles(provider: string): string[] {
	return Object.keys(loadAccountCatalog()?.[provider]?.profiles ?? {});
}

/** Credential of a saved /acc profile; throws with the available names when missing. */
export function getAccountCredential(provider: string, profile: string): AuthCredential {
	const cred = loadAccountCatalog()?.[provider]?.profiles?.[profile];
	if (!cred) {
		const available = listAccountProfiles(provider);
		throw new Error(
			`No saved /acc profile "${profile}" for ${provider}. Available: ${available.join(", ") || "none (save one with /acc save <name>)"}.`,
		);
	}
	return cred;
}

/** Best-effort: fold a rotated credential back into its catalog profile so other sessions can adopt it. */
function persistCatalogRotation(provider: string, previous: OAuthCredential, refreshed: OAuthCredential): void {
	try {
		const store = loadAccountCatalog();
		const entry = store?.[provider];
		if (!store || !entry?.profiles) return;
		const name = findCatalogProfile(entry, previous) ?? findCatalogProfile(entry, refreshed);
		if (!name) return;
		const stored = entry.profiles[name];
		if (stored?.type === "oauth" && stored.expires > refreshed.expires) return; // never overwrite a fresher snapshot
		entry.profiles[name] = refreshed;
		writeFileSync(accountStorePath(), JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
	} catch {
		// The clone keeps its refreshed in-memory credential either way.
	}
}

/**
 * Refresh a clone-pinned OAuth credential without going through the shared
 * auth.json refresh path (whose credential may belong to another account):
 * adopt a fresher snapshot of the same account from the /acc catalog first
 * (another session or clone may have rotated the token already), otherwise
 * refresh on this credential's own chain and persist the rotation into the
 * catalog. A lost refresh-rotation race is recovered from the winner's catalog
 * write. When `writeBack` is given (the lead's storage) and its live credential
 * is the SAME account, the rotation is also written through it, healing the
 * lead's copy for setups without an /acc catalog.
 */
async function refreshCloneAccountCredential(
	provider: string,
	expired: OAuthCredential,
	writeBack?: AuthStorage,
): Promise<OAuthCredential> {
	const adopt = (): OAuthCredential | undefined => {
		const entry = loadAccountCatalog()?.[provider];
		const name = entry ? findCatalogProfile(entry, expired) : undefined;
		const cred = name ? entry?.profiles?.[name] : undefined;
		return cred?.type === "oauth" && Date.now() < cred.expires && cred.expires > expired.expires ? cred : undefined;
	};
	const adopted = adopt();
	if (adopted) return adopted;
	const oauthProvider = getOAuthProvider(provider as OAuthProviderId);
	if (!oauthProvider) throw new Error(`No OAuth provider registered for "${provider}".`);
	try {
		const refreshed: OAuthCredential = { type: "oauth", ...(await oauthProvider.refreshToken(expired)) };
		const accountId = credentialField(expired, "accountId");
		if (accountId && !credentialField(refreshed, "accountId")) {
			(refreshed as unknown as Record<string, unknown>).accountId = accountId;
		}
		persistCatalogRotation(provider, expired, refreshed);
		if (writeBack) {
			try {
				const leadLive = writeBack.get(provider);
				if (leadLive && sameAccount(leadLive, expired)) writeBack.set(provider, refreshed);
			} catch {
				// auth.json write-back is a bonus; the catalog (or the pin) still has the rotation.
			}
		}
		return refreshed;
	} catch (error) {
		// Refresh-token rotation race: another session/clone on the same account may
		// have rotated first; it persists the fresh credential to the catalog right
		// after refreshing, so retry briefly before giving up.
		for (let attempt = 0; attempt < 5; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const recovered = adopt();
			if (recovered) return recovered;
		}
		throw error;
	}
}

/**
 * Per-clone credential view over the lead's AuthStorage. Session pins live in
 * clone-local maps (shadowed through a proxy: the class keeps them in plain
 * instance fields, and methods run with `this` = proxy), so pinning an account
 * here can never leak into the lead or sibling clones, while auth.json data,
 * file locking, and OAuth plumbing still delegate to the shared storage. The
 * lead's live account per provider is inherited as the initial pin, with
 * catalog-aware refresh so token rotations flow through the /acc catalog (and
 * back into auth.json when it still holds the same account) instead of being lost.
 */
export function createCloneAuthStorage(base: AuthStorage): AuthStorage {
	const sessionOverrides = new Map<string, unknown>();
	const sessionRefreshes = new Map<string, unknown>();
	const storage = new Proxy(base, {
		get(target, prop) {
			if (prop === "sessionOverrides") return sessionOverrides;
			if (prop === "sessionRefreshes") return sessionRefreshes;
			return Reflect.get(target, prop);
		},
	});
	for (const provider of base.list()) {
		const cred = base.get(provider);
		if (!cred) continue;
		storage.setSessionCredential(
			provider,
			cred,
			cred.type === "oauth"
				? { refresh: (expired) => refreshCloneAccountCredential(provider, expired, base) }
				: undefined,
		);
	}
	return storage;
}

/** Registry view whose auth resolves through the clone's own storage; everything else delegates to the lead's registry. */
export function createCloneModelRegistry(base: ModelRegistry, authStorage: AuthStorage): ModelRegistry {
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "authStorage") return authStorage;
			return Reflect.get(target, prop);
		},
	});
}

/**
 * Pin a saved /acc profile as the clone's account for `provider`. Expired OAuth
 * profiles are refreshed and verified FIRST (persisting the rotation), so a dead
 * profile fails the switch loudly instead of breaking the clone mid-task.
 */
export async function pinCloneAccount(auth: AuthStorage, provider: string, profile: string): Promise<void> {
	let cred = getAccountCredential(provider, profile);
	if (cred.type === "oauth" && Date.now() >= cred.expires) {
		try {
			cred = await refreshCloneAccountCredential(provider, cred);
		} catch (error) {
			throw new Error(
				`/acc profile "${profile}" (${provider}) failed to refresh: ${error instanceof Error ? error.message : String(error)} The saved token looks dead; re-add the account with /acc new ${profile}.`,
			);
		}
	}
	auth.setSessionCredential(
		provider,
		cred,
		cred.type === "oauth" ? { refresh: (expired) => refreshCloneAccountCredential(provider, expired) } : undefined,
	);
}

const RATE_LIMIT_ERROR_PATTERN = /\b429\b|rate.?limit|too.?many.?requests|usage limit/i;

/**
 * Provider rate/usage-limit errors (e.g. HTTP 429 rate_limit_error). Retrying
 * into the same window just burns it, so clones auto-pause on these instead of
 * retrying — and never fall back to another model, by design.
 */
export function isRateLimitedError(message: string | undefined): boolean {
	return !!message && RATE_LIMIT_ERROR_PATTERN.test(message);
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

interface ModelTransition {
	model: Model<Api>;
	activity: string;
}

/** Extract the current model from automatic fallback/restore session events. */
export function getModelTransition(event: AgentSessionEvent): ModelTransition | undefined {
	if (event.type === "model_fallback") {
		return {
			model: event.toModel,
			activity: `model fallback: ${formatModelSpec(event.fromModel)} → ${formatModelSpec(event.toModel)}`,
		};
	}
	if (event.type === "model_fallback_restore") {
		return { model: event.model, activity: `model restored: ${formatModelSpec(event.model)}` };
	}
	return undefined;
}

interface ThrottledEmitter {
	schedule(): void;
	flush(): void;
}

interface LinkedAbortControllers {
	signals: AbortSignal[];
	abort(index?: number): void;
	dispose(): void;
}

/** Per-leaf abort signals linked to the parent tool call's signal. */
export function createLinkedAbortControllers(count: number, parent?: AbortSignal): LinkedAbortControllers {
	const controllers = Array.from({ length: count }, () => new AbortController());
	const abort = (index?: number) => {
		if (index === undefined) {
			for (const controller of controllers) controller.abort();
			return;
		}
		controllers[index]?.abort();
	};
	const abortAll = () => abort();
	if (parent?.aborted) abortAll();
	else parent?.addEventListener("abort", abortAll, { once: true });
	return {
		signals: controllers.map((controller) => controller.signal),
		abort,
		dispose: () => parent?.removeEventListener("abort", abortAll),
	};
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
