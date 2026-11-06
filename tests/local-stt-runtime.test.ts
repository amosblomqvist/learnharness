/**
 * The on-device runtime. Most tests use a fake transcribe-cpp engine (no model
 * files, nothing native); the last group loads the REAL bundled Silero VAD through
 * transcribe-cpp, which needs no download and no network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { LANGUAGE_DETECTION_MODEL, getCatalogModel } from "../src/core/local-stt-catalog.ts";
import { createModelStore, type ModelStore } from "../src/server/local-stt/model-store.ts";
import { IDLE_UNLOAD_MS, LocalSttError, createLocalSttRuntime, defaultSileroPath, type LocalSttRuntime } from "../src/server/local-stt/runtime.ts";

class Fail extends Error {}
class OutOfMemory extends Fail {}
class ModelLoadError extends Fail {}
class ModelFileNotFound extends Fail {}
class InputTooShort extends Fail {}
class InputTooLong extends Fail {}
class UnsupportedRequest extends Fail {}
class InvalidArgument extends Fail {}
class OutputTruncated extends Fail { partialResult?: { text: string; language: string } }

type Call = { model: string; pcmLength: number; options: { language?: string } };

/** A fake engine whose models record what happens to them. */
function fakeEngine(options: {
	backends?: { deviceType: string }[];
	languages?: (file: string) => string[];
	decode?: (file: string, call: Call) => Promise<{ text: string; language: string }> | { text: string; language: string };
	detect?: (allowed: readonly string[] | null | undefined, pcmLength: number) => unknown;
	loadError?: (file: string) => Error | undefined;
} = {}) {
	const log = { loads: [] as string[], disposed: [] as string[], calls: [] as Call[], detections: [] as { allowed: readonly string[] | null | undefined; pcmLength: number }[] };
	let running = 0;
	let maxRunning = 0;
	const load = async (file: string) => {
		log.loads.push(path.basename(file));
		const error = options.loadError?.(file);
		if (error) throw error;
		const name = path.basename(file);
		return {
			capabilities: { languages: options.languages?.(name) ?? ["en", "de", "fr", "zh", "ja", "es-419"] },
			createLangIdSession: () => ({
				async run(pcm: Float32Array, opts: { allowed?: readonly string[] | null }) {
					log.detections.push({ allowed: opts.allowed, pcmLength: pcm.length });
					return options.detect?.(opts.allowed, pcm.length) ?? { code: opts.allowed?.[0] ?? null, allowedMass: 1, candidates: [{ code: opts.allowed?.[0] ?? "en", p: 1 }] };
				},
				dispose() {},
			}),
			createVadSession: () => ({ async run(pcm: Float32Array) { return { probs: Array.from({ length: Math.ceil(pcm.length / 512) }, () => 0.25) }; }, dispose() {} }),
			async transcribe(pcm: Float32Array, opts: { language?: string; signal?: AbortSignal }) {
				const call: Call = { model: name, pcmLength: pcm.length, options: { ...(opts.language ? { language: opts.language } : {}) } };
				log.calls.push(call);
				running++;
				maxRunning = Math.max(maxRunning, running);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					opts.signal?.throwIfAborted();
					return options.decode ? await options.decode(name, call) : { text: ` text from ${name} `, language: opts.language ?? "en" };
				} finally { running--; }
			},
			dispose() { log.disposed.push(name); },
		};
	};
	const engine = {
		TranscribeModel: { load },
		getAvailableBackendsAsync: async () => options.backends ?? [{ deviceType: "cpu" }],
		setLogHandler() {},
		OutOfMemory, ModelLoadError, ModelFileNotFound, InputTooShort, InputTooLong, UnsupportedRequest, InvalidArgument, OutputTruncated,
	};
	return { engine: engine as never, raw: engine, log, maxRunning: () => maxRunning };
}

