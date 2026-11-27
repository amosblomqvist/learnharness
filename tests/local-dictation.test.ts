/**
 * Local dictation: settings validation, the WAV encoder, and the
 * /api/stt/transcribe forwarder against a fake OpenAI-compatible endpoint.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";
import { encodeWav, LOCAL_STT_MAX_BYTES, localTranscriptionLanguage } from "../src/core/dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { transcribeLocalRequest, type LocalSttDeps } from "../src/server/local-stt.ts";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };

let server: Server;
let base = "";
let seen: Seen[] = [];
/** The fake endpoint's next reply: [status, body, extra headers]. */
let reply: () => [number, string, Record<string, string>?] = () => [200, JSON.stringify({ text: " hello world " })];

before(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
			const [status, body, headers] = reply();
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function settings(overrides: Partial<ReturnType<typeof resolveSettings>["dictation"]> = {}): LocalSttDeps["settings"] {
	return () => ({ ...resolveSettings({ version: 1, dictation: { provider: "local", localBaseUrl: base } }).dictation, ...overrides });
}

function clip(init: { headers?: Record<string, string>; body?: BodyInit; query?: string } = {}): Request {
	return new Request(`http://127.0.0.1:3999/api/stt/transcribe${init.query ?? "?language=en-GB"}`, {
		method: "POST",
		headers: { host: "127.0.0.1:3999", "content-type": "audio/wav", origin: "http://127.0.0.1:3999", "sec-fetch-site": "same-origin", ...init.headers },
		body: init.body ?? encodeWav([new Int16Array([1, -1, 2, -2])], 16000),
	});
}

async function call(request: Request, deps: LocalSttDeps = {}) {
	const res = await transcribeLocalRequest(request, { settings: settings(), apiKey: () => undefined, ...deps });
	return { status: res.status, body: (await res.json()) as { text?: string; message?: string } };
}

describe("local dictation settings", () => {
	it("old records resolve to Deepgram with local defaults", () => {
		assert.deepEqual(resolveSettings({ version: 1, dictation: { language: "pl" } }).dictation, {
			language: "pl", provider: "deepgram", localBaseUrl: "http://127.0.0.1:8000/v1", localModel: "Systran/faster-whisper-base",
		});
	});

	it("the write side accepts valid fields and normalizes the URL", () => {
		assert.deepEqual(parseDictationSettingsBody({ language: "en", provider: "local", localBaseUrl: " http://localhost:9000/v1/ ", localModel: " base.en " }), {
			ok: true, settings: { language: "en", provider: "local", localBaseUrl: "http://localhost:9000/v1", localModel: "base.en" },
		});
	});

	it("the write side rejects bad providers, URLs and model names", () => {
		for (const body of [
			{ provider: "whisper" }, { provider: null },
			{ localBaseUrl: "ftp://host/v1" }, { localBaseUrl: "http://user:pw@host/v1" }, { localBaseUrl: "http://host/v1?x=1" }, { localBaseUrl: "" }, { localBaseUrl: 3 },
			{ localModel: "" }, { localModel: "a\nb" }, { localModel: "x".repeat(201) }, { localModel: 1 },
		]) assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
	});

	it("stored records drop invalid fields independently", () => {
		const record = sanitizeUserSettings({ version: 1, dictation: { language: "fr", provider: "nope", localBaseUrl: "javascript:x", localModel: "small" } });
		assert.deepEqual(record?.dictation, { language: "fr", localModel: "small" });
	});

	it("Deepgram locales reduce to an ISO 639-1 code and multilingual omits it", () => {
		assert.equal(localTranscriptionLanguage("en-GB"), "en");
		assert.equal(localTranscriptionLanguage("zh-Hant"), "zh");
		assert.equal(localTranscriptionLanguage("de"), "de");
		assert.equal(localTranscriptionLanguage("multi"), undefined);
	});

	it("saving the language keeps the provider fields (sections are replaced whole)", async () => {
		const writes: unknown[] = [];
		const store = createDictationLanguageStore(async (_url, init) => {
			if (init?.method === "PUT") {
				writes.push(JSON.parse(init.body as string));
				return Response.json({ settings: { version: 1, dictation: JSON.parse(init.body as string) } });
			}
			return Response.json({ settings: { version: 1, dictation: { language: "en", provider: "local", localModel: "small" } } });
		});
		await store.load();
		assert.equal(await store.save("pl"), true);
		assert.deepEqual(writes.at(-1), { language: "pl", provider: "local", localModel: "small" });
		assert.equal(await store.saveSection({ localModel: undefined }), true);
		assert.deepEqual(writes.at(-1), { language: "pl", provider: "local" });
		assert.deepEqual(await store.getSettings(), {
			language: "pl", provider: "local", localBaseUrl: "http://127.0.0.1:8000/v1", localModel: "Systran/faster-whisper-base",
		});
	});
});

describe("WAV encoding", () => {
	it("writes a 16-bit mono PCM header and little-endian samples", () => {
		const wav = encodeWav([new Int16Array([1, -2]), new Int16Array([0x7fff])], 16000);
		const view = new DataView(wav.buffer);
		assert.equal(wav.byteLength, 44 + 6);
		assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
		assert.equal(String.fromCharCode(...wav.slice(8, 16)), "WAVEfmt ");
		assert.equal(view.getUint32(4, true), 36 + 6);
		assert.equal(view.getUint16(20, true), 1);
		assert.equal(view.getUint16(22, true), 1);
		assert.equal(view.getUint32(24, true), 16000);
		assert.equal(view.getUint32(28, true), 32000);
		assert.equal(view.getUint16(34, true), 16);
		assert.equal(view.getUint32(40, true), 6);
		assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [1, -2, 0x7fff]);
	});
});

