import type { AssistantMessage, AssistantMessageEvent, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { markUnadmittedUsage } from "./subscription-request-cycle.ts";

const POOL_KEY = Symbol.for("lh.worker-request-admission.pool.v1");
const WRAPPED_KEY = Symbol.for("lh.worker-request-admission.wrapped.v1");
const DEFAULT_LIMIT = 8;
type Waiter = { state: "queued" | "active" | "cancelled"; grant: (release: () => void) => void; release?: () => void };
type Pool = { getLimit: () => number; limit: number; active: number; queue: Waiter[] };
const shared = globalThis as typeof globalThis & { [POOL_KEY]?: Pool };
// Resolve at use time as well as across module copies; tests can replace this seam
// with a fresh, idle global pool without introducing a second production lane.
function pool(): Pool {
	return shared[POOL_KEY] ??= { getLimit: () => DEFAULT_LIMIT, limit: DEFAULT_LIMIT, active: 0, queue: [] };
}
function validLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Worker request concurrency must be a positive whole integer");
	return value;
}
function drain(state: Pool): void {
	// Never call application code/getters while releasing a permit. A failed
	// explicit refresh must not strand active requests or unrelated waiters.
	while (state.active < state.limit && state.queue.length) {
		const waiter = state.queue.shift()!;
		if (waiter.state !== "queued") continue;
		waiter.state = "active";
		state.active++;
		let released = false;
		const release = waiter.release = () => {
			if (released) return;
			released = true;
			waiter.state = "cancelled";
			state.active--;
			drain(state);
		};
		// Install cancellation ownership before handing off to transport setup.
		queueMicrotask(() => waiter.grant(release));
	}
}
function acquire(state: Pool, grant: Waiter["grant"]): () => void {
	const waiter: Waiter = { state: "queued", grant };
	state.queue.push(waiter);
	drain(state);
	return () => {
		if (waiter.state === "active") waiter.release!();
		else if (waiter.state === "queued") {
			waiter.state = "cancelled";
			state.queue.splice(state.queue.indexOf(waiter), 1);
		}
	};
}

/** Inject settings without importing stores/server code. Invalid getters leave the previous configuration intact. */
export function configureWorkerRequestAdmission(getLimit: () => number): void {
	const limit = validLimit(getLimit());
	const state = pool();
	state.getLimit = getLimit;
	state.limit = limit;
	drain(state);
}
/** Increase drains immediately; decrease never cancels work already admitted. */
export function refreshWorkerRequestAdmission(): void {
	const state = pool();
	const limit = validLimit(state.getLimit());
	state.limit = limit;
	drain(state);
}

type StreamArgs = Parameters<StreamFunction>;
type Terminal = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** One pull-through consumer, no copied event queue. Native producers retain
 * their own buffering; result-only callers drain and discard rather than retain.
 * Source result observation is independent of downstream iteration, so a paused
 * consumer cannot retain a completed model-request permit. */
class WorkerRequestStream extends AssistantMessageEventStream {
	private source?: AssistantMessageEventStream;
	private iterator?: AsyncIterator<AssistantMessageEvent>;
	private partial?: AssistantMessage;
	private final?: AssistantMessage;
	private syntheticTerminal?: Terminal;
	private invoked = false;
	private constructing = false;
	private claimed = false;
	private cancelAdmission?: () => void;
	private readonly controller = new AbortController();
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private readonly signal?: AbortSignal;
	private readonly onAbort = () => this.cancel();

	constructor(private readonly streamFn: StreamFunction, private readonly args: StreamArgs) {
		super();
		this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
		this.signal = args[2]?.signal;
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		if (this.signal?.aborted) this.cancel();
		else this.cancelAdmission = acquire(pool(), (release) => {
			if (this.final) { release(); return; }
			// acquire's cancellation function owns this same idempotent release.
			void this.start();
		});
	}

