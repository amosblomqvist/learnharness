import { createProvider, lazyStream, type Api, type ApiStreamOptions, type CredentialStore, type Model, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { SUBSCRIPTION_PROVIDERS, type CustomProviderDefinition } from "../core/provider-connections.ts";

/** Catalog aliases only. OAuth and refresh run in Electron, never Models.getAuth. */
export function subscriptionAliases(builtins: readonly Provider[]): Provider[] {
	return SUBSCRIPTION_PROVIDERS.map((entry) => {
		const original = builtins.find((p) => p.id === entry.provider);
		if (!original) throw new Error("Subscription adapter unavailable: " + entry.id);
		const refused = (model: Model<Api>) => lazyStream(model, async () => { throw new Error("Use the native subscription connection"); });
		return {
			id: entry.id, name: entry.name, baseUrl: original.baseUrl, auth: {},
			getModels: () => original.getModels().map((model) => ({ ...model, provider: entry.id, name: model.name + " · subscription" })),
			stream: refused, streamSimple: refused,
		};
	});
}

/** Never follow redirects with a dedicated endpoint key, even to another compatible server. */
export function endpointFetch(baseUrl: string, transport: typeof fetch = globalThis.fetch): typeof fetch {
	const origin = new URL(baseUrl).origin;
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const target = input instanceof Request ? input.url : String(input);
		if (new URL(target).origin !== origin) throw new Error("Custom provider request left its configured origin");
		const request = new Request(input, init);
		// The OpenAI SDK otherwise inherits these identifiers from the parent process.
		request.headers.delete("openai-organization");
		request.headers.delete("openai-project");
		return transport(request, { redirect: "error" });
	}) as typeof fetch;
}

/** Only this custom entry's credential can reach its endpoint. No ambient key lookup. */
export function customProvider(definition: CustomProviderDefinition): Provider {
	const api: ProviderStreams = definition.api === "openai-responses" ? openAIResponsesApi()
		: definition.api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi();
	const models: Model<Api>[] = definition.models.map((model) => ({
		...model,
		provider: definition.id,
		api: definition.api,
		baseUrl: definition.baseUrl,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	const provider = createProvider({
		id: definition.id,
		name: definition.name,
		baseUrl: definition.baseUrl,
		models,
		auth: { apiKey: {
			name: `${definition.name} dedicated key`,
			resolve: async ({ credential, signal }) => {
				signal.throwIfAborted();
				if (definition.keyless) return { auth: { apiKey: "local-keyless" }, source: "explicit keyless endpoint" };
				const bound = credential?.env?.LH_CUSTOM_PROVIDER_BASE_URL === definition.baseUrl && credential?.env?.LH_CUSTOM_PROVIDER_API === definition.api;
				return bound && credential?.key ? { auth: { apiKey: credential.key }, source: "dedicated endpoint key" } : undefined;
			},
		} },
		api,
	});
	return {
		...provider,
		stream: (model, context, options) => provider.stream(model, context, { ...options, fetch: endpointFetch(definition.baseUrl, options?.fetch as typeof fetch | undefined) } as ApiStreamOptions<typeof model.api>),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, fetch: endpointFetch(definition.baseUrl, options?.fetch as typeof fetch | undefined) }),
	};
}

export interface ModelConnections {
	credentials: CredentialStore;
	/** Non-secret configuration; the adapter is injected at the server composition root. */
	customProviders(): readonly CustomProviderDefinition[];
}
