/**
 * One chunked Groq dictation run: ordering, the background pump, prompts,
 * retries with backoff, Retry sending only what failed, and cancelling.
 * fetch and the clock are fakes; no network, no key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BACKOFF_MS, createChunkSession, MAX_ATTEMPTS, MAX_RETRY_WAIT_MS, PROMPT_TAIL_CHARS, promptTail, STOPPED_MESSAGE,
	type ChunkSession,
} from "../components/dictation-groq-chunks.ts";
import { GROQ_DICTATION_KEYLESS } from "../components/dictation-groq.ts";
import { GROQ_DICTATION_HEADER } from "../src/core/dictation.ts";

const RATE = 16000;
const loud = (seconds: number) => {
	const out = new Int16Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
	return out;
};
const quiet = (seconds: number) => new Int16Array(Math.round(seconds * RATE));
const join = (...parts: Int16Array[]) => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) { out.set(part, at); at += part.length; }
	return out;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Call { form: FormData; init: RequestInit; bytes: number; prompt: string | null }
type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

const ok = (text: string) => Response.json({ text });
const failure = (status: number, message: string, retryable: boolean, headers?: HeadersInit) =>
	Response.json({ message, retryable }, { status, headers });

/** A fake fetch answering from a script, one entry per call, in call order. */
function harness(script: Reply[], options: { maxAttempts?: number; maxRetryWaitMs?: number; holdSleep?: boolean } = {}) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const queue = [...script];
	const request = (async (_url: string, init?: RequestInit) => {
		const form = init!.body as FormData;
		const call: Call = { form, init: init!, bytes: (form.get("audio") as File).size, prompt: form.get("prompt") as string | null };
		calls.push(call);
		if (init!.signal?.aborted) throw init!.signal.reason;
		const next = queue.shift();
		if (next === undefined) throw new Error(`unexpected request #${calls.length}`);
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next(call) : next;
	}) as unknown as typeof fetch;
	const session = createChunkSession({
		request, model: "whisper-large-v3-turbo", language: "en", sampleRate: RATE,
		sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
			sleeps.push(ms);
			if (signal.aborted) return reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			if (!options.holdSleep) setImmediate(resolve);
		}),
		maxAttempts: options.maxAttempts,
		maxRetryWaitMs: options.maxRetryWaitMs,
	});
	return { session, calls, sleeps, queue };
}

/** 40 s of speech: two full chunks and a tail of about 10 s, so three requests. */
const SPEECH = loud(40);

describe("while recording", () => {
	it("sends each chunk in the background as soon as it is cut, before the recording ends", async () => {
		const { session, calls } = harness([ok("one"), ok("two"), ok("three")]);
		session.push(SPEECH.slice(0, 18 * RATE).buffer);
		await tick();
		assert.equal(calls.length, 1, "the first chunk went out the moment 18 s were captured");
		assert.deepEqual(session.chunks.map((c) => c.status), ["done"]);
		session.push(SPEECH.slice(18 * RATE).buffer);
		await tick();
		assert.equal(calls.length, 2, "and the second at ~33 s");
		assert.equal(session.chunks.at(-1)!.text, "two");
		const result = await session.stop();
		assert.equal(calls.length, 3, "stop sends the last, partial chunk");
		assert.deepEqual(result, { status: "done", text: "one two three" });
	});

	it("sends one request at a time, in order", async () => {
		let inFlight = 0;
		let peak = 0;
		const slow = (text: string) => async () => {
			inFlight++; peak = Math.max(peak, inFlight);
			await tick();
			inFlight--;
			return ok(text);
		};
		const { session } = harness([slow("a"), slow("b"), slow("c")]);
		session.push(SPEECH.buffer);
		const result = await session.stop();
		assert.equal(peak, 1);
		assert.deepEqual(result, { status: "done", text: "a b c" });
	});

	it("sends valid WAV chunks of the right size with the model, language and header", async () => {
		const { session, calls } = harness([ok("a"), ok("b"), ok("c")]);
		session.push(SPEECH.buffer);
		await session.stop();
		const first = calls[0]!;
		assert.deepEqual(first.init.headers, { [GROQ_DICTATION_HEADER]: "1" });
		assert.equal(first.form.get("model"), "whisper-large-v3-turbo");
		assert.equal(first.form.get("language"), "en");
		const wav = new Uint8Array(await (first.form.get("audio") as File).arrayBuffer());
		assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
		assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
		assert.ok(first.bytes > 44 + 12 * RATE * 2 && first.bytes <= 44 + 18 * RATE * 2, "between 12 and 18 s of audio");
		const sent = calls.reduce((total, call) => total + call.bytes - 44, 0);
		assert.equal(sent, SPEECH.length * 2, "every sample was sent, once");
	});

	it("reports the seconds captured", async () => {
		const { session } = harness([]);
		session.push(quiet(3).buffer);
		session.push(quiet(1.5).buffer);
		assert.equal(session.seconds, 4.5);
		session.cancel();
	});
});

