import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	AcpRpcError,
	spawnAcpClient,
	type AcpConfigOption,
	type AcpConfigOptionChoice,
	type AcpConfigOptionGroup,
} from "./acp-client.ts";
import type { AntigravityRuntimeSource } from "../../core/contracts/antigravity.ts";
import {
	ANTIGRAVITY_DISABLED_TOOLS,
	ANTIGRAVITY_MANAGED_VERSION,
	ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS,
} from "./constants.ts";
import type { AntigravityRuntimeKind, ResolvedAntigravityRuntime } from "./installation.ts";
import {
	antigravityModelsCachePath,
	buildAntigravityEnvironment,
	ensureAntigravityProfile,
} from "./profile.ts";

export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export type ThinkingLevelMap = Record<ThinkingLevel, string | null>;

export type AntigravityContextWindowSource = "explicit" | "usage_update";

export interface DiscoveredAntigravityModel {
	id: string;
	name: string;
	reasoning: boolean;
	supportedThinkingLevels: ThinkingLevel[];
	thinkingLevelMap: ThinkingLevelMap;
	input: ("text" | "image")[];
	contextWindow: number | null;
	contextWindowSource?: AntigravityContextWindowSource;
	maxTokens: number | null;
}

export interface AntigravityModelsCacheRuntime {
	source: AntigravityRuntimeSource;
	kind: AntigravityRuntimeKind;
	version: string | null;
	executablePath: string;
}

export interface AntigravityModelsCache {
	version: 1;
	updatedAt: string;
	runtime?: AntigravityModelsCacheRuntime;
	models: DiscoveredAntigravityModel[];
}

export function isVerifiedManagedUsageUpdateRuntime(
	runtime: Pick<AntigravityModelsCacheRuntime, "source" | "kind" | "version"> | null | undefined,
): boolean {
	return Boolean(
		runtime &&
			runtime.kind === "acp-server" &&
			runtime.source === "managed" &&
			runtime.version === ANTIGRAVITY_MANAGED_VERSION,
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeThinkingLevelKey(raw: string): ThinkingLevel | null {
	const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
	switch (cleaned) {
		case "off":
		case "none":
		case "disabled":
		case "no_thinking":
			return "off";
		case "minimal":
		case "min":
			return "minimal";
		case "low":
			return "low";
		case "medium":
		case "med":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
		case "extra_high":
		case "very_high":
			return "xhigh";
		case "max":
			return "max";
		default:
			return null;
	}
}

export function buildThinkingConfigFromRawValues(rawValues: readonly string[]): {
	reasoning: boolean;
	supportedThinkingLevels: ThinkingLevel[];
	thinkingLevelMap: ThinkingLevelMap;
} {
	const thinkingLevelMap: ThinkingLevelMap = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};

	for (const raw of rawValues) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const normalized = normalizeThinkingLevelKey(trimmed);
		if (normalized && thinkingLevelMap[normalized] === null) {
			thinkingLevelMap[normalized] = trimmed;
		}
	}

	const hasActiveLevel = (["minimal", "low", "medium", "high", "xhigh", "max"] as const).some(
		(lvl) => thinkingLevelMap[lvl] !== null,
	);

	if (!hasActiveLevel) {
		return {
			reasoning: false,
			supportedThinkingLevels: ["off"],
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
		};
	}

	const supportedThinkingLevels = ALL_THINKING_LEVELS.filter((lvl) => thinkingLevelMap[lvl] !== null);
	return {
		reasoning: true,
		supportedThinkingLevels,
		thinkingLevelMap,
	};
}

