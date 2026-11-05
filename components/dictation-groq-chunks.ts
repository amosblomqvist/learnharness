import { createChunker, encodePcm16Wav, type DictationLanguage, type GroqWhisperModel, type PcmChunk } from "@/src/core";
import { GroqRequestError, transcribeGroq } from "@/components/dictation-groq";

/**
 * One Groq dictation run, from the first captured frame to the finished
 * transcript. Audio is cut into chunks of about 15 s while the user is still
 * talking (src/core/dictation-chunks.ts); each chunk is sent to
 * /api/stt/transcribe in the background, and its text is kept at its place in
 * the order. Nothing is shown until the run ends: stop() sends the last,
 * partial chunk, waits for the rest and resolves with the whole transcript.
 *
 * Chunks go ONE AT A TIME, in order, not in parallel. A chunk takes a second
 * or two to transcribe and the next one is only ready 15 s later, so a single
 * request in flight keeps up with a live recording, and the stop adds one
 * request to wait for, not a queue. In exchange each chunk is sent with the end
 * of the previous chunk's transcript as Whisper's `prompt`, so a sentence that
 * crosses a boundary keeps its spelling, casing and punctuation, which parallel
 * requests cannot do. One request at a time also means a rate limit is met
 * with one request, not a burst, and a retry's backoff holds the line.
 *
 * The audio of EVERY chunk is kept until the run is dropped, which the caller
 * does once the transcript is safely inserted, on an explicit dismissal or when
 * a new recording starts. A chunk that still fails after its automatic retries
 * is marked failed and the run carries on with the later chunks; stop() then
 * reports the failure instead of a partial transcript, and retry() sends only
 * the failed chunks again before reporting the whole transcript. Memory is
 * bounded by the session limit: 32 KB per second of speech.
 */

/** Tries per chunk, the first included: the request is repeated at most twice. */
export const MAX_ATTEMPTS = 3;
/** Wait before the first repeat; doubles for the next. */
export const BACKOFF_MS = 1000;
/** A Retry-After longer than this is not waited out: the chunk fails at once,
 * its message says how long to wait, and the Retry button picks it up later. */
export const MAX_RETRY_WAIT_MS = 20_000;
/** How much of the previous transcript goes along as Whisper's prompt. */
export const PROMPT_TAIL_CHARS = 100;
/** Chunks shorter than this get no prompt: Whisper tends to echo a prompt back
 * when there is almost no audio to transcribe. */
export const PROMPT_MIN_SECONDS = 2;
/** What a chunk interrupted by cancel() reports. */
export const STOPPED_MESSAGE = "Transcription stopped before it finished. Retry to finish it.";

export type SessionResult =
	| { status: "done"; text: string }
	| { status: "failed"; error: string };

export type ChunkStatus = "queued" | "sending" | "done" | "failed" | "skipped";

type ChunkState = {
	seconds: number;
	/** The audio, kept until the session is dropped. Null for a skipped chunk. */
	wav: Uint8Array<ArrayBuffer> | null;
	status: ChunkStatus;
	text: string;
	error: string | null;
	/** Counts attempts at this chunk by the pump; a result from an older one
	 * (cancelled, then retried) is ignored. */
	run: number;
};

export type ChunkSession = {
	/** Captured audio (PCM16). Ignored once the run has been stopped or cancelled. */
	push(audio: ArrayBuffer): void;
	/** Seconds of audio captured so far. */
	readonly seconds: number;
	/** End the recording: send the last chunk, wait for every chunk, and report
	 * the transcript or the failure. Calling it again returns the same promise. */
	stop(): Promise<SessionResult>;
	/** After a failure: send only the failed chunks again, in order, and report
	 * the whole transcript or the failure that remains. */
	retry(): Promise<SessionResult>;
	/** Abort what is in flight. Chunks that had not finished count as failed
	 * (STOPPED_MESSAGE), so retry() can pick them up; a stop() or retry() still
	 * waiting settles with that failure. */
	cancel(): void;
	/** Chunks that still have no transcript: queued, in flight or failed. */
	readonly unsent: number;
	/** The chunks' states in order, for tests and diagnostics. */
	readonly chunks: readonly Readonly<{ seconds: number; status: ChunkStatus; text: string; error: string | null }>[];
};

