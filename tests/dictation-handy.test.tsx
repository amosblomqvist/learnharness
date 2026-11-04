import React, { act } from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	encodeWavPcm16Mono,
	isDictationProvider,
	type DictationSettings,
	type UserSettings,
} from "../src/core/index.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { listHandyModels, isHandyAvailable, transcribeWithHandy } from "../src/server/handy.ts";
import { useDictation } from "../components/dictation.tsx";

describe("encodeWavPcm16Mono", () => {
	it("produces a valid 44-byte RIFF/WAVE header and concatenates audio frames", () => {
		const frame1 = new Int16Array([100, 200, 300]);
		const frame2 = new Int16Array([400, 500]);
		const wav = encodeWavPcm16Mono([frame1.buffer, frame2.buffer], 16000);

		assert.equal(wav.byteLength, 44 + 10);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

		// "RIFF"
		const riff = String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!);
		assert.equal(riff, "RIFF");
		assert.equal(view.getUint32(4, true), 36 + 10);

		// "WAVE"
		const wave = String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!);
		assert.equal(wave, "WAVE");

		// "fmt "
		const fmt = String.fromCharCode(wav[12]!, wav[13]!, wav[14]!, wav[15]!);
		assert.equal(fmt, "fmt ");
		assert.equal(view.getUint16(20, true), 1); // PCM
		assert.equal(view.getUint16(22, true), 1); // Mono
		assert.equal(view.getUint32(24, true), 16000); // 16kHz
		assert.equal(view.getUint32(28, true), 32000); // Byte rate
		assert.equal(view.getUint16(32, true), 2); // Block align
		assert.equal(view.getUint16(34, true), 16); // 16-bit

		// "data"
		const dataTag = String.fromCharCode(wav[36]!, wav[37]!, wav[38]!, wav[39]!);
		assert.equal(dataTag, "data");
		assert.equal(view.getUint32(40, true), 10);

		// Samples
		const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, 5);
		assert.deepEqual([...samples], [100, 200, 300, 400, 500]);
	});

	it("preserves full 16-bit signed PCM bytes when given Int16Array views from pcm-capture worklet", () => {
		const frame1 = new Int16Array([1000, -1000, 16384]);
		const frame2 = new Int16Array([-16384, 32767, -32768]);
		const wav = encodeWavPcm16Mono([frame1, frame2], 16000);

		assert.equal(wav.byteLength, 44 + 12);
		const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, 6);
		assert.deepEqual([...samples], [1000, -1000, 16384, -16384, 32767, -32768]);
	});
});

describe("dictation settings with Handy provider", () => {
	it("validates provider and handyModel in parseDictationSettingsBody", () => {
		assert.equal(isDictationProvider("handy"), true);
		assert.equal(isDictationProvider("deepgram"), true);
		assert.equal(isDictationProvider("whisper"), false);

		assert.deepEqual(parseDictationSettingsBody({ provider: "handy" }), {
			ok: true,
			settings: { provider: "handy" },
		});
		assert.deepEqual(
			parseDictationSettingsBody({ provider: "handy", handyModel: "parakeet-tdt-0.6b-v3" }),
			{
				ok: true,
				settings: { provider: "handy", handyModel: "parakeet-tdt-0.6b-v3" },
			},
		);
		assert.equal(parseDictationSettingsBody({ provider: "unknown" }).ok, false);
		assert.equal(parseDictationSettingsBody({ handyModel: "   " }).ok, false);
	});

	it("sanitizes dictation settings with provider and handyModel", () => {
		const raw = {
			version: 1,
			dictation: {
				language: "en",
				provider: "handy",
				handyModel: "granite-speech-4.1-2b-plus",
			},
		};
		const sanitized = sanitizeUserSettings(raw);
		assert.deepEqual(sanitized?.dictation, {
			language: "en",
			provider: "handy",
			handyModel: "granite-speech-4.1-2b-plus",
		});
	});
});

describe("Handy CLI server helpers", () => {
	it("detects handy binary on system and lists downloaded models", async () => {
		const available = isHandyAvailable();
		assert.equal(typeof available, "boolean");

		const modelsResult = await listHandyModels();
		assert.equal(typeof modelsResult.available, "boolean");
		assert.ok(Array.isArray(modelsResult.models));
	});

	it("transcribes audio bytes via transcribeWithHandy", async () => {
		if (!isHandyAvailable()) return;
		const silence = new Int16Array(16000); // 1s silence
		const wav = encodeWavPcm16Mono([silence.buffer]);
		const result = await transcribeWithHandy(wav);
		assert.equal(typeof result.text, "string");
	});
});

