import { lazyStream, type AssistantMessageEvent, type AssistantMessageEventStream, type Api, type CredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { SUBSCRIPTION_PROVIDERS } from "../core/provider-connections.ts";

/** Separate provider IDs make subscription selection explicit and prevent API-key fallback. */
export function subscriptionAliases(builtins: readonly Provider[]): Provider[] {
	return SUBSCRIPTION_PROVIDERS.map((entry) => {
		const original = builtins.find((p) => p.id === entry.provider);
		if (!original?.auth.oauth) throw new Error(`Subscription adapter unavailable: ${entry.id}`);
		return {
			id: entry.id,
			name: entry.name,
			baseUrl: original.baseUrl,
			auth: { oauth: original.auth.oauth },
			getModels: () => original.getModels().map((model) => ({ ...model, provider: entry.id, name: `${model.name} · subscription` })),
			stream: (model, context, options) => aliasStream(model, original.stream({ ...model, provider: entry.provider }, nativeContext(context, entry.id, entry.provider), options)),
			streamSimple: (model, context, options) => aliasStream(model, original.streamSimple({ ...model, provider: entry.provider }, nativeContext(context, entry.id, entry.provider), options)),
		};
	});
}

/** Preserve SDK provider-specific request semantics without losing the selected auth source in history. */
function aliasStream(model: Model<Api>, inner: AssistantMessageEventStream): AssistantMessageEventStream {
	async function* remap(): AsyncGenerator<AssistantMessageEvent> {
		for await (const event of inner) {
			if (event.type === "done") yield { ...event, message: { ...event.message, provider: model.provider } };
			else if (event.type === "error") yield { ...event, error: { ...event.error, provider: model.provider } };
			else yield { ...event, partial: { ...event.partial, provider: model.provider } };
		}
	}
	return lazyStream(model, async () => remap());
}

export interface ModelConnections {
	credentials: CredentialStore;
}

/** The adapter sees its native provider ID so a resumed turn retains signed reasoning
 * and tool IDs. Persisted messages keep the explicit subscription identity. */
function nativeContext(context: Parameters<Provider["stream"]>[1], alias: string, provider: string): Parameters<Provider["stream"]>[1] {
	return { ...context, messages: context.messages.map((message) => message.role === "assistant" && message.provider === alias ? { ...message, provider } : message) };
}
