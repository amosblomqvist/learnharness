import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { PiEngine } from "../agent/models.ts";
import { markUnadmittedUsage, usageWasAdmitted, type SubscriptionDispatchLifecycle } from "../agent/subscription-request-cycle.ts";
import type { PluginCallPurpose, PluginModelSpec } from "../core/plugin-agents.ts";
import type { PluginInference, PluginInferenceOptions, PluginInferenceRequest } from "../core/plugins.ts";
import type { ModelCatalogResponse } from "../core/contracts/models.ts";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { validatePluginInferenceOptions as optionsFor } from "../core/plugin-validation.ts";

/** Complete dependency seam for off-network tests; production defaults are lazy
 * so supplying it never initializes host stores, accounts, or model collections. */
export interface PluginInferenceDeps {
	catalog(): ModelCatalogResponse | Promise<ModelCatalogResponse>;
	providerKeyPresent(provider: string): boolean | Promise<boolean>;
	engineForSpec(model: PluginModelSpec, background: boolean, lifecycle?: SubscriptionDispatchLifecycle): PiEngine | Promise<PiEngine>;
}
export interface PluginInferenceAdapter {
	inference: PluginInference;
	engineFor(model: PluginModelSpec, purpose: PluginCallPurpose, options?: PluginInferenceOptions): Promise<PiEngine>;
	onUsage(model: PluginModelSpec, usage: Usage): void;
}
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const subscription = (provider: string) => provider === "chatgpt" || NATIVE_SUBSCRIPTIONS.some((p) => p.logicalId === provider);
function abortError(): Error { return new DOMException("Plugin inference cancelled or disabled", "AbortError"); }
function check(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
/** Cancel the wait, not just the eventual transport. Removes listeners on every path. */
async function bounded<T>(value: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
	check(signal);
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(abortError()); signal.addEventListener("abort", abort, { once: true }); });
	try { return await Promise.race([Promise.resolve(value), cancelled]); }
	finally { signal.removeEventListener("abort", abort); }
}
function modelSpec(value: PluginModelSpec): PluginModelSpec {
	if (!value || typeof value.provider !== "string" || !value.provider.trim() || typeof value.id !== "string" || !value.id.trim()) throw new Error("An explicit model provider and id are required");
	if (value.thinkingLevel !== undefined && !levels.includes(value.thinkingLevel)) throw new Error("Invalid model thinkingLevel");
	return { provider: value.provider, id: value.id, ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }) };
}
function purposeOf(purpose: PluginCallPurpose): PluginCallPurpose {
	if (purpose !== "user" && purpose !== "background") throw new Error("Explicit inference purpose must be user or background");
	return purpose;
}
function failure(engine: PiEngine, partial: AssistantMessage | undefined, aborted: boolean, error?: unknown): AssistantMessage {
	return { ...(partial ?? { role: "assistant", api: engine.model.api, provider: engine.model.provider, model: engine.model.id,
		content: [], timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
		stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "Plugin inference cancelled or disabled"
			: error instanceof Error && error.message ? error.message
			: "Plugin inference transport failed or ended without a terminal response" };
}

/** Pull-through native stream: one consumer, no second event queue/history.
 * result() can drive an otherwise unconsumed stream, as native SDK streams do.
 * Terminal result is installed BEFORE yielding it (Agent reads result at that seam). */
class PluginStream extends AssistantMessageEventStream {
	private started = false;
	constructor(private readonly generate: (finish: (m: AssistantMessage) => void) => AsyncGenerator<AssistantMessageEvent>) { super(); }
	override [Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		if (this.started) throw new Error("Plugin inference streams support one consumer");
		this.started = true;
		return this.generate((message) => super.end(message));
	}
	override result(): Promise<AssistantMessage> {
		if (!this.started) void (async () => { for await (const _event of this) { /* drain without retaining events */ } })().catch(() => {});
		return super.result();
	}
}

/** Last-known host catalog only: this does not refresh accounts behind the
 * plugin's back. Connection refresh remains owned by existing Providers flows.
 * All inference uses existing transports (including consent, quota and scope
 * cancellation), with no API-key fallback or automatic background→user retry. */
export function createPluginInference(
	{ signal, dataDirectory }: { signal: AbortSignal; dataDirectory: string },
	injected?: PluginInferenceDeps,
): PluginInferenceAdapter {
	const directory = path.resolve(/* turbopackIgnore: true */ dataDirectory);
	let defaults: Promise<PluginInferenceDeps> | undefined;
	const dependencies = (): Promise<PluginInferenceDeps> => {
		check(signal);
		if (injected) return Promise.resolve(injected);
		return defaults ??= Promise.all([import("./model-catalog.ts"), import("../agent/models.ts"), import("./keys.ts")]).then(([catalog, models, keys]) => ({
			catalog: catalog.modelCatalog, providerKeyPresent: keys.providerKeyPresent, engineForSpec: models.piEngineForSpec,
		}));
	};
	const catalog = async (caller = signal) => {
		const deps = await bounded(dependencies(), caller);
		return structuredClone(await bounded(deps.catalog(), caller));
	};
	const available = async (spec: PluginModelSpec, caller: AbortSignal) => {
		const deps = await bounded(dependencies(), caller);
		const listing = await bounded(deps.catalog(), caller);
		if (!listing.providers.some((p) => p.id === spec.provider)) throw new Error(`Unknown model provider: ${spec.provider}`);
		if (!await bounded(deps.providerKeyPresent(spec.provider), caller)) {
			const missing = providerKeyMissing(spec.provider, []);
			throw Object.assign(new Error(missing.error), missing);
		}
		if (!listing.models.some((m) => m.provider === spec.provider && m.id === spec.id)) throw new Error(`Selected model unavailable in host catalog: ${spec.provider}/${spec.id}`);
		check(caller);
		return deps;
	};
	const onUsage = (model: PluginModelSpec, usage: Usage) => {
		if (signal.aborted || !usageWasAdmitted(usage)) return;
		const spec = modelSpec(model);
		// Explicit projection: never serialize transport models, request content,
		// account leases, arbitrary caller properties, or credentials.
		const row = { timestamp: new Date().toISOString(), model: spec, usage: {
			input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens,
			cost: { input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead, cacheWrite: usage.cost.cacheWrite, total: usage.cost.total },
		} };
		fs.mkdirSync(directory, { recursive: true });
		fs.appendFileSync(path.join(/* turbopackIgnore: true */ directory, "usage.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
	};
	const engineFor = async (model: PluginModelSpec, purpose: PluginCallPurpose, options?: PluginInferenceOptions): Promise<PiEngine> => {
		check(signal);
		const boundOptions = optionsFor(options);
		const spec = modelSpec(model), classified = purposeOf(purpose);
		const deps = await available(spec, signal);
		const base = await bounded(deps.engineForSpec(spec, classified === "background"), signal);
		if (base.model.provider !== spec.provider || base.model.id !== spec.id) throw new Error("Inference engine did not honor the explicitly selected model");
		if (boundOptions.reasoning !== undefined && boundOptions.reasoning !== base.level) throw new Error("Set model.thinkingLevel instead of overriding engine reasoning");
		return { model: base.model, level: base.level, streamFn: (_model, context, runtime) => {
			const controller = new AbortController();
			const combined = AbortSignal.any([signal, controller.signal, ...(runtime?.signal ? [runtime.signal] : [])]);
			return new PluginStream(async function* (finish) {
				let source: AssistantMessageEventStream | undefined;
				let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
				let partial: AssistantMessage | undefined;
				let terminal = false;
				let finalMessage: AssistantMessage | undefined;
				const stopSource = () => { source?.end(finalMessage ?? failure(base, partial, true)); };
				let admitted = !subscription(spec.provider);
				const lifecycle: SubscriptionDispatchLifecycle = {
					captured: () => { check(combined); },
					beforeDispatch: () => { check(combined); admitted = true; },
					noDispatch: () => { /* No admission is not a billed provider call. */ },
				};
				const finalize = (message: AssistantMessage) => {
					if (!admitted) markUnadmittedUsage(message.usage);
					terminal = true; finalMessage = message; finish(message);
				};
				try {
					check(combined);
					// Managed Agent passes private runtime hooks/options in its config;
					// do NOT forward that bag to provider transports. Auth stays host-owned.
					// sessionId is the host Agent's conversation id (stable across tool
					// rounds). OpenCode Go will not route a request that omits it.
					// Plugins still cannot set it: validatePluginInferenceOptions rejects it.
					const { temperature, maxTokens, cacheRetention, reasoning, thinkingBudgets, toolChoice, timeoutMs, maxRetries, maxRetryDelayMs, metadata, sessionId } = (runtime ?? {}) as SimpleStreamOptions;
					const safe = optionsFor(Object.fromEntries(Object.entries({ temperature, maxTokens, cacheRetention, reasoning, thinkingBudgets, toolChoice, timeoutMs, maxRetries, maxRetryDelayMs, metadata, ...boundOptions }).filter(([, value]) => value !== undefined)));
					if (safe.reasoning !== undefined && safe.reasoning !== base.level) throw new Error("Set model.thinkingLevel instead of overriding engine reasoning");
					const current = await available(spec, combined);
					const engine = await bounded(current.engineForSpec(spec, classified === "background", lifecycle), combined);
					if (engine.model.provider !== spec.provider || engine.model.id !== spec.id) throw new Error("Inference engine changed the explicitly selected model");
					const providerOptions: SimpleStreamOptions = { ...safe, signal: combined, reasoning: engine.level === "off" ? undefined : engine.level, ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}) };
					source = engine.streamFn(engine.model, context, providerOptions);
					combined.addEventListener("abort", stopSource, { once: true });
					if (combined.aborted) stopSource();
					iterator = source[Symbol.asyncIterator]();
					while (true) {
						const next = await bounded(iterator.next(), combined);
						if (next.done) break;
						const event = next.value;
						if ("partial" in event) partial = event.partial;
						if (event.type === "done" || event.type === "error") finalize(event.type === "done" ? event.message : event.error);
						yield event;
						if (terminal) return;
					}
					if (!terminal) {
						const message = failure(base, partial, combined.aborted); finalize(message);
						yield { type: "error", reason: message.stopReason as "error" | "aborted", error: message };
					}
				} catch (error) {
					if (!terminal) {
						const message = failure(base, partial, combined.aborted || (error instanceof Error && error.name === "AbortError"), error); finalize(message);
						yield { type: "error", reason: message.stopReason as "error" | "aborted", error: message };
					}
				} finally {
					controller.abort();
					// Resolve a pending SDK next()/result() before returning the iterator.
					// Native producers ignore pushes after end, so an early-detached view
					// cannot leave an accumulating queue or a stranded iterator wait.
					combined.removeEventListener("abort", stopSource);
					if (source) source.end(finalMessage ?? failure(base, partial, true));
					if (!terminal) finish(failure(base, partial, true));
					if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
				}
			});
		} };
	};
	const stream = async function* (request: PluginInferenceRequest): AsyncGenerator<AssistantMessageEvent> {
		const combined = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
		check(combined);
		const options = optionsFor(request.options), model = modelSpec(request.model), purpose = purposeOf(request.purpose);
		const engine = await bounded(engineFor(model, purpose), combined);
		if (options.reasoning !== undefined && options.reasoning !== engine.level) throw new Error("Set model.thinkingLevel instead of overriding engine reasoning");
		const source = engine.streamFn(engine.model, normalizeContext(request.context), { ...options, signal: combined });
		for await (const event of source) {
			if (event.type === "done" || event.type === "error") {
				const message = event.type === "done" ? event.message : event.error;
				if (message.stopReason !== "aborted" && usageWasAdmitted(message.usage)) onUsage(model, message.usage);
			}
			yield event;
		}
	};
	return {
		inference: { catalog: () => catalog(), stream, async complete(request) {
			let final: AssistantMessage | undefined;
			for await (const event of stream(request)) {
				if (event.type === "done") final = event.message;
				else if (event.type === "error") final = event.error;
			}
			if (!final) throw new Error("Inference stream ended without a final assistant message");
			return final;
		} }, engineFor, onUsage,
	};
}
