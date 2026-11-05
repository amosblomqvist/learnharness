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
import { GROQ_DICTATION_HEADER, GROQ_MAX_BODY_BYTES, GROQ_MAX_UPLOAD_BYTES, GROQ_PROMPT_MAX_CHARS } from "../src/core/dictation.ts";
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
	new File([encodePcm16Wav(new Int16Array(samples), 16000)], "dictation.wav", { type });

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
const retryable = async (res: Response) => ((await res.json()) as { retryable: boolean }).retryable;

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

	it("a POST needs an Origin equal to the one it was addressed to; a GET may omit it", async () => {
		assert.equal((await post(form())).status, 200);
		assert.equal((await post(form(), { "sec-fetch-site": "same-origin" })).status, 200);
		const noOrigin = new Request(URL_, { method: "POST", body: form(), headers: { [GROQ_DICTATION_HEADER]: "1" } });
		assert.equal((await route.POST(noOrigin)).status, 403, "no browser omits Origin on a POST");
		assert.equal((await post(form(), { origin: "http://localhost:3000" })).status, 403, "a different port is another origin");
		assert.equal(calls.length, 2, "only the two same-origin posts reached Groq");
		assert.equal((await route.GET(new Request(URL_, { headers: { [GROQ_DICTATION_HEADER]: "1" } }))).status, 200);
		assert.equal((await route.GET(new Request(URL_, { headers: { [GROQ_DICTATION_HEADER]: "1", origin: "http://evil.example" } }))).status, 403);
	});

	it("the origins the app really runs on still pass: dev on localhost, a LAN address, the packaged loopback port", async () => {
		for (const origin of ["http://localhost:3000", "http://192.168.1.20:3000", "http://127.0.0.1:48151"]) {
			const res = await route.POST(new Request(`${origin}/api/stt/transcribe`, {
				method: "POST", body: form(), headers: { [GROQ_DICTATION_HEADER]: "1", origin, "sec-fetch-site": "same-origin" },
			}));
			assert.equal(res.status, 200, origin);
		}
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
			headers: { [GROQ_DICTATION_HEADER]: "1", origin: "http://localhost", "content-type": "multipart/form-data; boundary=x" },
		} as RequestInit & { duplex: "half" }));
		assert.equal(res.status, 413);
		assert.ok(sent < GROQ_MAX_BODY_BYTES + 3 * chunk.byteLength, "the reader stopped pulling soon after the limit");
		assert.equal(calls.length, 0);
	});

	it("oversize: an audio part over Groq's upload limit is refused even inside the body allowance", async () => {
		const big = new Uint8Array(GROQ_MAX_UPLOAD_BYTES + 1);
		big.set(encodePcm16Wav(new Int16Array(0), 16000));
		const res = await post(form({ audio: new File([big], "dictation.wav", { type: "audio/wav" }) }));
		assert.equal(res.status, 413);
		assert.equal(calls.length, 0);
	});

	it("a corrupt multipart body is a 400", async () => {
		const res = await post("not multipart at all", { "content-type": "multipart/form-data; boundary=zzz" });
		assert.equal(res.status, 400);
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

describe("hardening", () => {
	it("aborts the call to Groq when the browser goes away, and answers without a transcript", async () => {
		const gone = new AbortController();
		let upstream: AbortSignal | undefined;
		let started!: () => void;
		const reached = new Promise<void>((resolve) => { started = resolve; });
		globalThis.fetch = ((_: unknown, init?: RequestInit) => {
			upstream = init!.signal!;
			started();
			return new Promise((_resolve, reject) => {
				upstream!.addEventListener("abort", () => reject(upstream!.reason), { once: true });
			});
		}) as typeof fetch;
		const pending = route.POST(new Request(URL_, {
			method: "POST", body: form(), signal: gone.signal,
			headers: { [GROQ_DICTATION_HEADER]: "1", origin: "http://localhost" },
		}));
		await reached;
		assert.equal(upstream!.aborted, false, "still waiting on Groq");
		gone.abort();
		const res = await pending;
		assert.equal(upstream!.aborted, true, "the Groq request was cancelled with the browser's");
		assert.equal(res.status, 499);
		assert.match(await message(res), /cancelled/);
	});

	it("scrubs the key from an error detail it relays, in JSON and in plain text", async () => {
		answer = () => new Response(JSON.stringify({ error: { message: `bad request for ${KEY}, retry with ${KEY}` } }), { status: 400 });
		let text = await message(await post(form()));
		assert.ok(!text.includes(KEY));
		assert.match(text, /\[redacted\], retry with \[redacted\]/);
		answer = () => new Response(`raw ${KEY} body`, { status: 422 });
		text = await message(await post(form()));
		assert.ok(!text.includes(KEY));
		assert.match(text, /raw \[redacted\] body/);
	});
});

describe("prompt: the end of the previous chunk, so Whisper carries on", () => {
	it("is forwarded trimmed, and left out when absent or blank", async () => {
		await post(form({ prompt: "  and then the second term  \n" }));
		assert.equal(calls[0]!.form.get("prompt"), "and then the second term");
		assert.deepEqual([...calls[0]!.form.keys()].sort(), ["file", "model", "prompt", "response_format"]);
		await post(form());
		assert.equal(calls[1]!.form.has("prompt"), false);
		await post(form({ prompt: "   " }));
		assert.equal(calls[2]!.form.has("prompt"), false, "a blank prompt is not sent");
	});

	it("keeps only the last GROQ_PROMPT_MAX_CHARS characters and never splits a surrogate pair", async () => {
		await post(form({ prompt: "x".repeat(5000) + "tail" }));
		const sent = calls[0]!.form.get("prompt") as string;
		assert.equal(sent.length, GROQ_PROMPT_MAX_CHARS);
		assert.ok(sent.endsWith("tail"));
		await post(form({ prompt: "a" + "😀".repeat(GROQ_PROMPT_MAX_CHARS) }));
		const emoji = calls[1]!.form.get("prompt") as string;
		assert.equal([...emoji].length, GROQ_PROMPT_MAX_CHARS);
		assert.equal(emoji, "😀".repeat(GROQ_PROMPT_MAX_CHARS), "whole code points only, no lone surrogate");
	});

	it("rejects a prompt that is not text, before contacting Groq", async () => {
		const res = await post(form({ prompt: new File(["x"], "prompt.txt", { type: "text/plain" }) }));
		assert.equal(res.status, 400);
		assert.equal(calls.length, 0);
	});
});

describe("failures say whether sending them again may work", () => {
	const groqError = (status: number, headers?: HeadersInit) => () => new Response(JSON.stringify({ error: { message: "x" } }), { status, headers });

	it("429 and 5xx, a timeout and an unreachable Groq are retryable; the rest are not", async () => {
		for (const status of [429, 500, 502, 503]) {
			answer = groqError(status);
			assert.equal(await retryable(await post(form())), true, String(status));
		}
		answer = () => { throw new TypeError("fetch failed"); };
		assert.equal(await retryable(await post(form())), true, "unreachable");
		answer = () => { throw new DOMException("timed out", "TimeoutError"); };
		assert.equal(await retryable(await post(form())), true, "timeout");
		for (const status of [400, 401, 403, 404, 413, 422]) {
			answer = groqError(status);
			assert.equal(await retryable(await post(form())), false, String(status));
		}
		answer = () => Response.json({ nope: 1 });
		assert.equal(await retryable(await post(form())), false, "a 200 without a transcript");
		const forbidden = await route.POST(new Request(URL_, { method: "POST", body: form() }));
		assert.equal(await retryable(forbidden), false);
		delete process.env.GROQ_API_KEY;
		assert.equal(await retryable(await post(form())), false, "keyless");
	});

	it("a 429 passes Groq's Retry-After on as a header, rounded up; without one there is none", async () => {
		answer = groqError(429, { "retry-after": "11.2" });
		let res = await post(form());
		assert.equal(res.headers.get("retry-after"), "12");
		answer = groqError(429);
		res = await post(form());
		assert.equal(res.headers.get("retry-after"), null);
		answer = groqError(429, { "retry-after": "soon" });
		assert.equal((await post(form())).headers.get("retry-after"), null, "an unparsable value is dropped");
	});
});
