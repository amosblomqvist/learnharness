import type { Api, AssistantMessage, Model, Provider, SimpleStreamOptions, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { nativeSubscriptionAbortController, nativeSubscriptionDenial, nativeSubscriptionLease, nativeSubscriptionScope, nativeSubscriptionScopeCurrent, type NativeSubscriptionProviderId, type NativeSubscriptionScope } from "./native-subscription-bridge.ts";

const NATIVE: Record<NativeSubscriptionProviderId, { sdk: "anthropic" | "xai"; name: string }> = {
	"subscription-anthropic": { sdk: "anthropic", name: "Claude" },
	"subscription-xai": { sdk: "xai", name: "Grok" },
};
/** Classify only for choosing a fixed message. The raw SDK/main text is never returned. */
export function nativeSubscriptionStreamError(provider: NativeSubscriptionProviderId, raw: string, purpose?: "background" | "chat"): string {
	const name = NATIVE[provider]?.name ?? "Subscription";
	const tail = "No API-key fallback was used.";
	if (/cancel|abort/i.test(raw)) return `${name} request cancelled. ${tail}`;
	if (/background/i.test(raw)) return nativeSubscriptionDenial(provider, "background");
	if (/quota|rate.?limit|usage limit|429|overloaded|too many requests/i.test(raw)) return `${name} subscription usage limit reached. Check your plan usage, then retry later. ${tail}`;
	if (/expired|invalid_grant|invalid.?token|unauthori[sz]ed|401|authentication/i.test(raw)) return `Your ${name} session expired. Reconnect in Providers. ${tail}`;
	if (/forbidden|permission|403|not eligible/i.test(raw)) return `This ${name} subscription does not permit this request. Check your plan; reconnecting may not change eligibility. ${tail}`;
	if (/disconnect|not connected|closed|desktop connection|lease/i.test(raw)) return nativeSubscriptionDenial(provider, purpose);
	if (/catalog|model|scope|authority/i.test(raw)) return `The selected model is unavailable for this ${name} account. Refresh Providers and explicitly choose an available model. ${tail}`;
	return `${name} request failed. Check your connection and ${name} usage, then retry. ${tail}`;
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
/** Pi's foreign-model treatment runs against the LOGICAL model first, then only our own turns take the SDK provider identity. */
export function nativeSubscriptionHistory(context: TranscriptContext, logicalModel: Model<Api>, nativeProviderId: string): TranscriptContext {
	const messages = transformMessages(context.messages, logicalModel);
	return { ...context, messages: messages.map((m) => m.role === "assistant" && m.provider === logicalModel.provider ? { ...m, provider: nativeProviderId } : m) };
}
let sdkProviders: Map<string, Provider> | undefined;
function sdkProvider(id: "anthropic" | "xai"): Provider {
	sdkProviders ??= new Map(builtinProviders().map((p) => [p.id, p]));
	const provider = sdkProviders.get(id);
	if (!provider) throw new Error("Subscription adapter unavailable");
	return provider;
}
export function nativeSubscriptionStream(provider: NativeSubscriptionProviderId, background: () => boolean): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = nativeSubscriptionAbortController(provider, purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel);
			let scope: NativeSubscriptionScope | undefined;
			let committed = false;
			let terminal = false;
			const check = () => { if (signal.aborted || !scope || scope.provider !== provider || background() !== purpose || !nativeSubscriptionScopeCurrent(scope)) throw new Error("cancelled or catalog authority changed"); };
			try {
				if (logicalModel.provider !== provider || !NATIVE[provider]) throw new Error("account catalog has no selected model");
				const native = NATIVE[provider];
				scope = nativeSubscriptionScope(provider, logicalModel.id);
				const credentials = await nativeSubscriptionLease(scope, purpose);
				check();
				const sdk = sdkProvider(native.sdk);
				// Never dispatch under the alias or through Models.getAuth: no OAuth refresh here, no env or stored API key.
				// The endpoint that receives the token comes from the pinned SDK catalog by id, never from the caller's logical model (baseUrl/api/headers/compat).
				const catalogModel = sdk.getModels().find((m) => m.id === logicalModel.id);
				if (!catalogModel) throw new Error("model not in catalog");
				const transport = { ...catalogModel, provider: sdk.id, headers: undefined } as Model<Api>;
				const origin = new URL(catalogModel.baseUrl).origin;
				const inner = options?.fetch ?? globalThis.fetch;
				// Token only travels to the SDK origin and never follows a redirect (same policy as the custom endpoint fetch).
				const delegate: typeof fetch = (input, init) => {
					const request = new Request(input, init);
					if (new URL(request.url).origin !== origin) throw new Error("request left the provider origin");
					// The OpenAI SDK behind xAI otherwise inherits these identifiers from the parent process env.
					request.headers.delete("openai-organization"); request.headers.delete("openai-project");
					return inner(request, { redirect: "error" });
				};
				// Caller credentials/headers/env are dropped; only the leased token authenticates.
				const { apiKey: _k, env: _e, headers: _h, transformHeaders: _t, ...rest } = (options ?? {}) as SimpleStreamOptions & { transformHeaders?: unknown };
				const source = sdk.streamSimple(transport, nativeSubscriptionHistory(context, logicalModel, sdk.id), {
					...rest,
					apiKey: credentials.accessToken,
					signal,
					maxRetries: 0,
					fetch: (input, init) => {
						check();
						if (committed) throw new Error("subscription requests are not retried once admitted");
						committed = true;
						return delegate(input, init);
					},
					onPayload: async (raw, model) => {
						const replacement = await options?.onPayload?.(raw, model);
						const body = replacement === undefined ? raw : replacement;
						if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid payload");
						check();
						// The leased model is the only model that may reach the wire, whatever the hook did.
						return { ...(body as Record<string, unknown>), model: scope!.selectedModelId };
					},
				});
				for await (const event of source) {
					check();
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					// Copy the message, not its blocks: tool-call ids and signatures stay byte-for-byte intact.
					partial = { ...message, provider, model: logicalModel.id };
					if (event.type === "done") { terminal = true; output.push({ ...event, message: partial }); }
					else if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
					else output.push({ ...event, partial });
				}
				if (!terminal) throw new Error("incomplete response");
			} catch (err) {
				if (terminal) return;
				const raw = err instanceof Error ? err.message : "";
				const aborted = signal.aborted;
				partial = { ...partial, provider, model: logicalModel.id, stopReason: aborted ? "aborted" : "error", errorMessage: nativeSubscriptionStreamError(provider, aborted ? "cancelled" : raw, purpose ? "background" : "chat") };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
