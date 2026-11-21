import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { useDictationLanguage } from "../components/dictation-preference.ts";

test("dictation honors pending provider choices across the Settings dialog lifetime", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let record = { version: 1, general: { dictationProvider: "deepgram" } };
	let finishWrite!: (outcome?: "saved" | "failed" | "unchanged") => void;
	let micCalls = 0;
	let sockets = 0;
	let transcriptionCalls = 0;
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
	class Socket {
		constructor() { sockets++; }
		addEventListener() {}
		close() {}
	}
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true, AudioContext: Context, AudioWorkletNode: Worklet, WebSocket: Socket,
		lh: { getUpdateState: async () => ({ status: "idle" }) },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			micCalls++;
			return { getTracks: () => [{ stop() {} }] };
		} } },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: record });
			if (url === "/api/settings/general") {
				const general = JSON.parse(String(init?.body));
				return new Promise<Response>((resolve) => { finishWrite = (outcome = "saved") => {
					if (outcome === "failed") {
						resolve(Response.json({ error: "save failed" }, { status: 500 }));
						return;
					}
					if (outcome === "saved") record = { ...record, general };
					resolve(Response.json({ settings: record }));
				}; });
			}
			if (url === "/api/keys") return Response.json({ keys: [{ id: "OPENAI_API_KEY", present: true }] });
			if (url === "/api/stt/token") return Response.json({ token: "fixture" });
			if (url === "/api/stt/openai") {
				transcriptionCalls++;
				return Response.json({ text: "fixture" });
			}
			throw new Error(`Unexpected request ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Harness() {
		const [settingsOpen, setSettingsOpen] = React.useState(true);
		current = useDictation({ append: () => {} });
		preference = useDictationLanguage();
		return <>
			<button data-testid="open-test-settings" onClick={() => setSettingsOpen(true)}>Settings</button>
			{settingsOpen && <SettingsDialogBody initialSection="general" onClose={() => setSettingsOpen(false)} />}
		</>;
	}
	function chooseProvider(provider: "deepgram" | "openai") {
		const select = document.querySelector<HTMLSelectElement>('[data-testid="dictation-provider"]')!;
		Object.defineProperty(select, "value", { configurable: true, writable: true, value: provider });
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	}
	try {
		await act(async () => root.render(<Harness />));
		const select = document.querySelector<HTMLSelectElement>('[data-testid="dictation-provider"]')!;
		await act(async () => chooseProvider("openai"));
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
		await act(async () => chooseProvider("deepgram"));
		await act(async () => finishWrite());
		assert.equal(record.general.dictationProvider, "deepgram");
		await act(async () => root.render(<Harness />));
		assert.equal(await preference.getProvider(), "deepgram", "a save during a reader gap invalidates the cached provider");

		for (const outcome of ["failed", "unchanged"] as const) {
			await act(async () => chooseProvider("openai"));
			await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
			assert.equal(document.querySelector('[data-testid="dictation-provider"]'), null);
			await act(async () => current.toggle());
			assert.equal(current.phase, "connecting");
			await act(async () => finishWrite(outcome));
			assert.equal(micCalls, 1, "an unconfirmed provider must not open the microphone");
			assert.equal(sockets, 0, "an unconfirmed provider must not fall back to Deepgram");
			assert.equal(transcriptionCalls, 0);
			assert.equal(current.phase, "idle");
			assert.match(current.error ?? "", /could not save the speech provider/i);
			await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="open-test-settings"]')!.click());
		}

		await act(async () => chooseProvider("openai"));
		await act(async () => finishWrite());
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="auto update"]')!.click());
		await act(async () => current.toggle());
		await act(async () => finishWrite("failed"));
		assert.equal(current.phase, "recording", "an unrelated General failure must not block dictation");
		assert.equal(micCalls, 2);
		await act(async () => current.cancel());
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});
