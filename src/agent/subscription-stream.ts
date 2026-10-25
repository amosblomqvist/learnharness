import { normalizeContext, type Api, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type StreamFunction, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { NATIVE_SUBSCRIPTIONS, type NativeSubscriptionScope } from "../core/contracts/subscriptions.ts";
import { nativeSubscriptionId, nativeSubscriptionBackgroundAllowed, subscriptionScope, subscriptionScopeCurrent, subscriptionAdmissionScope, subscriptionLease, subscriptionAbortController, subscriptionDenial } from "./subscription-bridge.ts";
import { markUnadmittedUsage, type SubscriptionDispatchLifecycle } from "./subscription-request-cycle.ts";

export function nativeSubscriptionError(provider: string, message: string): string {
	const label = NATIVE_SUBSCRIPTIONS.find((p) => p.logicalId === provider)?.label ?? "Subscription";
	const suffix = " No API-key fallback was used.";
	if (/background/i.test(message)) return `${label} background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	if (/quota|429|limit/i.test(message)) return `${label} usage limit reached. Check your provider account and try again later.${suffix}`;
	if (/expired|invalid_grant|401|refresh/i.test(message)) return `${label} authorization could not be refreshed. Retry or reconnect in Providers.${suffix}`;
	if (/cancel|abort|closed|disconnect/i.test(message)) return `${label} request cancelled or connection closed.${suffix}`;
	if (/catalog|model|stale|changed/i.test(message)) return `The selected ${label} model or connection is unavailable. Refresh Providers and explicitly choose an available model.${suffix}`;
	return `${label} request failed. Check the connection, account access and provider limits, then retry.${suffix}`;
}
export function subscriptionHistory(context: TranscriptContext, logical: Model<Api>, nativeId: string): TranscriptContext {
	const messages = transformMessages(context.messages, logical);
	return { ...context, messages: messages.map((message) => message.role === "assistant" && message.provider === logical.provider ? { ...message, provider: nativeId } : message) };
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
/** Direct native provider dispatch bypasses Models' ambient credential resolution entirely. */
export function nativeSubscriptionStream(provider: Provider, background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const nativeId = nativeSubscriptionId(logicalModel.provider);
		if (!nativeId || provider.id !== nativeId) {
			const error = { ...empty(logicalModel), errorMessage: nativeSubscriptionError(logicalModel.provider, "model unavailable") }; markUnadmittedUsage(error.usage); lifecycle?.noDispatch("other");
			output.push({ type: "error", reason: "error", error }); output.end(); return output;
		}
		const purpose = background();
		const { controller, release } = subscriptionAbortController(nativeId, purpose);
		const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel), scope: NativeSubscriptionScope | undefined;
			let committed = false, terminal = false;
			const check = () => {
				if (signal.aborted || !scope || !subscriptionScopeCurrent(scope)) throw new Error("cancelled or connection changed");
				if (purpose && !nativeSubscriptionBackgroundAllowed(nativeId)) throw new Error("background use disabled");
			};
			try {
				if (Object.keys(options?.headers ?? {}).some((key) => ["authorization", "x-api-key", "api-key", "host"].includes(key.toLowerCase()))) throw new Error("Authorization override forbidden");
				scope = subscriptionScope(nativeId, logicalModel.id); lifecycle?.captured(subscriptionAdmissionScope(scope));
				const auth = await subscriptionLease(scope, purpose); check();
				const authKeys = new Set(Object.keys(auth.headers ?? {}).map((key) => key.toLowerCase()));
				if (Object.keys(options?.headers ?? {}).some((key) => authKeys.has(key.toLowerCase()))) throw new Error("Authorization override forbidden");
				const nativeModel = provider.getModels().find((model) => model.id === logicalModel.id && model.api === logicalModel.api);
				if (!nativeModel) throw new Error("Native model unavailable");
				const transport = { ...nativeModel, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) };
				const fetch = options?.fetch ?? globalThis.fetch;
				const source = provider.streamSimple(transport, subscriptionHistory(normalizeContext(context), logicalModel, nativeId), {
					...options, apiKey: auth.apiKey, headers: { ...options?.headers, ...auth.headers }, signal, maxRetries: 0,
					fetch: (input, init) => {
						check(); if (committed) throw new Error("Subscription requests do not retry after dispatch");
						lifecycle?.beforeDispatch(subscriptionAdmissionScope(scope!)); committed = true; return fetch(input, init);
					},
					onPayload: async (raw, model) => {
						const replacement = await options?.onPayload?.(raw, model); check();
						if (replacement === undefined) return raw;
						if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) throw new Error("Invalid model payload override");
						return { ...replacement, model: (raw as { model: string }).model };
					},
				});
				for await (const event of source) {
					check();
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					partial = { ...message, provider: logicalModel.provider };
					if (event.type === "error") throw new Error(event.error.errorMessage ?? "Native stream failed");
					if (event.type === "done") { if (!terminal) { terminal = true; output.push({ ...event, message: partial }); } }
					else if (!terminal) output.push({ ...event, partial });
				}
				if (!terminal) throw new Error("Native stream ended without a terminal response");
			} catch (error) {
				if (terminal) return;
				if (!committed) { markUnadmittedUsage(partial.usage); lifecycle?.noDispatch(await subscriptionDenial(scope, controller, options?.signal?.aborted === true, purpose)); }
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: nativeSubscriptionError(logicalModel.provider, error instanceof Error ? error.message : "") };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
