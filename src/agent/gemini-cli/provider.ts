import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { EXTERNAL_CLI_PROVIDERS } from "../../core/contracts/external-cli.ts";

const GEMINI_CLI_API = "gemini-cli" as Api;

const SHARED_MODEL_FIELDS = {
	api: GEMINI_CLI_API,
	provider: EXTERNAL_CLI_PROVIDERS.geminiCli,
	baseUrl: "",
	input: ["text"],
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const GEMINI_CLI_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "pro", name: "Gemini Pro" },
	{ ...SHARED_MODEL_FIELDS, id: "flash", name: "Gemini Flash" },
	{ ...SHARED_MODEL_FIELDS, id: "flash-lite", name: "Gemini Flash-Lite" },
];

export function createGeminiCliProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: EXTERNAL_CLI_PROVIDERS.geminiCli,
		name: "Gemini CLI",
		auth: { apiKey: { name: "Gemini CLI", resolve: async () => ({ auth: {}, source: "gemini CLI" }) } },
		models: GEMINI_CLI_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
