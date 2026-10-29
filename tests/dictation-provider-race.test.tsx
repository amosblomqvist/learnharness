import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { useDictationLanguage } from "../components/dictation-preference.ts";

test("recording waits for an in-flight provider choice and locks it until capture ends", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let record = { version: 1, general: { dictationProvider: "deepgram" } };
	let finishWrite!: () => void;
	let micCalls = 0;
	let sockets = 0;
	let current!: Dictation;
	let preference!: ReturnType<typeof useDictationLanguage>;
	class Context {
		sampleRate = 16000;
		state = "running";
		destination = {};
		audioWorklet = { addModule: async () => {} };
		createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
	}
	class Worklet { port = {}; connect() {} disconnect() {} }
	class Socket { constructor() { sockets++; } }
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true, AudioContext: Context, AudioWorkletNode: Worklet, WebSocket: Socket,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			micCalls++;
			return { getTracks: () => [{ stop() {} }] };
		} } },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: record });
			if (url === "/api/settings/general") {
				const general = JSON.parse(String(init?.body));
				return new Promise<Response>((resolve) => { finishWrite = () => {
					record = { ...record, general };
					resolve(Response.json({ settings: record }));
				}; });
			}
			if (url === "/api/keys") return Response.json({ keys: [{ id: "OPENAI_API_KEY", present: true }] });
			if (url === "/api/stt/token") return Response.json({ token: "fixture" });
			throw new Error(`Unexpected request ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness() {
		current = useDictation({ append: () => {} });
		preference = useDictationLanguage();
		return <SettingsDialogBody initialSection="general" onClose={() => {}} />;
	}
	try {
		await act(async () => root.render(<Harness />));
		const select = document.querySelector<HTMLSelectElement>('[data-testid="dictation-provider"]')!;
		await act(async () => {
			Object.defineProperty(select, "value", { configurable: true, writable: true, value: "openai" });
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await act(async () => current.toggle());
		assert.equal(current.phase, "connecting");
		assert.equal(micCalls, 0, "do not capture using the old provider while its replacement is saving");
		assert.equal(select.disabled, true);
		await act(async () => finishWrite());
		assert.equal(current.phase, "recording");
		assert.equal(micCalls, 1);
		assert.equal(sockets, 0, "the confirmed OpenAI choice never opens Deepgram");
		await act(async () => current.cancel());
		assert.equal(select.disabled, false);

		// A successful save can finish after navigation has removed the last
		// dictation reader. A later page must not use the previously cached provider.
		await act(async () => root.render(<SettingsDialogBody initialSection="general" onClose={() => {}} />));
		const afterNavigation = document.querySelector<HTMLSelectElement>('[data-testid="dictation-provider"]')!;
		await act(async () => {
			Object.defineProperty(afterNavigation, "value", { configurable: true, writable: true, value: "deepgram" });
			afterNavigation.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await act(async () => finishWrite());
		assert.equal(record.general.dictationProvider, "deepgram");
		await act(async () => root.render(<Harness />));
		assert.equal(await preference.getProvider(), "deepgram", "a save during a reader gap invalidates the cached provider");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});
