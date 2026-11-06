import { createChunker, encodePcm16Wav, type PcmChunk } from "@/src/core";

/**
 * One chunked dictation run (Groq or Local), from the first captured frame to the
 * finished transcript. Audio is cut into chunks while the user is still talking
 * (src/core/dictation-chunks.ts, which asks `vad` where the pauses are), each
 * chunk is sent through the engine's transport in the background, and its text
 * waits at its place in the order. stop() sends the last chunk and resolves with
 * the whole transcript. What differs per engine is only the transport: how one
 * chunk's WAV becomes text (dictation-groq.ts, dictation-local.ts).
 *
 * Chunks go ONE AT A TIME, in order: a chunk takes a second or two and the next
 * is ready 15 s later, so one request in flight keeps up. Each carries the end of
 * the previous transcript to the transport (Groq sends it as Whisper's `prompt`,
 * so a sentence across a boundary keeps its spelling and punctuation; parallel
 * requests cannot do that), and a rate limit is met with one request, not a burst.
 * Local's server decodes one chunk at a time anyway, and its language is pinned
 * from the first answer, which needs that answer before the next chunk goes.
 *
 * The audio of EVERY chunk is kept until the caller drops the run (transcript
 * inserted, dismissal, a new recording). A chunk that still fails after its
 * automatic retries is marked failed and later chunks carry on; stop() then
 * reports the failure instead of a partial transcript, and retry() re-sends only
 * the failed ones. Memory is bounded by the session limit: 32 KB per second.
 */

/** Tries per chunk, the first included: the request is repeated at most twice. */
const MAX_ATTEMPTS = 3;
/** Wait before the first repeat; doubles for the next. */
const BACKOFF_MS = 1000;
/** A Retry-After longer than this is not waited out: the chunk fails at once, its
 * message says how long to wait, and Retry picks it up later. */
const MAX_RETRY_WAIT_MS = 20_000;
/** What a chunk interrupted by cancel() reports. */
export const STOPPED_MESSAGE = "Transcription stopped before it finished. Retry to finish it.";

export type SessionResult =
	| { status: "done"; text: string }
	| { status: "failed"; error: string };

export type ChunkStatus = "queued" | "sending" | "done" | "failed";

/** A failed chunk request: `message` is fit to show the user, `retryable` says
 * whether sending the same chunk again may work, `retryAfterMs` is the wait the
 * server asked for. Each engine's transport throws its own subclass. */
export class TranscribeRequestError extends Error {
	constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
		super(message);
		this.name = "TranscribeRequestError";
	}
}

export type ChunkRequest = {
	wav: Uint8Array<ArrayBuffer>;
	seconds: number;
	/** The transcript of the chunk before this one, when that chunk is done and has text. */
	previousText: string | undefined;
	signal: AbortSignal;
};

export type ChunkTranscript = {
	text: string;
	/** A limitation of this take worth showing once (Local's missing language detector). */
	warning?: string;
};

/** One engine's way from a chunk's audio to its text. */
export type ChunkTransport = {
	/** Rejects with a TranscribeRequestError whose message is fit to show the user; a
	 * request aborted through `signal` may reject any way, the session checks the signal first. */
	transcribe(chunk: ChunkRequest): Promise<ChunkTranscript>;
	/** What a failure with no message of its own says, e.g. "Groq transcription failed". */
	failure: string;
	/** The whole transcript from the finished chunks' texts, in order, none of them empty. */
	join(texts: readonly string[]): string;
};

type ChunkState = {
	seconds: number;
	/** The audio, kept until the session is dropped. */
	wav: Uint8Array<ArrayBuffer>;
	status: ChunkStatus;
	text: string;
	error: string | null;
	/** Counts attempts at this chunk by the pump; a result from an older one
	 * (cancelled, then retried) is ignored. */
	run: number;
};

export type ChunkSession = {
	/** Captured audio (PCM16). Ignored once the run has been stopped or cancelled. */
	push(audio: Int16Array): void;
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
	/** The first warning a transport reported for this take (shown once), or null. */
	readonly warning: string | null;
	/** The chunks' states in order, for tests and diagnostics. */
	readonly chunks: readonly Readonly<{ seconds: number; status: ChunkStatus; text: string; error: string | null }>[];
};

