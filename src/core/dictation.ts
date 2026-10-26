/** Browser-safe dictation configuration and PCM/WAV helpers. */
export type DictationProvider = "deepgram" | "openai";

export const DICTATION_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
// Below OpenAI's documented 25 MB limit, including the WAV header.
export const MAX_DICTATION_WAV_BYTES = 24_000_000;
// Leave room for queued frames and the partial frame flushed after stopping.
export const DICTATION_STOP_PCM_BYTES = MAX_DICTATION_WAV_BYTES - WAV_HEADER_BYTES - 320_000;

/** Encode mono signed PCM16 as a WAV without writing audio to disk. */
export function pcm16Wav(frames: readonly Uint8Array[]): Blob {
	const dataBytes = frames.reduce((size, frame) => size + frame.byteLength, 0);
	if (dataBytes === 0 || dataBytes % 2 !== 0 || dataBytes + WAV_HEADER_BYTES > MAX_DICTATION_WAV_BYTES) {
		throw new Error("Invalid or oversized dictation audio");
	}
	const header = new ArrayBuffer(WAV_HEADER_BYTES);
	const view = new DataView(header);
	const write = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	write(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); write(8, "WAVE");
	write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
	view.setUint16(22, 1, true); view.setUint32(24, DICTATION_SAMPLE_RATE, true);
	view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	write(36, "data"); view.setUint32(40, dataBytes, true);
	return new Blob([header, ...frames.map((frame) => Uint8Array.from(frame))], { type: "audio/wav" });
}