function flattenChoices(option: AcpConfigOption): AcpConfigOptionChoice[] {
	const out: AcpConfigOptionChoice[] = [];
	const seen = new Set<string>();

	const pushChoice = (item: unknown) => {
		if (typeof item === "string") {
			const val = item.trim();
			if (val && !seen.has(val)) {
				seen.add(val);
				out.push({ value: val, name: val });
			}
			return;
		}
		if (!isPlainObject(item)) return;
		if (Array.isArray(item.options)) {
			for (const nested of item.options) pushChoice(nested);
			return;
		}
		const value = typeof item.value === "string" ? item.value.trim() : "";
		if (!value || seen.has(value)) return;
		seen.add(value);
		out.push(item as AcpConfigOptionChoice);
	};

	if (Array.isArray(option.options)) {
		for (const item of option.options as Array<AcpConfigOptionChoice | AcpConfigOptionGroup>) {
			pushChoice(item);
		}
	}
	if (out.length === 0 && Array.isArray(option.availableValues)) {
		for (const item of option.availableValues) {
			pushChoice(item);
		}
	}
	return out;
}

function configOptionId(option: AcpConfigOption): string {
	if (typeof option.id === "string" && option.id.trim()) return option.id.trim();
	if (typeof option.configId === "string" && option.configId.trim()) return option.configId.trim();
	return "";
}

export function findModelConfigOption(
	configOptions: readonly AcpConfigOption[],
): { configId: string; choices: AcpConfigOptionChoice[]; currentValue: string | null } | null {
	for (const option of configOptions) {
		const id = configOptionId(option);
		if (option.category === "model" || id === "model") {
			const choices = flattenChoices(option);
			if (choices.length > 0) {
				const rawCurrent =
					typeof option.currentValue === "string" && option.currentValue.trim()
						? option.currentValue.trim()
						: typeof option.value === "string" && option.value.trim()
							? option.value.trim()
							: null;
				return { configId: id || "model", choices, currentValue: rawCurrent };
			}
		}
	}
	return null;
}

export function findThoughtLevelConfigOption(
	configOptions: readonly AcpConfigOption[],
): { configId: string; values: string[] } | null {
	for (const option of configOptions) {
		const id = configOptionId(option);
		if (
			option.category === "thought_level" ||
			id === "thought_level" ||
			id === "thinking_level" ||
			id === "reasoning_effort"
		) {
			const choices = flattenChoices(option);
			return {
				configId: id || "thought_level",
				values: choices.map((c) => c.value),
			};
		}
	}
	return null;
}

function extractContextWindow(choice: AcpConfigOptionChoice): number | null {
	const meta = isPlainObject(choice._meta) ? choice._meta : undefined;
	for (const candidate of [
		choice.contextWindow,
		choice.context_window,
		choice.maxInputTokens,
		choice.max_input_tokens,
		meta?.contextWindow,
		meta?.context_window,
	]) {
		if (isPositiveInteger(candidate)) return candidate;
	}
	return null;
}

function extractMaxTokens(choice: AcpConfigOptionChoice): number | null {
	const meta = isPlainObject(choice._meta) ? choice._meta : undefined;
	for (const candidate of [
		choice.maxTokens,
		choice.max_tokens,
		choice.maxOutputTokens,
		choice.max_output_tokens,
		meta?.maxTokens,
		meta?.max_tokens,
	]) {
		if (isPositiveInteger(candidate)) return candidate;
	}
	return null;
}

function extractInputModalities(choice: AcpConfigOptionChoice): ("text" | "image")[] {
	const meta = isPlainObject(choice._meta) ? choice._meta : undefined;
	if (choice.supportsImages === false || meta?.supportsImages === false) {
		return ["text"];
	}
	for (const candidate of [choice.input, choice.modalities, choice.inputModalities, meta?.input]) {
		if (Array.isArray(candidate) && candidate.some((item) => typeof item === "string")) {
			const normalized = candidate.filter((item): item is "text" | "image" => item === "text" || item === "image");
			if (normalized.length > 0) return [...new Set(normalized)];
			return ["text"];
		}
	}
	return ["text", "image"];
}

