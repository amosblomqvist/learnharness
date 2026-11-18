import { createProvider, type Api, type Model, type SimpleStreamOptions, type StreamFunction, type ThinkingLevel } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

// One entry per model family; the thinking level goes to the CLI as --effort.
// Families and efforts follow `agy models` (CLI 1.5.11). The CLI has no
// version-less aliases, so new families need a manual update here.
// Default follows the user's CLI model. Explicit slugs fail if the account lacks access.
const MODELS: readonly (readonly [id: string, name: string, efforts: readonly ThinkingLevel[]])[] = [
	["default", "Antigravity · CLI default", ["low", "medium", "high"]],
	["gemini-4-hydrogen", "Gemini 4 Hydrogen", ["low", "medium", "high", "xhigh"]],
	["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
	["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]],
	["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]],
	["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]],
	["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
];

type MapLevel = keyof NonNullable<Model<Api>["thinkingLevelMap"]>;
const LEVELS: readonly MapLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const ANTIGRAVITY_MODELS: Model<Api>[] = MODELS.map(([id, name, efforts]) => ({
	id, name, api: "antigravity-cli", provider: ANTIGRAVITY_PROVIDER, baseUrl: "",
	input: ["text", "image"], reasoning: true,
	thinkingLevelMap: Object.fromEntries(LEVELS.map((level) => [level, (efforts as readonly MapLevel[]).includes(level) ? level : null])),
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
