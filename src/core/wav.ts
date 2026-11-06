/** Size of the canonical RIFF/WAVE header written below. */
export const WAV_HEADER_BYTES = 44;

/** Wrap 16-bit little-endian mono PCM in a canonical 44-byte WAV header.
 * Dictation capture is already linear16, so no resampling or re-encoding. */
export function encodePcm16Wav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
	const dataBytes = pcm.byteLength;
	const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), WAV_HEADER_BYTES);
	return out;
}

/** True when the bytes begin like a RIFF/WAVE file. */
export function looksLikeWav(bytes: Uint8Array): boolean {
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	return bytes.byteLength >= WAV_HEADER_BYTES && tag(0) === "RIFF" && tag(8) === "WAVE";
}

/** The samples of a 16-bit mono WAV at `sampleRate` in the canonical layout encodePcm16Wav
 * writes (44-byte header, data chunk last), or undefined when it is anything else.
 * A data length that disagrees with the file is not trusted: the file's own size wins. */
export function decodePcm16Wav(bytes: Uint8Array, sampleRate: number): Int16Array | undefined {
	if (!looksLikeWav(bytes)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	const canonical = tag(12) === "fmt " && view.getUint32(16, true) === 16 && view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1
		&& view.getUint32(24, true) === sampleRate && view.getUint16(34, true) === 16 && tag(36) === "data";
	if (!canonical) return undefined;
	const dataBytes = bytes.byteLength - WAV_HEADER_BYTES;
	if (dataBytes % 2 !== 0) return undefined;
	// Copy: the view's offset need not be 2-aligned, and the caller owns the result.
	const copy = new Uint8Array(dataBytes);
	copy.set(bytes.subarray(WAV_HEADER_BYTES));
	return new Int16Array(copy.buffer);
}