function buildDiscoveredModel(
	choice: AcpConfigOptionChoice,
	thoughtValues: readonly string[],
	observedContextWindow: number | null = null,
): DiscoveredAntigravityModel {
	const { reasoning, supportedThinkingLevels, thinkingLevelMap } = buildThinkingConfigFromRawValues(thoughtValues);
	const displayName = typeof choice.name === "string" && choice.name.trim() ? choice.name.trim() : choice.value;
	const explicitContextWindow = extractContextWindow(choice);
	const contextWindow = explicitContextWindow ?? observedContextWindow;
	const contextWindowSource: AntigravityContextWindowSource | undefined =
		explicitContextWindow !== null
			? "explicit"
			: observedContextWindow !== null
				? "usage_update"
				: undefined;
	return {
		id: choice.value,
		name: displayName,
		reasoning,
		supportedThinkingLevels,
		thinkingLevelMap,
		input: extractInputModalities(choice),
		contextWindow,
		...(contextWindowSource ? { contextWindowSource } : {}),
		maxTokens: extractMaxTokens(choice),
	};
}

const VALID_RUNTIME_SOURCES = new Set<AntigravityRuntimeSource>([
	"env",
	"custom",
	"managed",
	"cli",
	"t3-external",
]);
const VALID_RUNTIME_KINDS = new Set<AntigravityRuntimeKind>(["acp-server", "cli"]);

function sanitizeCachedRuntime(raw: unknown): AntigravityModelsCacheRuntime | undefined {
	if (!isPlainObject(raw)) return undefined;
	const source =
		typeof raw.source === "string" && VALID_RUNTIME_SOURCES.has(raw.source as AntigravityRuntimeSource)
			? (raw.source as AntigravityRuntimeSource)
			: null;
	const kind =
		typeof raw.kind === "string" && VALID_RUNTIME_KINDS.has(raw.kind as AntigravityRuntimeKind)
			? (raw.kind as AntigravityRuntimeKind)
			: null;
	const executablePath =
		typeof raw.executablePath === "string" && raw.executablePath.trim() ? raw.executablePath : null;
	const version =
		raw.version === null
			? null
			: typeof raw.version === "string" && raw.version.trim()
				? raw.version.trim()
				: undefined;
	if (!source || !kind || !executablePath || version === undefined) return undefined;
	return { source, kind, version, executablePath };
}

function sanitizeCachedModel(raw: unknown): DiscoveredAntigravityModel | null {
	if (!isPlainObject(raw)) return null;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return null;
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
	const reasoning = raw.reasoning === true;

	const rawMap = isPlainObject(raw.thinkingLevelMap) ? raw.thinkingLevelMap : {};
	const thinkingLevelMap: ThinkingLevelMap = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	if (reasoning) {
		for (const level of ALL_THINKING_LEVELS) {
			const val = rawMap[level];
			thinkingLevelMap[level] = typeof val === "string" && val.trim() ? val.trim() : null;
		}
	}

	const supportedThinkingLevels = reasoning
		? ALL_THINKING_LEVELS.filter((level) => thinkingLevelMap[level] !== null)
		: (["off"] as ThinkingLevel[]);

	const effectiveReasoning = reasoning && supportedThinkingLevels.some((level) => level !== "off");
	if (!effectiveReasoning) {
		for (const level of ALL_THINKING_LEVELS) thinkingLevelMap[level] = null;
	}

	const rawInput = Array.isArray(raw.input) ? raw.input : ["text", "image"];
	const inputSet = new Set<"text" | "image">();
	for (const entry of rawInput) {
		if (entry === "text" || entry === "image") inputSet.add(entry);
	}
	if (inputSet.size === 0) inputSet.add("text");

	const contextWindow = isPositiveInteger(raw.contextWindow) ? raw.contextWindow : null;
	const contextWindowSource: AntigravityContextWindowSource | undefined =
		contextWindow !== null && (raw.contextWindowSource === "explicit" || raw.contextWindowSource === "usage_update")
			? raw.contextWindowSource
			: undefined;

	return {
		id,
		name,
		reasoning: effectiveReasoning,
		supportedThinkingLevels: effectiveReasoning ? supportedThinkingLevels : ["off"],
		thinkingLevelMap,
		input: [...inputSet],
		contextWindow,
		...(contextWindowSource ? { contextWindowSource } : {}),
		maxTokens: isPositiveInteger(raw.maxTokens) ? raw.maxTokens : null,
	};
}

