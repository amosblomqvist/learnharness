import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodePcm16Wav, looksLikeWav, WAV_HEADER_BYTES } from "../src/core/wav.ts";

const ascii = (bytes: Uint8Array, offset: number, length = 4) => String.fromCharCode(...bytes.subarray(offset, offset + length));

describe("PCM16 WAV encoder", () => {
	it("writes a canonical mono 16-bit header and keeps the samples byte-for-byte", () => {
		const first = new Int16Array([0, 1, -1, 32767]);
		const second = new Int16Array([-32768, 256]);
		const wav = encodePcm16Wav([first.buffer, second], 16000);
		const view = new DataView(wav.buffer);
		const dataBytes = (first.length + second.length) * 2;
		assert.equal(wav.byteLength, WAV_HEADER_BYTES + dataBytes);
		assert.equal(ascii(wav, 0), "RIFF");
		assert.equal(view.getUint32(4, true), 36 + dataBytes, "RIFF size excludes the first 8 bytes");
		assert.equal(ascii(wav, 8), "WAVE");
		assert.equal(ascii(wav, 12), "fmt ");
		assert.equal(view.getUint32(16, true), 16, "PCM fmt chunk");
		assert.equal(view.getUint16(20, true), 1, "PCM format tag");
		assert.equal(view.getUint16(22, true), 1, "mono");
		assert.equal(view.getUint32(24, true), 16000, "sample rate");
		assert.equal(view.getUint32(28, true), 32000, "byte rate");
		assert.equal(view.getUint16(32, true), 2, "block align");
		assert.equal(view.getUint16(34, true), 16, "bits per sample");
		assert.equal(ascii(wav, 36), "data");
		assert.equal(view.getUint32(40, true), dataBytes);
		const samples = new Int16Array(wav.buffer.slice(WAV_HEADER_BYTES));
		assert.deepEqual([...samples], [0, 1, -1, 32767, -32768, 256]);
	});

	it("honours the sample rate it is given", () => {
		const view = new DataView(encodePcm16Wav([], 48000).buffer);
		assert.equal(view.getUint32(24, true), 48000);
		assert.equal(view.getUint32(28, true), 96000);
	});

	it("an empty recording is a valid header-only file", () => {
		const wav = encodePcm16Wav([], 16000);
		assert.equal(wav.byteLength, WAV_HEADER_BYTES);
		assert.equal(new DataView(wav.buffer).getUint32(40, true), 0);
		assert.equal(looksLikeWav(wav), true);
	});

	it("respects a typed-array view's offset and length inside a larger buffer", () => {
		const backing = new Int16Array([9, 9, 7, 8, 9, 9]);
		const wav = encodePcm16Wav([backing.subarray(2, 4)], 16000);
		assert.deepEqual([...new Int16Array(wav.buffer.slice(WAV_HEADER_BYTES))], [7, 8]);
	});

	it("looksLikeWav accepts the encoder's output and rejects other bytes", () => {
		assert.equal(looksLikeWav(encodePcm16Wav([new Int16Array(10).buffer], 16000)), true);
		assert.equal(looksLikeWav(new Uint8Array(0)), false);
		assert.equal(looksLikeWav(new Uint8Array(64)), false, "zeros");
		assert.equal(looksLikeWav(new TextEncoder().encode("RIFF....WAVE" + "x".repeat(40))), true, "header tags only");
		assert.equal(looksLikeWav(new TextEncoder().encode("RIFF....AVI " + "x".repeat(40))), false, "RIFF but not WAVE");
		assert.equal(looksLikeWav(new TextEncoder().encode("RIFF....WAVE")), false, "shorter than a header");
	});
});
