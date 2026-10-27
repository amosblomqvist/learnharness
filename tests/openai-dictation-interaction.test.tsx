import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { isDictationActive } from "../components/dictation-state.ts";
import { useDictation, type Dictation, OPENAI_DICTATION_KEYLESS } from "../components/dictation.tsx";

(globalThis as Record<string, unknown>).React = React;

it("records, flushes and retries OpenAI audio without losing or double-inserting it", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let provider: "openai" | "deepgram" = "openai";
	let hasKey = true;
	let micCalls = 0;
	let uploads = 0;
	let mode: "defer" | "fail" | "success" = "defer";
	let resolveUpload: ((res: Response) => void) | undefined;
	let current: Dictation;
	const appended: string[] = [];
	let worklet: FakeWorklet;
	let socket: FakeSocket;
	const sent: unknown[] = [];

	class FakeWorklet {
		port = {
			onmessage: (_event: { data: unknown }) => {},
			postMessage: (message: { type: string }) => {
				if (message.type === "flush") queueMicrotask(() => {
					this.port.onmessage({ data: { type: "audio", buffer: new Int16Array([777]) } });
					this.port.onmessage({ data: { type: "flushed" } });
				});
			},
		};
		constructor() { worklet = this; }
		connect() {}
		disconnect() {}
		emit(data: unknown) { this.port.onmessage({ data }); }
	}
	class FakeContext {
		sampleRate = 16000;
		state = "running";
		destination = {};
		audioWorklet = { addModule: async () => {} };
		createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
		async resume() {}
	}
	class FakeSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		readyState = 0;
		listeners = new Map<string, ((event: any) => void)[]>();
		constructor() {
			socket = this;
			queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
		}
		addEventListener(type: string, callback: (event: any) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
		}
		emit(type: string, event: unknown) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
		send(value: unknown) {
			sent.push(value);
			if (value === JSON.stringify({ type: "CloseStream" })) queueMicrotask(() => this.emit("close", { code: 1000 }));
		}
		close() { this.readyState = 3; }
	}
	const globals = globalThis as Record<string, unknown>;
	for (const [name, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		AudioContext: FakeContext, AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
		navigator: { userAgent: "", platform: "MacIntel", mediaDevices: { getUserMedia: async () => {
			micCalls++;
			return { getTracks: () => [{ stop() {} }] };
		} } },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: { version: 1, general: { dictationProvider: provider } } });
			if (url === "/api/keys") return Response.json({ keys: hasKey ? [{ id: "OPENAI_API_KEY", present: true }] : [] });
			if (url === "/api/stt/token") return Response.json({ token: "fake-deepgram-token" });
			assert.equal(url, "/api/stt/openai");
			uploads++;
			const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer());
			assert.equal(new DataView(bytes.buffer).getUint32(24, true), 16000);
			assert.deepEqual([...bytes.slice(44)], [100, 0, 56, 255, 9, 3]);
			if (mode === "fail") return Response.json({ message: "OpenAI transcription failed (429)." }, { status: 502 });
			if (mode === "success") return Response.json({ text: "Результат test" });
			return new Promise<Response>((resolve) => { resolveUpload = resolve; });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness() { current = useDictation({ append: (text) => appended.push(text) }); return null; }
	const record = async () => {
		await act(async () => { current!.toggle(); });
		assert.equal(current!.phase, "recording");
		act(() => worklet!.emit({ type: "audio", buffer: new Int16Array([100, -200]) }));
	};
	try {
		await act(async () => root.render(<Harness />));
		await record();
		let result: Promise<boolean>;
		await act(async () => { result = current!.finish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(current!.phase, "stopping");
		assert.deepEqual(appended, []);
		await act(async () => { resolveUpload!(Response.json({ text: "Первый ответ" })); assert.equal(await result!, true); });
		assert.deepEqual(appended, ["Первый ответ"]);
		assert.equal(current!.active, false);

		mode = "fail";
		await record();
		await act(async () => { assert.equal(await current!.finish(), false); });
		assert.equal(current!.retryable, true);
		assert.equal(current!.active, true, "failed audio gates submission");
		assert.equal(isDictationActive(), true, "pending retry keeps shared settings locked");
		assert.equal(await current!.finish(), false, "submission stays gated while audio is pending");
		assert.deepEqual(appended, ["Первый ответ"]);
		mode = "success";
		await act(async () => { current!.toggle(); await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(current!.retryable, false);
		assert.equal(isDictationActive(), false, "successful retry unlocks settings");
		assert.deepEqual(appended, ["Первый ответ", "Результат test"]);

		mode = "defer";
		await record();
		await act(async () => { result = current!.finish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
		const late = resolveUpload!;
		act(() => current!.cancel());
		assert.equal(await result!, false);
		await act(async () => { late(Response.json({ text: "late" })); await Promise.resolve(); });
		assert.deepEqual(appended, ["Первый ответ", "Результат test"]);

		hasKey = false;
		const beforeMic = micCalls;
		await act(async () => current!.toggle());
		assert.equal(current!.error, OPENAI_DICTATION_KEYLESS);
		assert.equal(micCalls, beforeMic, "missing key is detected before capturing audio");

		provider = "deepgram";
		await act(async () => { notifySettingsSaved("general"); });
		await act(async () => current!.toggle());
		assert.equal(current!.phase, "recording");
		act(() => socket!.emit("message", { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "Deepgram text" }] } }) }));
		await act(async () => { assert.equal(await current!.finish(), true); });
		assert.equal(appended.at(-1), "Deepgram text");
		assert.ok(sent.includes(JSON.stringify({ type: "CloseStream" })));
		assert.equal(uploads, 4, "Deepgram never invokes the OpenAI API");
	} finally {
		act(() => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete globals[name];
		}
	}
});

it("stopping while provider settings are loading cannot start a late microphone or submit", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = globalThis as Record<string, unknown>;
	let resolveSettings!: (res: Response) => void;
	const settings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
	let micCalls = 0;
	let current: Dictation;
	for (const [name, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: { userAgent: "", platform: "MacIntel", mediaDevices: { getUserMedia: async () => { micCalls++; throw new Error("unexpected mic"); } } },
		fetch: async () => settings,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness() { current = useDictation({ append: () => assert.fail("unexpected transcript") }); return null; }
	try {
		await act(async () => root.render(<Harness />));
		act(() => current!.toggle());
		assert.equal(current!.phase, "connecting");
		await act(async () => { assert.equal(await current!.finish(), false); });
		assert.equal(current!.phase, "idle");
		await act(async () => { resolveSettings(Response.json({ settings: { general: { dictationProvider: "openai" } } })); await Promise.resolve(); });
		assert.equal(micCalls, 0);
	} finally {
		act(() => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete globals[name];
		}
	}
});
