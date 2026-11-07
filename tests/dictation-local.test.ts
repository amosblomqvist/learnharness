/**
 * The renderer's side of Local dictation: the readiness check, the transcribe transport
 * (what it sends, how it maps the route's answers, the per-take language pin) and the
 * chunk session over it (ordered assembly, retry, Retry). fetch and Silero are fakes;
 * no model is loaded. Where the hook uses it is tested in dictation-chunked-flow.test.tsx.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChunkSession, STOPPED_MESSAGE, TranscribeRequestError } from "../components/dictation-chunk-session.ts";
import {
	checkLocalReady, LOCAL_DICTATION_NO_MODEL, localTransport, warmLocalModel,
} from "../components/dictation-local.ts";
import { GROQ_DICTATION_HEADER } from "../src/core/dictation.ts";
import { energyVad } from "./helpers/dictation-vad.ts";

const RATE = 16000;
const loud = (seconds: number) => {
	const out = new Int16Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
	return out;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const wav = new Uint8Array(100) as Uint8Array<ArrayBuffer>;

interface Call { url: string; init: RequestInit; form: FormData }
type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

/** A fake fetch answering from a script, one entry per call. */
function script(replies: Reply[]) {
	const calls: Call[] = [];
	const queue = [...replies];
	const request = (async (url: string, init: RequestInit) => {
		const call = { url, init, form: init.body as FormData };
		calls.push(call);
		const next = queue.shift();
		if (next === undefined) throw new Error(`unexpected request #${calls.length}`);
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next(call) : next;
	}) as unknown as typeof fetch;
	return { calls, request };
}

const ok = (text: string, extra: Record<string, unknown> = {}) => Response.json({ text, ...extra });
const failure = (status: number, message: string, retryable: boolean) => Response.json({ message, retryable }, { status });
const OPTIONS = { model: "whisper-small", language: "auto", preferredLanguages: ["en", "de"], chineseOutput: "simplified" } as const;

const models = (over: Record<string, unknown> = {}) => ({
	hardwareTier: "cpu", engineAvailable: true,
	models: [{ id: "whisper-small", installed: true, partialBytes: 0, download: null }, { id: "whisper-tiny", installed: false, partialBytes: 0, download: null }],
	languageDetector: { id: "voxlingua107-ecapa-q8", installed: false, partialBytes: 0, download: null },
	...over,
});

describe("checkLocalReady", () => {
	it("refuses an unchosen model without asking the server", async () => {
		const { calls, request } = script([]);
		await assert.rejects(checkLocalReady("", request), { message: LOCAL_DICTATION_NO_MODEL });
		assert.equal(calls.length, 0);
	});

	it("resolves for an installed model, asking the models route with the dictation header", async () => {
		const { calls, request } = script([Response.json(models())]);
		await checkLocalReady("whisper-small", request);
		assert.equal(calls[0]!.url, "/api/stt/local/models");
		assert.deepEqual(calls[0]!.init.headers, { [GROQ_DICTATION_HEADER]: "1" });
	});

	it("reads a model that is chosen but not installed (or no longer in the list) as no model", async () => {
		await assert.rejects(checkLocalReady("whisper-tiny", script([Response.json(models())]).request), { message: LOCAL_DICTATION_NO_MODEL });
		await assert.rejects(checkLocalReady("gone", script([Response.json(models())]).request), { message: LOCAL_DICTATION_NO_MODEL });
		const downloading = models({ models: [{ id: "whisper-small", installed: false, partialBytes: 5, download: { state: "downloading", bytes: 5, total: 10 } }] });
		await assert.rejects(checkLocalReady("whisper-small", script([Response.json(downloading)]).request), { message: LOCAL_DICTATION_NO_MODEL });
	});

	it("says why when the engine cannot load, and what went wrong when the route or the network fails", async () => {
		await assert.rejects(checkLocalReady("whisper-small", script([Response.json(models({ engineAvailable: false, engineError: "No native engine." }))]).request), { message: "No native engine." });
		await assert.rejects(checkLocalReady("whisper-small", script([Response.json(models({ engineAvailable: false }))]).request), /can't run on this computer/);
		await assert.rejects(checkLocalReady("whisper-small", script([failure(403, "Dictation requests must come from the LearnHarness window.", false)]).request), /must come from the LearnHarness window/);
		await assert.rejects(checkLocalReady("whisper-small", script([new Response("<html>", { status: 500 })]).request), /Local dictation failed \(500\)/);
		await assert.rejects(checkLocalReady("whisper-small", script([new TypeError("offline")]).request), /Could not reach/);
	});
});

describe("warmLocalModel", () => {
	it("posts the warm action as JSON to the model route with the dictation header, and returns at once", () => {
		const { calls, request } = script([Response.json({ model: "whisper-small" })]);
		assert.equal(warmLocalModel("whisper-small", request), undefined);
		assert.equal(calls[0]!.url, "/api/stt/local/models/whisper-small");
		assert.equal(calls[0]!.init.method, "POST");
		assert.deepEqual(calls[0]!.init.headers, { [GROQ_DICTATION_HEADER]: "1", "Content-Type": "application/json" });
		assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { action: "warm" });
	});

	it("swallows a network failure, a refusal and a fetch that throws at once", async () => {
		warmLocalModel("whisper-small", script([new TypeError("offline")]).request);
		warmLocalModel("whisper-small", script([failure(409, "no", false)]).request);
		warmLocalModel("whisper-small", (() => { throw new Error("sync"); }) as unknown as typeof fetch);
		await tick();
	});
});