describe("useDictation with Handy mode", () => {
	it("captures audio and POSTs to /api/stt/transcribe on stop, flushing transcript into target", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const appends: string[] = [];
		let fetchCalls: { url: string; method?: string; body?: unknown }[] = [];

		class MockAudioGraph {
			state = "running";
			destination = {};
			audioWorklet = { addModule: async () => {} };
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
		}

		let sendWorkletAudio: ((buffer: ArrayBuffer | ArrayBufferView) => void) | null = null;
		class MockWorklet {
			port = {
				get onmessage(): ((e: { data: unknown }) => void) | null {
					return null;
				},
				set onmessage(fn: ((e: { data: unknown }) => void) | null) {
					if (fn) {
						sendWorkletAudio = (buf: ArrayBuffer | ArrayBufferView) => fn({ data: { type: "audio", buffer: buf } });
					} else {
						sendWorkletAudio = null;
					}
				},
			};
			connect() {}
			disconnect() {}
		}

		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({
			React,
			window: dom.window,
			document: dom.document,
			CustomEvent: dom.window.CustomEvent,
			navigator: {
				userAgent: "",
				platform: "",
				mediaDevices: {
					getUserMedia: async () => ({
						getTracks: () => [{ stop() {} }],
					}),
				},
			},
			AudioContext: MockAudioGraph,
			AudioWorkletNode: MockWorklet,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string, init?: RequestInit) => {
				fetchCalls.push({ url, method: init?.method, body: init?.body });
				if (url === "/api/settings") {
					return Response.json({
						settings: {
							version: 1,
							dictation: { language: "en", provider: "handy", handyModel: "test-model" },
						},
					});
				}
				if (url === "/api/stt/token") {
					return Response.json({ token: "handy-local", provider: "handy" });
				}
				if (url.startsWith("/api/stt/transcribe")) {
					return Response.json({ text: "Hello from local Handy" });
				}
				return Response.json({});
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}

		const { createRoot } = await import("react-dom/client");
		let hook!: ReturnType<typeof useDictation>;
		function Harness() {
			hook = useDictation({ append: (text) => appends.push(text) });
			return null;
		}

		const root = createRoot(dom.document.getElementById("root")!);
		await act(async () => {
			root.render(<Harness />);
		});

		// Start dictation
		await act(async () => {
			hook.toggle();
		});

		assert.equal(hook.phase, "recording");

		// Simulate PCM frame from worklet (pcm-capture.js sends Int16Array directly)
		const frame = new Int16Array([1000, -1000, 2000, -2000]);
		const emit = sendWorkletAudio as ((buffer: ArrayBuffer | ArrayBufferView) => void) | null;
		emit?.(frame);

		// Stop dictation
		await act(async () => {
			hook.stop();
		});

		// Verify transcribe was called with intact 16-bit PCM WAV bytes
		const transcribeCall = fetchCalls.find((c) => c.url.startsWith("/api/stt/transcribe"));
		assert.ok(transcribeCall, "must POST to /api/stt/transcribe");
		assert.equal(transcribeCall.method, "POST");
		assert.ok(transcribeCall.url.includes("model=test-model"));
		const postedWav = transcribeCall.body as Uint8Array;
		const postedSamples = new Int16Array(postedWav.buffer, postedWav.byteOffset + 44, 4);
		assert.deepEqual([...postedSamples], [1000, -1000, 2000, -2000]);

		// Verify text was appended to primary input
		assert.deepEqual(appends, ["Hello from local Handy"]);
		assert.equal(hook.phase, "idle");

		// Cleanup global mocks
		await act(async () => {
			root.unmount();
		});
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	it("discards audio and does not call transcribe on cancel (Esc)", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const appends: string[] = [];
		let fetchCalls: string[] = [];

		class MockAudioGraph {
			state = "running";
			destination = {};
			audioWorklet = { addModule: async () => {} };
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
		}

		class MockWorklet {
			port = { onmessage: null };
			connect() {}
			disconnect() {}
		}

		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({
			React,
			window: dom.window,
			document: dom.document,
			CustomEvent: dom.window.CustomEvent,
			navigator: {
				userAgent: "",
				platform: "",
				mediaDevices: {
					getUserMedia: async () => ({
						getTracks: () => [{ stop() {} }],
					}),
				},
			},
			AudioContext: MockAudioGraph,
			AudioWorkletNode: MockWorklet,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string) => {
				fetchCalls.push(url);
				if (url === "/api/settings") {
					return Response.json({
						settings: {
							version: 1,
							dictation: { language: "en", provider: "handy" },
						},
					});
				}
				if (url === "/api/stt/token") {
					return Response.json({ token: "handy-local", provider: "handy" });
				}
				return Response.json({});
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}

		const { createRoot } = await import("react-dom/client");
		let hook!: ReturnType<typeof useDictation>;
		function Harness() {
			hook = useDictation({ append: (text) => appends.push(text) });
			return null;
		}

		const root = createRoot(dom.document.getElementById("root")!);
		await act(async () => {
			root.render(<Harness />);
		});

		await act(async () => {
			hook.toggle();
		});
		assert.equal(hook.phase, "recording");

		await act(async () => {
			hook.cancel();
		});

		assert.equal(hook.phase, "idle");
		assert.equal(fetchCalls.some((u) => u.startsWith("/api/stt/transcribe")), false);
		assert.deepEqual(appends, []);

		await act(async () => {
			root.unmount();
		});
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	it("stopping during connecting phase does not revert to recording when token resolves", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const appends: string[] = [];
		let resolveToken!: (res: Response) => void;

		class MockAudioGraph {
			state = "running";
			destination = {};
			audioWorklet = { addModule: async () => {} };
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
		}

		class MockWorklet {
			port = { onmessage: null };
			connect() {}
			disconnect() {}
		}

		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({
			React,
			window: dom.window,
			document: dom.document,
			CustomEvent: dom.window.CustomEvent,
			navigator: {
				userAgent: "",
				platform: "",
				mediaDevices: {
					getUserMedia: async () => ({
						getTracks: () => [{ stop() {} }],
					}),
				},
			},
			AudioContext: MockAudioGraph,
			AudioWorkletNode: MockWorklet,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string) => {
				if (url === "/api/settings") {
					return Response.json({
						settings: {
							version: 1,
							dictation: { language: "en", provider: "handy" },
						},
					});
				}
				if (url === "/api/stt/token") {
					return new Promise<Response>((r) => {
						resolveToken = r;
					});
				}
				return Response.json({});
			},
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}

		const { createRoot } = await import("react-dom/client");
		const { notifySettingsSaved } = await import("../components/settings-signal.ts");
		let hook!: ReturnType<typeof useDictation>;
		function Harness() {
			hook = useDictation({ append: (text) => appends.push(text) });
			return null;
		}

		const root = createRoot(dom.document.getElementById("root")!);
		await act(async () => {
			root.render(<Harness />);
		});
		await act(async () => {
			notifySettingsSaved("dictation");
		});

		// Start dictation while token is still pending -> phase is "connecting"
		await act(async () => {
			hook.toggle();
		});
		assert.equal(hook.phase, "connecting");

		// Stop dictation while still in "connecting" phase
		await act(async () => {
			hook.stop();
		});
		assert.equal(hook.phase, "idle");

		// Resolve token late — must NOT transition back to "recording"
		await act(async () => {
			resolveToken?.(Response.json({ token: "handy-local", provider: "handy" }));
		});
		assert.equal(hook.phase, "idle");

		await act(async () => {
			root.unmount();
		});
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	it("throws when handy binary returns non-JSON output instead of silently returning empty text", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const fakeBin = path.join(os.tmpdir(), `fake-handy-${Date.now()}.sh`);
		await fs.promises.writeFile(fakeBin, "#!/bin/sh\necho 'not valid json'\n", { mode: 0o755 });
		const prevBin = process.env.LH_HANDY_BIN;
		process.env.LH_HANDY_BIN = fakeBin;
		try {
			const silence = new Int16Array(160);
			const wav = encodeWavPcm16Mono([silence]);
			await assert.rejects(
				() => transcribeWithHandy(wav),
				/Handy returned invalid transcription output/,
			);
		} finally {
			if (prevBin === undefined) delete process.env.LH_HANDY_BIN;
			else process.env.LH_HANDY_BIN = prevBin;
			await fs.promises.unlink(fakeBin).catch(() => {});
		}
	});
});

