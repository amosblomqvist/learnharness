"use strict";
/**
 * The on-device transcriber, run as a child process of the app server
 * (runtime.ts). It is the only code that loads sherpa-onnx's native addon, so
 * a native crash ends this process and fails one request instead of taking
 * the server down. Plain CommonJS, loaded by path from the server's working
 * directory and kept outside Next's module graph (the image-resize worker
 * precedent in src/agent/image-processing/).
 *
 * Protocol (IPC, advanced serialization):
 *   parent → { id, type: "transcribe", dir, pcm: Uint8Array }  mono 16 kHz s16le
 *   child  → { id, text } | { id, error }
 */
const path = require("node:path");
const { splitAtQuietPoints, pcm16ToFloat32 } = require("./split.cjs");

const SAMPLE_RATE = 16_000;
/** Shorter or quieter input makes Parakeet invent a word ("Yeah."). */
const MIN_SECONDS = 0.3;
const MIN_PEAK = 0.01;

/** @type {{ dir: string, recognizer: Promise<any> } | null} */
let loaded = null;

function recognizerFor(dir) {
	if (loaded && loaded.dir === dir) return loaded.recognizer;
	const sherpa = require("sherpa-onnx-node");
	const recognizer = sherpa.OfflineRecognizer.createAsync({
		featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			transducer: {
				encoder: path.join(dir, "encoder.int8.onnx"),
				decoder: path.join(dir, "decoder.int8.onnx"),
				joiner: path.join(dir, "joiner.int8.onnx"),
			},
			tokens: path.join(dir, "tokens.txt"),
			numThreads: 2,
			provider: "cpu",
			debug: 0,
			modelType: "nemo_transducer",
		},
	});
	loaded = { dir, recognizer };
	recognizer.catch(() => {
		if (loaded && loaded.recognizer === recognizer) loaded = null;
	});
	return recognizer;
}

function audible(samples, start, end) {
	if (end - start < MIN_SECONDS * SAMPLE_RATE) return false;
	for (let i = start; i < end; i++) if (Math.abs(samples[i]) >= MIN_PEAK) return true;
	return false;
}

async function transcribe(dir, pcm) {
	const samples = pcm16ToFloat32(pcm);
	const parts = [];
	for (const [start, end] of splitAtQuietPoints(samples, SAMPLE_RATE)) {
		if (!audible(samples, start, end)) continue;
		const recognizer = await recognizerFor(dir);
		const stream = recognizer.createStream();
		stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(start, end) });
		await recognizer.decodeAsync(stream);
		const text = recognizer.getResult(stream).text.trim();
		if (text) parts.push(text);
	}
	return parts.join(" ");
}

// One request at a time: the model is large and a second decode only adds
// memory and contention. The parent also serializes, this is the backstop.
let queue = Promise.resolve();
process.on("message", (message) => {
	if (!message || message.type !== "transcribe") return;
	const { id, dir, pcm } = message;
	queue = queue.then(async () => {
		try {
			process.send({ id, text: await transcribe(dir, pcm) });
		} catch (error) {
			process.send({ id, error: error instanceof Error ? error.message : String(error) });
		}
	});
});
// The parent going away (crash, quit) must not leave this process behind.
process.on("disconnect", () => process.exit(0));
process.send({ type: "ready" });
