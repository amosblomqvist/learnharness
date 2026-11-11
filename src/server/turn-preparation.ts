/**
 * Private ownership while an answer is being prepared, before a real teacher
 * exists. The one outer handle is registered synchronously and stays stable
 * through handoff; only the real teacher owns replay/events. View cancellation
 * never aborts preparation or another view.
 */
import type { PiTurnHandle } from "./pi/ui-stream.ts";
import { beginTurn, endTurn, handoffTurn, isTurnOwner } from "./turn-liveness.ts";
import { registerTurn, runningTurn, settledTurnResponse, unregisterTurn } from "./turn-runs.ts";

export interface TurnPreparation {
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	handoff(realHandle: PiTurnHandle): void;
	finish(): void;
}

/** Claims the existing per-session turn gate, with no await or separate job.
 * Aborting preparation does NOT release it: the host must await its callback's
 * settlement and durable cleanup, then call finish (including failure paths).
 * Once handed off, the host calls finish after the real teacher's settlement. */
export function claimPreparingTurn(chatId: string): TurnPreparation | null {
	const owner = {};
	const preparation = new AbortController();
	let real: PiTurnHandle | undefined;
	let finished = false;
	const waiting = new Set<() => void>();

	const outer: PiTurnHandle = {
		subscribe() {
			let cancelled = false;
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let resolveReady!: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void;
			let rejectReady!: (error: unknown) => void;
			const ready = new Promise<ReadableStreamDefaultReader<Uint8Array> | null>((resolve, reject) => {
				resolveReady = resolve;
				rejectReady = reject;
			});
			const connect = () => {
				waiting.delete(connect);
				if (cancelled) return;
				try {
					// A handed-off handle always supplies its own replay, even if
					// finish ran meanwhile. Preparation itself has no event log.
					reader = (real ? real.subscribe() : settledTurnResponse(chatId).body!).getReader();
					resolveReady(reader);
				} catch (error) {
					rejectReady(error);
				}
			};
			return new ReadableStream<Uint8Array>({
				start() {
					if (real || finished) connect();
					else waiting.add(connect);
				},
				async pull(controller) {
					try {
						const source = await ready;
						if (!source || cancelled) return;
						const { value, done } = await source.read();
						if (cancelled) return;
						if (done) {
							reader = undefined;
							source.releaseLock();
							controller.close();
						} else controller.enqueue(value);
					} catch (error) {
						if (!cancelled) controller.error(error);
						reader?.releaseLock();
						reader = undefined;
					}
				},
				async cancel(reason) {
					cancelled = true;
					waiting.delete(connect);
					resolveReady(null);
					const source = reader;
					reader = undefined;
					if (source) {
						try { await source.cancel(reason); }
						finally { source.releaseLock(); }
					}
				},
			});
		},
		abort() {
			if (finished) return;
			if (real) real.abort();
			else preparation.abort();
		},
	};

	if (!beginTurn(chatId, owner)) return null;
	registerTurn(chatId, outer);

	const isCurrent = () => !finished && isTurnOwner(chatId, owner) && runningTurn(chatId) === outer;
	const connectWaiting = () => {
		for (const connect of waiting) connect();
	};
	return {
		signal: preparation.signal,
		isCurrent,
		handoff(realHandle) {
			if (real || preparation.signal.aborted || !isCurrent()) {
				realHandle.abort();
				throw new Error("Turn preparation is no longer eligible for teacher handoff");
			}
			// No await between the ownership check, timestamp reset, and transfer.
			handoffTurn(chatId, owner);
			real = realHandle;
			connectWaiting();
		},
		finish() {
			if (finished) return;
			finished = true;
			connectWaiting();
			// Keep the handle registered until liveness settlement, matching
			// ordinary turns. Both deletions are fenced against a successor,
			// including one admitted by a teacher TTL expiration.
			endTurn(chatId, owner);
			unregisterTurn(chatId, outer);
		},
	};
}
