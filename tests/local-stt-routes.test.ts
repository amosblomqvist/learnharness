/**
 * /api/stt/local/* and /api/stt/vad with an injected runtime and model store:
 * same-origin refusal, bad bodies, and the happy paths. No model is loaded and
 * nothing is downloaded.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GROQ_DICTATION_HEADER, STT_MAX_AUDIO_BYTES, STT_MAX_BODY_BYTES } from "../src/core/dictation.ts";
import { LANGUAGE_DETECTION_MODEL, getCatalogModel } from "../src/core/local-stt-catalog.ts";
import type { LocalModelsResponse } from "../src/core/local-stt.ts";
import { encodePcm16Wav } from "../src/core/wav.ts";
import { createModelStore, setLocalModelStore, type ModelStore } from "../src/server/local-stt/model-store.ts";
import { LocalSttError, setLocalSttRuntime, type LocalSttRuntime, type TranscribeChunkOptions } from "../src/server/local-stt/runtime.ts";

const modelsRoute = await import("../app/api/stt/local/models/route.ts");
const modelRoute = await import("../app/api/stt/local/models/[id]/route.ts");
const transcribeRoute = await import("../app/api/stt/local/transcribe/route.ts");
const vadRoute = await import("../app/api/stt/vad/route.ts");

const BASE = "http://localhost/api/stt";
const ID = "whisper-small";

let dir: string;
let store: ModelStore;
let transcribed: { samples: number; options: Omit<TranscribeChunkOptions, "signal"> & { aborted: boolean } }[];
let scored: number[];
let warmed: string[];
let warmImpl: () => Promise<void>;
let unloaded: string[];
let transcribeImpl: () => Promise<{ text: string; language?: string; warning?: string }>;
let vadImpl: () => Promise<number[]>;
let hardware: Awaited<ReturnType<LocalSttRuntime["hardware"]>>;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "lh-stt-routes-"));
	// Downloads hang until the test ends: the routes are under test, not the transfer.
	store = createModelStore({ dir, fetch: (async (_url: unknown, init?: RequestInit) => {
		const aborted = () => new DOMException("aborted", "AbortError");
		if (init?.signal?.aborted) throw aborted();
		await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(aborted())));
		throw new Error("unreachable");
	}) as typeof fetch });
	setLocalModelStore(store);
	transcribed = []; scored = []; unloaded = []; warmed = [];
	warmImpl = async () => {};
	transcribeImpl = async () => ({ text: "hello", language: "en" });
	vadImpl = async () => [0.1, 0.9];
	hardware = { tier: "cpu", available: true };
	setLocalSttRuntime({
		hardware: async () => hardware,
		transcribeChunk: async (pcm, { signal, ...options }) => { transcribed.push({ samples: pcm.length, options: { ...options, aborted: signal?.aborted ?? false } }); return transcribeImpl(); },
		scoreVad: async (pcm) => { scored.push(pcm.length); return vadImpl(); },
		warm: async (id) => { warmed.push(id); return warmImpl(); },
		unload: async (id) => { unloaded.push(id); },
		dispose: async () => {},
	});
});
afterEach(async () => {
	await store.cancel(ID).catch(() => undefined);
	setLocalSttRuntime(undefined);
	setLocalModelStore(undefined);
	await rm(dir, { recursive: true, force: true });
});

const intent = { [GROQ_DICTATION_HEADER]: "1", origin: "http://localhost" };
const get = (url: string, headers: Record<string, string> = { [GROQ_DICTATION_HEADER]: "1" }) => new Request(url, { headers });
const post = (url: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
	new Request(url, { method: "POST", body, headers: { ...intent, ...headers } });
const wav = (samples = 16000, rate = 16000) => new File([encodePcm16Wav(new Int16Array(samples), rate)], "chunk.wav", { type: "audio/wav" });
function form(parts: Record<string, string | Blob | undefined> = {}) {
	const body = new FormData();
	for (const [name, value] of Object.entries({
		audio: wav(), model: ID, preferredLanguages: JSON.stringify(["en"]), ...parts,
	})) {
		if (value !== undefined) body.set(name, value);
	}
	return body;
}
const transcribe = (body: BodyInit | null, headers?: Record<string, string>) => transcribeRoute.POST(post(`${BASE}/local/transcribe`, body, headers));
const error = async (res: Response) => (await res.json()) as { message: string; retryable: boolean };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const act = (method: "POST" | "DELETE", id: string, body?: string, headers: Record<string, string> = intent) =>
	(method === "POST" ? modelRoute.POST : modelRoute.DELETE)(new Request(`${BASE}/local/models/${id}`, { method, body, headers }), params(id));

describe("same-origin protection", () => {
	const refusals: [string, Record<string, string>][] = [
		["no dictation header", { origin: "http://localhost" }],
		["a cross-site request", { ...intent, "sec-fetch-site": "cross-site" }],
		["a foreign origin", { ...intent, origin: "http://evil.example" }],
		["origin null", { ...intent, origin: "null" }],
	];
	for (const [name, headers] of refusals) {
		it(`refuses ${name} on every route, doing nothing`, async () => {
			assert.equal((await modelsRoute.GET(new Request(`${BASE}/local/models`, { headers }))).status, 403);
			assert.equal((await modelRoute.POST(new Request(`${BASE}/local/models/${ID}`, { method: "POST", headers }), params(ID))).status, 403);
			assert.equal((await modelRoute.DELETE(new Request(`${BASE}/local/models/${ID}`, { method: "DELETE", headers }), params(ID))).status, 403);
			assert.equal((await transcribeRoute.POST(new Request(`${BASE}/local/transcribe`, { method: "POST", body: form(), headers }))).status, 403);
			assert.equal((await vadRoute.POST(new Request(`${BASE}/vad`, { method: "POST", body: form(), headers }))).status, 403);
			assert.equal((await modelRoute.POST(new Request(`${BASE}/local/models/${ID}`, { method: "POST", body: JSON.stringify({ action: "warm" }), headers }), params(ID))).status, 403);
			assert.deepEqual([transcribed, scored, unloaded, warmed], [[], [], [], []]);
			assert.equal((await store.status(ID)).download, null, "no download started");
		});
	}

	it("refuses a POST without an Origin (no browser omits it) but lets a GET omit it", async () => {
		const noOrigin = new Request(`${BASE}/vad`, { method: "POST", body: form(), headers: { [GROQ_DICTATION_HEADER]: "1" } });
		assert.equal((await vadRoute.POST(noOrigin)).status, 403);
		assert.equal((await modelsRoute.GET(get(`${BASE}/local/models`))).status, 200);
	});

	it("answers 403 in the shared error shape", async () => {
		const res = await transcribeRoute.POST(new Request(`${BASE}/local/transcribe`, { method: "POST", body: form() }));
		assert.deepEqual(await res.json(), { message: "Dictation requests must come from the LearnHarness window.", retryable: false });
		assert.equal(res.headers.get("cache-control"), "no-store");
	});
});

describe("GET /api/stt/local/models", () => {
	it("lists every catalog model, the detector and the hardware tier", async () => {
		await writeFile(path.join(dir, `${ID}.gguf`), "");
		await truncate(path.join(dir, `${ID}.gguf`), getCatalogModel(ID)!.size);
		hardware = { tier: "accelerated", available: true };
		const res = await modelsRoute.GET(get(`${BASE}/local/models`));
		assert.equal(res.status, 200);
		const body = (await res.json()) as LocalModelsResponse;
		assert.equal(body.hardwareTier, "accelerated");
		assert.equal(body.engineAvailable, true);
		assert.equal(body.models.length, 29);
		assert.equal(body.models.find((m) => m.id === ID)?.installed, true);
		assert.equal(body.models.filter((m) => m.installed).length, 1);
		assert.deepEqual(body.languageDetector, { id: LANGUAGE_DETECTION_MODEL.id, installed: false, partialBytes: 0, download: null });
	});

	it("still answers when the native engine cannot load", async () => {
		hardware = { tier: "cpu", available: false, error: "no platform package" };
		const body = (await (await modelsRoute.GET(get(`${BASE}/local/models`))).json()) as LocalModelsResponse;
		assert.deepEqual([body.engineAvailable, body.engineError, body.hardwareTier], [false, "no platform package", "cpu"]);
	});
});

describe("model downloads", () => {
	it("starts a download with an empty body or { action: 'download' }, and reports progress to the next GET", async () => {
		const started = await act("POST", ID);
		assert.equal(started.status, 200);
		assert.equal(((await started.json()) as { model: { download: { state: string; total: number } } }).model.download.state, "downloading");
		assert.equal((await act("POST", ID, JSON.stringify({ action: "download" }))).status, 200);
		const list = (await (await modelsRoute.GET(get(`${BASE}/local/models`))).json()) as LocalModelsResponse;
		const model = list.models.find((m) => m.id === ID)!;
		assert.equal(model.download?.state, "downloading");
		assert.equal(model.download?.total, getCatalogModel(ID)!.size);
	});

	it("can download the language detector", async () => {
		const res = await act("POST", LANGUAGE_DETECTION_MODEL.id);
		assert.equal(res.status, 200);
		await act("POST", LANGUAGE_DETECTION_MODEL.id, JSON.stringify({ action: "cancel" }));
	});

	it("cancels with { action: 'cancel' }", async () => {
		await act("POST", ID);
		const res = await act("POST", ID, JSON.stringify({ action: "cancel" }));
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { model: { download: unknown } }).model.download, null);
	});

	it("refuses ids that are not downloadable, and bad actions", async () => {
		for (const id of ["nope", "..%2Fetc", "whisper-small.gguf"]) {
			assert.equal((await act("POST", id)).status, 404, id);
			assert.equal((await act("DELETE", id)).status, 404, id);
		}
		assert.equal((await act("POST", ID, JSON.stringify({ action: "format" }))).status, 400);
		assert.equal((await act("POST", ID, "not json")).status, 400);
		assert.equal((await act("POST", ID, JSON.stringify({ action: "download", pad: "x".repeat(2000) }))).status, 413);
		assert.equal((await store.status(ID)).download, null);
	});

	it("deletes: the loaded model is freed before its file goes", async () => {
		await writeFile(path.join(dir, `${ID}.gguf`), "");
		await truncate(path.join(dir, `${ID}.gguf`), getCatalogModel(ID)!.size);
		await writeFile(path.join(dir, `${ID}.partial`), "x");
		const res = await act("DELETE", ID);
		assert.equal(res.status, 200);
		assert.deepEqual(unloaded, [ID]);
		assert.deepEqual((await res.json()) as unknown, { model: { id: ID, installed: false, partialBytes: 0, download: null } });
		assert.equal(existsSync(path.join(dir, `${ID}.gguf`)), false);
		assert.equal(existsSync(path.join(dir, `${ID}.partial`)), false);
	});
});

describe("POST /api/stt/local/transcribe", () => {
	it("transcribes a chunk and passes the validated options to the runtime", async () => {
		const res = await transcribe(form({ language: "de", preferredLanguages: JSON.stringify(["en", "tl", "en-GB"]), chineseOutput: "traditional" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "hello", language: "en" });
		assert.deepEqual(transcribed, [{
			samples: 16000,
			options: { modelId: ID, language: "de", preferredLanguages: ["en", "fil"], chineseOutput: "traditional", aborted: false },
		}]);
	});

	it("defaults language to auto and Chinese output to simplified", async () => {
		await transcribe(form());
		assert.equal(transcribed[0]!.options.language, "auto");
		assert.equal(transcribed[0]!.options.chineseOutput, "simplified");
	});

	it("passes a warning through", async () => {
		transcribeImpl = async () => ({ text: "hallo", language: "de", warning: "The language detector isn't downloaded." });
		assert.deepEqual(await (await transcribe(form())).json(), { text: "hallo", language: "de", warning: "The language detector isn't downloaded." });
	});

	it("rejects bad requests with a 4xx and never reaches the runtime", async () => {
		const bad: [string, BodyInit | null, number, Record<string, string>?][] = [
			["not multipart", "{}", 415, { "content-type": "application/json" }],
			["no body", null, 400, { "content-type": "multipart/form-data; boundary=x" }],
			["no audio", form({ audio: undefined }), 400],
			["empty audio", form({ audio: new File([], "a.wav", { type: "audio/wav" }) }), 400],
			["wrong media type", form({ audio: new File([encodePcm16Wav(new Int16Array(100), 16000)], "a.mp3", { type: "audio/mpeg" }) }), 415],
			["not a WAV", form({ audio: new File([new Uint8Array(200)], "a.wav", { type: "audio/wav" }) }), 400],
			["wrong sample rate", form({ audio: wav(1600, 44100) }), 400],
			["no model", form({ model: undefined }), 400],
			["an unknown model", form({ model: "gpt-4o-transcribe" }), 400],
			["the detector as a model", form({ model: LANGUAGE_DETECTION_MODEL.id }), 400],
			["an unknown language", form({ language: "klingon" }), 400],
			["no preferred languages", form({ preferredLanguages: undefined }), 400],
			["preferred languages that are not JSON", form({ preferredLanguages: "en,de" }), 400],
			["an empty preferred list", form({ preferredLanguages: "[]" }), 400],
			["an unknown Chinese output", form({ chineseOutput: "pinyin" }), 400],
		];
		for (const [name, body, status, headers] of bad) {
			const res = await transcribe(body, headers);
			assert.equal(res.status, status, name);
			const info = await error(res);
			assert.equal(typeof info.message, "string", name);
			assert.equal(info.retryable, false, name);
		}
		assert.deepEqual(transcribed, []);
	});

	it("refuses an oversized upload", async () => {
		const huge = new File([new Uint8Array(STT_MAX_AUDIO_BYTES + 2)], "a.wav", { type: "audio/wav" });
		assert.equal((await transcribe(form({ audio: huge }))).status, 413);
		const declared = new Request(`${BASE}/local/transcribe`, {
			method: "POST", body: form(), headers: { ...intent, "content-length": String(STT_MAX_BODY_BYTES + 1) },
		});
		assert.equal((await transcribeRoute.POST(declared)).status, 413);
		assert.deepEqual(transcribed, []);
	});

	it("keeps the body ceiling inside the proxy buffer next.config.ts sets", async () => {
		const { MAX_IMPORT_BODY_BYTES } = await import("../lib/notes-import-limits.ts");
		assert.ok(STT_MAX_BODY_BYTES < MAX_IMPORT_BODY_BYTES);
	});

	it("answers a runtime failure in the shared shape, with its status", async () => {
		transcribeImpl = async () => { throw new LocalSttError("Pick a model in Settings.", 409); };
		const res = await transcribe(form());
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { message: "Pick a model in Settings.", retryable: false });

		transcribeImpl = async () => { throw new LocalSttError("Transcription failed: x", 500, true); };
		assert.equal((await error(await transcribe(form()))).retryable, true);
	});

	it("turns an unexpected error into a generic retryable 500 without its details", async () => {
		const original = console.error;
		console.error = () => {};
		try {
			transcribeImpl = async () => { throw new Error("secret path /home/me/x"); };
			const res = await transcribe(form());
			assert.equal(res.status, 500);
			const info = await error(res);
			assert.equal(info.retryable, true);
			assert.doesNotMatch(info.message, /secret/);
		} finally { console.error = original; }
	});

	it("answers 499 when the browser went away", async () => {
		const controller = new AbortController();
		transcribeImpl = async () => { controller.abort(); throw new Error("aborted"); };
		const res = await transcribeRoute.POST(new Request(`${BASE}/local/transcribe`, { method: "POST", body: form(), headers: intent, signal: controller.signal }));
		assert.equal(res.status, 499);
	});
});

describe("POST /api/stt/local/models/[id] with the warm action", () => {
	const warm = (body: string, id = ID) => act("POST", id, body);
	const action = JSON.stringify({ action: "warm" });

	it("loads the named model through the runtime and answers once it is loaded", async () => {
		const res = await warm(action);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { model: ID });
		assert.deepEqual(warmed, [ID]);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.deepEqual(transcribed, [], "nothing is transcribed");
	});

	it("rejects a bad body or an id that is not a catalog model, without touching the runtime", async () => {
		assert.equal((await warm("not json")).status, 400);
		assert.equal((await warm(action, "voxlingua107-ecapa-q8")).status, 400, "the detector is not a model to warm");
		assert.equal((await warm(action, "no-such-model")).status, 404);
		assert.equal((await warm(JSON.stringify({ action: "warm", pad: "x".repeat(2000) }))).status, 413);
		assert.deepEqual(warmed, []);
	});

	it("answers a load failure in the shared shape", async () => {
		warmImpl = async () => { throw new LocalSttError("That model isn't downloaded.", 409); };
		const res = await warm(action);
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { message: "That model isn't downloaded.", retryable: false });
	});
});

describe("POST /api/stt/vad", () => {
	it("answers the per-frame probabilities", async () => {
		const res = await vadRoute.POST(post(`${BASE}/vad`, form({ audio: wav(1024) })));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { probs: [0.1, 0.9] });
		assert.deepEqual(scored, [1024]);
	});

	it("needs only audio, and rejects bad audio", async () => {
		const only = new FormData();
		only.set("audio", wav(512));
		assert.equal((await vadRoute.POST(post(`${BASE}/vad`, only))).status, 200);
		const noAudio = new FormData();
		noAudio.set("model", ID);
		assert.equal((await vadRoute.POST(post(`${BASE}/vad`, noAudio))).status, 400);
		assert.equal((await vadRoute.POST(post(`${BASE}/vad`, form({ audio: wav(100, 8000) })))).status, 400);
		assert.equal((await vadRoute.POST(post(`${BASE}/vad`, "x", { "content-type": "text/plain" }))).status, 415);
		assert.deepEqual(scored, [512]);
	});

	it("answers a scoring failure in the shared shape", async () => {
		vadImpl = async () => { throw new LocalSttError("Voice activity detection couldn't start.", 503); };
		const res = await vadRoute.POST(post(`${BASE}/vad`, form()));
		assert.equal(res.status, 503);
		assert.match((await error(res)).message, /couldn't start/);
	});
});
