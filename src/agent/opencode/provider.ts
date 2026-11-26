import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { OPENCODE_PROVIDER } from "../../core/contracts/opencode.ts";

export const OPENCODE_API = "opencode-cli";

const shared = {
	api: OPENCODE_API,
	provider: OPENCODE_PROVIDER,
	baseUrl: "",
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const OPENCODE_MODELS: readonly Model<Api>[] = [
	{ ...shared, id: "auto", name: "OpenCode (native auto)" },
];

export function createOpenCodeProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: OPENCODE_PROVIDER,
		name: "OpenCode",
		auth: { apiKey: { name: "OpenCode CLI", resolve: async () => ({ auth: {}, source: "opencode CLI" }) } },
		models: OPENCODE_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