let dir: string;
let store: ModelStore;
let runtime: LocalSttRuntime;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "lh-stt-runtime-"));
	store = createModelStore({ dir, fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch });
});
afterEach(async () => {
	await runtime?.dispose();
	await rm(dir, { recursive: true, force: true });
});

/** "Install" a model: a file of the catalog size is what the store counts. Sparse, so cheap. */
async function install(id: string) {
	const model = id === LANGUAGE_DETECTION_MODEL.id ? LANGUAGE_DETECTION_MODEL : getCatalogModel(id)!;
	const file = path.join(dir, `${id}.gguf`);
	await writeFile(file, "");
	await truncate(file, model.size);
}
const make = (engine: ReturnType<typeof fakeEngine>) => (runtime = createLocalSttRuntime({ store, loadEngine: async () => engine.engine }));
const pcm = (seconds: number) => new Int16Array(Math.round(seconds * 16000));
const base = { language: "auto", preferredLanguages: ["en"], chineseOutput: "simplified" as const };

describe("hardware", () => {
	it("is accelerated when transcribe.cpp reports a non-CPU backend, else cpu", async () => {
		assert.deepEqual(await make(fakeEngine({ backends: [{ deviceType: "cpu" }] })).hardware(), { tier: "cpu", available: true });
		assert.deepEqual(await make(fakeEngine({ backends: [{ deviceType: "cpu" }, { deviceType: "gpu" }] })).hardware(), { tier: "accelerated", available: true });
		assert.deepEqual(await make(fakeEngine({ backends: [{ deviceType: "igpu" }] })).hardware(), { tier: "accelerated", available: true });
	});

	it("says the engine is unavailable, without throwing, when it cannot load", async () => {
		runtime = createLocalSttRuntime({ store, loadEngine: async () => { throw new Error("no platform package"); } });
		const hardware = await runtime.hardware();
		assert.equal(hardware.available, false);
		assert.equal(hardware.tier, "cpu");
		assert.match(hardware.error ?? "", /no platform package/);
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) => e instanceof LocalSttError && e.code === "engine_unavailable" && e.status === 503);
	});

	it("does not load the engine until something needs it", async () => {
		let loads = 0;
		runtime = createLocalSttRuntime({ store, loadEngine: async () => { loads++; return fakeEngine().engine; } });
		assert.equal(loads, 0);
		await runtime.hardware();
		assert.equal(loads, 1);
		await runtime.hardware();
		assert.equal(loads, 1);
	});
});