export type ChunkSessionOptions = {
	request: typeof fetch;
	model: GroqWhisperModel;
	language: DictationLanguage;
	sampleRate: number;
	maxAttempts?: number;
	backoffMs?: number;
	maxRetryWaitMs?: number;
	/** Wait for `ms`; rejects when `signal` aborts. Replaceable so tests need no real time. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal.aborted) return reject(signal.reason);
	const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
	const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
	signal.addEventListener("abort", onAbort, { once: true });
});

/** The last PROMPT_TAIL_CHARS characters of `text`, starting at a word. */
export function promptTail(text: string): string {
	const chars = [...text.trim()];
	if (chars.length <= PROMPT_TAIL_CHARS) return chars.join("");
	const tail = chars.slice(-PROMPT_TAIL_CHARS).join("");
	// The cut usually lands inside a word: drop its fragment.
	return /\s/.test(chars[chars.length - PROMPT_TAIL_CHARS - 1]!) ? tail : tail.replace(/^\S*\s+/, "");
}

export function createChunkSession(options: ChunkSessionOptions): ChunkSession {
	const { request, model, language, sampleRate } = options;
	const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
	const backoffMs = options.backoffMs ?? BACKOFF_MS;
	const maxRetryWaitMs = options.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
	const sleep = options.sleep ?? realSleep;
	const chunker = createChunker({ sampleRate });
	const chunks: ChunkState[] = [];
	/** Aborted by cancel(); replaced when retry() starts afresh. */
	let controller = new AbortController();
	let closed = false;
	let running = false;
	let stopped: Promise<SessionResult> | null = null;
	let idleWaiters: (() => void)[] = [];

	const enqueue = (chunk: PcmChunk) => {
		chunks.push({
			seconds: chunk.seconds,
			wav: chunk.skip ? null : encodePcm16Wav(chunk.pcm, sampleRate),
			status: chunk.skip ? "skipped" : "queued",
			text: "",
			error: null,
			run: 0,
		});
	};

	/** The text to continue from: the previous chunk's transcript, looking back
	 * over skipped (silent) chunks, if that chunk is done. */
	const promptFor = (at: number): string | undefined => {
		if (chunks[at]!.seconds < PROMPT_MIN_SECONDS) return undefined;
		let before = at - 1;
		while (before >= 0 && chunks[before]!.status === "skipped") before--;
		const previous = chunks[before];
		return previous?.status === "done" && previous.text ? promptTail(previous.text) : undefined;
	};

	const waitFor = (error: GroqRequestError, attempt: number): number | undefined => {
		if (attempt >= maxAttempts || !error.retryable) return undefined;
		if (error.retryAfterMs !== undefined) return error.retryAfterMs <= maxRetryWaitMs ? error.retryAfterMs : undefined;
		return backoffMs * 2 ** (attempt - 1);
	};

	async function send(at: number): Promise<void> {
		const chunk = chunks[at]!;
		const { signal } = controller;
		const run = ++chunk.run;
		const fail = (message: string) => { if (chunk.run === run) { chunk.status = "failed"; chunk.error = message; } };
		chunk.status = "sending";
		for (let attempt = 1; ; attempt++) {
			try {
				const text = await transcribeGroq(request, { wav: chunk.wav!, model, language, prompt: promptFor(at), signal });
				if (chunk.run === run) { chunk.text = text; chunk.status = "done"; chunk.error = null; }
				return;
			} catch (err) {
				if (signal.aborted) return fail(STOPPED_MESSAGE);
				const error = err instanceof GroqRequestError ? err : new GroqRequestError(err instanceof Error ? err.message : "Groq transcription failed", false);
				const wait = waitFor(error, attempt);
				if (wait === undefined) return fail(error.message);
				try { await sleep(wait, signal); } catch { return fail(STOPPED_MESSAGE); }
			}
		}
	}

	async function pump(): Promise<void> {
		try {
			for (;;) {
				const at = chunks.findIndex((chunk) => chunk.status === "queued");
				if (at < 0) return;
				await send(at);
			}
		} finally {
			// Synchronously after the last look at the queue, so a chunk pushed
			// after it starts a new pump instead of being stranded.
			running = false;
			for (const wake of idleWaiters.splice(0)) wake();
		}
	}

	const kick = () => {
		if (running) return;
		running = true;
		void pump();
	};

	const idle = async () => {
		while (running) await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
	};

	const result = (): SessionResult => {
		// Anything that is neither transcribed nor skipped counts as failed, so a
		// chunk can never be dropped from the transcript without the user knowing.
		const failed = chunks.find((chunk) => chunk.status !== "done" && chunk.status !== "skipped");
		if (failed) return { status: "failed", error: failed.error ?? "Groq transcription failed" };
		const text = chunks.filter((chunk) => chunk.status === "done" && chunk.text).map((chunk) => chunk.text).join(" ");
		return { status: "done", text };
	};

	return {
		push(audio) {
			if (closed) return;
			for (const chunk of chunker.push(audio)) enqueue(chunk);
			kick();
		},
		get seconds() { return chunker.samples / sampleRate; },
		stop() {
			stopped ??= (async () => {
				closed = true;
				const last = chunker.finish();
				if (last) enqueue(last);
				kick();
				await idle();
				return result();
			})();
			return stopped;
		},
		async retry() {
			closed = true;
			if (controller.signal.aborted) controller = new AbortController();
			for (const chunk of chunks) {
				// Bumping `run` retires any attempt of a cancelled run still unwinding.
				if (chunk.status === "failed") { chunk.status = "queued"; chunk.error = null; chunk.run++; }
			}
			kick();
			await idle();
			return result();
		},
		cancel() {
			closed = true;
			controller.abort();
			for (const chunk of chunks) {
				if (chunk.status === "queued" || chunk.status === "sending") { chunk.status = "failed"; chunk.error = STOPPED_MESSAGE; chunk.run++; }
			}
		},
		get unsent() { return chunks.filter((chunk) => chunk.status !== "done" && chunk.status !== "skipped").length; },
		get chunks() { return chunks; },
	};
}
