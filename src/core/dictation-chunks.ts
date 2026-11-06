/**
 * Cuts a live PCM16 recording into chunks of about 15 s for the engines that
 * transcribe whole files (Groq's Whisper and the on-device Local engine), using
 * Silero VAD to find the pauses. Pure: no timers, no audio APIs, no network. The
 * speech probabilities come from an injected `score`, which the app backs with
 * POST /api/stt/vad (components/dictation-vad.ts).
 *
 * The segmentation (speechSegments, cutCandidates, the cut scoring), the speech
 * test (hasSpeech) and joinTranscripts are adapted from pi-voice, src/chunking.ts and src/vad.ts,
 * Copyright (c) 2026 Earendil Works contributors, MIT licence
 * (https://github.com/earendil-works/pi-voice; the licence text is in
 * docs/local-stt-licenses.md). The differences: pi-voice cuts 5 to 40 s chunks
 * for models that take long audio, here the window is GROQ_CHUNK_MIN to MAX
 * seconds around GROQ_CHUNK_TARGET, and the probabilities arrive a window at a
 * time from the server instead of a frame at a time from a local session.
 *
 * Once 18 s are buffered, those 18 s are scored in ONE request (Silero is stateful, so
 * it hears them as one continuous clip, not as fragments), and the cut goes in the
 * best pause between 12 s and 18 s: long pauses beat short ones,
 * then closeness to 15 s decides. Without a pause in the window, the cut is hard,
 * at the 15 s target, so a chunk is never longer than 18 s.
 *
 * Whisper-style models invent text ("Thank you.") for silence, so a chunk in which
 * Silero hears no speech is dropped, and so is a final chunk under 0.3 s (a stray
 * click or the moment before the stop button). The caller only sees chunks worth
 * sending.
 *
 * A failed score never loses audio: the chunk is cut at the target, as it would be
 * without a pause, and kept as if it held speech. The scorer is asked again for the next chunk.
 */
import {
	GROQ_CHUNK_MAX_SECONDS,
	GROQ_CHUNK_MIN_SECONDS,
	GROQ_CHUNK_TARGET_SECONDS,
	GROQ_MIN_PCM_BYTES,
} from "./dictation.ts";
import { VAD_FRAME_SAMPLES } from "./local-stt.ts";

// Silero's own segmentation, as pi-voice applies it (Silero 6.2.3 get_speech_timestamps).
/** A frame at or above this starts speech. */
const THRESHOLD = 0.5;
/** A frame below this (the threshold less 0.15) ends it, once the silence lasts. */
const NEG_THRESHOLD = THRESHOLD - 0.15;
const MIN_SPEECH_MS = 250;
const MIN_SILENCE_MS = 100;
const SPEECH_PAD_MS = 30;
// pi-voice's speech filter (Handy's SmoothedVad onset), which decides what is kept.
/** A frame above this counts as voiced. */
const VOICED_THRESHOLD = 0.3;
/** This much voiced audio in a row is speech: a short word is kept, a click is not. */
const ONSET_MS = 60;

const samplesFor = (ms: number, sampleRate: number) => (ms * sampleRate) / 1000;

export type SpeechSegment = { start: number; end: number };

/**
 * Speech segments, in samples, from per-frame Silero probabilities: Silero 6.2.3's
 * get_speech_timestamps as transcribe.cpp ports it, without a maximum speech
 * length. `samples` is the length of the scored audio, whose last frame is
 * zero-padded.
 */
export function speechSegments(probs: ArrayLike<number>, samples: number, sampleRate: number): SpeechSegment[] {
	const minSpeech = samplesFor(MIN_SPEECH_MS, sampleRate);
	const minSilence = samplesFor(MIN_SILENCE_MS, sampleRate);
	const pad = samplesFor(SPEECH_PAD_MS, sampleRate);
	const segments: SpeechSegment[] = [];
	let triggered = false;
	let start = 0;
	let tempEnd = 0;
	for (let i = 0; i < probs.length; i++) {
		const prob = probs[i]!;
		const at = i * VAD_FRAME_SAMPLES;
		if (prob >= THRESHOLD && tempEnd !== 0) tempEnd = 0;
		if (prob >= THRESHOLD && !triggered) {
			triggered = true;
			start = at;
			continue;
		}
		if (prob < NEG_THRESHOLD && triggered) {
			if (tempEnd === 0) tempEnd = at;
			if (at - tempEnd < minSilence) continue;
			if (tempEnd - start > minSpeech) segments.push({ start, end: tempEnd });
			triggered = false;
			tempEnd = 0;
		}
	}
	if (triggered && samples - start > minSpeech) segments.push({ start, end: samples });

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (i === 0) segment.start = Math.max(0, segment.start - pad);
		const next = segments[i + 1];
		if (!next) {
			segment.end = Math.min(samples, segment.end + pad);
			continue;
		}
		const silence = next.start - segment.end;
		const share = silence < 2 * pad ? Math.floor(silence / 2) : pad;
		segment.end = Math.min(samples, segment.end + share);
		next.start = Math.max(0, next.start - share);
	}
	return segments;
}

