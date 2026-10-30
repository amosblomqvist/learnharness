import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { UserSettings } from "../src/core/index.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const select = () => document.querySelector<HTMLSelectElement>('[data-testid="dictation-provider"]')!;

async function fixture(keys: { deepgram: boolean; elevenlabs: boolean }, dictation: UserSettings["dictation"] = { language: "en" }) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = { record: { version: 1, dictation } as UserSettings, writes: [] as unknown[], failWrite: false };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.writes.push(body);
			if (state.failWrite) return Response.json({}, { status: 500 });
			state.record = { ...state.record, dictation: body };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { DictationProviderSetting } = await import("../components/dictation-provider-setting.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	await act(async () => { root.render(<DictationProviderSetting keyPresence={keys} />); });
	await act(async () => { notifySettingsSaved("dictation"); }); // a fresh record per fixture
	return state;
}

async function choose(value: string) {
	await act(async () => {
		// linkedom's select.value is read-only: select the option instead.
		for (const option of select().querySelectorAll("option")) {
			if (option.getAttribute("value") === value) option.setAttribute("selected", "");
			else option.removeAttribute("selected");
		}
		select().dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("with nothing saved the picker shows the provider the keys resolve to", async () => {
	await fixture({ deepgram: false, elevenlabs: true });
	assert.equal(select().value, "elevenlabs");
	assert.deepEqual([...select().querySelectorAll("option")].map((o) => o.textContent), ["Deepgram", "ElevenLabs"]);
});

test("with both keys and nothing saved it shows Deepgram; with no keys, Deepgram's keyless default", async () => {
	await fixture({ deepgram: true, elevenlabs: true });
	assert.equal(select().value, "deepgram");
	await dispose!();
	restore!();
	await fixture({ deepgram: false, elevenlabs: false });
	assert.equal(select().value, "deepgram");
});

test("a saved choice wins over key presence", async () => {
	await fixture({ deepgram: true, elevenlabs: false }, { language: "en", provider: "elevenlabs" });
	assert.equal(select().value, "elevenlabs");
});

test("choosing a provider saves it together with the language", async () => {
	const state = await fixture({ deepgram: true, elevenlabs: true }, { language: "pl" });
	await choose("elevenlabs");
	assert.deepEqual(state.writes, [{ language: "pl", provider: "elevenlabs" }]);
	assert.equal(select().value, "elevenlabs");
});

test("a failed save keeps the previous value", async () => {
	const state = await fixture({ deepgram: true, elevenlabs: true });
	state.failWrite = true;
	await choose("elevenlabs");
	assert.equal(select().value, "deepgram");
});

test("the picker locks while dictation is active", async () => {
	await fixture({ deepgram: true, elevenlabs: true });
	assert.equal(select().disabled, false);
	await act(async () => { setDictationActive(true); });
	assert.equal(select().disabled, true);
});