export type ChunkSessionOptions = {
	transport: ChunkTransport;
	/** Silero's probabilities for a clip, which is how the chunker finds pauses and silence. */
	vad: (pcm: Int16Array, signal: AbortSignal) => Promise<readonly number[]>;
	sampleRate: number;
	/** Wait for `ms`; rejects when `signal` aborts. Replaceable so tests need no real time. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal.aborted) return reject(signal.reason);
	const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
	const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
	signal.addEventListener("abort", onAbort, { once: true });
});

export function createChunkSession(options: ChunkSessionOptions): ChunkSession {
	const { transport, sampleRate } = options;
	const sleep = options.sleep ?? realSleep;
	const chunks: ChunkState[] = [];
	/** Aborted by cancel(); replaced when retry() starts afresh. */
	let controller = new AbortController();
	let closed = false;
	let running = false;
	let stopped: Promise<SessionResult> | null = null;
	let idleWaiters: (() => void)[] = [];
	let warning: string | null = null;
	/** stop() is waiting for the chunker's last cut: audio that is not a chunk yet. */
	let finishing: Promise<PcmChunk | null> | null = null;

	const enqueue = (chunk: PcmChunk) => {
		chunks.push({
			seconds: chunk.seconds,
			wav: encodePcm16Wav(chunk.pcm, sampleRate),
			status: "queued",
			text: "",
			error: null,
			run: 0,
		});
	};

	/** The text to continue from: the previous chunk's transcript, if that chunk is done. */
	const previousTextFor = (at: number): string | undefined => {
		const previous = chunks[at - 1];
		return previous?.status === "done" && previous.text ? previous.text : undefined;
	};

	const waitFor = (error: TranscribeRequestError, attempt: number): number | undefined => {
		if (attempt >= MAX_ATTEMPTS || !error.retryable) return undefined;
		if (error.retryAfterMs !== undefined) return error.retryAfterMs <= MAX_RETRY_WAIT_MS ? error.retryAfterMs : undefined;
		return BACKOFF_MS * 2 ** (attempt - 1);
	};

	async function send(at: number): Promise<void> {
		const chunk = chunks[at]!;
		const { signal } = controller;
		const run = ++chunk.run;
		const fail = (message: string) => { if (chunk.run === run) { chunk.status = "failed"; chunk.error = message; } };
		chunk.status = "sending";
		// A chunk cut after cancel() (its scoring was in flight) is kept, not sent.
		if (signal.aborted) return fail(STOPPED_MESSAGE);
		for (let attempt = 1; ; attempt++) {
			try {
				const { text, warning: notice } = await transport.transcribe({ wav: chunk.wav, seconds: chunk.seconds, previousText: previousTextFor(at), signal });
				if (chunk.run === run) { chunk.text = text; chunk.status = "done"; chunk.error = null; warning ??= notice || null; }
				return;
			} catch (err) {
				if (signal.aborted) return fail(STOPPED_MESSAGE);
				const error = err instanceof TranscribeRequestError ? err : new TranscribeRequestError(err instanceof Error && err.message ? err.message : transport.failure, false);
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
		// Anything not transcribed counts as failed, so a chunk can never be
		// dropped from the transcript without the user knowing.
		const failed = chunks.find((chunk) => chunk.status !== "done");
		if (failed) return { status: "failed", error: failed.error ?? transport.failure };
		return { status: "done", text: transport.join(chunks.filter((chunk) => chunk.text).map((chunk) => chunk.text)) };
	};

	// A scoring request dies with the run, so cancel() cannot leave one behind. A failed
	// one is the chunker's to absorb: it keeps the audio.
	const chunker = createChunker({
		sampleRate,
		score: (pcm) => options.vad(pcm, controller.signal),
		onChunk(chunk) { enqueue(chunk); kick(); },
	});

	return {
		push(audio) {
			if (closed) return;
			chunker.push(audio);
		},
		get seconds() { return chunker.samples / sampleRate; },
		stop() {
			stopped ??= (async () => {
				closed = true;
				// Waits for a cut in progress, so the last chunk follows the ones before it.
				finishing = chunker.finish();
				const last = await finishing;
				finishing = null;
				if (last) enqueue(last);
				kick();
				await idle();
				return result();
			})();
			return stopped;
		},
		async retry() {
			closed = true;
			// An Esc during the last scoring leaves that chunk still to arrive.
			if (finishing) await finishing;
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
		// The audio still being scored counts: Esc then must keep the recording, not drop it.
		get unsent() { return chunks.filter((chunk) => chunk.status !== "done").length + (finishing ? 1 : 0); },
		get warning() { return warning; },
		get chunks() { return chunks; },
	};
}
