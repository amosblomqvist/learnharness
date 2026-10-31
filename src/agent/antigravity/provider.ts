import { createProvider, type Api, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

// Default follows the user's CLI model. Explicit slugs fail if the account lacks access.
const MODELS = [
	["default", "Antigravity · CLI default"],
	["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
	["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
	["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
	["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
	["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
] as const;

export const ANTIGRAVITY_MODELS: Model<Api>[] = MODELS.map(([id, name]) => ({
	id, name, api: "antigravity-cli", provider: ANTIGRAVITY_PROVIDER, baseUrl: "",
	input: ["text", "image"], reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	// Internal compaction budgets only; effective CLI limits and prices are unknown.
	contextWindow: 128_000, maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

export function createAntigravityProvider(stream: StreamFunction<Api, SimpleStreamOptions>) {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER, name: "Google Antigravity CLI",
		auth: { apiKey: { name: "Google account sign-in", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: ANTIGRAVITY_MODELS, api: { stream, streamSimple: stream },
	});
}