describe("transcribing a chunk", () => {
	it("says so when the model is not downloaded", async () => {
		const fake = fakeEngine();
		make(fake);
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "model_not_installed" && e.status === 409 && /Choose a model in Settings/.test(e.message));
		assert.deepEqual(fake.log.loads, []);
	});

	it("rejects an unknown model id", async () => {
		make(fakeEngine());
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "nope" }), (e: unknown) => e instanceof LocalSttError && e.status === 400);
	});

	it("loads the model once, trims the text and returns the language", async () => {
		await install("whisper-small");
		const fake = fakeEngine({ decode: () => ({ text: "  hello there \n", language: "en" }) });
		make(fake);
		const first = await runtime.transcribeChunk(pcm(2), { ...base, modelId: "whisper-small" });
		const second = await runtime.transcribeChunk(pcm(2), { ...base, modelId: "whisper-small" });
		assert.deepEqual(first, { text: "hello there", language: "en" });
		assert.deepEqual(second, first);
		assert.deepEqual(fake.log.loads, ["whisper-small.gguf"], "one load for two chunks");
		assert.equal(fake.log.calls[0]!.pcmLength, 32000);
	});

	it("keeps one ASR model loaded: switching unloads the old one first", async () => {
		await install("whisper-small");
		await install("canary-180m-flash");
		const fake = fakeEngine();
		make(fake);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "canary-180m-flash" });
		assert.deepEqual(fake.log.loads, ["whisper-small.gguf", "canary-180m-flash.gguf"]);
		assert.deepEqual(fake.log.disposed, ["whisper-small.gguf"]);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.deepEqual(fake.log.disposed, ["whisper-small.gguf", "canary-180m-flash.gguf"]);
	});

	it("unloads a model on request, so its file can be deleted", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		make(fake);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		await runtime.unload("canary-180m-flash");
		assert.deepEqual(fake.log.disposed, []);
		await runtime.unload("whisper-small");
		assert.deepEqual(fake.log.disposed, ["whisper-small.gguf"]);
	});

	it("runs one decode at a time, however many chunks arrive together", async () => {
		await install("whisper-small");
		await install("canary-180m-flash");
		const fake = fakeEngine();
		make(fake);
		await Promise.all([
			runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }),
			runtime.transcribeChunk(pcm(1), { ...base, modelId: "canary-180m-flash" }),
			runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }),
			runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }),
		]);
		assert.equal(fake.maxRunning(), 1);
		assert.equal(fake.log.calls.length, 4);
	});

	it("returns empty text for an empty or too-short clip", async () => {
		await install("whisper-small");
		const fake = fakeEngine({ decode: () => { throw new InputTooShort("short"); } });
		make(fake);
		assert.deepEqual(await runtime.transcribeChunk(new Int16Array(0), { ...base, modelId: "whisper-small" }), { text: "" });
		assert.equal((await runtime.transcribeChunk(pcm(0.1), { ...base, modelId: "whisper-small" })).text, "");
	});

	it("keeps the partial transcript of output that began repeating", async () => {
		await install("whisper-small");
		make(fakeEngine({ decode: () => { const e = new OutputTruncated("loop"); e.partialResult = { text: " so far ", language: "en" }; throw e; } }));
		assert.equal((await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" })).text, "so far");
	});

	it("cancels with the request: an aborted chunk never reaches the model", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		make(fake);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", signal: controller.signal }));
		assert.deepEqual(fake.log.calls, []);
	});
});

describe("errors in plain words", () => {
	it("maps load failures", async () => {
		await install("whisper-small");
		make(fakeEngine({ loadError: () => new OutOfMemory("oom") }));
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "out_of_memory" && /smaller model/.test(e.message) && !e.retryable);
		make(fakeEngine({ loadError: () => new ModelLoadError("bad gguf") }));
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "model_load_failed" && /download it again/.test(e.message));
		make(fakeEngine({ loadError: () => new ModelFileNotFound("gone") }));
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "model_load_failed");
	});

	it("falls back to the CPU when an accelerator runs out of memory loading", async () => {
		await install("whisper-small");
		let attempts = 0;
		const fake = fakeEngine({ backends: [{ deviceType: "cpu" }, { deviceType: "gpu" }] });
		const original = fake.raw.TranscribeModel.load;
		fake.raw.TranscribeModel.load = async (file: string, opts?: unknown) => {
			attempts++;
			if (!opts) throw new OutOfMemory("gpu full");
			return original(file);
		};
		make(fake);
		assert.equal((await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" })).text, "text from whisper-small.gguf");
		assert.equal(attempts, 2);
	});

	it("retries a failed load on the next request", async () => {
		await install("whisper-small");
		let fail = true;
		make(fakeEngine({ loadError: () => (fail ? new ModelLoadError("x") : undefined) }));
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }));
		fail = false;
		assert.equal((await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" })).text.length > 0, true);
	});

	it("maps decode failures", async () => {
		await install("whisper-small");
		const cases: [Error, string, number, boolean][] = [
			[new OutOfMemory("x"), "out_of_memory", 500, false],
			[new InputTooLong("x"), "transcription_failed", 500, false],
			[new UnsupportedRequest("x"), "unsupported_language", 400, false],
			[new Error("native exploded"), "transcription_failed", 500, true],
		];
		for (const [error, code, status, retryable] of cases) {
			make(fakeEngine({ decode: () => { throw error; } }));
			await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }), (e: unknown) =>
				e instanceof LocalSttError && e.code === code && e.status === status && e.retryable === retryable, code);
			await runtime.dispose();
		}
	});
});

