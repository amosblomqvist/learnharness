/**
 * /api/stt/transcribe — the Groq (Whisper) dictation transport. Groq is never
 * called: global fetch is replaced for the whole file and any URL but the
 * transcription endpoint fails the test. Keys are throwaway strings.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { GROQ_DICTATION_HEADER, GROQ_MAX_BODY_BYTES, GROQ_MAX_UPLOAD_BYTES } from "../src/core/dictation.ts";
import { encodePcm16Wav } from "../src/core/wav.ts";

const dir = mkdtempSync(path.join(tmpdir(), "lh-groq-stt-"));
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.GROQ_API_KEY;
after(() => { rmSync(dir, { recursive: true, force: true }); });

const route = await import("../app/api/stt/transcribe/route.ts");

const URL_ = "http://localhost/api/stt/transcribe";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const KEY = "gsk_test_not_a_real_key_0123456789";
const realFetch = globalThis.fetch;

interface Call { url: string; init: RequestInit; form: FormData }
let calls: Call[] = [];
let answer: () => Response | Promise<Response> = () => Response.json({ text: " hello world \n" });

beforeEach(() => {
	calls = [];
	answer = () => Response.json({ text: " hello world \n" });
	process.env.GROQ_API_KEY = KEY;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		assert.equal(url, GROQ_URL, "only Groq's transcription endpoint may be contacted");
		calls.push({ url, init: init!, form: init!.body as FormData });
		return answer();
	}) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GROQ_API_KEY; });

const wavFile = (samples = 1600, type = "audio/wav") =>
	new File([encodePcm16Wav([new Int16Array(samples).buffer], 16000)], "dictation.wav", { type });

function form(parts: Record<string, string | Blob | undefined> = {}) {
	const body = new FormData();
	for (const [name, value] of Object.entries({ audio: wavFile(), ...parts })) {
		if (value !== undefined) body.set(name, value);
	}
	return body;
}

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
	return route.POST(new Request(URL_, {
		method: "POST", body, headers: { [GROQ_DICTATION_HEADER]: "1", origin: "http://localhost", ...headers },
	}));
}

const message = async (res: Response) => ((await res.json()) as { message: string }).message;

describe("trust and configuration gates", () => {
	it("refuses a request without the same-origin dictation header, and cross-site or foreign-origin ones", async () => {
		const noHeader = await route.POST(new Request(URL_, { method: "POST", body: form() }));
		assert.equal(noHeader.status, 403);
		assert.equal((await post(form(), { "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal((await post(form(), { origin: "http://evil.example" })).status, 403);
		assert.equal((await post(form(), { origin: "null" })).status, 403);
		assert.equal((await route.GET(new Request(URL_))).status, 403);
		assert.equal(calls.length, 0);
	});

	it("accepts same-origin requests, with or without an Origin header", async () => {
		assert.equal((await post(form())).status, 200);
		const noOrigin = new Request(URL_, { method: "POST", body: form(), headers: { [GROQ_DICTATION_HEADER]: "1" } });
		assert.equal((await route.POST(noOrigin)).status, 200);
		assert.equal((await post(form(), { "sec-fetch-site": "same-origin" })).status, 200);
	});

	it("keyless: 503 before the body is read, and nothing is sent to Groq", async () => {
		delete process.env.GROQ_API_KEY;
		const res = await post(form());
		assert.equal(res.status, 503);
		assert.match(await message(res), /No GROQ_API_KEY/);
		assert.equal(calls.length, 0);
	});

	it("GET reports readiness without calling Groq", async () => {
		const get = () => route.GET(new Request(URL_, { headers: { [GROQ_DICTATION_HEADER]: "1" } }));
		assert.deepEqual(await (await get()).json(), { ready: true });
		delete process.env.GROQ_API_KEY;
		assert.equal((await get()).status, 503);
		assert.equal(calls.length, 0);
	});

	it("never returns the key in a response", async () => {
		for (const make of [() => post(form()), () => post(form({ model: "nope" }))]) {
			assert.ok(!(await (await make()).text()).includes(KEY));
		}
	});
});

describe("input validation", () => {
	it("requires multipart/form-data", async () => {
		const res = await post(JSON.stringify({ audio: "x" }), { "content-type": "application/json" });
		assert.equal(res.status, 415);
	});

	it("rejects a missing or empty audio part", async () => {
		assert.equal((await post(form({ audio: undefined }))).status, 400);
		assert.equal((await post(form({ audio: new File([], "dictation.wav", { type: "audio/wav" }) }))).status, 400);
		assert.equal((await post(form({ audio: "just text" }))).status, 400);
	});

	it("rejects non-WAV content types and bytes that only claim to be WAV", async () => {
		const webm = new File([new Uint8Array(500)], "dictation.webm", { type: "audio/webm" });
		assert.equal((await post(form({ audio: webm }))).status, 415);
		const liar = new File([new Uint8Array(500)], "dictation.wav", { type: "audio/wav" });
		const res = await post(form({ audio: liar }));
		assert.equal(res.status, 400);
		assert.match(await message(res), /not a valid WAV/);
		for (const type of ["audio/x-wav", "audio/wave", "AUDIO/WAV"]) {
			assert.equal((await post(form({ audio: wavFile(1600, type) }))).status, 200, type);
		}
		assert.equal(calls.length, 3, "only the three accepted types reached Groq");
	});

	it("rejects an unknown model or language before contacting Groq", async () => {
		assert.equal((await post(form({ model: "whisper-1" }))).status, 400);
		assert.equal((await post(form({ language: "xx" }))).status, 400);
		assert.equal((await post(form({ language: "pl&model=other" }))).status, 400);
		assert.equal(calls.length, 0);
	});

	it("oversize: a declared Content-Length over the body limit is refused as 413", async () => {
		const res = await post(form(), { "content-length": String(GROQ_MAX_BODY_BYTES + 1) });
		assert.equal(res.status, 413);
		assert.match(await message(res), /too large/);
		assert.equal(calls.length, 0);
	});

	it("oversize: a streamed body with no Content-Length is cut off at the limit", async () => {
		let sent = 0;
		const chunk = new Uint8Array(1024 * 1024);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > GROQ_MAX_BODY_BYTES + chunk.byteLength) return controller.close();
				sent += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});
		const res = await route.POST(new Request(URL_, {
			method: "POST", body, duplex: "half",
			headers: { [GROQ_DICTATION_HEADER]: "1", "content-type": "multipart/form-data; boundary=x" },
		} as RequestInit & { duplex: "half" }));
		assert.equal(res.status, 413);
		assert.ok(sent < GROQ_MAX_BODY_BYTES + 3 * chunk.byteLength, "the reader stopped pulling soon after the limit");
		assert.equal(calls.length, 0);
	});

	it("oversize: an audio part over Groq's upload limit is refused even inside the body allowance", async () => {
		const big = new Uint8Array(GROQ_MAX_UPLOAD_BYTES + 1);
		big.set(encodePcm16Wav([], 16000));
		const res = await post(form({ audio: new File([big], "dictation.wav", { type: "audio/wav" }) }));
		assert.equal(res.status, 413);
		assert.equal(calls.length, 0);
	});

	it("a corrupt multipart body is a 400", async () => {
		const res = await post("not multipart at all", { "content-type": "multipart/form-data; boundary=zzz" });
		assert.equal(res.status, 400);
	});

	it("a recording at the size cap still fits", async () => {
		const full = new Uint8Array(GROQ_MAX_UPLOAD_BYTES);
		full.set(encodePcm16Wav([], 16000));
		assert.equal((await post(form({ audio: new File([full], "dictation.wav", { type: "audio/wav" }) }))).status, 200);
	});
});

describe("forwarding to Groq", () => {
	it("sends the audio, model and Whisper language with the bearer key, and returns the trimmed transcript", async () => {
		const res = await post(form({ model: "whisper-large-v3", language: "pt-BR" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "hello world" });
		assert.equal(calls.length, 1);
		const { init, form: sent } = calls[0]!;
		assert.equal(init.method, "POST");
		assert.deepEqual(init.headers, { Authorization: `Bearer ${KEY}` }, "no content-type: fetch sets the multipart boundary");
		assert.equal(sent.get("model"), "whisper-large-v3");
		assert.equal(sent.get("language"), "pt");
		assert.equal(sent.get("response_format"), "json");
		const file = sent.get("file") as File;
		assert.equal(file.name, "dictation.wav");
		assert.equal(file.type, "audio/wav");
		assert.equal(file.size, wavFile().size);
		assert.deepEqual([...sent.keys()].sort(), ["file", "language", "model", "response_format"]);
		assert.ok(init.signal instanceof AbortSignal, "bounded by a timeout");
	});

	it("defaults to the turbo model and omits language when none is sent", async () => {
		await post(form());
		const sent = calls[0]!.form;
		assert.equal(sent.get("model"), "whisper-large-v3-turbo");
		assert.equal(sent.has("language"), false);
	});

	it("maps dictation languages: 'multi' omits language, Cantonese becomes yue, locales collapse", async () => {
		const sentFor = async (language: string) => { await post(form({ language })); return calls.at(-1)!.form.get("language"); };
		assert.equal(await sentFor("multi"), null);
		assert.equal(await sentFor("zh-HK"), "yue");
		assert.equal(await sentFor("en-GB"), "en");
		assert.equal(await sentFor("pl"), "pl");
	});

	it("silence is a valid empty transcript", async () => {
		answer = () => Response.json({ text: "" });
		const res = await post(form());
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "" });
	});
});

describe("Groq failures become clear messages", () => {
	const groqError = (status: number, text: unknown, headers?: HeadersInit) => () =>
		new Response(typeof text === "string" ? text : JSON.stringify(text), { status, headers });

	it("401: the key was rejected, pointing at Settings → Providers", async () => {
		answer = groqError(401, { error: { message: "Invalid API Key" } });
		const res = await post(form());
		assert.equal(res.status, 502, "a Groq 401 is not our own 401");
		assert.match(await message(res), /rejected the API key.*Settings → Providers/);
	});

	it("403: no access to speech-to-text", async () => {
		answer = groqError(403, { error: { message: "forbidden" } });
		const res = await post(form());
		assert.equal(res.status, 502);
		assert.match(await message(res), /refused the request \(403\)/);
	});

	it("413: too large keeps its status", async () => {
		answer = groqError(413, { error: { message: "Request Entity Too Large" } });
		const res = await post(form());
		assert.equal(res.status, 413);
		assert.match(await message(res), /too large for Groq/);
	});

	it("429: rate limit keeps its status and relays retry-after", async () => {
		answer = groqError(429, { error: { message: "Rate limit reached" } }, { "retry-after": "12" });
		let res = await post(form());
		assert.equal(res.status, 429);
		assert.equal(await message(res), "Groq rate limit reached. Try again in 12 s.");
		answer = groqError(429, "{}", { "retry-after": "600" });
		assert.match(await message(await post(form())), /Try again in 10 min\./);
		answer = groqError(429, "{}");
		res = await post(form());
		assert.equal(res.status, 429);
		assert.match(await message(res), /Wait a moment/);
	});

	it("400/422: relays Groq's own explanation, trimmed", async () => {
		answer = groqError(400, { error: { message: "file is too short ".repeat(30) } });
		const res = await post(form());
		assert.equal(res.status, 502);
		const text = await message(res);
		assert.match(text, /could not process the audio \(400\): file is too short/);
		assert.ok(text.length < 300);
		answer = groqError(422, "plain text body");
		assert.match(await message(await post(form())), /\(422\): plain text body/);
	});

	it("5xx: Groq is unavailable; other statuses are reported with their code", async () => {
		answer = groqError(503, { error: { message: "overloaded" } });
		assert.match(await message(await post(form())), /Groq is unavailable \(503\)/);
		answer = groqError(404, { error: { message: "model not found" } });
		assert.match(await message(await post(form())), /transcription failed \(404\): model not found/);
	});

	it("network failure, timeout, and malformed success bodies are 502s", async () => {
		answer = () => { throw new TypeError("fetch failed"); };
		let res = await post(form());
		assert.equal(res.status, 502);
		assert.match(await message(res), /unreachable/);
		answer = () => { throw new DOMException("timed out", "TimeoutError"); };
		assert.match(await message(await post(form())), /too long/);
		answer = () => new Response("<html>gateway</html>", { status: 200 });
		assert.match(await message(await post(form())), /unreadable/);
		answer = () => Response.json({ transcript: "wrong field" });
		res = await post(form());
		assert.equal(res.status, 502);
		assert.match(await message(res), /no transcript/);
	});
});
