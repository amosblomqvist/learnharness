/**
 * Dictation chunking against the REAL bundled Silero VAD: the client's scoreVad posts to
 * the real /api/stt/vad route, which runs the model natively through transcribe.cpp
 * (src/server/local-stt/runtime.ts). Offline: Silero ships with the app.
 * The audio is synthetic: silence, and a speech-like signal (pulse train through vowel
 * resonators with syllable envelopes), which Silero does take for speech.
 * No ASR model is involved, so Groq and Local transcription stay mocked.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createChunkSession } from "../components/dictation-chunk-session.ts";
import { groqTransport } from "../components/dictation-groq.ts";
import { scoreVad } from "../components/dictation-vad.ts";
import { createChunker, hasSpeech, speechSegments, type PcmChunk } from "../src/core/dictation-chunks.ts";
import { GROQ_CHUNK_MAX_SECONDS, GROQ_CHUNK_MIN_SECONDS } from "../src/core/dictation.ts";
import { createModelStore, setLocalModelStore, type ModelStore } from "../src/server/local-stt/model-store.ts";
import { createLocalSttRuntime, setLocalSttRuntime, type LocalSttRuntime } from "../src/server/local-stt/runtime.ts";

const vadRoute = await import("../app/api/stt/vad/route.ts");

const RATE = 16000;
const s = (seconds: number) => Math.round(seconds * RATE);
const silence = (seconds: number) => new Int16Array(s(seconds));
function join(...parts: Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) { out.set(part, at); at += part.length; }
	return out;
}

/** A small deterministic generator, so a run never differs from the last. */
function random(seed: number) {
	let state = seed;
	return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [570, 840, 2410], [660, 1720, 2410]];
/** Speech-like audio: a glottal pulse train through three vowel resonators, a vowel every 220 ms with a syllable envelope, a drifting pitch and a little breath. */
function speechLike(seconds: number, seed = 1): Int16Array {
	const noise = random(seed);
	const out = silence(seconds);
	const state = [[0, 0], [0, 0], [0, 0]] as [number, number][];
	let phase = 0;
	const syllable = 0.22;
	for (let i = 0; i < out.length; i++) {
		const t = i / RATE;
		const vowel = VOWELS[Math.floor(t / syllable) % VOWELS.length]!;
		phase += (120 * (1 + 0.1 * Math.sin(2 * Math.PI * 0.7 * t) + 0.04 * Math.sin(2 * Math.PI * 5 * t))) / RATE;
		if (phase >= 1) phase -= 1;
		const excitation = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) ** 2 - 0.4 : -0.1;
		let y = 0;
		vowel.forEach((centre, j) => {
			const r = Math.exp((-Math.PI * (60 + 40 * j)) / RATE);
			const [a, b] = state[j]!;
			const v = excitation * (j === 0 ? 1 : 0.7) + 2 * r * Math.cos((2 * Math.PI * centre) / RATE) * a - r * r * b;
			state[j] = [v, a];
			y += v;
		});
		const envelope = Math.sin(Math.PI * ((t % syllable) / syllable)) ** 0.5;
		out[i] = Math.round((y * 0.05 + (noise() - 0.5) * 0.15) * 8000 * envelope);
	}
	return out;
}

let dir: string;
let store: ModelStore;
let real: LocalSttRuntime;
let vadRequests = 0;

/** fetch for the renderer code, answered by the real route (same-origin headers as a browser sends them). */
const request = (async (url: string, init: RequestInit) => {
	assert.equal(url, "/api/stt/vad");
	vadRequests++;
	return vadRoute.POST(new Request(`http://localhost${url}`, {
		method: "POST", body: init.body, signal: init.signal,
		headers: { ...(init.headers as Record<string, string>), origin: "http://localhost" },
	}));
}) as unknown as typeof fetch;

const score = (pcm: Int16Array) => scoreVad(request, pcm, RATE);

before(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "lh-dictation-vad-"));
	store = createModelStore({ dir });
	setLocalModelStore(store);
	real = createLocalSttRuntime({ store });
	setLocalSttRuntime(real);
	const hardware = await real.hardware();
	assert.equal(hardware.available, true, hardware.error);
});
after(async () => {
	setLocalSttRuntime(undefined);
	setLocalModelStore(undefined);
	await real?.dispose();
	await rm(dir, { recursive: true, force: true });
});