describe("language", () => {
	it("native detection passes no language, and the model's answer comes back", async () => {
		await install("whisper-small");
		const fake = fakeEngine({ decode: () => ({ text: "bonjour", language: "fr" }) });
		make(fake);
		const result = await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", preferredLanguages: ["en", "fr"] });
		assert.deepEqual(fake.log.calls[0]!.options, {});
		assert.deepEqual(result, { text: "bonjour", language: "fr" });
	});

	it("an explicit language is fixed and sent as the model's own code", async () => {
		await install("canary-180m-flash");
		const fake = fakeEngine();
		make(fake);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "canary-180m-flash", language: "de" });
		assert.deepEqual(fake.log.calls[0]!.options, { language: "de" });
		assert.deepEqual(fake.log.detections, [], "no detector for a fixed language");
	});

	it("refuses a language the model does not support", async () => {
		await install("parakeet-tdt-0.6b-v2");
		make(fakeEngine());
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "parakeet-tdt-0.6b-v2", language: "de" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "unsupported_language" && e.status === 400);
	});

	it("also refuses when the loaded model's own capabilities lack the language", async () => {
		await install("canary-180m-flash");
		make(fakeEngine({ languages: () => ["en"] }));
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "canary-180m-flash", language: "de" }), (e: unknown) =>
			e instanceof LocalSttError && e.code === "unsupported_language");
	});

	it("Auto on a model without native detection uses the detector on the first 7 s, among the preferred languages", async () => {
		await install("canary-180m-flash");
		await install(LANGUAGE_DETECTION_MODEL.id);
		const fake = fakeEngine({ detect: () => ({ code: "de", allowedMass: 0.9, candidates: [{ code: "de", p: 0.9 }, { code: "en", p: 0.1 }] }) });
		make(fake);
		const result = await runtime.transcribeChunk(pcm(12), { ...base, modelId: "canary-180m-flash", preferredLanguages: ["en", "de"] });
		assert.deepEqual(fake.log.detections, [{ allowed: ["en", "de"], pcmLength: 7 * 16000 }]);
		assert.deepEqual(fake.log.calls[0]!.options, { language: "de" });
		assert.equal(result.language, "de");
		assert.equal(result.warning, undefined);
		assert.deepEqual(fake.log.loads.sort(), [`${LANGUAGE_DETECTION_MODEL.id}.gguf`, "canary-180m-flash.gguf"].sort());
	});

	it("without the detector on disk, Auto uses the first preferred language and warns", async () => {
		await install("canary-180m-flash");
		const fake = fakeEngine();
		make(fake);
		const result = await runtime.transcribeChunk(pcm(2), { ...base, modelId: "canary-180m-flash", preferredLanguages: ["de", "en"] });
		assert.deepEqual(fake.log.calls[0]!.options, { language: "de" });
		assert.match(result.warning ?? "", /language detector isn't downloaded. Transcribed as German/);
	});

	it("a clip under half a second skips the detector, and a failing detector falls back with a warning", async () => {
		await install("canary-180m-flash");
		await install(LANGUAGE_DETECTION_MODEL.id);
		const fake = fakeEngine({ detect: () => { throw new Error("detector broke"); } });
		make(fake);
		const short = await runtime.transcribeChunk(pcm(0.4), { ...base, modelId: "canary-180m-flash", preferredLanguages: ["en", "de"] });
		assert.deepEqual(fake.log.detections, []);
		assert.equal(short.warning, undefined);
		const broken = await runtime.transcribeChunk(pcm(2), { ...base, modelId: "canary-180m-flash", preferredLanguages: ["de", "en"] });
		assert.match(broken.warning ?? "", /Couldn't detect the language. Transcribed as German/);
		assert.deepEqual(fake.log.calls.at(-1)!.options, { language: "de" });
	});

	it("Auto with a single preferred language on such a model is just that language", async () => {
		await install("canary-180m-flash");
		const fake = fakeEngine();
		make(fake);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "canary-180m-flash", preferredLanguages: ["fr"] });
		assert.deepEqual(fake.log.calls[0]!.options, { language: "fr" });
		assert.deepEqual(fake.log.detections, []);
	});

	it("Auto on a model with one language is that language, whatever the preferences say (Settings hides the language row for it)", async () => {
		await install("parakeet-unified-en-0.6b");
		const fake = fakeEngine({ languages: () => ["en"] });
		make(fake);
		for (const preferredLanguages of [["en"], ["de"], ["de", "fr"]]) {
			const result = await runtime.transcribeChunk(pcm(1), { ...base, modelId: "parakeet-unified-en-0.6b", preferredLanguages });
			assert.equal(result.language, "en", preferredLanguages.join());
		}
		assert.deepEqual(fake.log.calls.map((call) => call.options), [{ language: "en" }, { language: "en" }, { language: "en" }]);
		assert.deepEqual(fake.log.detections, []);
	});
});

