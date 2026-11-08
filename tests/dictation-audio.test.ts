import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { dictationWav, LOCAL_DICTATION_MAX_BYTES, LOCAL_DICTATION_TIMEOUT_MS } from "../src/core/local-dictation.ts";
import { createLocalEngine } from "../components/dictation-engines.ts";

test("real worklet emits PCM buffers and flushes a short final frame exactly once", () => {
	const messages: { type: string; buffer?: ArrayBuffer }[] = [];
	let Processor!: new () => { process: (input: Float32Array[][]) => boolean; port: { onmessage: (event: { data: unknown }) => void } };
	vm.runInNewContext(readFileSync(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8"), {
		AudioWorkletProcessor: class { port = { postMessage: (message: { type: string; buffer?: ArrayBuffer }) => messages.push(message) }; },
		registerProcessor: (_name: string, type: typeof Processor) => { Processor = type; },
		Int16Array, ArrayBuffer,
	});
	const processor = new Processor();
	processor.process([[new Float32Array(2048).fill(0.5)]]);
	processor.process([[new Float32Array([-1, 0, 1])]]);
	processor.port.onmessage({ data: { type: "flush" } });
	processor.port.onmessage({ data: { type: "flush" } });
	const frames = messages.filter((message) => message.type === "audio").map((message) => message.buffer!);
	assert.deepEqual(frames.map((frame) => frame.byteLength), [4096, 6]);
	assert(frames.every((frame) => frame instanceof ArrayBuffer));
	const wav = dictationWav(frames);
	assert.equal(new DataView(wav.buffer).getInt16(44, true), 16383);
	assert.deepEqual([...new Int16Array(wav.buffer, 44 + 4096)], [-32768, 0, 32767]);
});

test("local timeout aborts the upload and reports an explicit error", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let signal: AbortSignal | null | undefined;
	const errors: string[] = [];
	const engine = createLocalEngine({ server: "whisper.cpp", url: "http://localhost:8080/inference" }, {
		ready() {}, text() { assert.fail("no transcript on timeout"); }, end() { assert.fail("no success on timeout"); }, error(message) { errors.push(message); },
	}, async (_url, init) => {
		signal = init?.signal;
		return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	});
	engine.write(new Int16Array([1]).buffer);
	engine.finish();
	t.mock.timers.tick(LOCAL_DICTATION_TIMEOUT_MS);
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert(signal?.aborted);
	assert.deepEqual(errors, ["Local transcription timed out after 5 minutes"]);
	engine.cancel();
});

test("sample limit clips the last frame and requests stop without losing the recording", async () => {
	let limit = 0;
	let uploaded = 0;
	let ended!: () => void;
	const done = new Promise<void>((resolve) => { ended = resolve; });
	const engine = createLocalEngine({ server: "llama.cpp", url: "http://localhost:8080/v1/audio/transcriptions" }, {
		ready() {}, text() {}, end: ended, error(message) { assert.fail(message); }, limit() { limit++; },
	}, async (_url, init) => { uploaded = (init!.body as Uint8Array).byteLength; return Response.json({ text: "" }); });
	engine.write(new ArrayBuffer(LOCAL_DICTATION_MAX_BYTES - 44 - 2));
	engine.write(new ArrayBuffer(8));
	assert.equal(limit, 1);
	engine.finish(); await done;
	assert.equal(uploaded, LOCAL_DICTATION_MAX_BYTES);
});