/** A pause between speech: `from` to `to` in samples, with `cut` in its middle. */
export type CutCandidate = { cut: number; gapSeconds: number; from: number; to: number };

/** One candidate in the middle of each pause, lead-in and tail included. */
export function cutCandidates(segments: readonly SpeechSegment[], samples: number, sampleRate: number): CutCandidate[] {
	const candidates: CutCandidate[] = [];
	let silenceStart = 0;
	for (const { start, end } of [...segments, { start: samples, end: samples }]) {
		if (start > silenceStart) {
			candidates.push({
				cut: Math.floor((silenceStart + start) / 2),
				gapSeconds: (start - silenceStart) / sampleRate,
				from: silenceStart,
				to: start,
			});
		}
		silenceStart = Math.max(silenceStart, end);
	}
	return candidates;
}

/**
 * The sample to cut the first `samples` of a recording at: the best-scoring pause
 * between GROQ_CHUNK_MIN_SECONDS and GROQ_CHUNK_MAX_SECONDS, or the target
 * (GROQ_CHUNK_TARGET_SECONDS) when there is none. pi-voice's score: a pause counts for its length up to 1 s (so
 * every pause of a second or more ties), less a penalty for the distance from the
 * target, 0.05 per second before it and 0.1 per second after, since a late cut
 * makes a longer upload. `samples` must be at least the maximum.
 */
export function planCut(probs: ArrayLike<number>, samples: number, sampleRate: number): number {
	const minAt = Math.round(GROQ_CHUNK_MIN_SECONDS * sampleRate);
	const maxAt = Math.round(GROQ_CHUNK_MAX_SECONDS * sampleRate);
	let best = Math.round(GROQ_CHUNK_TARGET_SECONDS * sampleRate);
	let bestScore = -Infinity;
	for (const { gapSeconds, from, to } of cutCandidates(speechSegments(probs, samples, sampleRate), samples, sampleRate)) {
		// A pause that straddles an edge of the window is still a pause inside it: take
		// the point of the window nearest the pause's middle (its middle, when inside).
		const cut = Math.floor(Math.min(maxAt, Math.max(minAt, (from + to) / 2)));
		if (cut < from || cut > to) continue;
		const position = cut / sampleRate;
		const score = Math.min(gapSeconds, 1) - (position > GROQ_CHUNK_TARGET_SECONDS
			? 0.1 * (position - GROQ_CHUNK_TARGET_SECONDS)
			: 0.05 * (GROQ_CHUNK_TARGET_SECONDS - position));
		if (score > bestScore) { best = cut; bestScore = score; }
	}
	return best;
}

/**
 * True when `probs` holds speech: at least 60 ms of frames above 0.3 in a row,
 * which is when pi-voice's speech filter starts keeping audio. Looser than a
 * segment (250 ms, for choosing cuts), so a short word such as "no" is never dropped.
 */
export function hasSpeech(probs: ArrayLike<number>, sampleRate: number): boolean {
	const onset = Math.ceil(samplesFor(ONSET_MS, sampleRate) / VAD_FRAME_SAMPLES);
	let run = 0;
	for (let i = 0; i < probs.length; i++) {
		run = probs[i]! > VOICED_THRESHOLD ? run + 1 : 0;
		if (run >= onset) return true;
	}
	return false;
}

// Scripts written without spaces between words, and CJK punctuation.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;