describe("the transcribe transport", () => {
	const transcribe = (request: typeof fetch, options: Partial<Parameters<typeof localTransport>[1]> = {}, signal = new AbortController().signal) =>
		localTransport(request, { ...OPTIONS, ...options }).transcribe({ wav, seconds: 15, previousText: undefined, signal });

	it("posts the WAV, the model, the preferred languages, the language and the Chinese output to the local route", async () => {
		const { calls, request } = script([ok("  hello  ")]);
		const signal = new AbortController().signal;
		assert.deepEqual(await transcribe(request, { chineseOutput: "traditional" }, signal), { text: "hello", warning: undefined });
		const { url, init, form } = calls[0]!;
		assert.equal(url, "/api/stt/local/transcribe");
		assert.equal(init.method, "POST");
		assert.deepEqual(init.headers, { [GROQ_DICTATION_HEADER]: "1" });
		assert.equal(init.signal, signal);
		assert.equal((form.get("audio") as File).type, "audio/wav");
		assert.equal(form.get("model"), "whisper-small");
		assert.deepEqual(JSON.parse(form.get("preferredLanguages") as string), ["en", "de"]);
		assert.equal(form.get("language"), "auto");
		assert.equal(form.get("chineseOutput"), "traditional");
		assert.equal(form.get("prompt"), null, "the local route takes no prompt");
	});

	it("maps the route's refusals: a missing model is final, a decode failure is retryable as the server says", async () => {
		const missing = await transcribe(script([failure(409, "That model isn't downloaded. Choose it in Settings → Dictation.", false)]).request).catch((e: unknown) => e);
		assert.ok(missing instanceof TranscribeRequestError);
		assert.equal((missing as TranscribeRequestError).message, "That model isn't downloaded. Choose it in Settings → Dictation.");
		assert.equal((missing as TranscribeRequestError).retryable, false);
		const decode = await transcribe(script([failure(500, "The speech model could not decode this audio.", true)]).request).catch((e: unknown) => e);
		assert.equal((decode as TranscribeRequestError).retryable, true);
		const bare = await transcribe(script([new Response("<html>", { status: 502 })]).request).catch((e: unknown) => e);
		assert.equal((bare as TranscribeRequestError).message, "Local dictation failed (502)");
		assert.equal((bare as TranscribeRequestError).retryable, true, "a gateway error is worth repeating");
		const invalid = await transcribe(script([new Response("<html>", { status: 400 })]).request).catch((e: unknown) => e);
		assert.equal((invalid as TranscribeRequestError).retryable, false);
	});

	it("treats a dropped connection as transient and an answer without text as final", async () => {
		const dropped = await transcribe(script([new TypeError("fetch failed")]).request).catch((e: unknown) => e);
		assert.match((dropped as TranscribeRequestError).message, /Could not send the recording/);
		assert.equal((dropped as TranscribeRequestError).retryable, true);
		const empty = await transcribe(script([Response.json({ nope: 1 })]).request).catch((e: unknown) => e);
		assert.match((empty as TranscribeRequestError).message, /no transcript/);
		assert.equal((empty as TranscribeRequestError).retryable, false);
	});

	it("pins the language the first answer with words reports, and sends it from then on", async () => {
		const { calls, request } = script([ok("one", { language: "de" }), ok("two", { language: "fr" }), ok("three")]);
		const transport = localTransport(request, OPTIONS);
		const chunk = { wav, seconds: 15, previousText: undefined, signal: new AbortController().signal };
		await transport.transcribe(chunk);
		await transport.transcribe(chunk);
		await transport.transcribe(chunk);
		assert.deepEqual(calls.map((c) => c.form.get("language")), ["auto", "de", "de"], "a later answer cannot move the pin");
	});

	it("does not pin from an answer with no words, or an answer with no language", async () => {
		const { calls, request } = script([ok("", { language: "ja" }), ok("words"), ok("more", { language: "es" }), ok("last")]);
		const transport = localTransport(request, OPTIONS);
		const chunk = { wav, seconds: 15, previousText: undefined, signal: new AbortController().signal };
		for (let i = 0; i < 4; i++) await transport.transcribe(chunk);
		assert.deepEqual(calls.map((c) => c.form.get("language")), ["auto", "auto", "auto", "es"]);
	});

	it("never pins over a fixed language, and each take starts afresh", async () => {
		const fixed = script([ok("a", { language: "de" }), ok("b")]);
		const transport = localTransport(fixed.request, { ...OPTIONS, language: "fr" });
		const chunk = { wav, seconds: 15, previousText: undefined, signal: new AbortController().signal };
		await transport.transcribe(chunk);
		await transport.transcribe(chunk);
		assert.deepEqual(fixed.calls.map((c) => c.form.get("language")), ["fr", "fr"]);
		const next = script([ok("c")]);
		await localTransport(next.request, OPTIONS).transcribe(chunk);
		assert.equal(next.calls[0]!.form.get("language"), "auto", "a new transport has no pin");
	});

	it("passes the engine's warning on, and ignores an empty one", async () => {
		const withWarning = await transcribe(script([ok("hi", { warning: "No detector." })]).request);
		assert.equal(withWarning.warning, "No detector.");
		assert.equal((await transcribe(script([ok("hi", { warning: "" })]).request)).warning, undefined);
	});
});