describe("Chinese output", () => {
	const mandarin = (text: string) => fakeEngine({ decode: () => ({ text, language: "zh" }) });

	it("writes Simplified by default, from Traditional model output", async () => {
		await install("whisper-small");
		make(mandarin("學習語音輸入"));
		const result = await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", language: "zh", preferredLanguages: ["zh"] });
		assert.equal(result.text, "学习语音输入");
	});

	it("writes Traditional when asked, from Simplified model output", async () => {
		await install("whisper-small");
		make(mandarin("学习语音输入"));
		const result = await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", language: "zh", preferredLanguages: ["zh"], chineseOutput: "traditional" });
		assert.equal(result.text, "學習語音輸入");
	});

	it("never converts Japanese (kana present) or text from a speaker who does not use Chinese", async () => {
		await install("whisper-small");
		make(fakeEngine({ decode: () => ({ text: "学習する図書館", language: "ja" }) }));
		assert.equal((await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", language: "ja", preferredLanguages: ["ja", "zh"] })).text, "学習する図書館");
		make(fakeEngine({ decode: () => ({ text: "學習 and 語音", language: "en" }) }));
		assert.equal((await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small", language: "en", preferredLanguages: ["en"] })).text, "學習 and 語音");
	});
});

describe("idle unload", () => {
	/** A fake clock: timers fire only when the test says so. */
	function clock() {
		const timers = new Map<number, { callback: () => void; ms: number }>();
		let next = 1;
		return {
			timers,
			deps: {
				setTimer: (callback: () => void, ms: number) => { timers.set(next, { callback, ms }); return next++; },
				clearTimer: (handle: unknown) => { timers.delete(handle as number); },
			},
			fire: () => { const [first] = [...timers.entries()]; if (first) { timers.delete(first[0]); first[1].callback(); } },
		};
	}
	const makeIdle = (fake: ReturnType<typeof fakeEngine>, c: ReturnType<typeof clock>) =>
		(runtime = createLocalSttRuntime({ store, loadEngine: async () => fake.engine, ...c.deps }));

	it("waits ten minutes by default", () => {
		assert.equal(IDLE_UNLOAD_MS, 10 * 60 * 1000);
	});

	it("unloads the ASR model and the detector after the idle time, and the next request reloads", async () => {
		await install("canary-180m-flash");
		await install(LANGUAGE_DETECTION_MODEL.id);
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		const request = { ...base, modelId: "canary-180m-flash", preferredLanguages: ["en", "de"] };
		await runtime.transcribeChunk(pcm(2), request);
		assert.deepEqual([...c.timers.values()].map((t) => t.ms), [IDLE_UNLOAD_MS], "one clock, started when the request finished");
		assert.deepEqual(fake.log.disposed, []);
		c.fire();
		await runtime.unload("nothing-loaded");
		assert.deepEqual(fake.log.disposed.sort(), [`${LANGUAGE_DETECTION_MODEL.id}.gguf`, "canary-180m-flash.gguf"].sort());
		await runtime.transcribeChunk(pcm(2), request);
		assert.equal(fake.log.loads.filter((name) => name === "canary-180m-flash.gguf").length, 2, "reloaded as normal");
	});

	it("a warm-up loads the model without transcribing, and counts as use: it arms the clock and cancels an earlier one", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await runtime.warm("whisper-small");
		assert.deepEqual(fake.log.loads, ["whisper-small.gguf"]);
		assert.deepEqual(fake.log.calls, [], "nothing was decoded");
		assert.deepEqual([...c.timers.values()].map((t) => t.ms), [IDLE_UNLOAD_MS]);
		await runtime.warm("whisper-small");
		assert.equal(c.timers.size, 1, "the earlier clock was cleared, not stacked");
		assert.equal(fake.log.loads.length, 1, "already loaded");
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.equal(fake.log.loads.length, 1, "the first chunk finds the model ready");
		assert.deepEqual(fake.log.disposed, []);
	});

	it("a warm-up that has not finished stops the clock, and an unload that fires meanwhile skips", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		const [armed] = [...c.timers.values()];
		armed!.callback(); // the timer fires, its job queued
		await runtime.warm("whisper-small");
		assert.deepEqual(fake.log.disposed, []);
		assert.equal(fake.log.loads.length, 1);
	});

	it("a warm-up refuses what a chunk would: an unknown or a not downloaded model", async () => {
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await assert.rejects(runtime.warm("nope"), (e: unknown) => e instanceof LocalSttError && e.status === 400);
		await assert.rejects(runtime.warm("whisper-small"), (e: unknown) => e instanceof LocalSttError && e.code === "model_not_installed");
		assert.equal(c.timers.size, 0, "nothing loaded, no clock");
		assert.deepEqual(fake.log.loads, []);
	});

	it("restarts the clock on every request, so a busy dictation never unloads", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.equal(c.timers.size, 1, "the earlier clock was cleared");
		assert.deepEqual(fake.log.disposed, []);
	});

	it("does not unload while a request is running or queued, and rearms afterwards", async () => {
		await install("whisper-small");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let first = false;
		const fake = fakeEngine({ decode: async () => { if (first) { first = false; await gate; } return { text: "x", language: "en" }; } });
		const c = clock();
		makeIdle(fake, c);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }); // loads, arms the clock
		first = true;
		const running = runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.equal(c.timers.size, 0, "a request in flight stops the clock");
		const queued = runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		release();
		await Promise.all([running, queued]);
		assert.deepEqual(fake.log.disposed, []);
		assert.equal(c.timers.size, 1, "the last request out rearms it");
	});

	it("a timer that fires after a request has joined the queue skips the unload", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		const [armed] = [...c.timers.values()];
		// The timer fires, but a request lands before its queued job runs.
		armed!.callback();
		const request = runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		await request;
		assert.deepEqual(fake.log.disposed, []);
		assert.equal(fake.log.loads.length, 1, "no reload");
	});

	it("starts no clock when nothing is loaded, and disposing cancels it", async () => {
		await install("whisper-small");
		const fake = fakeEngine({ loadError: () => new ModelLoadError("bad") });
		const c = clock();
		makeIdle(fake, c);
		await assert.rejects(runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" }));
		assert.equal(c.timers.size, 0);
		const ok = fakeEngine();
		const c2 = clock();
		makeIdle(ok, c2);
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.equal(c2.timers.size, 1);
		await runtime.dispose();
		assert.equal(c2.timers.size, 0);
	});

	it("leaves Silero loaded", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		const c = clock();
		makeIdle(fake, c);
		await runtime.scoreVad(new Int16Array(1024));
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		c.fire();
		await runtime.unload("nothing-loaded");
		assert.deepEqual(fake.log.disposed, ["whisper-small.gguf"]);
		await runtime.scoreVad(new Int16Array(1024));
		assert.equal(fake.log.loads.filter((name) => name.startsWith("silero")).length, 1);
	});

	it("uses an unref'd real timer by default, so it never keeps the process alive", async () => {
		await install("whisper-small");
		const fake = fakeEngine();
		runtime = createLocalSttRuntime({ store, loadEngine: async () => fake.engine, idleUnloadMs: 60_000 });
		await runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		// The test process would hang for a minute at exit if the timer held it; dispose clears it.
		await runtime.dispose();
	});
});