describe("ordered assembly", () => {
	it("skips blank texts and silent chunks without leaving double spaces or gaps", async () => {
		const audio = join(loud(14), quiet(0.4), loud(3), quiet(30), loud(14));
		const { session, calls } = harness([ok("hello"), ok(""), ok("goodbye"), ok("again"), ok("more"), ok("last")]);
		session.push(audio.buffer);
		const result = await session.stop();
		assert.equal(result.status, "done");
		assert.ok(session.chunks.some((c) => c.status === "skipped"), "the silent stretch was not sent");
		assert.equal(calls.length, session.chunks.filter((c) => c.status !== "skipped").length);
		const text = (result as { text: string }).text;
		assert.ok(!text.includes("  ") && text === text.trim() && text.startsWith("hello") && !text.startsWith("hello  "));
		assert.ok(session.chunks.some((c) => c.status === "done" && c.text === ""), "an empty transcript is a finished chunk, not a failure");
	});
});

describe("silence and very short audio", () => {
	it("sends nothing for a recording that is only silence, and ends with an empty transcript", async () => {
		const { session, calls } = harness([]);
		session.push(quiet(40).buffer);
		assert.deepEqual(await session.stop(), { status: "done", text: "" });
		assert.equal(calls.length, 0);
		assert.equal(session.unsent, 0);
	});

	it("sends nothing at all when nothing was captured", async () => {
		const { session, calls } = harness([]);
		assert.deepEqual(await session.stop(), { status: "done", text: "" });
		assert.equal(calls.length, 0);
	});
});

describe("prompt: continuing across a boundary", () => {
	it("gives each chunk the end of the previous transcript, and the first none", async () => {
		const sentence = "the quick brown fox jumps over the lazy dog and keeps running through the whole wide field until night";
		const { session, calls } = harness([ok(sentence), ok("second chunk text"), ok("third")]);
		session.push(SPEECH.buffer);
		await session.stop();
		assert.equal(calls[0]!.prompt, null);
		assert.equal(calls[1]!.prompt, promptTail(sentence));
		assert.equal(calls[2]!.prompt, "second chunk text");
	});

	it("sends no prompt to a very short chunk, which Whisper would echo it back for", async () => {
		// A pause just before the end of the window leaves a 0.85 s tail.
		const { session, calls } = harness([ok("a long first part"), ok("tail")]);
		session.push(join(loud(17.7), quiet(0.4), loud(0.5)).buffer);
		await session.stop();
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.prompt, null, "a sub-two-second tail carries no prompt");
	});

	it("looks back past a silent chunk to the last one with text", async () => {
		const audio = join(loud(16.5), quiet(0.5), quiet(18), quiet(0.5), loud(5));
		const { session, calls } = harness([ok("before the quiet"), ok("after")]);
		session.push(audio.buffer);
		await session.stop();
		assert.equal(session.chunks.some((c) => c.status === "skipped"), true);
		assert.equal(calls[1]!.prompt, "before the quiet");
	});

	it("sends none when the previous chunk failed", async () => {
		const { session, calls } = harness([failure(502, "no", false), ok("later")]);
		session.push(loud(25).buffer);
		await session.stop();
		assert.equal(calls[1]!.prompt, null);
	});

	it("promptTail keeps the last words, starting at a word, and handles unspaced scripts", () => {
		assert.equal(promptTail("  short text  "), "short text");
		const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const tail = promptTail(words);
		assert.ok(tail.length <= PROMPT_TAIL_CHARS);
		assert.ok(words.endsWith(tail));
		assert.match(tail, /^word\d+/, "no word fragment at the front");
		const kanji = "日本語".repeat(100);
		assert.equal([...promptTail(kanji)].length, PROMPT_TAIL_CHARS);
		assert.equal(promptTail(""), "");
	});
});

