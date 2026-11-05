/**
 * The Groq dictation chunker: where it cuts, that it never exceeds its
 * maximum, and what it flags as not worth sending. Synthetic PCM only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createChunker, isSilent, MIN_VOICED_MS, SILENCE_RMS, type PcmChunk,
} from "../src/core/dictation-chunks.ts";
import {
	GROQ_CHUNK_MAX_SECONDS, GROQ_CHUNK_MIN_SECONDS, GROQ_CHUNK_TARGET_SECONDS, GROQ_MIN_PCM_BYTES,
} from "../src/core/dictation.ts";

const RATE = 16000;
const FRAME = 2048; // the worklet's frame, 128 ms

/** Loud audio standing in for speech: a sine, so every 100 ms stretch has energy. */
function loud(seconds: number, amplitude = 8000): Int16Array {
	const out = new Int16Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
	return out;
}
const quiet = (seconds: number) => new Int16Array(Math.round(seconds * RATE));
function join(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) { out.set(part, at); at += part.length; }
	return out;
}

/** Speech with a pause at each given (start, length) second range. */
function speech(totalSeconds: number, pauses: [number, number][] = []): Int16Array {
	const audio = loud(totalSeconds);
	for (const [start, length] of pauses) audio.fill(0, Math.round(start * RATE), Math.round((start + length) * RATE));
	return audio;
}

/** Feed audio the way the worklet does, in 2048-sample frames, then finish. */
function chunkAll(audio: Int16Array): PcmChunk[] {
	const chunker = createChunker({ sampleRate: RATE });
	const chunks: PcmChunk[] = [];
	for (let at = 0; at < audio.length; at += FRAME) chunks.push(...chunker.push(audio.slice(at, at + FRAME)));
	const last = chunker.finish();
	if (last) chunks.push(last);
	return chunks;
}

const endOf = (chunk: PcmChunk) => chunk.pcm.length / RATE;