export function readAntigravityModelsCache(
	options: { dataDir?: string; env?: Record<string, string | undefined> } = {},
): AntigravityModelsCache | null {
	const cachePath = antigravityModelsCachePath(options);
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
		if (!isPlainObject(raw) || raw.version !== 1 || !Array.isArray(raw.models)) return null;
		const models = raw.models.map(sanitizeCachedModel).filter((m): m is DiscoveredAntigravityModel => m !== null);
		if (models.length === 0) return null;
		const runtime = sanitizeCachedRuntime(raw.runtime);
		return {
			version: 1,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
			...(runtime ? { runtime } : {}),
			models,
		};
	} catch {
		return null;
	}
}

export function hasCachedAntigravityModels(
	options: { dataDir?: string; env?: Record<string, string | undefined> } = {},
): boolean {
	const cache = readAntigravityModelsCache(options);
	return cache !== null && cache.models.length > 0;
}

export function writeAntigravityModelsCache(
	models: DiscoveredAntigravityModel[],
	options: {
		dataDir?: string;
		env?: Record<string, string | undefined>;
		updatedAt?: string;
		runtime?: AntigravityModelsCacheRuntime;
	} = {},
): AntigravityModelsCache {
	const runtime = options.runtime
		? {
				source: options.runtime.source,
				kind: options.runtime.kind,
				version: options.runtime.version,
				executablePath: options.runtime.executablePath,
			}
		: undefined;
	const cache: AntigravityModelsCache = {
		version: 1,
		updatedAt: options.updatedAt ?? new Date().toISOString(),
		...(runtime ? { runtime } : {}),
		models,
	};
	const cachePath = antigravityModelsCachePath(options);
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.tmp.${process.pid}.${randomUUID()}`;
	fs.writeFileSync(tmp, `${JSON.stringify(cache, null, "\t")}\n`, { encoding: "utf8", mode: 0o644 });
	fs.renameSync(tmp, cachePath);
	return cache;
}

export interface DiscoverAntigravityModelsOptions {
	authFile?: string;
	dataDir?: string;
	env?: Record<string, string | undefined>;
	homeDir?: string;
	platform?: NodeJS.Platform;
	spawnProcess?: typeof spawn;
	modelProbeTimeoutMs?: number;
	stdoutDrainMs?: number;
}

export async function discoverAntigravityModels(
	runtime: ResolvedAntigravityRuntime,
	options: DiscoverAntigravityModelsOptions = {},
): Promise<AntigravityModelsCache> {
	const platform = options.platform ?? process.platform;
	const baseEnv = options.env ?? process.env;
	const modelProbeTimeoutMs = options.modelProbeTimeoutMs ?? ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS;
	// Google's pinned managed agy_acp_server (1.4.5) awaits _send_usage_update
	// before replying to session/set_config_option when switching to a different model,
	// omitting it only when get_context_window_size(model_id) returns None (unknown limit),
	// and returns early without _send_usage_update when model_id === current_model_id.
	// Pre-reply ordering is verified only for that pinned managed build; custom, external,
	// or unpinned acp-server binaries and standalone agy (kind === "cli") never infer
	// contextWindow from usage_update (keeping explicit choice metadata or null; live
	// turns capture cliContextWindow in stream.ts).
	const allowUsageUpdateInference = isVerifiedManagedUsageUpdateRuntime(runtime);

	const profileDir = ensureAntigravityProfile({
		authFile: options.authFile,
		env: baseEnv,
		homeDir: options.homeDir,
		platform,
	});

	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-models-"));
	const cwd = path.join(runDir, "cwd");
	const tempDir = path.join(runDir, "tmp");
	fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
	fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

	const env = buildAntigravityEnvironment({
		baseEnv,
		geminiHome: profileDir,
		tempDir,
		harnessPath: runtime.harnessPath,
		platform,
	});

	let activeSessionId: string | null = null;
	let latestConfigOptions: AcpConfigOption[] | undefined;
	let configUpdateGeneration = 0;
	let initialModelId: string | null = null;
	let activeModelId: string | null = null;
	let initialSessionContextWindow: number | null = null;
	let usageStreamTainted = false;
	let inModelProbe = false;
	let completedAtLeastOneProbe = false;
	let usageUpdatesInCurrentProbe = 0;
	let usageWindowInCurrentProbe: number | null = null;

	const discovered: DiscoveredAntigravityModel[] = [];
	const knownModelWindows = new Map<string, number>();
	const initialSessionInferredIndices = new Set<number>();

	const preSessionConfigOptions = new Map<string, AcpConfigOption[]>();
	const preSessionUsageWindow = new Map<string, number>();

	const taintForOutOfOrderUsage = (): void => {
		usageStreamTainted = true;
		initialSessionContextWindow = null;
		knownModelWindows.clear();
		usageWindowInCurrentProbe = null;
		usageUpdatesInCurrentProbe = 0;
		// Any earlier entry that relied on session/new + same-model silence assumed strict
		// pre-reply ordering; clear those back to null while preserving explicit choice
		// metadata and directly observed single-update entries.
		for (const idx of initialSessionInferredIndices) {
			const entry = discovered[idx];
			if (entry) {
				const clearedEntry: DiscoveredAntigravityModel = { ...entry, contextWindow: null };
				delete clearedEntry.contextWindowSource;
				discovered[idx] = clearedEntry;
			}
		}
		initialSessionInferredIndices.clear();
	};

	const client = spawnAcpClient({
		cwd,
		env,
		runtime,
		profileDir,
		platform,
		spawnProcess: options.spawnProcess,
		onRpcSettled: (method) => {
			if (method === "session/set_config_option") {
				inModelProbe = false;
				completedAtLeastOneProbe = true;
			}
		},
		onSessionUpdate: (sessionId, update) => {
			if (activeSessionId !== null) {
				if (sessionId !== undefined && sessionId !== activeSessionId) {
					return;
				}
				if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
					latestConfigOptions = update.configOptions;
					configUpdateGeneration++;
				}
				if (allowUsageUpdateInference && update.sessionUpdate === "usage_update") {
					const size = update.size;
					if (typeof size === "number" && Number.isFinite(size) && size > 0) {
						const rounded = Math.round(size);
						if (usageStreamTainted) {
							return;
						}
						if (inModelProbe) {
							usageUpdatesInCurrentProbe++;
							if (usageUpdatesInCurrentProbe > 1) {
								// Multiple usage_update notifications landed during a single probe
								// (e.g., a delayed update from a prior switch overlapped this one).
								taintForOutOfOrderUsage();
								return;
							}
							usageWindowInCurrentProbe = rounded;
							return;
						}
						if (completedAtLeastOneProbe) {
							// Out-of-band usage_update arrived outside an active probe after a
							// completed model switch (including in the same stdout chunk after
							// the reply), violating pre-reply ordering.
							taintForOutOfOrderUsage();
							return;
						}
						// Deferred initial usage_update from session/new before the first probe begins.
						initialSessionContextWindow = rounded;
					}
				}
				return;
			}

			// Before session/new returns sessionId, buffer per-session updates so only
			// notifications matching the created sessionId (or sessionless ones) apply.
			const key = sessionId ?? "";
			if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
				preSessionConfigOptions.set(key, update.configOptions);
			}
			if (allowUsageUpdateInference && update.sessionUpdate === "usage_update") {
				const size = update.size;
				if (typeof size === "number" && Number.isFinite(size) && size > 0) {
					preSessionUsageWindow.set(key, Math.round(size));
				}
			}
		},
	});

	const probeModelConfig = async (sessionId: string, configId: string, value: string) => {
		inModelProbe = true;
		usageUpdatesInCurrentProbe = 0;
		usageWindowInCurrentProbe = null;
		try {
			return await client.setConfigOption(sessionId, configId, value, modelProbeTimeoutMs);
		} finally {
			inModelProbe = false;
			completedAtLeastOneProbe = true;
		}
	};

	const resolveObservedContextWindow = (
		modelId: string,
		prevActiveModelId: string | null,
	): { contextWindow: number | null; inferredFromInitial: boolean } => {
		if (!allowUsageUpdateInference || usageStreamTainted) {
			return { contextWindow: null, inferredFromInitial: false };
		}
		if (usageUpdatesInCurrentProbe === 1 && usageWindowInCurrentProbe !== null) {
			knownModelWindows.set(modelId, usageWindowInCurrentProbe);
			return {
				contextWindow: usageWindowInCurrentProbe,
				inferredFromInitial: prevActiveModelId === modelId && modelId === initialModelId,
			};
		}
		// Only a confirmed same-model no-op (prevActiveModelId === modelId) may reuse a
		// known window or the deferred session/new window. Switching to a different model
		// that replies silently means unknown limit (None) and must preserve null.
		if (usageUpdatesInCurrentProbe === 0 && prevActiveModelId === modelId) {
			const known = knownModelWindows.get(modelId);
			if (known !== undefined) {
				return { contextWindow: known, inferredFromInitial: false };
			}
			if (modelId === initialModelId && initialSessionContextWindow !== null) {
				knownModelWindows.set(modelId, initialSessionContextWindow);
				return { contextWindow: initialSessionContextWindow, inferredFromInitial: true };
			}
		}
		return { contextWindow: null, inferredFromInitial: false };
	};

	const handleProbeFailure = (err: unknown): void => {
		activeModelId = null;
		usageWindowInCurrentProbe = null;
		usageUpdatesInCurrentProbe = 0;
		// A non-RPC-error rejection (such as AcpTimeoutError) leaves the server-side
		// switch in flight, so a late usage_update cannot be unambiguously attributed
		// to subsequent models on this session.
		if (!(err instanceof AcpRpcError)) {
			usageStreamTainted = true;
		}
	};

	try {
		await client.initialize();
		const sessionResult = await client.sessionNew({
			cwd,
			mcpServers: [],
			disabledTools: [...ANTIGRAVITY_DISABLED_TOOLS],
		});

		activeSessionId = sessionResult.sessionId;
		const bufferedConfig = preSessionConfigOptions.get(activeSessionId) ?? preSessionConfigOptions.get("");
		if (bufferedConfig) {
			latestConfigOptions = bufferedConfig;
			configUpdateGeneration++;
		}
		if (allowUsageUpdateInference) {
			const bufferedUsage = preSessionUsageWindow.get(activeSessionId) ?? preSessionUsageWindow.get("");
			if (bufferedUsage !== undefined) {
				initialSessionContextWindow = bufferedUsage;
			}
		}
		preSessionConfigOptions.clear();
		preSessionUsageWindow.clear();

		const initialConfigOptions = Array.isArray(sessionResult.configOptions)
			? sessionResult.configOptions
			: (latestConfigOptions ?? []);

		const modelOption = findModelConfigOption(initialConfigOptions);
		if (!modelOption || modelOption.choices.length === 0) {
			throw new Error("Antigravity ACP did not advertise any available models.");
		}

		initialModelId = modelOption.currentValue;
		activeModelId = initialModelId;

		const initialThoughtOption = findThoughtLevelConfigOption(initialConfigOptions);
		const fallbackThoughtValues = initialThoughtOption?.values ?? [];

		const backfillCandidates: Array<{ index: number; choice: AcpConfigOptionChoice }> = [];

		for (const choice of modelOption.choices) {
			if (client.isClosed()) {
				discovered.push(buildDiscoveredModel(choice, fallbackThoughtValues));
				continue;
			}

			const genBefore = configUpdateGeneration;
			const prevActiveModelId = activeModelId;
			try {
				const res = await probeModelConfig(sessionResult.sessionId, modelOption.configId, choice.value);
				activeModelId = choice.value;

				let perModelOptions: AcpConfigOption[] | undefined;
				if (Array.isArray(res.configOptions)) {
					perModelOptions = res.configOptions;
				} else if (configUpdateGeneration > genBefore && latestConfigOptions) {
					perModelOptions = latestConfigOptions;
				}

				const thoughtValues = perModelOptions
					? (findThoughtLevelConfigOption(perModelOptions)?.values ?? [])
					: fallbackThoughtValues;
				const explicitContextWindow = extractContextWindow(choice);
				const observed = resolveObservedContextWindow(choice.value, prevActiveModelId);
				const modelEntry = buildDiscoveredModel(choice, thoughtValues, observed.contextWindow);
				const idx = discovered.push(modelEntry) - 1;
				if (explicitContextWindow === null && observed.inferredFromInitial) {
					initialSessionInferredIndices.add(idx);
				}
				if (
					allowUsageUpdateInference &&
					modelEntry.contextWindow === null &&
					(prevActiveModelId === choice.value || prevActiveModelId === null)
				) {
					backfillCandidates.push({ index: idx, choice });
				}
			} catch (err) {
				// Graceful fallback per model on bounded timeout or per-model error.
				handleProbeFailure(err);
				discovered.push(buildDiscoveredModel(choice, fallbackThoughtValues));
			}
		}

		// Re-probe any same-model no-op candidates that stayed null (e.g., the initial active
		// model when session/new had not emitted usage_update before Pass 1) once a switch to
		// another model has changed activeModelId.
		if (allowUsageUpdateInference && !usageStreamTainted && backfillCandidates.length > 0 && !client.isClosed()) {
			for (const { index, choice } of backfillCandidates) {
				if (client.isClosed() || usageStreamTainted) break;
				if (discovered[index]?.contextWindow !== null) continue;
				if (activeModelId === choice.value) continue;
				const prevActiveModelId = activeModelId;
				try {
					await probeModelConfig(sessionResult.sessionId, modelOption.configId, choice.value);
					activeModelId = choice.value;
					const observed = resolveObservedContextWindow(choice.value, prevActiveModelId);
					if (observed.contextWindow !== null) {
						discovered[index] = {
							...discovered[index]!,
							contextWindow: observed.contextWindow,
							contextWindowSource: "usage_update",
						};
						if (observed.inferredFromInitial) {
							initialSessionInferredIndices.add(index);
						}
					}
				} catch (err) {
					// Keep null on bounded timeout or error during backfill and invalidate active model tracking.
					handleProbeFailure(err);
				}
			}
		}

		// Close and drain the ACP child/reader before writing models.json so any
		// trailing out-of-order usage_update arriving during shutdown taints
		// `discovered` before disk persistence (matching the returned cache). If
		// stdout cannot drain within the bounded window, taint session-inferred
		// entries conservatively.
		await client.close({ stdoutDrainMs: options.stdoutDrainMs }).catch(() => {});
		if (!client.isStdoutDrained()) {
			taintForOutOfOrderUsage();
		}

		return writeAntigravityModelsCache(discovered, {
			dataDir: options.dataDir,
			env: baseEnv,
			runtime: {
				source: runtime.source,
				kind: runtime.kind,
				version: runtime.version,
				executablePath: runtime.executablePath,
			},
		});
	} finally {
		await client.close({ stdoutDrainMs: options.stdoutDrainMs }).catch(() => {});
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}
