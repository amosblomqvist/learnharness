/**
 * In-memory audio cache for read aloud (ElevenLabs voice slice 8).
 *
 * Wraps a chunk loader (text, signal, options → audio Blob) so replaying a
 * message in the same window makes no request. Memory only: nothing touches
 * disk, and the cache dies with the window.
 *
 *  - Key: (chunk text, voice id, model id). "No voice / no model" (the server
 *    picks its defaults) is its own value, distinct from any explicit id.
 *  - Cap: ~50 MB of Blob size in total. Past it, the OLDEST entries (by
 *    insertion; a hit does not refresh) are dropped first. A single blob over
 *    the cap is served but never kept.
 *  - Only a successful load is kept. Failed and aborted loads never are.
 *  - Concurrent loads of one key share a single request. That request is
 *    aborted only when every caller waiting on it has aborted, so one
 *    caller's stop() can't cancel audio another one still wants.
 */

/** What changes the audio for the same text. Both absent → the server defaults. */
export interface SpeechOptions {
	voiceId?: string;
	modelId?: string;
}

export type ChunkLoader = (text: string, signal: AbortSignal, options?: SpeechOptions) => Promise<Blob>;

/** ~50 MB of audio bytes (owner decision, PRD "In-memory audio cache"). */
export const AUDIO_CACHE_MAX_BYTES = 50 * 1024 * 1024;

interface Inflight {
	promise: Promise<Blob>;
	controller: AbortController;
	waiters: number;
}

const abortError = () => new DOMException("aborted", "AbortError");

export function withAudioCache(load: ChunkLoader, { maxBytes = AUDIO_CACHE_MAX_BYTES } = {}): ChunkLoader {
	/** Insertion-ordered, so the first key is the oldest. */
	const entries = new Map<string, Blob>();
	const inflight = new Map<string, Inflight>();
	let total = 0;

	const remember = (key: string, blob: Blob) => {
		if (blob.size > maxBytes) return;
		entries.set(key, blob);
		total += blob.size;
		for (const [oldest, old] of entries) {
			if (total <= maxBytes) break;
			entries.delete(oldest);
			total -= old.size;
		}
	};

	return (text, signal, options) => {
		const key = JSON.stringify([text, options?.voiceId ?? null, options?.modelId ?? null]);
		const hit = entries.get(key);
		if (hit) return Promise.resolve(hit);
		if (signal.aborted) return Promise.reject(abortError());

		let request = inflight.get(key);
		if (!request) {
			const controller = new AbortController();
			const started: Inflight = {
				controller,
				waiters: 0,
				promise: load(text, controller.signal, options).then(
					(blob) => {
						if (inflight.get(key) === started) {
							inflight.delete(key);
							remember(key, blob);
						}
						return blob;
					},
					(error) => {
						if (inflight.get(key) === started) inflight.delete(key);
						throw error;
					},
				),
			};
			request = started;
			inflight.set(key, started);
		}

		const shared = request;
		shared.waiters++;
		return new Promise<Blob>((resolve, reject) => {
			const onAbort = () => {
				if (--shared.waiters === 0) {
					if (inflight.get(key) === shared) inflight.delete(key);
					shared.controller.abort();
				}
				reject(abortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			shared.promise.then(
				(blob) => {
					signal.removeEventListener("abort", onAbort);
					resolve(blob);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	};
}