describe("retrying a failing chunk", () => {
	it("repeats a transient failure with doubling backoff, then succeeds", async () => {
		const { session, calls, sleeps } = harness([failure(502, "Groq is unavailable (503).", true), failure(502, "Groq is unavailable (503).", true), ok("finally")]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "done", text: "finally" });
		assert.equal(calls.length, 3);
		assert.deepEqual(sleeps, [BACKOFF_MS, BACKOFF_MS * 2]);
	});

	it("gives up after a bounded number of attempts and reports the last message", async () => {
		const { session, calls, sleeps } = harness([failure(502, "Groq is unavailable (503).", true), failure(502, "Groq is unavailable (503).", true), failure(502, "Groq is unavailable (503). Try again shortly.", true)]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "failed", error: "Groq is unavailable (503). Try again shortly." });
		assert.equal(calls.length, MAX_ATTEMPTS);
		assert.equal(sleeps.length, MAX_ATTEMPTS - 1);
		assert.equal(session.unsent, 1);
	});

	it("does not repeat a failure that cannot help, such as a rejected key", async () => {
		const { session, calls, sleeps } = harness([failure(502, "Groq rejected the API key (401).", false)]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "failed", error: "Groq rejected the API key (401)." });
		assert.equal(calls.length, 1);
		assert.deepEqual(sleeps, []);
	});

	it("a missing key is not retried and keeps the line the Settings link recognises", async () => {
		const { session, calls } = harness([failure(503, "No GROQ_API_KEY", false)]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "failed", error: GROQ_DICTATION_KEYLESS });
		assert.equal(calls.length, 1);
	});

	it("waits as long as a 429's Retry-After says, not the default backoff", async () => {
		const { session, sleeps } = harness([failure(429, "Groq rate limit reached. Try again in 7 s.", true, { "retry-after": "7" }), ok("after the wait")]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "done", text: "after the wait" });
		assert.deepEqual(sleeps, [7000]);
	});

	it("does not wait out a long Retry-After: it fails at once and says how long", async () => {
		const { session, calls, sleeps } = harness([failure(429, "Groq rate limit reached. Try again in 10 min.", true, { "retry-after": "600" })]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "failed", error: "Groq rate limit reached. Try again in 10 min." });
		assert.equal(calls.length, 1);
		assert.deepEqual(sleeps, []);
		assert.ok(600_000 > MAX_RETRY_WAIT_MS);
	});

	it("treats a dropped connection as transient and a non-route gateway error as retryable", async () => {
		const { session, calls } = harness([new TypeError("fetch failed"), new Response("<html>bad gateway</html>", { status: 502 }), ok("through")]);
		session.push(loud(5).buffer);
		assert.deepEqual(await session.stop(), { status: "done", text: "through" });
		assert.equal(calls.length, 3);
	});

	it("a retry for one chunk holds the later chunks back, and they carry on after it", async () => {
		const { session, calls } = harness([failure(502, "x", true), ok("a"), ok("b"), ok("c")]);
		session.push(loud(40).buffer);
		const result = await session.stop();
		assert.deepEqual(result, { status: "done", text: "a b c" });
		assert.equal(calls.length, 4);
		assert.equal(calls[0]!.bytes, calls[1]!.bytes, "the same chunk was sent twice, then the next");
	});

	it("keeps going after a chunk fails for good: later chunks are still sent", async () => {
		const { session, calls } = harness([failure(502, "bad audio", false), ok("two"), ok("three")]);
		session.push(loud(40).buffer);
		const result = await session.stop();
		assert.equal(result.status, "failed");
		assert.equal(calls.length, 3);
		assert.deepEqual(session.chunks.map((c) => c.status), ["failed", "done", "done"]);
	});
});

describe("Retry sends only the failed chunks", () => {
	it("resends just those, with the same audio, and then reports the whole transcript", async () => {
		const { session, calls } = harness([
			ok("one"), failure(502, "boom", false), ok("three"), // first pass over three chunks
			ok("two"), // the retry
		]);
		session.push(loud(40).buffer);
		assert.equal((await session.stop()).status, "failed");
		const middle = calls[1]!;
		const result = await session.retry();
		assert.equal(calls.length, 4, "exactly one more request");
		assert.equal(calls[3]!.bytes, middle.bytes);
		const before = new Uint8Array(await (middle.form.get("audio") as File).arrayBuffer());
		const after = new Uint8Array(await (calls[3]!.form.get("audio") as File).arrayBuffer());
		assert.deepEqual(after, before, "the very same audio goes up again");
		assert.equal(calls[3]!.prompt, "one", "and it continues from the chunk before it");
		assert.deepEqual(result, { status: "done", text: "one two three" });
		assert.equal(session.unsent, 0);
	});

	it("can fail again and be retried again, still without touching the finished chunks", async () => {
		const { session, calls } = harness([ok("a"), failure(502, "boom", false), failure(502, "boom again", false), ok("b")]);
		session.push(loud(25).buffer);
		assert.equal((await session.stop()).status, "failed");
		assert.deepEqual(await session.retry(), { status: "failed", error: "boom again" });
		assert.deepEqual(await session.retry(), { status: "done", text: "a b" });
		assert.equal(calls.length, 4);
	});

	it("with nothing failed, retry sends nothing and reports the transcript", async () => {
		const { session, calls } = harness([ok("only")]);
		session.push(loud(5).buffer);
		await session.stop();
		assert.deepEqual(await session.retry(), { status: "done", text: "only" });
		assert.equal(calls.length, 1);
	});

	it("retries every failed chunk, in order, each continuing from the one before", async () => {
		const { session, calls } = harness([
			failure(502, "x", false), failure(502, "y", false), failure(502, "z", false),
			ok("A one"), ok("B two"), ok("C three"),
		]);
		session.push(loud(40).buffer);
		await session.stop();
		const result = await session.retry();
		assert.deepEqual(result, { status: "done", text: "A one B two C three" });
		assert.equal(calls[3]!.prompt, null);
		assert.equal(calls[4]!.prompt, "A one");
		assert.equal(calls[5]!.prompt, "B two");
	});
});

