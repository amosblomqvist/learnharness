/* 24 kHz mono PCM16 for Codex dictation. Flush preserves the final partial frame. */
class CodexPcmCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = new Int16Array(2048);
		this.count = 0;
		this.port.onmessage = (event) => {
			if (event.data?.type !== "flush") return;
			if (this.count) this.sendFrame();
			this.port.postMessage({ type: "flushed" });
		};
	}
	sendFrame() {
		const buffer = this.frame.buffer.slice(0, this.count * 2);
		this.port.postMessage({ type: "audio", buffer }, [buffer]);
		this.frame = new Int16Array(2048);
		this.count = 0;
	}
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		let sum = 0;
		for (const value of channel) {
			sum += value * value;
			const sample = Math.max(-1, Math.min(1, value));
			this.frame[this.count++] = sample < 0 ? sample * 32768 : sample * 32767;
			if (this.count === this.frame.length) this.sendFrame();
		}
		this.port.postMessage({ type: "level", rms: Math.sqrt(sum / channel.length) });
		return true;
	}
}
registerProcessor("codex-pcm-capture", CodexPcmCapture);
