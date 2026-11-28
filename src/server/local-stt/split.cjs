"use strict";
/**
 * Cut a long clip into pieces the recognizer can take in one pass. Parakeet's
 * ONNX export attends over the whole input, so memory grows with clip length;
 * pieces stay at or under maxSeconds. Each cut lands on the quietest 20 ms
 * frame in the last third of the allowed window, which is almost always a
 * pause between words. Plain CommonJS: the transcriber child loads it
 * directly, outside Next's module graph.
 */

const FRAME_SECONDS = 0.02;

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} [maxSeconds]
 * @returns {Array<[number, number]>} [start, end) sample ranges covering the clip
 */
function splitAtQuietPoints(samples, sampleRate, maxSeconds = 30) {
	const total = samples.length;
	const maxLen = Math.floor(maxSeconds * sampleRate);
	if (total <= maxLen) return total === 0 ? [] : [[0, total]];
	const frame = Math.max(1, Math.floor(FRAME_SECONDS * sampleRate));
	const ranges = [];
	let start = 0;
	while (total - start > maxLen) {
		const searchFrom = start + Math.floor((maxLen * 2) / 3);
		const searchTo = start + maxLen - frame;
		let best = start + maxLen;
		let bestEnergy = Infinity;
		for (let at = searchFrom; at <= searchTo; at += frame) {
			let energy = 0;
			for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
			if (energy < bestEnergy) {
				bestEnergy = energy;
				best = at + Math.floor(frame / 2);
			}
		}
		ranges.push([start, best]);
		start = best;
	}
	ranges.push([start, total]);
	return ranges;
}

/**
 * Little-endian 16-bit PCM bytes to floats in [-1, 1).
 * @param {Uint8Array} pcm
 */
function pcm16ToFloat32(pcm) {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
	const out = new Float32Array(view.byteLength / 2);
	for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
	return out;
}

module.exports = { splitAtQuietPoints, pcm16ToFloat32 };