describe("a Local chunk session", () => {
	function session(replies: Reply[], options: Partial<Parameters<typeof localTransport>[1]> = {}) {
		const fetcher = script(replies);
		const sleeps: number[] = [];
		const chunkSession = createChunkSession({
			transport: localTransport(fetcher.request, { ...OPTIONS, ...options }), vad: energyVad, sampleRate: RATE,
			sleep: async (ms) => { sleeps.push(ms); },
		});
		return { ...fetcher, sleeps, session: chunkSession };
	}

	it("sends chunks one at a time in order while recording, and joins the transcript in order", async () => {
		const { session: s, calls } = session([ok("alpha", { language: "en" }), ok("beta"), ok("gamma")]);
		s.push(loud(18));
		await tick();
		assert.equal(calls.length, 1, "the first chunk went out the moment 18 s were captured");
		s.push(loud(22));
		const result = await s.stop();
		assert.deepEqual(result, { status: "done", text: "alpha beta gamma" });
		assert.deepEqual(calls.map((c) => c.form.get("language")), ["auto", "en", "en"]);
	});

	it("repeats a transient failure with the session's backoff, and waits for the pin before the next chunk", async () => {
		const { session: s, calls, sleeps } = session([
			failure(500, "The speech model hit a snag.", true), ok("one", { language: "pl" }), ok("two"), ok("three"),
		]);
		s.push(loud(40));
		assert.deepEqual(await s.stop(), { status: "done", text: "one two three" });
		assert.deepEqual(sleeps, [1000]);
		assert.deepEqual(calls.map((c) => c.form.get("language")), ["auto", "auto", "pl", "pl"], "the repeat of chunk 1 is still unpinned; the rest follow its answer");
	});

	it("does not repeat a refusal that cannot help, keeps going, and Retry re-sends only the failed chunk in the pinned language", async () => {
		const { session: s, calls } = session([
			ok("one", { language: "it" }), failure(409, "Choose a model.", false), ok("three"),
			ok("two"),
		]);
		s.push(loud(40));
		assert.deepEqual(await s.stop(), { status: "failed", error: "Choose a model." });
		assert.equal(calls.length, 3);
		assert.deepEqual(s.chunks.map((c) => c.status), ["done", "failed", "done"]);
		assert.deepEqual(await s.retry(), { status: "done", text: "one two three" });
		assert.equal(calls.length, 4);
		assert.equal(calls[3]!.form.get("language"), "it");
		assert.equal(s.unsent, 0);
	});

	it("cancel aborts the request in flight and leaves the audio to retry", async () => {
		let signal: AbortSignal | undefined;
		const { session: s } = session([
			(call) => { signal = call.init.signal!; return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); },
			ok("kept"),
		]);
		s.push(loud(5));
		const waiting = s.stop();
		await tick();
		s.cancel();
		assert.equal(signal!.aborted, true);
		assert.deepEqual(await waiting, { status: "failed", error: STOPPED_MESSAGE });
		assert.deepEqual(await s.retry(), { status: "done", text: "kept" });
	});

	it("reports the engine's first warning once, from whichever chunk had it", async () => {
		const { session: s } = session([ok("one", { language: "en" }), ok("two", { warning: "first" }), ok("three", { warning: "second" })]);
		s.push(loud(40));
		await s.stop();
		assert.equal(s.warning, "first");
	});
});
