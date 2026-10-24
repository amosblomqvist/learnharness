import {
	createProvider,
	envApiKeyAuth,
	type AnthropicMessagesCompat,
	type Model,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	type Provider,
	type RefreshModelsContext,
	type ThinkingLevel,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	COMMANDCODE_METADATA,
	COMMANDCODE_SNAPSHOT,
	type CommandCodeApi,
	type CommandCodeModelMetadata,
} from "./commandcode-models.generated.ts";

/**
 * Command Code (commandcode.ai) Provider API — OpenAI Chat Completions,
 * OpenAI Responses and Anthropic Messages wires behind one plain API key.
 * https://commandcode.ai/docs/provider
 *
 * The endpoint serves Claude models on /messages only and advertises which
 * other models also accept /responses; every remaining model answers on
 * /chat/completions. The per-model `api` + `baseUrl` below follow that rule.
 */
export const COMMANDCODE_PROVIDER_ID = "commandcode";
export const COMMANDCODE_API_KEY_ENV = "COMMAND_CODE_API_KEY";
export const COMMANDCODE_MODELS_URL =
	process.env.COMMAND_CODE_MODELS_URL ?? "https://api.commandcode.ai/provider/v1/models";

const API_BASE = "https://api.commandcode.ai/provider/v1";
const MODELS_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 65_536;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const MODEL_EFFORT_LEVELS: readonly ThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** One catalog entry as the provider needs it (snapshot or live refresh). */
export interface CommandCodeCatalogEntry {
	id: string;
	name: string;
	api: CommandCodeApi;
	contextWindow: number;
}

/** The Anthropic SDK appends /v1/messages, so its base URL stops before /v1. */
function baseUrlFor(api: CommandCodeApi): string {
	return api === "anthropic-messages" ? API_BASE.slice(0, -"/v1".length) : API_BASE;
}

function thinkingLevelMapFor(efforts: readonly string[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = {};
	for (const level of MODEL_EFFORT_LEVELS) {
		map[level] = efforts.includes(level) ? level : null;
	}
	return map;
}

function compatFor(api: CommandCodeApi, reasoning: boolean): Model<CommandCodeApi>["compat"] {
	if (api === "openai-responses") {
		return {
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
			sessionAffinityFormat: "openai-nosession",
		} satisfies OpenAIResponsesCompat;
	}
	if (api === "anthropic-messages") {
		return {
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: false,
			supportsCacheControlOnTools: false,
			...(reasoning ? { forceAdaptiveThinking: true } : {}),
		} as AnthropicMessagesCompat;
	}
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		maxTokensField: "max_tokens",
	} satisfies OpenAICompletionsCompat;
}

function metadataFor(id: string): CommandCodeModelMetadata | undefined {
	return COMMANDCODE_METADATA[id];
}

/** Build one pi-ai model from a catalog entry + its capability metadata. */
export function commandCodeModel(entry: CommandCodeCatalogEntry): Model<CommandCodeApi> {
	const meta = metadataFor(entry.id);
	const reasoning = meta?.reasoning ?? false;
	return {
		id: entry.id,
		name: entry.name,
		api: entry.api,
		provider: COMMANDCODE_PROVIDER_ID,
		baseUrl: baseUrlFor(entry.api),
		input: meta ? [...meta.input] : ["text"],
		cost: meta?.cost ?? ZERO_COST,
		contextWindow: entry.contextWindow,
		maxTokens: Math.min(entry.contextWindow, meta?.maxTokens ?? DEFAULT_MAX_TOKENS),
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMapFor(meta?.efforts ?? []) } : {}),
		compat: compatFor(entry.api, reasoning),
	};
}

function apiForModelId(id: string, endpoints: readonly string[] | undefined): CommandCodeApi {
	if (id.startsWith("claude-")) return "anthropic-messages";
	return endpoints?.includes("/responses") ? "openai-responses" : "openai-completions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parse GET /provider/v1/models into catalog entries. */
export function parseCommandCodeCatalog(body: unknown): CommandCodeCatalogEntry[] {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new Error("Command Code model list response has no data array");
	}
	return body.data.map((value) => {
		if (!isRecord(value)) throw new Error("Command Code model entry is not an object");
		const { id, name, context_length, supported_endpoints } = value;
		if (typeof id !== "string" || typeof name !== "string" || typeof context_length !== "number") {
			throw new Error("Command Code model entry is missing id/name/context_length");
		}
		const endpoints = Array.isArray(supported_endpoints)
			? supported_endpoints.filter((entry): entry is string => typeof entry === "string")
			: undefined;
		return { id, name, api: apiForModelId(id, endpoints), contextWindow: context_length };
	});
}

async function fetchModels(
	context: RefreshModelsContext,
): Promise<readonly Model<CommandCodeApi>[]> {
	const response = await fetch(COMMANDCODE_MODELS_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`Command Code model list request failed: ${response.status}`);
	}
	return parseCommandCodeCatalog(await response.json()).map(commandCodeModel);
}

/** The Command Code provider: static snapshot + live catalog overlay. */
export function commandCodeProvider(): Provider<CommandCodeApi> {
	return createProvider<CommandCodeApi>({
		id: COMMANDCODE_PROVIDER_ID,
		name: "Command Code",
		baseUrl: API_BASE,
		auth: {
			apiKey: envApiKeyAuth("Command Code API key", [COMMANDCODE_API_KEY_ENV]),
		},
		models: COMMANDCODE_SNAPSHOT.map(commandCodeModel),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
		fetchModels,
	});
}
