import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const NINEROUTER_PROVIDER_ID = "9router";
export const DEFAULT_NINEROUTER_BASE_URL = "http://127.0.0.1:20128/v1";

let cachedLocalKey: { value?: string; checkedAt: number } | undefined;
const KEY_CACHE_TTL_MS = 10_000;

// ponytail: local key fallback checks %APPDATA%/9router/db/data.sqlite on Windows or ~/.config/9router on POSIX.
/** Read local 9router active API key from SQLite if available. Cached for 10s to avoid sync disk thrashing. */
export function resolveLocal9RouterKey(): string | undefined {
	const now = Date.now();
	if (cachedLocalKey && now - cachedLocalKey.checkedAt < KEY_CACHE_TTL_MS) {
		return cachedLocalKey.value;
	}

	const appData = process.env.APPDATA || (process.env.HOME ? path.join(process.env.HOME, ".config") : "");
	if (!appData) {
		cachedLocalKey = { value: undefined, checkedAt: now };
		return undefined;
	}
	const dbPath = path.join(appData, "9router", "db", "data.sqlite");
	if (!fs.existsSync(dbPath)) {
		cachedLocalKey = { value: undefined, checkedAt: now };
		return undefined;
	}
	try {
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db.prepare("SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1").get() as { key?: string } | undefined;
		db.close();
		cachedLocalKey = { value: row?.key, checkedAt: now };
		return row?.key;
	} catch {
		cachedLocalKey = { value: undefined, checkedAt: now };
		return undefined;
	}
}

export function nineRouterApiKey(): string | undefined {
	if (process.env.LH_IGNORE_ENV_KEYS === "1") return process.env.NINEROUTER_API_KEY || undefined;
	return process.env.NINEROUTER_API_KEY || resolveLocal9RouterKey();
}

export function nineRouterBaseUrl(): string {
	return (process.env.NINEROUTER_BASE_URL || DEFAULT_NINEROUTER_BASE_URL).replace(/\/+$/, "");
}

interface Raw9RouterModel {
	id: string;
	context_length?: number;
	max_completion_tokens?: number;
	capabilities?: {
		vision?: boolean;
		reasoning?: boolean;
	};
}

function makeModel(raw: Raw9RouterModel, baseUrl: string): Model<"openai-completions"> {
	const isVision = Boolean(raw.capabilities?.vision);
	return {
		id: raw.id,
		name: raw.id,
		api: "openai-completions",
		provider: NINEROUTER_PROVIDER_ID,
		baseUrl,
		reasoning: Boolean(raw.capabilities?.reasoning),
		input: isVision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: raw.context_length || 128000,
		maxTokens: raw.max_completion_tokens || 8192,
	};
}

const BASELINE_MODELS: Raw9RouterModel[] = [
	{ id: "ag/gemini-3.8-flash", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-3.8-flash-high", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-3.8-flash-medium", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-3.8-flash-low", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-4-argon-high", context_length: 1048576, max_completion_tokens: 32768, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-4-argon-medium", context_length: 1048576, max_completion_tokens: 32768, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-4-argon-low", context_length: 1048576, max_completion_tokens: 32768, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-3.1-pro-high", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/gemini-3.1-pro-low", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-sonnet-5-5", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: false } },
	{ id: "ag/claude-sonnet-5-5-high", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-sonnet-5-5-medium", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-sonnet-5-5-low", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-opus-5-5", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: false } },
	{ id: "ag/claude-opus-5-5-high", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-opus-5-5-medium", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "ag/claude-opus-5-5-low", context_length: 200000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3.8-flash", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3.7-flash", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3.6-flash", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3.5-flash-lite", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3.1-flash-lite-preview", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-3-flash-preview", context_length: 1048576, max_completion_tokens: 65536, capabilities: { vision: true, reasoning: true } },
	{ id: "gemini/gemini-4-argon", context_length: 1048576, max_completion_tokens: 32768, capabilities: { vision: true, reasoning: true } },
	{ id: "dahl/zai-org/GLM-5.3-Flash", context_length: 1000000, max_completion_tokens: 128000, capabilities: { vision: false, reasoning: true } },
	{ id: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731", context_length: 1000000, max_completion_tokens: 384000, capabilities: { vision: false, reasoning: true } },
	{ id: "dahl/MiniMaxAI/MiniMax-M2.7", context_length: 204800, max_completion_tokens: 131072, capabilities: { vision: true, reasoning: true } },
	{ id: "mmf/mimo-auto", context_length: 262144, max_completion_tokens: 131072, capabilities: { vision: true, reasoning: true } },
	{ id: "oc/jev-1.13-free", context_length: 128000, max_completion_tokens: 8192, capabilities: { vision: false, reasoning: false } },
	{ id: "oc/mimo-v2.6-flash-free", context_length: 128000, max_completion_tokens: 8192, capabilities: { vision: true, reasoning: true } },
	{ id: "oc/space-bunny-free", context_length: 128000, max_completion_tokens: 8192, capabilities: { vision: false, reasoning: false } },
	{ id: "oc/nemotron-3-ultra-free", context_length: 128000, max_completion_tokens: 8192, capabilities: { vision: false, reasoning: true } },
];

export function nineRouterProvider() {
	const baseUrl = nineRouterBaseUrl();

	return createProvider({
		id: NINEROUTER_PROVIDER_ID,
		name: "9router",
		baseUrl,
		auth: {
			apiKey: {
				name: "9router API key",
				login: async (interaction) => {
					interaction.signal.throwIfAborted();
					const key = await interaction.prompt({ type: "secret", message: "Enter 9router API key" });
					interaction.signal.throwIfAborted();
					return { type: "api_key", key };
				},
				resolve: async ({ ctx, credential, signal }) => {
					signal.throwIfAborted();
					if (credential?.key) {
						return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
					}
					const envKey = await ctx.env("NINEROUTER_API_KEY");
					signal.throwIfAborted();
					if (envKey) return { auth: { apiKey: envKey }, source: "NINEROUTER_API_KEY" };
					if (process.env.LH_IGNORE_ENV_KEYS !== "1") {
						const localKey = resolveLocal9RouterKey();
						if (localKey) return { auth: { apiKey: localKey }, source: "local 9router" };
					}
					return undefined;
				},
			},
		},
		models: BASELINE_MODELS.map((m) => makeModel(m, baseUrl)),
		fetchModels: async (context) => {
			const key = context.credential?.type === "api_key" ? context.credential.key : nineRouterApiKey();
			try {
				const res = await fetch(`${baseUrl}/models`, {
					headers: {
						accept: "application/json",
						...(key ? { authorization: `Bearer ${key}` } : {}),
					},
					signal: context.signal,
				});
				if (!res.ok) return [];
				const body = (await res.json()) as { data?: Raw9RouterModel[] };
				if (!Array.isArray(body?.data)) return [];
				return body.data.map((m) => makeModel(m, baseUrl));
			} catch {
				return [];
			}
		},
		api: {
			"openai-completions": openAICompletionsApi(),
		},
	});
}
