import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";
import { MAX_DICTATION_WAV_BYTES, pcm16Wav } from "../src/core/dictation.ts";
import { transcribeOpenAIDictation } from "../src/server/openai-dictation.ts";
import nextConfig from "../next.config.ts";

const key = "sk-test-openai-only";
const makeWav = () => pcm16Wav([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
const request = (body: Blob, contentType = "audio/wav") => new Request("http://localhost/api/stt/openai", {
	method: "POST", headers: { "content-type": contentType }, body,
});

describe("OpenAI dictation audio", () => {
	it("allows the full bounded recording through the Next proxy", () => {
		assert.equal(nextConfig.experimental?.proxyClientMaxBodySize, MAX_DICTATION_WAV_BYTES);
	});
	it("encodes all PCM frames in a mono 16 kHz WAV", async () => {
		const blob = makeWav();
		assert.equal(blob.type, "audio/wav");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const view = new DataView(bytes.buffer);
		assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
		assert.equal(view.getUint32(4, true), 42);
		assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
		assert.equal(view.getUint16(22, true), 1);
		assert.equal(view.getUint32(24, true), 16_000);
		assert.equal(view.getUint32(40, true), 6);
		assert.deepEqual([...bytes.slice(44)], [1, 2, 3, 4, 5, 6]);
	});

	it("rejects empty, odd-length and oversized audio", () => {
		assert.throws(() => pcm16Wav([]), /Invalid or oversized/);
		assert.throws(() => pcm16Wav([new Uint8Array(1)]), /Invalid or oversized/);
		assert.throws(() => pcm16Wav([new Uint8Array(MAX_DICTATION_WAV_BYTES)]), /Invalid or oversized/);
	});

	it("flushes a partial worklet frame before acknowledging stop", () => {
		const messages: { type: string; buffer?: Int16Array }[] = [];
		let Processor: new () => { port: { onmessage: (event: { data: unknown }) => void }; process: (inputs: Float32Array[][]) => boolean };
		class Base {
			port = { onmessage: (_event: unknown) => {}, postMessage: (message: { type: string; buffer?: Int16Array }) => messages.push(message) };
		}
		vm.runInNewContext(fs.readFileSync(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8"), {
			AudioWorkletProcessor: Base, Int16Array, Math,
			registerProcessor: (_name: string, processor: typeof Processor) => { Processor = processor; },
		});
		const processor = new Processor!();
		processor.process([[new Float32Array([0.5, -0.5, 0.25])]]);
		processor.port.onmessage({ data: { type: "flush" } });
		assert.deepEqual(messages.map((message) => message.type), ["level", "audio", "flushed"]);
		assert.equal(messages[1]!.buffer?.length, 3);
	});
});

describe("OpenAI transcription route", () => {
	it("uses the configured API key and current transcription model, returning only text", async () => {
		let calls = 0;
		const res = await transcribeOpenAIDictation(request(makeWav()), {
			apiKey: key, enabled: true, fetchFn: async (url, init) => {
				calls++;
				assert.equal(String(url), "https://api.openai.com/v1/audio/transcriptions");
				assert.equal(init?.method, "POST");
				assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
				const form = init?.body as FormData;
				assert.equal(form.get("model"), "gpt-transcribe");
				const file = form.get("file") as File;
				assert.equal(file.name, "dictation.wav");
				assert.equal(file.type, "audio/wav");
				assert.deepEqual([...new Uint8Array(await file.arrayBuffer()).slice(44)], [1, 2, 3, 4, 5, 6]);
				assert.ok(init?.signal);
				return Response.json({ text: "Привет, OpenAI!", languages: [{ code: "ru" }] });
			},
		});
		assert.equal(calls, 1);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.deepEqual(await res.json(), { text: "Привет, OpenAI!" });
	});

	it("does not call OpenAI without explicit provider selection or an API key", async () => {
		let calls = 0;
		const fetchFn = async () => { calls++; return Response.json({}); };
		assert.equal((await transcribeOpenAIDictation(request(makeWav()), { apiKey: key, enabled: false, fetchFn })).status, 403);
		assert.equal((await transcribeOpenAIDictation(request(makeWav()), { apiKey: undefined, enabled: true, fetchFn })).status, 503);
		assert.equal(calls, 0);
	});

	it("rejects malformed, oversized or incorrectly typed audio before dispatch", async () => {
		let calls = 0;
		const deps = { apiKey: key, enabled: true, fetchFn: async () => { calls++; return Response.json({}); } };
		assert.equal((await transcribeOpenAIDictation(request(makeWav(), "application/json"), deps)).status, 415);
		assert.equal((await transcribeOpenAIDictation(request(new Blob(["not wav"])), deps)).status, 400);
		const oversized = new Request("http://localhost/api/stt/openai", { method: "POST", headers: { "content-type": "audio/wav", "content-length": String(MAX_DICTATION_WAV_BYTES + 1) }, body: makeWav() });
		assert.equal((await transcribeOpenAIDictation(oversized, deps)).status, 400);
		const noLength = request(new Blob([new Uint8Array(MAX_DICTATION_WAV_BYTES + 1)]));
		assert.equal((await transcribeOpenAIDictation(noLength, deps)).status, 400);
		assert.equal(calls, 0);
	});

	it("redacts upstream errors and rejects malformed transcription responses", async () => {
		const failed = await transcribeOpenAIDictation(request(makeWav()), { apiKey: key, enabled: true, fetchFn: async () => new Response(`echo ${key}`, { status: 429 }) });
		assert.equal(failed.status, 502);
		assert.doesNotMatch(await failed.text(), /sk-test-openai-only/);
		const malformed = await transcribeOpenAIDictation(request(makeWav()), { apiKey: key, enabled: true, fetchFn: async () => Response.json({}) });
		assert.equal(malformed.status, 502);
	});
});
