import {
	createProvider,
	type Api,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";
import type { DiscoveredAntigravityModel } from "./models-discovery.ts";

export function toPiAntigravityModel(entry: DiscoveredAntigravityModel): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: [...entry.input],
		// Pi-required numeric placeholders, not prices: Antigravity manages
		// billing/quota externally. Server pricing and model menus report unpriced / CLI billing.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: entry.reasoning,
		thinkingLevelMap: { ...entry.thinkingLevelMap },
		contextWindow: entry.contextWindow ?? 0,
		maxTokens: entry.maxTokens ?? 0,
	};
}

export function createAntigravityProvider(
	streamSimple: StreamFunction<Api, SimpleStreamOptions>,
	models: readonly DiscoveredAntigravityModel[] = [],
): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		auth: {
			apiKey: {
				name: "Antigravity Google Account",
				resolve: async () => ({ auth: {}, source: "antigravity ACP" }),
			},
		},
		models: models.map(toPiAntigravityModel),
		api: { stream: streamSimple, streamSimple },
	});
}
