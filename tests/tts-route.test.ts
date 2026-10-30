/**
 * POST /api/tts — the read-aloud proxy (ElevenLabs voice slice 6). The key
 * stays server-side; the route streams ElevenLabs' MP3 straight back. Pinned
 * with a fake upstream (no network):
 *   - pass-through: audio/mpeg, the upstream body streamed unbuffered
 *   - upstream URL/body: Alice + eleven_v4_turbo defaults, mp3_44100_64,
 *     the xi-api-key header, explicit voice/model honoured
 *   - 400 empty / over-cap / malformed (the voice id lands in a URL path)
 *   - 503 keyless → { message, keyless }, 502 upstream with ElevenLabs' status
 *   - the key never appears in any response body
 * Throwaway key strings only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tts-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.ELEVENLABS_API_KEY;

const KEY = `${"k".repeat(36)}wxyz`; // throwaway
const realFetch = globalThis.fetch;

type Route = typeof import("../app/api/tts/route.ts");
let route: Route;
before(async () => {
	route = await import("../app/api/tts/route.ts");
});
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.ELEVENLABS_API_KEY;
});
after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
});

interface Upstream {
	url: string;
	init: RequestInit;
}

/** Install a fake upstream; returns what the route sent it. */
function upstream(respond: () => Response): Upstream[] {
	const calls: Upstream[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		// The model-list lookup (slice 9) is not a speech call; its answer here
		// is unusable on purpose (the model falls back to what was asked for).
		// Likewise the voice-list lookup: unusable, so the asked-for voice plays.
		if (String(url).includes("/v1/models") || String(url).includes("/v2/voices")) return new Response("{}", { status: 404 });
		calls.push({ url: String(url), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return calls;
}

const post = (body: unknown) =>
	route.POST(new Request("http://localhost/api/tts", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

const AUDIO = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });

describe("a keyed request", () => {
	it("streams the upstream audio back as audio/mpeg", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		upstream(AUDIO);
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "audio/mpeg");
		assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
	});

	it("does not buffer: the response body is the upstream body", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		const body = new ReadableStream<Uint8Array>({ start() {} }); // never closes
		upstream(() => new Response(body, { status: 200 }));
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 200); // returned while the upstream is still open
		assert(res.body);
	});

	it("calls the streaming endpoint with Alice, eleven_v4_turbo, mp3_44100_64 and the key header", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		const calls = upstream(AUDIO);
		await post({ text: "Hello there." });
		assert.equal(calls.length, 1);
		assert.equal(
			calls[0]!.url,
			"https://api.elevenlabs.io/v1/text-to-speech/Xb7hH8MSUJpSbSDYk0k2/stream?output_format=mp3_44100_64",
		);
		assert.equal(calls[0]!.init.method, "POST");
		const headers = new Headers(calls[0]!.init.headers);
		assert.equal(headers.get("xi-api-key"), KEY);
		assert.equal(headers.get("content-type"), "application/json");
		assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { text: "Hello there.", model_id: "eleven_v4_turbo" });
	});

	it("honours an explicit voice and model", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		const calls = upstream(AUDIO);
		await post({ text: "Hi.", voiceId: "VoiceId123", modelId: "eleven_flash_v2_5" });
		assert(calls[0]!.url.includes("/text-to-speech/VoiceId123/stream?"));
		assert.equal(JSON.parse(calls[0]!.init.body as string).model_id, "eleven_flash_v2_5");
	});
});

describe("bad requests are 400 and never reach the upstream", () => {
	const cases: Array<[string, unknown]> = [
		["empty text", { text: "" }],
		["whitespace-only text", { text: "   \n " }],
		["missing text", {}],
		["non-string text", { text: 5 }],
		["not json", "{nope"],
		["over the 2500-character cap", { text: "a".repeat(2501) }],
		["a voice id that is not a plain id", { text: "Hi.", voiceId: "../../v1/user" }],
		["a model id that is not a plain id", { text: "Hi.", modelId: "x y" }],
	];
	for (const [name, body] of cases) {
		it(name, async () => {
			process.env.ELEVENLABS_API_KEY = KEY;
			const calls = upstream(AUDIO);
			const res = await post(body);
			assert.equal(res.status, 400);
			assert.equal(typeof ((await res.json()) as { message: unknown }).message, "string");
			assert.equal(calls.length, 0);
		});
	}

	it("text exactly at the cap is accepted", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		upstream(AUDIO);
		assert.equal((await post({ text: "a".repeat(2500) })).status, 200);
	});
});

describe("keyless", () => {
	it("is 503 and names the missing key, without calling upstream", async () => {
		const calls = upstream(AUDIO);
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 503);
		const body = (await res.json()) as { message: string; keyless: string };
		assert.equal(body.keyless, "ELEVENLABS_API_KEY");
		assert.equal(typeof body.message, "string");
		assert.equal(calls.length, 0);
	});
});

describe("upstream failures are 502 with a short message and ElevenLabs' status", () => {
	it("a quota error", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		upstream(() => Response.json({ detail: { status: "quota_exceeded", message: "You have no credits left." } }, { status: 401 }));
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 502);
		const body = (await res.json()) as { message: string; upstreamStatus: number };
		assert.equal(body.upstreamStatus, 401);
		assert(body.message.includes("401"));
		assert(body.message.includes("You have no credits left."));
	});

	it("a permission error with an unparsable body keeps the status", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		upstream(() => new Response("forbidden <html>", { status: 403 }));
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 502);
		assert.equal(((await res.json()) as { upstreamStatus: number }).upstreamStatus, 403);
	});

	it("an unreachable upstream", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		const res = await post({ text: "Hello there." });
		assert.equal(res.status, 502);
		assert.equal(typeof ((await res.json()) as { message: string }).message, "string");
	});

	it("the message is short even for a huge upstream body", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		upstream(() => new Response("x".repeat(50_000), { status: 500 }));
		const body = (await (await post({ text: "Hello there." })).json()) as { message: string };
		assert(body.message.length < 300);
	});
});

describe("the key never reaches a response body", () => {
	it("not on success, 400, 503 or any 502", async () => {
		process.env.ELEVENLABS_API_KEY = KEY;
		const bodies: string[] = [];
		upstream(AUDIO);
		bodies.push(Buffer.from(await (await post({ text: "Hi." })).arrayBuffer()).toString("latin1"));
		bodies.push(await (await post({ text: "" })).text());
		// An upstream that echoes the key back in its error must not leak it.
		upstream(() => new Response(`bad key ${KEY}`, { status: 401 }));
		bodies.push(await (await post({ text: "Hi." })).text());
		globalThis.fetch = (async () => {
			throw new Error(`connect failed for ${KEY}`);
		}) as typeof fetch;
		bodies.push(await (await post({ text: "Hi." })).text());
		delete process.env.ELEVENLABS_API_KEY;
		bodies.push(await (await post({ text: "Hi." })).text());
		for (const body of bodies) assert.equal(body.includes(KEY), false);
	});
});
