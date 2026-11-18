import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	spawnAcpClient,
	type AcpConfigOption,
	type AcpConfigOptionChoice,
	type AcpConfigOptionGroup,
} from "./acp-client.ts";
import { ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS } from "./constants.ts";
import type { ResolvedAntigravityRuntime } from "./installation.ts";
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

export interface DiscoveredAntigravityModel {
	id: string;
	name: string;
	reasoning: boolean;
	supportedThinkingLevels: ThinkingLevel[];
	thinkingLevelMap: ThinkingLevelMap;
	input: ("text" | "image")[];
	contextWindow: number | null;
	maxTokens: number | null;
}

export interface AntigravityModelsCache {
	version: 1;
	updatedAt: string;
	models: DiscoveredAntigravityModel[];
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
): { configId: string; choices: AcpConfigOptionChoice[] } | null {
	for (const option of configOptions) {
		const id = configOptionId(option);
		if (option.category === "model" || id === "model") {
			const choices = flattenChoices(option);
			if (choices.length > 0) {
				return { configId: id || "model", choices };
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
): DiscoveredAntigravityModel {
	const { reasoning, supportedThinkingLevels, thinkingLevelMap } = buildThinkingConfigFromRawValues(thoughtValues);
	const displayName = typeof choice.name === "string" && choice.name.trim() ? choice.name.trim() : choice.value;
	return {
		id: choice.value,
		name: displayName,
		reasoning,
		supportedThinkingLevels,
		thinkingLevelMap,
		input: extractInputModalities(choice),
		contextWindow: extractContextWindow(choice),
		maxTokens: extractMaxTokens(choice),
	};
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

	return {
		id,
		name,
		reasoning: effectiveReasoning,
		supportedThinkingLevels: effectiveReasoning ? supportedThinkingLevels : ["off"],
		thinkingLevelMap,
		input: [...inputSet],
		contextWindow: isPositiveInteger(raw.contextWindow) ? raw.contextWindow : null,
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
		return {
			version: 1,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
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
	options: { dataDir?: string; env?: Record<string, string | undefined>; updatedAt?: string } = {},
): AntigravityModelsCache {
	const cache: AntigravityModelsCache = {
		version: 1,
		updatedAt: options.updatedAt ?? new Date().toISOString(),
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
}

export async function discoverAntigravityModels(
	runtime: ResolvedAntigravityRuntime,
	options: DiscoverAntigravityModelsOptions = {},
): Promise<AntigravityModelsCache> {
	const platform = options.platform ?? process.platform;
	const baseEnv = options.env ?? process.env;
	const modelProbeTimeoutMs = options.modelProbeTimeoutMs ?? ANTIGRAVITY_MODEL_PROBE_TIMEOUT_MS;

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

	let latestConfigOptions: AcpConfigOption[] | undefined;
	let configUpdateGeneration = 0;

	const client = spawnAcpClient({
		cwd,
		env,
		runtime,
		profileDir,
		platform,
		spawnProcess: options.spawnProcess,
		onSessionUpdate: (_sessionId, update) => {
			if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
				latestConfigOptions = update.configOptions;
				configUpdateGeneration++;
			}
		},
	});

	try {
		await client.initialize();
		const sessionResult = await client.sessionNew({
			cwd,
			mcpServers: [],
			disabledTools: ["run_workflow"],
		});

		const initialConfigOptions = Array.isArray(sessionResult.configOptions)
			? sessionResult.configOptions
			: (latestConfigOptions ?? []);

		const modelOption = findModelConfigOption(initialConfigOptions);
		if (!modelOption || modelOption.choices.length === 0) {
			throw new Error("Antigravity ACP did not advertise any available models.");
		}

		const initialThoughtOption = findThoughtLevelConfigOption(initialConfigOptions);
		const fallbackThoughtValues = initialThoughtOption?.values ?? [];

		const discovered: DiscoveredAntigravityModel[] = [];

		for (const choice of modelOption.choices) {
			if (client.isClosed()) {
				discovered.push(buildDiscoveredModel(choice, fallbackThoughtValues));
				continue;
			}

			const genBefore = configUpdateGeneration;
			try {
				const res = await client.setConfigOption(
					sessionResult.sessionId,
					modelOption.configId,
					choice.value,
					modelProbeTimeoutMs,
				);

				let perModelOptions: AcpConfigOption[] | undefined;
				if (Array.isArray(res.configOptions)) {
					perModelOptions = res.configOptions;
				} else if (configUpdateGeneration > genBefore && latestConfigOptions) {
					perModelOptions = latestConfigOptions;
				}

				if (perModelOptions) {
					const perModelThought = findThoughtLevelConfigOption(perModelOptions);
					discovered.push(buildDiscoveredModel(choice, perModelThought?.values ?? []));
				} else {
					discovered.push(buildDiscoveredModel(choice, fallbackThoughtValues));
				}
			} catch {
				// Graceful fallback per model on bounded timeout or per-model error.
				discovered.push(buildDiscoveredModel(choice, fallbackThoughtValues));
			}
		}

		return writeAntigravityModelsCache(discovered, {
			dataDir: options.dataDir,
			env: baseEnv,
		});
	} finally {
		await client.close().catch(() => {});
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}
