import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
	ParakeetNotReadyError, createParakeetTranscriber, pcm16ToFloat32, type ParakeetRecognizer,
} from "../src/server/parakeet-transcriber.ts";
import type { ParakeetModelFiles } from "../src/server/parakeet-model.ts";

const FILES: ParakeetModelFiles = { encoder: "e", decoder: "d", joiner: "j", tokens: "t" };
const pcm = (...samples: number[]) => new Uint8Array(new Int16Array(samples).buffer);

function fakeRecognizer(text = " hello world ", onDecode?: () => Promise<void>) {
	const calls: { sampleRate: number; samples: Float32Array }[] = [];
	const recognizer: ParakeetRecognizer = {
		createStream() {
			const stream = {
				acceptWaveform(wave: { sampleRate: number; samples: Float32Array }) { calls.push(wave); },
			};
			return stream;
		},
		async decodeAsync() { await onDecode?.(); },
		getResult() { return { text }; },
	};
	return { recognizer, calls };
}

describe("Parakeet transcriber", () => {
	it("converts little-endian 16-bit PCM to floats in [-1, 1)", () => {
		const out = pcm16ToFloat32(pcm(0, 16384, -32768, 32767));
		assert.deepEqual([...out].map((v) => Math.round(v * 1e4) / 1e4), [0, 0.5, -1, 1]);
		assert.equal(pcm16ToFloat32(new Uint8Array(0)).length, 0);
	});

	it("refuses to run before the model is installed", async () => {
		const transcriber = createParakeetTranscriber({ files: () => null, load: async () => fakeRecognizer().recognizer });
		await assert.rejects(transcriber.transcribe(pcm(1, 2)), ParakeetNotReadyError);
	});

	it("feeds 16 kHz samples to the recognizer and returns the trimmed text", async () => {
		const { recognizer, calls } = fakeRecognizer();
		const transcriber = createParakeetTranscriber({ files: () => FILES, load: async () => recognizer });
		assert.equal(await transcriber.transcribe(pcm(0, 16384)), "hello world");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.sampleRate, 16000);
		assert.deepEqual([...calls[0]!.samples], [0, 0.5]);
	});

	it("returns empty text for empty audio without loading the model", async () => {
		let loads = 0;
		const transcriber = createParakeetTranscriber({ files: () => FILES, load: async () => { loads++; return fakeRecognizer().recognizer; } });
		assert.equal(await transcriber.transcribe(new Uint8Array(0)), "");
		assert.equal(loads, 0);
	});

	it("rejects audio that is not whole 16-bit samples", async () => {
		const transcriber = createParakeetTranscriber({ files: () => FILES, load: async () => fakeRecognizer().recognizer });
		await assert.rejects(transcriber.transcribe(new Uint8Array(3)), /16-bit/);
	});

	it("decodes one request at a time", async () => {
		let running = 0;
		let peak = 0;
		const { recognizer } = fakeRecognizer("ok", async () => {
			peak = Math.max(peak, ++running);
			await new Promise((r) => setTimeout(r, 15));
			running--;
		});
		const transcriber = createParakeetTranscriber({ files: () => FILES, load: async () => recognizer });
		await Promise.all([transcriber.transcribe(pcm(1)), transcriber.transcribe(pcm(2)), transcriber.transcribe(pcm(3))]);
		assert.equal(peak, 1);
	});

	it("loads once, frees the recognizer after the idle window and loads again on demand", async () => {
		let loads = 0;
		const transcriber = createParakeetTranscriber({
			files: () => FILES, idleMs: 20, load: async () => { loads++; return fakeRecognizer().recognizer; },
		});
		await transcriber.transcribe(pcm(1));
		await transcriber.transcribe(pcm(1));
		assert.equal(loads, 1);
		await new Promise((r) => setTimeout(r, 60));
		await transcriber.transcribe(pcm(1));
		assert.equal(loads, 2);
	});

	it("does not cache a failed load", async () => {
		let loads = 0;
		const transcriber = createParakeetTranscriber({
			files: () => FILES,
			load: async () => { if (++loads === 1) throw new Error("boom"); return fakeRecognizer().recognizer; },
		});
		await assert.rejects(transcriber.transcribe(pcm(1)), /boom/);
		assert.equal(await transcriber.transcribe(pcm(1)), "hello world");
	});
});

// Real-model smoke: opt in with LH_PARAKEET_MODEL_DIR=<extracted model dir>.
const modelDir = process.env.LH_PARAKEET_MODEL_DIR;
describe("Parakeet transcriber with the real model", { skip: modelDir ? false : "set LH_PARAKEET_MODEL_DIR to run" }, () => {
	it("transcribes the English sample", async () => {
		const sherpa = (await import("sherpa-onnx-node")).default;
		const dir = modelDir!;
		const wave = sherpa.readWave(path.join(dir, "test_wavs", "en.wav"));
		const ratio = wave.sampleRate / 16000;
		const out = new Int16Array(Math.floor(wave.samples.length / ratio));
		for (let i = 0; i < out.length; i++) out[i] = Math.round(wave.samples[Math.floor(i * ratio)]! * 32767);
		const transcriber = createParakeetTranscriber({
			files: () => ({
				encoder: path.join(dir, "encoder.int8.onnx"), decoder: path.join(dir, "decoder.int8.onnx"),
				joiner: path.join(dir, "joiner.int8.onnx"), tokens: path.join(dir, "tokens.txt"),
			}),
		});
		const text = await transcriber.transcribe(new Uint8Array(out.buffer));
		assert.match(text.toLowerCase(), /ask not what your country can do for you/);
	});
});