describe("POST /api/stt/transcribe", () => {
	it("forwards the clip as multipart and returns the trimmed transcript", async () => {
		seen = [];
		reply = () => [200, JSON.stringify({ text: " hello world " })];
		const result = await call(clip(), { apiKey: () => "local-secret" });
		assert.deepEqual(result, { status: 200, body: { text: "hello world" } });
		const [request] = seen;
		assert.equal(request?.url, "/v1/audio/transcriptions");
		assert.match(String(request?.headers["content-type"]), /^multipart\/form-data; boundary=/);
		assert.equal(request?.headers.authorization, "Bearer local-secret");
		assert.match(request!.body, /name="file"; filename="dictation\.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF/);
		assert.match(request!.body, /name="model"\r\n\r\nSystran\/faster-whisper-base\r\n/);
		assert.match(request!.body, /name="response_format"\r\n\r\njson\r\n/);
		assert.match(request!.body, /name="language"\r\n\r\nen\r\n/);
	});

	it("omits language for multilingual and the bearer when no key is set", async () => {
		seen = [];
		reply = () => [200, JSON.stringify({ text: "hej" })];
		assert.equal((await call(clip({ query: "?language=multi" }))).status, 200);
		assert.doesNotMatch(seen[0]!.body, /name="language"/);
		assert.equal(seen[0]!.headers.authorization, undefined);
	});

	it("refuses cross-site requests before touching the endpoint", async () => {
		seen = [];
		const result = await call(clip({ headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }));
		assert.equal(result.status, 403);
		assert.match(result.body.message!, /Cross-site/);
		assert.equal(seen.length, 0);
	});

	it("refuses when local dictation is not selected", async () => {
		seen = [];
		const result = await call(clip(), { settings: settings({ provider: "deepgram" }) });
		assert.equal(result.status, 409);
		assert.equal(seen.length, 0);
	});

	it("rejects non-audio bodies, bad languages and empty clips", async () => {
		assert.equal((await call(clip({ headers: { "content-type": "application/json" }, body: "{}" }))).status, 415);
		assert.equal((await call(clip({ query: "?language=xx" }))).status, 400);
		assert.equal((await call(clip({ body: new Uint8Array() }))).status, 400);
	});

	it("caps the upload at 25 MB, by header and by streamed bytes", async () => {
		seen = [];
		const declared = await call(clip({ headers: { "content-length": String(LOCAL_STT_MAX_BYTES + 1) }, body: new Uint8Array(10) }));
		assert.equal(declared.status, 413);
		const streamed = await call(clip({ body: new Uint8Array(LOCAL_STT_MAX_BYTES + 1) }));
		assert.equal(streamed.status, 413);
		assert.match(streamed.body.message!, /25 MB/);
		assert.equal(seen.length, 0);
	});

	it("maps endpoint failures to honest 502/504 messages", async () => {
		const cases: [() => [number, string, Record<string, string>?], number, RegExp][] = [
			[() => [500, "{}"], 502, /HTTP 500/],
			[() => [401, "{}"], 502, /rejected the key \(HTTP 401\)/],
			[() => [404, "{}"], 502, /no .*\/audio\/transcriptions \(HTTP 404\)/],
			[() => [307, "", { location: "http://example.com/" }], 502, /redirect/],
			[() => [200, "not json"], 502, /invalid JSON/],
			[() => [200, JSON.stringify({ result: "x" })], 502, /no text/],
		];
		for (const [next, status, message] of cases) {
			reply = next;
			const result = await call(clip());
			assert.equal(result.status, status, String(message));
			assert.match(result.body.message!, message);
		}
	});

	it("reports an unreachable server and a timeout", async () => {
		const closed = await call(clip(), { settings: settings({ localBaseUrl: "http://127.0.0.1:1/v1" }) });
		assert.equal(closed.status, 502);
		assert.match(closed.body.message!, /unreachable at http:\/\/127\.0\.0\.1:1\/v1/);
		const slow: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});
		const timedOut = await call(clip(), { fetch: slow, timeoutMs: 20 });
		assert.equal(timedOut.status, 504);
	});
});