	private failure(aborted: boolean, error?: unknown): AssistantMessage {
		const model = this.args[0];
		const message: AssistantMessage = {
			...(this.partial ?? { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
			stopReason: aborted ? "aborted" : "error",
			errorMessage: aborted ? "Worker model request cancelled" : error instanceof Error ? error.message : "Worker model request failed or ended without a terminal response",
		};
		// Invocation is not proof of billing, but neither is a failed invocation
		// proof of NO dispatch. Preserve native usage/identity whenever available.
		if (!this.invoked) markUnadmittedUsage(message.usage);
		return message;
	}
	private finish(message: AssistantMessage, synthetic = false): void {
		if (this.final) return;
		this.final = message;
		if (synthetic) this.syntheticTerminal = { type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message };
		this.signal?.removeEventListener("abort", this.onAbort);
		this.cancelAdmission?.();
		// Release BEFORE resolving result or yielding any terminal to Agent/tools.
		super.end(message);
	}
	private stopSource(): void {
		this.controller.abort();
		// Signal/end are the native cancellation contract: wake SDK waits and
		// discard subsequent pushes. Our own waits are bounded independently;
		// an uncooperative custom provider's actual network cannot be forced shut.
		try { this.source?.end(this.final); } catch { /* cancellation is best effort */ }
		try { void Promise.resolve(this.iterator?.return?.()).catch(() => {}); } catch { /* likewise */ }
	}
	private cancel(): void {
		if (this.constructing && !this.final) {
			// A synchronous factory can abort its caller before returning the
			// source. Deliver abort now, but observe that returned source's native
			// result before scheduling synthetic cancellation below.
			this.controller.abort();
			return;
		}
		const complete = () => {
			if (!this.final) this.finish(this.failure(true), true);
			this.stopSource();
			this.resolveReady();
		};
		if (this.source && !this.final) {
			// Give a native abort handler's synchronously supplied terminal/result
			// first refusal, preserving its actual usage rather than replacing it.
			this.controller.abort();
			queueMicrotask(complete);
		} else complete();
	}
	private async start(): Promise<void> {
		try {
			if (this.final) return;
			this.invoked = true;
			const [model, context, options] = this.args;
			// Runtime thenables are tolerated for faulty/custom setup, even though
			// the native StreamFunction contract itself returns synchronously.
			let source: AssistantMessageEventStream;
			this.constructing = true;
			try { source = this.streamFn(model, context, { ...options, signal: this.controller.signal }); }
			finally { this.constructing = false; }
			const pendingSetup = typeof (source as unknown as { then?: unknown })?.then === "function";
			// Runtime async setup is not the native contract. It may never settle;
			// do not defer cancellation while waiting for an unavailable source.
			if (pendingSetup && this.controller.signal.aborted) this.cancel();
			this.source = pendingSetup ? await source : source;
			if (this.final) { this.stopSource(); return; }
			// PluginStream.result() starts a competing drain unless its iterator
			// is claimed FIRST. Native SDK result() itself is passive.
			this.iterator = this.source[Symbol.asyncIterator]();
			void Promise.resolve(this.source.result()).then(
				(message) => this.finish(message),
				(error: unknown) => { this.finish(this.failure(false, error), true); this.stopSource(); },
			).catch(() => {});
			if (this.controller.signal.aborted) this.cancel();
		} catch (error) {
			this.finish(this.failure(this.controller.signal.aborted, error), true);
			this.stopSource();
		} finally { this.resolveReady(); }
	}
	private async next(): Promise<IteratorResult<AssistantMessageEvent>> {
		const signal = this.controller.signal;
		const aborted = () => new DOMException("Worker model request cancelled", "AbortError");
		if (signal.aborted) throw aborted();
		let onAbort!: () => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(aborted());
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			// Race attaches rejection handlers to the source next() even if it
			// settles after cancellation. No extra consumer or buffered history.
			return await Promise.race([this.iterator!.next(), cancelled]);
		} finally { signal.removeEventListener("abort", onAbort); }
	}
	private async *events(): AsyncGenerator<AssistantMessageEvent> {
		let terminal = false;
		try {
			await this.ready;
			if (!this.iterator) {
				terminal = true;
				if (this.syntheticTerminal) yield this.syntheticTerminal;
				return;
			}
			while (true) {
				const next = await this.next();
				if (next.done) break;
				const event = next.value;
				if ("partial" in event) this.partial = event.partial;
				if (event.type === "done" || event.type === "error") {
					this.finish(event.type === "done" ? event.message : event.error);
					terminal = true;
				}
				yield event;
				if (terminal) return;
			}
			// end(message) is a valid native result-only completion. end() without
			// a message strands native result(), so never await it at this seam.
			if (!this.final) this.finish(this.failure(false), true);
			terminal = true;
			if (this.syntheticTerminal) yield this.syntheticTerminal;
		} catch (error) {
			if (!this.final) this.finish(this.failure(this.controller.signal.aborted, error), true);
			terminal = true;
			if (this.syntheticTerminal) yield this.syntheticTerminal;
			else if (this.final?.stopReason === "error" || this.final?.stopReason === "aborted") {
				// A native abort result can win before bounded next() unwinds.
				// Retain that actual message/usage rather than fabricating a failure.
				yield { type: "error", reason: this.final.stopReason, error: this.final };
			}
		} finally {
			if (!terminal) this.cancel();
			else this.stopSource();
		}
	}
	override [Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		if (this.claimed) throw new Error("Worker request streams support one consumer");
		this.claimed = true;
		const iterator = this.events();
		// An unstarted async generator's return() skips its finally block. Also
		// cancel BEFORE a pending next(), rather than queuing return behind it.
		const originalReturn = iterator.return.bind(iterator);
		iterator.return = (value) => { this.cancel(); return originalReturn(value); };
		return iterator;
	}
	// Existing PluginStream cancellation closes its source via end(message).
	// Treat that public SDK seam as ownership cleanup too, not just resolution.
	override end(message?: AssistantMessage): void {
		if (!this.final) this.finish(message ?? this.failure(true), message === undefined);
		this.stopSource();
		this.resolveReady();
	}
	override result(): Promise<AssistantMessage> {
		if (!this.claimed) void (async () => {
			for await (const _event of this) { /* bounded: discard, never retain */ }
		})().catch(() => {});
		return super.result();
	}
}

/** Idempotent across duplicated Next modules, with explicit shared metadata. */
export function workerRequestStream(streamFn: StreamFunction): StreamFunction {
	if ((streamFn as StreamFunction & { [WRAPPED_KEY]?: boolean })[WRAPPED_KEY]) return streamFn;
	const wrapped: StreamFunction = (...args) => new WorkerRequestStream(streamFn, args);
	Object.defineProperty(wrapped, WRAPPED_KEY, { value: true });
	return wrapped;
}