async function chunkAll(audio: Int16Array): Promise<PcmChunk[]> {
	const chunks: PcmChunk[] = [];
	const chunker = createChunker({ sampleRate: RATE, score, onChunk: (chunk) => chunks.push(chunk) });
	for (let at = 0; at < audio.length; at += 2048) chunker.push(audio.slice(at, at + 2048));
	const last = await chunker.finish();
	if (last) chunks.push(last);
	return chunks;
}

describe("the real Silero through scoreVad", () => {
	it("scores silence low and speech-like audio high, one probability per 512 samples", async () => {
		const quiet = await score(silence(3));
		assert.equal(quiet.length, Math.ceil(s(3) / 512));
		assert.ok(Math.max(...quiet) < 0.1, `silence scored up to ${Math.max(...quiet)}`);
		assert.equal(hasSpeech(quiet, RATE), false);
		assert.deepEqual(speechSegments(quiet, s(3), RATE), []);

		const audio = join(silence(2), speechLike(4), silence(2));
		const probs = await score(audio);
		assert.equal(probs.length, Math.ceil(audio.length / 512));
		assert.ok(Math.max(...probs) > 0.9, `speech scored up to ${Math.max(...probs)}`);
		assert.equal(hasSpeech(probs, RATE), true);
		const segments = speechSegments(probs, audio.length, RATE);
		assert.ok(segments[0]!.start / RATE > 1.8 && segments[0]!.start / RATE < 2.6, `speech starts at ${segments[0]!.start / RATE} s`);
		assert.ok(segments.at(-1)!.end / RATE > 5 && segments.at(-1)!.end / RATE <= 6.3, `speech ends at ${segments.at(-1)!.end / RATE} s`);
	});
});

describe("chunking with the real Silero", () => {
	it("cuts in the pause, not through the speech around it", async () => {
		// 16 s of speech, a 1.5 s pause, 8 s more: the cut belongs in the pause at 16-17.5 s.
		const audio = join(speechLike(16, 2), silence(1.5), speechLike(8, 3));
		const chunks = await chunkAll(audio);
		assert.equal(chunks.length, 2);
		const cut = chunks[0]!.seconds;
		assert.ok(cut > 16 && cut < 17.5, `cut at ${cut} s`);
		assert.deepEqual(join(...chunks.map((c) => c.pcm)), audio, "no audio lost");
	});

	it("drops a recording of silence, and a long wait before the words", async () => {
		assert.deepEqual(await chunkAll(silence(40)), []);
		const audio = join(silence(30), speechLike(5, 4));
		const chunks = await chunkAll(audio);
		assert.equal(chunks.length, 1, "the silent windows were skipped");
		assert.ok(chunks[0]!.seconds >= 5 && chunks[0]!.seconds <= GROQ_CHUNK_MAX_SECONDS);
		assert.ok(chunks[0]!.pcm.length <= audio.length - s(GROQ_CHUNK_MIN_SECONDS), "at least one silent window was dropped");
	});

	it("runs a whole Groq-transport session on it: the silent first chunk is never sent, the words are", async () => {
		const sent: number[] = [];
		const transcribe = (async (_url: string, init: RequestInit) => {
			sent.push(((init.body as FormData).get("audio") as File).size);
			return Response.json({ text: "hello there" });
		}) as unknown as typeof fetch;
		const session = createChunkSession({
			transport: groqTransport(transcribe, { model: "whisper-large-v3-turbo", language: "en" }),
			vad: (pcm, signal) => scoreVad(request, pcm, RATE, signal),
			sampleRate: RATE,
		});
		const before = vadRequests;
		const audio = join(silence(20), speechLike(6, 5));
		for (let at = 0; at < audio.length; at += 2048) session.push(audio.slice(at, at + 2048));
		assert.deepEqual(await session.stop(), { status: "done", text: "hello there" });
		assert.equal(sent.length, 1, "only the chunk with speech in it went to the engine");
		assert.ok(vadRequests - before >= 2, "the real route was asked");
	});
});
