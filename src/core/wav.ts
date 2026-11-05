/** Size of the canonical RIFF/WAVE header written below. */
export const WAV_HEADER_BYTES = 44;

/** Wrap 16-bit little-endian mono PCM chunks in a canonical 44-byte WAV header.
 * Dictation capture is already linear16, so no resampling or re-encoding. */
export function encodePcm16Wav(chunks: readonly (ArrayBuffer | ArrayBufferView)[], sampleRate: number): Uint8Array<ArrayBuffer> {
	const parts = chunks.map((chunk) => chunk instanceof ArrayBuffer
		? new Uint8Array(chunk)
		: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	const dataBytes = parts.reduce((total, part) => total + part.byteLength, 0);
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
	let offset = WAV_HEADER_BYTES;
	for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
	return out;
}

/** True when the bytes begin like a RIFF/WAVE file. */
export function looksLikeWav(bytes: Uint8Array): boolean {
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	return bytes.byteLength >= WAV_HEADER_BYTES && tag(0) === "RIFF" && tag(8) === "WAVE";
}