/** Chunk texts in order: a space between two chunks unless either side is unspaced script. */
export function joinTranscripts(texts: readonly string[]): string {
	let joined = "";
	// Whole code points: astral Han (CJK Extension B+) is a surrogate pair.
	let last: string | undefined;
	for (const raw of texts) {
		const text = raw.trim();
		if (!text) continue;
		if (last !== undefined && !UNSPACED.test(last) && !UNSPACED.test(String.fromCodePoint(text.codePointAt(0)!))) {
			joined += " ";
		}
		joined += text;
		last = Array.from(text).at(-1);
	}
	return joined;
}

export type PcmChunk = {
	/** This chunk's samples. */
	pcm: Int16Array;
	seconds: number;
};

/** Silero's speech probability for each 512-sample frame of `pcm`, the last one zero-padded. Rejects when it cannot be scored. */
export type VadScore = (pcm: Int16Array) => Promise<readonly number[]>;

export type ChunkerOptions = {
	sampleRate: number;
	score: VadScore;
	/** Receives each chunk worth sending, in order, as soon as its cut is known. */
	onChunk: (chunk: PcmChunk) => void;
};

export type Chunker = {
	/** Add captured audio (PCM16). Chunks it completes reach `onChunk` once scored: usually none, now and then one. */
	push(audio: Int16Array): void;
	/** The recording ended: wait for any cut in progress, then give the remaining audio as the last chunk, or null if there is none worth sending. Audio pushed after it is ignored. */
	finish(): Promise<PcmChunk | null>;
	/** Samples pushed so far, including any that were dropped. */
	readonly samples: number;
};

export function createChunker({ sampleRate, score, onChunk }: ChunkerOptions): Chunker {
	const maxAt = Math.round(GROQ_CHUNK_MAX_SECONDS * sampleRate);
	const targetAt = Math.round(GROQ_CHUNK_TARGET_SECONDS * sampleRate);
	const shortest = GROQ_MIN_PCM_BYTES / 2;
	let parts: Int16Array[] = [];
	let buffered = 0;
	let total = 0;
	let finished = false;
	let running: Promise<void> | null = null;

	const joined = (): Int16Array => {
		if (parts.length === 1) return parts[0]!;
		const all = new Int16Array(buffered);
		let at = 0;
		for (const part of parts) { all.set(part, at); at += part.length; }
		return all;
	};

	/** Probabilities for `pcm`, or null when scoring failed or answered the wrong length. */
	const probsFor = async (pcm: Int16Array): Promise<readonly number[] | null> => {
		try {
			const probs = await score(pcm);
			return probs.length === Math.ceil(pcm.length / VAD_FRAME_SAMPLES) ? probs : null;
		} catch {
			return null;
		}
	};

	/** The chunk for `pcm`, or null when `probs` hear no speech in it. Unscored audio is kept. */
	const make = (pcm: Int16Array, probs: readonly number[] | null): PcmChunk | null => {
		if (probs && !hasSpeech(probs.slice(0, Math.ceil(pcm.length / VAD_FRAME_SAMPLES)), sampleRate)) return null;
		return { pcm, seconds: pcm.length / sampleRate };
	};

	/** Cut every full window of the buffered audio, one scoring request each. Audio that
	 * arrives while a request is out waits behind the cut. */
	async function drain(): Promise<void> {
		while (buffered >= maxAt) {
			const all = joined();
			// Only the window a cut can fall in is scored, so a request is never over 18 s
			// however far a slow one let the buffer grow.
			const probs = await probsFor(all.subarray(0, maxAt));
			const cut = probs ? planCut(probs, maxAt, sampleRate) : targetAt;
			const chunk = make(all.slice(0, cut), probs);
			// The buffer may have grown during the request: drop only what was cut.
			const rest = joined().slice(cut);
			parts = rest.length ? [rest] : [];
			buffered = rest.length;
			if (chunk) onChunk(chunk);
		}
	}

	const kick = () => {
		if (running || buffered < maxAt) return;
		const current: Promise<void> = drain().finally(() => {
			if (running === current) running = null;
			if (!finished) kick();
		});
		running = current;
	};

	return {
		push(audio) {
			if (finished || audio.length === 0) return;
			parts.push(audio);
			buffered += audio.length;
			total += audio.length;
			kick();
		},
		async finish() {
			finished = true;
			while (running) await running;
			if (buffered === 0) return null;
			const pcm = joined().slice();
			parts = [];
			buffered = 0;
			if (pcm.length < shortest) return null;
			return make(pcm, await probsFor(pcm));
		},
		get samples() { return total; },
	};
}
