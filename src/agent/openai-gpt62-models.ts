import { isModelType, type AnyModel, type Model, type Provider } from "@earendil-works/pi-ai";

// Backport Pi's direct OpenAI records until the pinned release includes them:
// https://github.com/earendil-works/pi/commit/e56d35ce5eceedfa16eaf13a5f01a1f7b7271253
const shared = {
	type: "chat",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	inputLimits: {
		maxRequestBytes: 512 * 1024 * 1024,
		images: { maxPerRequest: 1500, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 } },
	},
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	// Pi caps direct OpenAI models at the short-context pricing threshold.
	contextWindow: 272_000,
	maxTokens: 128_000,
	compat: {
		supportsStrictMode: true,
		supportsOpenAIGrammarTools: true,
		supportsAdditionalTools: true,
		supportsToolSearch: true,
		supportsMidConvoSystemMessages: true,
		supportsExplicitPromptCacheMode: true,
		supportsMidConvoEffort: true,
	},
} satisfies Omit<Model<"openai-responses">, "id" | "name" | "cost">;

const models: Model<"openai-responses">[] = [
	{
		...shared, id: "gpt-6.2-astra", name: "GPT-6.2 Astra",
		cost: {
			input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
			tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
		},
	},
	{
		...shared, id: "gpt-6.2-sol", name: "GPT-6.2 Sol",
		cost: {
			input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
		},
	},
];

function addMissing<T extends AnyModel>(catalog: readonly T[]): readonly (T | Model<"openai-responses">)[] {
	const missing = models.filter(({ id }) => !catalog.some((model) => model.id === id && isModelType(model, "chat")));
	return missing.length ? [...catalog, ...missing] : catalog;
}

export function withOpenAIGpt62Models(provider: Provider): Provider {
	if (provider.id !== "openai") return provider;
	const native = provider.getModels();
	if (addMissing(native) === native) return provider;
	return {
		...provider,
		getModels: () => addMissing(provider.getModels()),
		getAllModels: () => addMissing(provider.getAllModels?.() ?? provider.getModels()),
	};
}