describe("where it cuts", () => {
	it("cuts in the middle of a pause inside the 12-18 s window, not at 15 s", () => {
		const chunks = chunkAll(speech(40, [[16.2, 0.4]]));
		assert.ok(endOf(chunks[0]!) > 16.2 && endOf(chunks[0]!) < 16.6, `first cut ${endOf(chunks[0]!)} s is inside the pause`);
		assert.notEqual(Math.round(endOf(chunks[0]!)), 15);
	});

	it("takes the quietest pause when there are several", () => {
		// A faint 300 ms dip at 13 s (not silent: amplitude 1000) and a true gap at 17 s.
		const audio = speech(40, [[17.0, 0.3]]);
		audio.fill(0, 0, 0);
		const dip = audio.subarray(Math.round(13 * RATE), Math.round(13.3 * RATE));
		for (let i = 0; i < dip.length; i++) dip[i] = Math.round(1000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
		const first = chunkAll(audio)[0]!;
		assert.ok(endOf(first) > 17.0 && endOf(first) < 17.3, `cut ${endOf(first)} s is in the real gap`);
	});

	it("among pauses about equally quiet, prefers the one nearest 15 s", () => {
		const chunks = chunkAll(speech(40, [[12.5, 0.3], [14.6, 0.3], [17.4, 0.3]]));
		assert.ok(endOf(chunks[0]!) > 14.6 && endOf(chunks[0]!) < 14.9, `cut ${endOf(chunks[0]!)} s`);
	});

	it("ignores pauses outside the window", () => {
		const chunks = chunkAll(speech(40, [[8, 0.5], [21, 0.5]]));
		assert.ok(endOf(chunks[0]!) >= GROQ_CHUNK_MIN_SECONDS && endOf(chunks[0]!) <= GROQ_CHUNK_MAX_SECONDS);
		assert.ok(!(endOf(chunks[0]!) > 8 && endOf(chunks[0]!) < 8.5));
	});

	it("never lets a chunk exceed the maximum, even when there is no pause at all", () => {
		const chunks = chunkAll(loud(100));
		assert.ok(chunks.length >= 6);
		for (const chunk of chunks.slice(0, -1)) {
			assert.ok(chunk.seconds >= GROQ_CHUNK_MIN_SECONDS && chunk.seconds <= GROQ_CHUNK_MAX_SECONDS, `${chunk.seconds} s`);
		}
		assert.ok(chunks.at(-1)!.seconds <= GROQ_CHUNK_MAX_SECONDS);
		// With nothing to choose between, the cut sits at the target.
		assert.ok(Math.abs(chunks[0]!.seconds - GROQ_CHUNK_TARGET_SECONDS) < 0.2, `${chunks[0]!.seconds} s`);
	});

	it("loses and repeats no audio: the chunks joined are the recording", () => {
		const audio = speech(63.37, [[15.1, 0.3], [29.9, 0.4], [44, 0.3]]);
		const chunks = chunkAll(audio);
		assert.deepEqual(join(...chunks.map((c) => c.pcm)), audio);
		assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
	});

	it("waits until 18 s are buffered before cutting, so nothing is emitted early", () => {
		const chunker = createChunker({ sampleRate: RATE });
		const audio = speech(40, [[16, 0.4]]);
		let emittedAt: number | undefined;
		for (let at = 0; at < audio.length && emittedAt === undefined; at += FRAME) {
			if (chunker.push(audio.slice(at, at + FRAME)).length) emittedAt = (at + FRAME) / RATE;
		}
		assert.ok(emittedAt! >= GROQ_CHUNK_MAX_SECONDS && emittedAt! < GROQ_CHUNK_MAX_SECONDS + 0.2, `${emittedAt} s`);
	});

	it("copies what it is given, so the capture buffer can be reused", () => {
		const chunker = createChunker({ sampleRate: RATE });
		const frame = loud(0.128);
		chunker.push(frame);
		frame.fill(0);
		assert.ok(chunker.finish()!.pcm.some((v) => v !== 0));
	});

	it("takes an ArrayBuffer as the worklet posts it, and counts samples", () => {
		const chunker = createChunker({ sampleRate: RATE });
		chunker.push(loud(0.128).buffer as ArrayBuffer);
		chunker.push(new ArrayBuffer(0));
		assert.equal(chunker.samples, FRAME);
	});

	it("handles a burst bigger than two chunks in one push", () => {
		const chunker = createChunker({ sampleRate: RATE });
		const done = chunker.push(loud(40));
		assert.equal(done.length, 2);
		assert.deepEqual(done.map((c) => c.index), [0, 1]);
		assert.ok(chunker.finish()!.seconds < GROQ_CHUNK_MAX_SECONDS);
	});
});

describe("what it will not send", () => {
	it("flags near-silence under -50 dBFS, such as a quiet room", () => {
		const hiss = loud(20, Math.round(SILENCE_RMS * 32768 * Math.SQRT2 * 0.5));
		assert.equal(isSilent(hiss, RATE), true);
		assert.equal(chunkAll(hiss)[0]!.skip, "silence");
	});

	it("keeps quiet but real speech", () => {
		assert.equal(isSilent(loud(5, 400), RATE), false, "about -41 dBFS");
	});

	it("is not fooled into skipping by a long chunk with only a little speech in it", () => {
		const audio = join(quiet(8), loud(1.2), quiet(9));
		assert.equal(chunkAll(audio)[0]!.skip, undefined);
	});

	it("does not send a lone click as speech, but does send a short word", () => {
		const click = quiet(10);
		click.fill(20000, 8000, 8000 + 160); // 10 ms
		assert.equal(isSilent(click, RATE), true);
		const word = join(quiet(4), loud(MIN_VOICED_MS / 1000 + 0.1), quiet(4));
		assert.equal(isSilent(word, RATE), false);
	});

	it("flags a final chunk shorter than 0.3 s as short, and sends one a little longer", () => {
		const shortest = GROQ_MIN_PCM_BYTES / 2;
		assert.ok(Math.abs(shortest / RATE - 0.3) < 0.001);
		const chunker = createChunker({ sampleRate: RATE });
		chunker.push(loud(0.28));
		const tail = chunker.finish()!;
		assert.equal(tail.skip, "short");
		const again = createChunker({ sampleRate: RATE });
		again.push(loud(0.4));
		assert.equal(again.finish()!.skip, undefined);
	});

	it("keeps a very short tail after a full chunk, in order, flagged short", () => {
		// The only pause in the window ends the chunk 0.2 s before the stop.
		const chunks = chunkAll(speech(18.1, [[17.8, 0.2]]));
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0]!.seconds > 17.8 && chunks[0]!.seconds < 18, `cut at ${chunks[0]!.seconds} s`);
		assert.equal(chunks[0]!.skip, undefined);
		assert.equal(chunks[1]!.index, 1);
		assert.ok(chunks[1]!.seconds < 0.3);
		assert.equal(chunks[1]!.skip, "short");
	});

	it("finishing with nothing buffered gives no chunk, and finishing twice gives one", () => {
		const empty = createChunker({ sampleRate: RATE });
		assert.equal(empty.finish(), null);
		const chunker = createChunker({ sampleRate: RATE });
		chunker.push(loud(2));
		assert.ok(chunker.finish());
		assert.equal(chunker.finish(), null, "the audio is handed out once");
	});

	it("a short chunk that is also silent is reported as short", () => {
		const chunker = createChunker({ sampleRate: RATE });
		chunker.push(quiet(0.1));
		assert.equal(chunker.finish()!.skip, "short");
	});
});