describe("voice activity", () => {
	it("scores one probability per 512-sample frame, the last zero padded", async () => {
		const fake = fakeEngine();
		make(fake);
		assert.equal((await runtime.scoreVad(new Int16Array(512 * 10))).length, 10);
		assert.equal((await runtime.scoreVad(new Int16Array(512 * 10 + 1))).length, 11);
		assert.deepEqual(await runtime.scoreVad(new Int16Array(0)), []);
		assert.deepEqual(fake.log.loads, ["silero-vad-v6.2-F32.gguf"], "loaded once and kept");
	});

	it("is not blocked by a decode in flight, and a failed load is retried", async () => {
		await install("whisper-small");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fake = fakeEngine({ decode: async () => { await gate; return { text: "x", language: "en" }; } });
		make(fake);
		const decoding = runtime.transcribeChunk(pcm(1), { ...base, modelId: "whisper-small" });
		assert.equal((await runtime.scoreVad(new Int16Array(1024))).length, 2);
		release();
		await decoding;

		let fail = true;
		const flaky = fakeEngine();
		const load = flaky.raw.TranscribeModel.load;
		flaky.raw.TranscribeModel.load = async (file: string) => {
			if (fail) throw new Error("no file");
			return load(file);
		};
		make(flaky);
		await assert.rejects(runtime.scoreVad(new Int16Array(1024)), (e: unknown) => e instanceof LocalSttError && e.code === "engine_unavailable");
		fail = false;
		assert.equal((await runtime.scoreVad(new Int16Array(1024))).length, 2);
	});
});