describe("stop is idempotent", () => {
	it("a second stop returns the same result and uploads no extra chunk", async () => {
		const { session, calls } = harness([ok("hello")]);
		session.push(loud(5).buffer);
		const first = session.stop();
		const second = session.stop();
		assert.equal(first, second, "the same promise");
		assert.deepEqual(await first, { status: "done", text: "hello" });
		assert.deepEqual(await session.stop(), { status: "done", text: "hello" }, "even after it settled");
		assert.equal(calls.length, 1, "one request for one recording; no empty 44-byte chunk");
	});

	it("audio arriving after stop is ignored", async () => {
		const { session, calls } = harness([ok("hello")]);
		session.push(loud(5).buffer);
		const done = session.stop();
		session.push(loud(5).buffer);
		await done;
		assert.equal(calls.length, 1);
		assert.equal(session.seconds, 5);
	});
});

describe("cancel", () => {
	it("aborts the request in flight and settles a waiting stop() instead of leaving it hanging", async () => {
		let signal: AbortSignal | undefined;
		const { session, calls } = harness([(call) => {
			signal = call.init.signal!;
			return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
		}]);
		session.push(loud(5).buffer);
		const waiting = session.stop();
		await tick();
		assert.equal(calls.length, 1);
		session.cancel();
		assert.equal(signal!.aborted, true);
		assert.deepEqual(await waiting, { status: "failed", error: STOPPED_MESSAGE });
		assert.equal(session.unsent, 1, "the audio is still there to retry");
	});

	it("interrupts a backoff wait", async () => {
		const { session, calls, sleeps } = harness([failure(502, "x", true)], { holdSleep: true });
		session.push(loud(5).buffer);
		const waiting = session.stop();
		await tick();
		assert.equal(sleeps.length, 1, "waiting to try again");
		session.cancel();
		assert.deepEqual(await waiting, { status: "failed", error: STOPPED_MESSAGE });
		assert.equal(calls.length, 1, "and never tried again");
	});

	it("retry after a cancel picks up only the chunks that had not finished, even when called at once", async () => {
		const gate: { release?: () => void } = {};
		const { session, calls } = harness([
			ok("one"), // chunk 1 completes
			(call) => new Promise<Response>((_resolve, reject) => { gate.release = () => reject(call.init.signal!.reason); call.init.signal!.addEventListener("abort", gate.release, { once: true }); }),
			ok("two"), ok("three"), // after the retry
		]);
		session.push(loud(40).buffer);
		const waiting = session.stop();
		await tick();
		assert.equal(calls.length, 2);
		session.cancel();
		const retried = session.retry(); // straight away, before the aborted attempt has unwound
		assert.deepEqual(await retried, { status: "done", text: "one two three" });
		assert.equal((await waiting).status, "done", "the original stop settles with the final outcome too");
		assert.equal(calls.length, 4, "the finished chunk was not sent again");
	});
});

describe("limits", () => {
	it("uses the documented defaults", () => {
		assert.equal(MAX_ATTEMPTS, 3);
		assert.equal(BACKOFF_MS, 1000);
		assert.equal(MAX_RETRY_WAIT_MS, 20_000);
	});

	it("honours custom limits", async () => {
		const { session, calls } = harness([failure(502, "x", true), failure(502, "x", true)], { maxAttempts: 2 });
		session.push(loud(5).buffer);
		assert.equal((await session.stop()).status, "failed");
		assert.equal(calls.length, 2);
	});
});

export type { ChunkSession };
