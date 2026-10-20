import { createModels, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageDiagnostic, type StreamFunction } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { engineForCollection, type PiEngine, type ResolvedModelSpec } from "../agent/models.ts";
import { USAGE_REPORT_DIAGNOSTIC, type UsagePresence } from "../core/contracts.ts";
import { SubscriptionError, subscriptionFailure, subscriptionResponseCode, type SubscriptionErrorCode } from "../core/subscription.ts";
import { subscriptionErrorCode } from "./subscription-errors.ts";
import type { SubscriptionService } from "./subscription.ts";

/** Which usage fields did this raw supplier event report?
 *
 *  The real SDK seeds every assistant message with all-zero usage
 *  (openai-codex-responses stream setup) and only writes real values in
 *  finalizeResponse — which runs for a terminal `response.completed|
 *  response.incomplete` event, and only when `response.usage` is present.
 *  So the supplier's own terminal payload is the one trustworthy signal:
 *  neither a partial (streamed before any completion) nor the SDK's zeros
 *  prove anything, and each field is judged on its own (plan law: preserve
 *  each obtained token field). Only booleans leave this function; the
 *  payload never enters shared state, a log, or a partial message. */
function usagePresenceOfEvent(event: unknown): UsagePresence {
	const none: UsagePresence = { input: false, output: false, cacheRead: false, cacheWrite: false, reasoning: false };
	if (!event || typeof event !== "object") return none;
	const { type, response } = event as { type?: unknown; response?: unknown };
	if (type !== "response.completed" && type !== "response.done" && type !== "response.incomplete") return none;
	if (!response || typeof response !== "object") return none;
	const usage = (response as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return none;
	const payload = usage as Record<string, unknown>;
	const obj = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const inputDetails = obj(payload.input_tokens_details);
	const outputDetails = obj(payload.output_tokens_details);
	// Only finite, non-negative counts establish field presence. Preserve
	// reported fields even when the remaining fields cannot establish a cost.
	const counted = (value: unknown): boolean =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	return {
		input: counted(payload.input_tokens),
		output: counted(payload.output_tokens),
		cacheRead: counted(inputDetails.cached_tokens),
		cacheWrite: counted(inputDetails.cache_write_tokens),
		reasoning: counted(outputDetails.reasoning_tokens),
	};
}

/** Stamp the message-level presence marker (contracts/chat.ts
 *  messageUsagePresence): the legacy both-priced-sides boolean plus the
 *  field map capture projects with. The SDK's numeric usage stays untouched. */
function withUsageReport(message: AssistantMessage, fields: UsagePresence): AssistantMessage {
	const reported = fields.input && fields.output;
	const diagnostic: AssistantMessageDiagnostic = {
		type: USAGE_REPORT_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { reported, fields: { ...fields } },
	};
	const others = (message.diagnostics ?? []).filter((entry) => entry.type !== USAGE_REPORT_DIAGNOSTIC);
	return { ...message, diagnostics: [...others, diagnostic] };
}

/** A per-engine real SDK collection. It cannot resolve another source or generation. */
export function createSubscriptionEngine(service: SubscriptionService, spec: ResolvedModelSpec, generation: string): PiEngine {
	const models = createModels({ credentials: service.credentials(generation) });
	models.setProvider(openaiCodexProvider());
	const engine = engineForCollection(spec, models);
	const streamFn: StreamFunction = (requestModel, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			let lease: Awaited<ReturnType<SubscriptionService["acquireLease"]>> | undefined;
			let failure: SubscriptionErrorCode = "subscription_unknown";
			let partial: AssistantMessage | undefined;
			/** The trusted per-field presence for this call (see
			 *  usagePresenceOfEvent): each field judged once, at the terminal
			 *  event. */
			let usageFields: UsagePresence = { input: false, output: false, cacheRead: false, cacheWrite: false, reasoning: false };
			const safeError = (message?: AssistantMessage): AssistantMessage => {
				const safe = message ?? partial ?? {
					role: "assistant", content: [], api: engine.model.api, provider: engine.model.provider, model: engine.model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error", timestamp: Date.now(),
				};
				const info = subscriptionFailure(failure);
				const failed: AssistantMessage = { ...safe, stopReason: "error", errorMessage: `${info.code}: ${info.message}`, diagnostics: [{ type: "subscription_error", timestamp: Date.now(), details: { code: info.code } }] };
				return withUsageReport(failed, usageFields);
			};
			try {
				if (requestModel.provider !== engine.model.provider || requestModel.id !== engine.model.id) throw new SubscriptionError("subscription_model_unavailable");
				lease = await service.acquireLease(generation, options?.signal);
				// Caller auth, headers, endpoint/environment and fetch overrides cannot
				// replace this instance's OAuth grant or send to a different source.
				const protectedFetch: typeof fetch = async (input, init) => {
					let response: Response;
					try { response = await lease!.fetch(input, init); }
					catch (error) {
						failure = error instanceof SubscriptionError ? error.code : "subscription_network";
						throw new SubscriptionError(failure);
					}
					if (!response.ok) {
						failure = "subscription_unknown";
						try {
							// Bound diagnostic input; never expose or log its raw body.
							const reader = response.clone().body?.getReader();
							let size = 0;
							const chunks: Uint8Array[] = [];
							if (reader) {
								while (true) {
									const chunk = await reader.read();
									if (chunk.done) break;
									size += chunk.value.byteLength;
									if (size > 8192) { void reader.cancel(); break; }
									chunks.push(chunk.value);
								}
								if (size <= 8192) failure = subscriptionResponseCode(JSON.parse(Buffer.concat(chunks).toString("utf8")));
							}
						} catch { /* Unknown response format stays unknown. */ }
						// The real SDK receives a sanitized failure too: diagnostics never
						// briefly carry a raw supplier body into shared partial messages.
						return Response.json({ error: { message: subscriptionFailure(failure).message, code: failure } }, { status: response.status });
					}
					return response;
				};
				// Resolve through the real SDK before lazyStream stringifies its cause.
				// The second SDK read below rechecks the durable generation at stream setup.
				await models.getAuth(engine.model, { signal: lease.signal });
				const source = engine.streamFn(engine.model, context, {
					...options,
					apiKey: undefined, headers: undefined, env: undefined,
					onPayload: undefined, onResponse: undefined,
					// Our own observer (never a caller override): presence only.
					onProviderStreamEvent: (event) => { usageFields = usagePresenceOfEvent(event); },
					fetch: protectedFetch, signal: lease.signal, transport: "sse", maxRetries: 0,
				});
				for await (const event of source) {
					if (event.type === "error") {
						output.push({ type: "error", reason: "error", error: safeError(event.error) });
					} else {
						if ("partial" in event) {
							partial = event.partial;
							delete partial.diagnostics;
							delete partial.errorMessage;
						}
						// A completed call carries the presence marker; usage
						// numbers stay exactly as the SDK reported them.
						output.push(event.type === "done" ? { ...event, message: withUsageReport(event.message, usageFields) } : event);
					}
				}
			} catch (error) {
				// ModelsError preserves causes for pre-stream credential failures;
				// the shared classifier walks them (service/HTTP reuse it too). A
				// supplier/body classification already made by protectedFetch wins
				// over the generic fallback: never downgrade a known code.
				const classified = subscriptionErrorCode(error);
				if (classified !== "subscription_unknown") failure = classified;
				output.push({ type: "error", reason: "error", error: safeError() });
			} finally {
				lease?.release();
				output.end();
			}
		})();
		return output;
	};
	return { ...engine, streamFn };
}
