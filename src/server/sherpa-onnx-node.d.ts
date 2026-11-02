/** sherpa-onnx-node ships JSDoc types only; declare the surface we use. */
declare module "sherpa-onnx-node" {
	interface Wave { sampleRate: number; samples: Float32Array }
	interface Stream { acceptWaveform(wave: Wave): void }
	interface Recognizer {
		createStream(): Stream;
		decodeAsync(stream: Stream): Promise<void>;
		getResult(stream: Stream): { text: string };
	}
	const sherpa: {
		OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> };
		readWave(filename: string): Wave;
	};
	export default sherpa;
}
