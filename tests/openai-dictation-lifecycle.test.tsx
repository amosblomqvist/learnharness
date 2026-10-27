import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";

test("cancelling pending key preflight and unmounting an upload invalidate late work", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let finishKeys!: (response: Response) => void;
	let finishUpload!: (response: Response) => void;
	let uploadSignal!: AbortSignal;
	let keyCheckPending = true;
	let micCalls = 0;
	let current!: Dictation;
	let worklet!: Worklet;
	const appended: string[] = [];
	class Context {
		sampleRate = 16000;
		state = "running";
		destination = {};
		audioWorklet = { addModule: async () => {} };
		createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
	}
	class Worklet {
		port = {
			onmessage: (_event: { data: unknown }) => {},
			postMessage: () => queueMicrotask(() => this.port.onmessage({ data: { type: "flushed" } })),
		};
		constructor() { worklet = this; }
		connect() {} disconnect() {}
	}
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true, AudioContext: Context, AudioWorkletNode: Worklet,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			micCalls++;
			return { getTracks: () => [{ stop() {} }] };
		} } },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: { version: 1, general: { dictationProvider: "openai" } } });
			if (url === "/api/keys") {
				if (keyCheckPending) return new Promise<Response>((resolve) => { finishKeys = resolve; });
				return Response.json({ keys: [{ id: "OPENAI_API_KEY", present: true }] });
			}
			if (url === "/api/stt/openai") {
				uploadSignal = init!.signal!;
				return new Promise<Response>((resolve) => { finishUpload = resolve; });
			}
			throw new Error(`Unexpected request ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness() { current = useDictation({ append: (text) => appended.push(text) }); return null; }
	let unmounted = false;
	try {
		await act(async () => root.render(<Harness />));
		await act(async () => current.toggle());
		assert.equal(current.phase, "connecting");
		assert.equal(micCalls, 0);
		await act(async () => assert.equal(await current.finish(), false));
		keyCheckPending = false;
		await act(async () => finishKeys(Response.json({ keys: [{ id: "OPENAI_API_KEY", present: true }] })));
		assert.equal(micCalls, 0, "a late key check must not start a cancelled recording");
		await act(async () => current.toggle());
		assert.equal(current.phase, "recording");
		act(() => worklet.port.onmessage({ data: { type: "audio", buffer: new Int16Array([123]) } }));
		let result!: Promise<boolean>;
		await act(async () => { result = current.finish(); await Promise.resolve(); });
		assert.equal(current.phase, "stopping");
		await act(async () => { root.unmount(); unmounted = true; });
		assert.equal(uploadSignal.aborted, true);
		assert.equal(await result, false);
		await act(async () => finishUpload(Response.json({ text: "late result" })));
		assert.deepEqual(appended, [], "a late upload cannot append to a new page");
	} finally {
		if (!unmounted) await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});
