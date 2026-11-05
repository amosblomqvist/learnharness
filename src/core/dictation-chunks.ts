import {
	DICTATION_SAMPLE_RATE,
	GROQ_CHUNK_MAX_SECONDS,
	GROQ_CHUNK_MIN_SECONDS,
	GROQ_CHUNK_TARGET_SECONDS,
	GROQ_MIN_PCM_BYTES,
} from "./dictation.ts";

/**
 * Cuts a live PCM16 recording into chunks of about 15 seconds for Groq's
 * Whisper, which transcribes whole files. Pure: no timers, no audio APIs.
 *
 * Where to cut. Cutting at a fixed 15 s would split words. Once 18 s are
 * buffered, the cut goes at the quietest point between 12 s and 18 s, found by
 * short-term energy, so it lands in a pause between words or phrases. Among
 * points about as quiet as the quietest (within 3 dB) the one nearest 15 s is
 * taken, so chunks stay near the target. 18 s is also the hard limit: a chunk
 * never runs longer, even if the speaker never pauses.
 *
 * What not to send. A chunk with almost no sound is flagged `silence`; Whisper
 * invents text ("Thank you.") for silence, and a request for it is wasted. A
 * final chunk under 0.3 s is flagged `short`: it is a stray click or the
 * moment before the stop button, not speech. Flagged chunks stay in order so
 * indices remain stable; the caller just does not send them.
 */

/** Level below which a 20 ms frame counts as silent: -50 dBFS, the floor of the
 * dictation meter. Speech after the browser's gain control sits far above it. */
export const SILENCE_RMS = 10 ** (-50 / 20);
/** A chunk needs this much sound above SILENCE_RMS to be worth sending. A
 * single click or pop is shorter; the shortest spoken word is longer. */
export const MIN_VOICED_MS = 100;
const FRAME_MS = 20;
/** How long a stretch has to stay quiet to count as a pause when choosing a cut. */
const PAUSE_MS = 100;
/** How often a cut position is considered. */
const STEP_MS = 10;
/** Quiet points within this energy factor (3 dB) of the quietest compete on closeness to 15 s. */
const NEAR_QUIETEST = 2;
/** Added to the energy limit so an all-but-digital-silence stretch compares sanely. */
const ENERGY_FLOOR = 1e-9;

export type PcmChunk = {
	/** 0, 1, 2 … in recording order, counting flagged chunks. */
	index: number;
	/** This chunk's samples (a copy: it owns its memory). */
	pcm: Int16Array;
	seconds: number;
	/** Set when the chunk should not be transcribed. */
	skip?: "silence" | "short";
};

export type ChunkerOptions = {
	sampleRate?: number;
	targetSeconds?: number;
	minSeconds?: number;
	maxSeconds?: number;
};

export type Chunker = {
	/** Add captured audio (little-endian PCM16). Returns the chunks it completed: usually none, now and then one. */
	push(audio: ArrayBuffer | Int16Array): PcmChunk[];
	/** The recording ended: the remaining audio as the last chunk, or null if there is none. */
	finish(): PcmChunk | null;
	/** Samples pushed so far. */
	readonly samples: number;
};

const toSamples = (audio: ArrayBuffer | Int16Array): Int16Array =>
	audio instanceof Int16Array ? audio : new Int16Array(audio, 0, audio.byteLength >> 1);

/** True when `pcm` has at least MIN_VOICED_MS of 20 ms frames above SILENCE_RMS. */
export function isSilent(pcm: Int16Array, sampleRate: number): boolean {
	const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
	const limit = (SILENCE_RMS * 32768) ** 2;
	let voiced = 0;
	for (let start = 0; start < pcm.length; start += frame) {
		const end = Math.min(start + frame, pcm.length);
		let sum = 0;
		for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
		if (sum / (end - start) >= limit) voiced += end - start;
	}
	return (voiced * 1000) / sampleRate < MIN_VOICED_MS;
}

/** The sample index to cut `pcm` at, between `minAt` and `maxAt`: the middle of
 * the quietest 100 ms stretch, preferring one near `targetAt` among the nearly
 * as quiet. Exported for tests. */
export function quietestCut(pcm: Int16Array, sampleRate: number, minAt: number, targetAt: number, maxAt: number): number {
	const half = Math.max(1, Math.round((sampleRate * PAUSE_MS) / 2000));
	const step = Math.max(1, Math.round((sampleRate * STEP_MS) / 1000));
	const last = Math.min(pcm.length, maxAt + half);
	// Running sum of squares, so each 100 ms stretch is two lookups.
	const sums = new Float64Array(last + 1);
	for (let i = 0; i < last; i++) sums[i + 1] = sums[i]! + pcm[i]! * pcm[i]!;
	const energy = (at: number) => {
		const from = Math.max(0, at - half);
		const to = Math.min(pcm.length, at + half);
		return (sums[to]! - sums[from]!) / Math.max(1, to - from) / 32768 ** 2;
	};
	let quietest = Infinity;
	for (let at = minAt; at <= maxAt; at += step) quietest = Math.min(quietest, energy(at));
	const limit = quietest * NEAR_QUIETEST + ENERGY_FLOOR;
	let best = maxAt;
	let bestDistance = Infinity;
	for (let at = minAt; at <= maxAt; at += step) {
		if (energy(at) > limit) continue;
		const distance = Math.abs(at - targetAt);
		if (distance < bestDistance) { best = at; bestDistance = distance; }
	}
	return best;
}

export function createChunker(options: ChunkerOptions = {}): Chunker {
	const sampleRate = options.sampleRate ?? DICTATION_SAMPLE_RATE;
	const minAt = Math.round((options.minSeconds ?? GROQ_CHUNK_MIN_SECONDS) * sampleRate);
	const targetAt = Math.round((options.targetSeconds ?? GROQ_CHUNK_TARGET_SECONDS) * sampleRate);
	const maxAt = Math.round((options.maxSeconds ?? GROQ_CHUNK_MAX_SECONDS) * sampleRate);
	const shortest = GROQ_MIN_PCM_BYTES / 2;
	let parts: Int16Array[] = [];
	let buffered = 0;
	let total = 0;
	let index = 0;

	const make = (pcm: Int16Array): PcmChunk => {
		const skip = pcm.length < shortest ? "short" : isSilent(pcm, sampleRate) ? "silence" : undefined;
		return { index: index++, pcm, seconds: pcm.length / sampleRate, ...(skip ? { skip } : {}) };
	};
	const joined = (): Int16Array => {
		if (parts.length === 1) return parts[0]!;
		const all = new Int16Array(buffered);
		let at = 0;
		for (const part of parts) { all.set(part, at); at += part.length; }
		return all;
	};

	return {
		push(audio) {
			const samples = toSamples(audio);
			if (samples.length === 0) return [];
			// Copy: the capture buffer is the worklet's to reuse, not ours to keep.
			parts.push(samples.slice());
			buffered += samples.length;
			total += samples.length;
			const done: PcmChunk[] = [];
			while (buffered >= maxAt) {
				const all = joined();
				const cut = quietestCut(all, sampleRate, minAt, targetAt, maxAt);
				done.push(make(all.slice(0, cut)));
				const rest = all.slice(cut);
				parts = rest.length ? [rest] : [];
				buffered = rest.length;
			}
			return done;
		},
		finish() {
			if (buffered === 0) return null;
			const last = make(joined().slice());
			parts = [];
			buffered = 0;
			return last;
		},
		get samples() { return total; },
	};
}