// ── the real engine ─────────────────────────────────────────────────────────

describe("the bundled Silero model with the real transcribe.cpp", () => {
	let real: LocalSttRuntime;
	after(async () => { await real?.dispose(); });

	it("loads, and generated silence scores low in every frame", async () => {
		real = createLocalSttRuntime({ store });
		const hardware = await real.hardware();
		assert.equal(hardware.available, true, hardware.error);
		const probs = await real.scoreVad(new Int16Array(16000 * 3));
		assert.equal(probs.length, Math.ceil((16000 * 3) / 512));
		assert.ok(probs.every((p) => p >= 0 && p <= 1));
		assert.ok(Math.max(...probs) < 0.1, `silence scored up to ${Math.max(...probs)}`);
	});

	it("scores a short or ragged clip, and serves concurrent requests one at a time", async () => {
		assert.deepEqual((await real.scoreVad(new Int16Array(100))).length, 1);
		const noise = new Int16Array(16000).map(() => Math.round((Math.random() - 0.5) * 20000));
		const results = await Promise.all([real.scoreVad(noise), real.scoreVad(noise), real.scoreVad(new Int16Array(16000))]);
		assert.deepEqual(results.map((r) => r.length), [32, 32, 32]);
		assert.ok(Math.max(...results[2]!) < 0.1);
	});

	it("ships the model next to the server code, byte for byte what pi-voice bundles", async () => {
		assert.match(defaultSileroPath(), /src[\\/]server[\\/]local-stt[\\/]silero-vad-v6\.2-F32\.gguf$/);
		const bytes = await readFile(defaultSileroPath());
		assert.equal(createHash("sha256").update(bytes).digest("hex"), "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6");
	});
});
