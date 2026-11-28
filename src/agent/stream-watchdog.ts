import type { AssistantMessage, AssistantMessageEvent, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { markUnadmittedUsage } from "./subscription-request-cycle.ts";
import { forwardWorkerContinuation } from "./worker-request-admission.ts";

export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_EVENT_TIMEOUT_MS = 60_000;

export type StreamActivityKind = "progress" | "content";

export interface WatchdogTimer {
	unref?: () => void;
}

export interface StreamWatchdogOptions {
	firstEventTimeoutMs?: number;
	idleEventTimeoutMs?: number;
	setTimeoutFn?: (callback: () => void, ms: number) => WatchdogTimer;
	clearTimeoutFn?: (handle: WatchdogTimer) => void;
}

interface ResolvedWatchdogConfig {
	firstEventTimeoutMs: number;
	idleEventTimeoutMs: number;
	setTimeoutFn: (callback: () => void, ms: number) => WatchdogTimer;
	clearTimeoutFn: (handle: WatchdogTimer) => void;
}

const WRAPPED_KEY = Symbol.for("lh.stream-watchdog.wrapped.v1");
const ACTIVITY_KEY = Symbol.for("lh.stream-watchdog.activity.v1");
const WOKE = Symbol("watchdog-woke");

type ActivityCallback = (kind: StreamActivityKind) => void;
const activityGlobal = globalThis as typeof globalThis & {
	[ACTIVITY_KEY]?: WeakMap<AbortSignal, ActivityCallback>;
};

function activityRegistry(): WeakMap<AbortSignal, ActivityCallback> {
	return (activityGlobal[ACTIVITY_KEY] ??= new WeakMap());
}

/** Report provider-side stream liveness that does not immediately emit a Pi
 * event (e.g. buffered CLI tool-JSON deltas or non-delta progress frames).
 * No-op when no watchdog owns `signal`. */
export function reportStreamActivity(signal: AbortSignal | undefined, kind: StreamActivityKind = "progress"): void {
	if (!signal) return;
	activityRegistry().get(signal)?.(kind);
}

function validTimeoutMs(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${label} must be a positive finite number of milliseconds`);
	}
	return value;
}

function formatSeconds(ms: number): string {
	return String(Math.round(ms) / 1000);
}

function defaultSetTimeout(callback: () => void, ms: number): WatchdogTimer {
	return setTimeout(callback, ms);
}

function defaultClearTimeout(handle: WatchdogTimer): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
}

type StreamArgs = Parameters<StreamFunction>;
type Terminal = Extract<AssistantMessageEvent, { type: "done" | "error" }>;
type Phase = "first-event" | "idle";

class WatchdogStream extends AssistantMessageEventStream {
	private source?: AssistantMessageEventStream;
	private iterator?: AsyncIterator<AssistantMessageEvent>;
	private partial?: AssistantMessage;
	private final?: AssistantMessage;
	private syntheticTerminal?: Terminal;
	private claimed = false;
	private constructing = false;
	private phase: Phase = "first-event";
	private timer?: WatchdogTimer;
	private readonly innerController = new AbortController();
	private readonly callerSignal?: AbortSignal;
	private unlinkContinuation?: () => void;
	private readonly closedToolCallIndexes = new Set<number>();
	private woken = false;
	private wakeResolve!: () => void;
	private readonly wakePromise: Promise<typeof WOKE>;

	constructor(
		innerFn: StreamFunction,
		private readonly args: StreamArgs,
		private readonly config: ResolvedWatchdogConfig,
	) {
		super();
		this.wakePromise = new Promise<typeof WOKE>((resolve) => {
			this.wakeResolve = () => resolve(WOKE);
		});
		this.callerSignal = args[2]?.signal;

		if (this.callerSignal?.aborted) {
			const msg = this.buildSyntheticMessage("aborted", "Stream aborted before start", true);
			this.final = msg;
			this.syntheticTerminal = { type: "error", reason: "aborted", error: msg };
			this.wake();
			super.end(msg);
			return;
		}

		activityRegistry().set(this.innerController.signal, this.onActivity);
		this.unlinkContinuation = forwardWorkerContinuation(this.callerSignal, this.innerController.signal);
		this.callerSignal?.addEventListener("abort", this.onCallerAbort, { once: true });
		this.armTimer();

		const [model, context, options] = args;
		this.constructing = true;
		let source: AssistantMessageEventStream;
		try {
			source = innerFn(model, context, { ...options, signal: this.innerController.signal });
		} catch (error) {
			this.constructing = false;
			const aborted = this.callerSignal?.aborted === true;
			const msg = this.buildSyntheticMessage(
				aborted ? "aborted" : "error",
				aborted ? "Stream aborted" : error instanceof Error ? error.message : "Stream failed to start",
			);
			this.finalizeSynthetic(msg, true);
			return;
		}
		this.constructing = false;
		this.source = source;

		if (this.final) {
			this.stopSource();
			return;
		}

		// Claim iterator first to prevent competing drains (e.g. PluginStream.result()).
		this.iterator = this.source[Symbol.asyncIterator]();
		// Observe source.result() independently so paused-iterator consumers
		// still resolve and hand off worker continuations without deadlock.
		void Promise.resolve(this.source.result()).then(
			(message) => this.finishNormal(message),
			(error: unknown) => this.finishSourceFailure(error),
		).catch(() => {});

		if (this.callerSignal?.aborted) {
			this.handleCallerAbort();
		}
	}

	private buildSyntheticMessage(stopReason: "error" | "aborted", errorMessage: string, unadmitted = false): AssistantMessage {
		const model = this.args[0];
		const base = this.partial ?? {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		// Filter out unclosed toolCall blocks that never received `toolcall_end`.
		const content = base.content.filter(
			(block, index) => !(block.type === "toolCall" && !this.closedToolCallIndexes.has(index)),
		);
		const message: AssistantMessage = {
			...base,
			content,
			stopReason,
			errorMessage,
		};
		if (unadmitted) markUnadmittedUsage(message.usage);
		return message;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			const handle = this.timer;
			this.timer = undefined;
			this.config.clearTimeoutFn(handle);
		}
	}

	private armTimer(): void {
		if (this.final) return;
		this.clearTimer();
		const timeoutMs = this.phase === "first-event"
			? this.config.firstEventTimeoutMs
			: this.config.idleEventTimeoutMs;
		const handle = this.config.setTimeoutFn(() => this.onStallTimeout(), timeoutMs);
		handle?.unref?.();
		this.timer = handle;
	}

	private cleanup(): void {
		this.clearTimer();
		activityRegistry().delete(this.innerController.signal);
		this.unlinkContinuation?.();
		this.unlinkContinuation = undefined;
		this.callerSignal?.removeEventListener("abort", this.onCallerAbort);
	}

	private wake(): void {
		if (this.woken) return;
		this.woken = true;
		this.wakeResolve();
	}

	private stopSource(reason?: unknown): void {
		if (!this.innerController.signal.aborted) {
			this.innerController.abort(reason);
		}
		try { this.source?.end(this.final); } catch { /* cancellation is best effort */ }
		try { void Promise.resolve(this.iterator?.return?.()).catch(() => {}); } catch { /* likewise */ }
	}

	private finalizeSynthetic(message: AssistantMessage, abortInner: boolean, abortReason?: unknown): void {
		if (this.final) return;
		this.cleanup();
		this.final = message;
		this.syntheticTerminal = {
			type: "error",
			reason: message.stopReason === "aborted" ? "aborted" : "error",
			error: message,
		};
		this.wake();
		super.end(message);
		if (abortInner) this.stopSource(abortReason);
	}

	/** Normal source completion: clean up timers/bridges and resolve result(),
	 * NEVER aborting innerController so parked continuations remain intact. */
	private finishNormal(message: AssistantMessage): void {
		if (this.final) return;
		this.cleanup();
		this.final = message;
		super.end(message);
	}

	private finishSourceFailure(error: unknown): void {
		if (this.final) return;
		const aborted = this.callerSignal?.aborted === true;
		const msg = this.buildSyntheticMessage(
			aborted ? "aborted" : "error",
			aborted ? "Stream aborted" : error instanceof Error ? error.message : "Stream failed",
		);
		this.finalizeSynthetic(msg, true);
	}

	private readonly onActivity = (kind: StreamActivityKind): void => {
		if (this.final) return;
		if (kind === "content") this.phase = "idle";
		this.armTimer();
		reportStreamActivity(this.callerSignal, kind);
	};

	private onStallTimeout(): void {
		this.timer = undefined;
		if (this.final) return;
		if (this.callerSignal?.aborted) {
			this.handleCallerAbort();
			return;
		}
		const timeoutMs = this.phase === "first-event"
			? this.config.firstEventTimeoutMs
			: this.config.idleEventTimeoutMs;
		const sec = formatSeconds(timeoutMs);
		const errorMessage = this.phase === "first-event"
			? `Stream stalled: timed out waiting for initial response after ${sec}s`
			: `Stream stalled: timed out after ${sec}s with no stream activity`;
		const stallMessage = this.buildSyntheticMessage("error", errorMessage);
		// Record stall error BEFORE aborting innerController so an inner
		// provider's abort handler cannot overwrite stopReason: "error".
		this.finalizeSynthetic(stallMessage, true, new Error(errorMessage));
	}

	private readonly onCallerAbort = (): void => {
		this.handleCallerAbort();
	};

	private handleCallerAbort(): void {
		this.clearTimer();
		if (this.final) return;
		if (this.constructing) {
			if (!this.innerController.signal.aborted) {
				this.innerController.abort(this.callerSignal?.reason);
			}
			return;
		}
		const complete = () => {
			if (!this.final) {
				const msg = this.buildSyntheticMessage("aborted", "Stream aborted");
				this.finalizeSynthetic(msg, true, this.callerSignal?.reason);
			} else {
				this.wake();
				this.stopSource(this.callerSignal?.reason);
			}
		};
		if (this.source && !this.final) {
			// Give a native abort handler's synchronously supplied result first
			// refusal so billed usage is preserved.
			if (!this.innerController.signal.aborted) {
				this.innerController.abort(this.callerSignal?.reason);
			}
			queueMicrotask(complete);
		} else {
			complete();
		}
	}

	private abortEarly(): void {
		if (this.final) return;
		const msg = this.buildSyntheticMessage("aborted", "Stream closed early");
		this.finalizeSynthetic(msg, true);
	}

	private async nextWithWake(): Promise<IteratorResult<AssistantMessageEvent> | typeof WOKE> {
		if (this.woken) return WOKE;
		const nextPromise = this.iterator!.next();
		// Prevent unhandledRejection if an uncooperative iterator rejects after wake.
		void nextPromise.catch(() => {});
		return await Promise.race([nextPromise, this.wakePromise]);
	}

	private async *events(): AsyncGenerator<AssistantMessageEvent> {
		let terminal = false;
		try {
			if (!this.iterator) {
				terminal = true;
				if (this.syntheticTerminal) yield this.syntheticTerminal;
				return;
			}
			while (true) {
				const step = await this.nextWithWake();
				if (step === WOKE) {
					terminal = true;
					if (this.syntheticTerminal) {
						yield this.syntheticTerminal;
					} else if (this.final && (this.final.stopReason === "error" || this.final.stopReason === "aborted")) {
						yield { type: "error", reason: this.final.stopReason, error: this.final };
					}
					return;
				}
				if (this.syntheticTerminal) {
					terminal = true;
					yield this.syntheticTerminal;
					return;
				}
				if (step.done) break;
				const event = step.value;
				if ("partial" in event) this.partial = event.partial;
				switch (event.type) {
					case "start":
						// Never narrow first-event timeout on `start`: providers emit it immediately before first token.
						break;
					case "toolcall_start":
						this.closedToolCallIndexes.delete(event.contentIndex);
						this.onActivity("content");
						break;
					case "toolcall_delta":
						this.onActivity("content");
						break;
					case "toolcall_end":
						this.closedToolCallIndexes.add(event.contentIndex);
						this.onActivity("content");
						break;
					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
						this.onActivity("content");
						break;
					case "done":
						this.finishNormal(event.message);
						terminal = true;
						break;
					case "error":
						this.finishNormal(event.error);
						terminal = true;
						break;
				}
				yield event;
				if (terminal) return;
			}
			// Guard against empty source.end() with no terminal event or resolved result.
			if (!this.final) {
				const msg = this.buildSyntheticMessage("error", "Stream ended without a terminal response");
				this.cleanup();
				this.final = msg;
				this.syntheticTerminal = { type: "error", reason: "error", error: msg };
				super.end(msg);
			}
			terminal = true;
			if (this.syntheticTerminal) yield this.syntheticTerminal;
		} catch (error) {
			if (!this.final) {
				const aborted = this.callerSignal?.aborted === true;
				const msg = this.buildSyntheticMessage(
					aborted ? "aborted" : "error",
					aborted ? "Stream aborted" : error instanceof Error ? error.message : "Stream failed",
				);
				this.finalizeSynthetic(msg, true);
			}
			terminal = true;
			if (this.syntheticTerminal) {
				yield this.syntheticTerminal;
			} else if (this.final && (this.final.stopReason === "error" || this.final.stopReason === "aborted")) {
				yield { type: "error", reason: this.final.stopReason, error: this.final };
			}
		} finally {
			if (!terminal) this.abortEarly();
		}
	}

	override [Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		if (this.claimed) throw new Error("Watchdog streams support one consumer");
		this.claimed = true;
		const iterator = this.events();
		const originalReturn = iterator.return.bind(iterator);
		iterator.return = (value) => {
			if (!this.final) this.abortEarly();
			return originalReturn(value);
		};
		return iterator;
	}

	override end(message?: AssistantMessage): void {
		if (this.final) return;
		const finalMessage = message ?? this.buildSyntheticMessage("aborted", "Stream closed");
		this.cleanup();
		this.final = finalMessage;
		if (message === undefined) {
			this.syntheticTerminal = { type: "error", reason: "aborted", error: finalMessage };
		}
		this.wake();
		super.end(finalMessage);
		this.stopSource();
	}

	override result(): Promise<AssistantMessage> {
		if (!this.claimed) {
			void (async () => {
				for await (const _event of this) {
					// Drain so every content event resets the watchdog for result-only callers.
				}
			})().catch(() => {});
		}
		return super.result();
	}
}

/** Wrap a StreamFunction with a two-phase inactivity watchdog (120s first content,
 * 60s idle between events). Idempotent across duplicated Next.js module instances
 * when called with default options; explicit options always create a fresh wrapper. */
export function streamWatchdog(streamFn: StreamFunction, options?: StreamWatchdogOptions): StreamFunction {
	if (options === undefined && (streamFn as StreamFunction & { [WRAPPED_KEY]?: boolean })[WRAPPED_KEY]) {
		return streamFn;
	}
	const config: ResolvedWatchdogConfig = {
		firstEventTimeoutMs: validTimeoutMs(options?.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS, "firstEventTimeoutMs"),
		idleEventTimeoutMs: validTimeoutMs(options?.idleEventTimeoutMs ?? DEFAULT_IDLE_EVENT_TIMEOUT_MS, "idleEventTimeoutMs"),
		setTimeoutFn: options?.setTimeoutFn ?? defaultSetTimeout,
		clearTimeoutFn: options?.clearTimeoutFn ?? defaultClearTimeout,
	};
	const wrapped: StreamFunction = (...args) => new WatchdogStream(streamFn, args, config);
	Object.defineProperty(wrapped, WRAPPED_KEY, { value: true });
	return wrapped;
}
