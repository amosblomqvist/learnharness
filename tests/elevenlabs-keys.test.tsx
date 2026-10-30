/**
 * The ElevenLabs key in Settings → Keys (ElevenLabs voice, slice 2): ONE
 * stored value rendered as TWO rows — in the Dictation group beside Deepgram
 * and in the Read aloud group. A save from either row goes through the
 * existing keys route once and both rows reflect it live. Fake only the
 * boundary (fetch); the shape gate + masking are the real core functions, so
 * the 400 path is the real one.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AUTH_KEYS, keyRowTarget, maskKey, validateKeyShape, type AuthKeyStatus } from "../src/core/index.ts";

const ID = "ELEVENLABS_API_KEY";
const DICTATION_ROW = "key-elevenlabs_api_key";
const READ_ALOUD_ROW = "key-elevenlabs_api_key-read-aloud";
const GOOD = `${"e".repeat(36)}wxyz`; // throwaway

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const click = async (element: HTMLElement) => { assert(element); await act(async () => { element.click(); }); };
async function paste(element: HTMLElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function fixture(initialRow?: string) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () {};
	win.HTMLElement.prototype.scrollIntoView = () => {};
	const state = { stored: undefined as string | undefined, puts: [] as string[], saved: 0 };
	// Like GET /api/keys: one status per curated key, ElevenLabs reflecting the store.
	const statuses = (): AuthKeyStatus[] => AUTH_KEYS.map((info) => info.id === ID && state.stored !== undefined
		? { id: ID, info, present: true, masked: `${maskKey(state.stored)} (${state.stored.length} chars)`, source: "file", shadowedByEnv: false }
		: { id: info.id, info, present: false, masked: null, source: "none", shadowedByEnv: false });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/keys") return Response.json({ keys: statuses(), providers: [] });
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
			if (url === "/api/custom-provider") return Response.json({});
			assert.equal(url, `/api/keys/${ID}`);
			assert.equal(init!.method, "PUT");
			const { value } = JSON.parse(init!.body as string) as { value: string };
			state.puts.push(value);
			const shape = validateKeyShape(ID, value);
			if (!shape.ok) return Response.json({ error: shape.error }, { status: 400 });
			state.stored = value.trim();
			return Response.json({ key: statuses().find((s) => s.id === ID) });
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
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	await act(async () => { root.render(<KeysSection initialRow={initialRow} />); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	return state;
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("the ElevenLabs row sits in the Dictation group beside Deepgram and again in a Read aloud group", async () => {
	await fixture();
	const dictation = byTest("group-dictation");
	const readAloud = byTest("group-read-aloud");
	assert.ok(dictation.querySelector(`[data-testid="${DICTATION_ROW}"]`));
	assert.ok(dictation.querySelector('[data-testid="key-deepgram_api_key"]'));
	assert.ok(readAloud.querySelector(`[data-testid="${READ_ALOUD_ROW}"]`));
	assert.equal(readAloud.querySelector('[data-testid="key-deepgram_api_key"]'), null, "Deepgram never reads aloud");
	assert.equal(byTest("group-search").querySelector(`[data-testid^="${DICTATION_ROW}"]`), null, "not a search key");
	assert.match(byTest("key-deepgram_api_key-row").textContent!, /Deepgram \(dictation only\)/);
	assert.match(byTest(`${DICTATION_ROW}-status`).textContent!, /not set/);
	assert.match(byTest(`${READ_ALOUD_ROW}-status`).textContent!, /not set/);
});

for (const [from, group] of [[READ_ALOUD_ROW, "Read aloud"], [DICTATION_ROW, "Dictation"]] as const) {
	test(`saving from the ${group} row stores one value and both rows show it masked, live`, async () => {
		const state = await fixture();
		await click(byTest(`${from}-row`));
		await paste(byTest(`${from}-input`), `  ${GOOD}  `);
		await click(byTest(`${from}-save`));
		assert.equal(state.puts.length, 1, "one PUT through the existing keys route");
		assert.equal(state.stored, GOOD);
		for (const row of [DICTATION_ROW, READ_ALOUD_ROW]) {
			assert.equal(byTest(`${row}-status`).textContent, "…wxyz · 40", row);
			assert.ok(!document.body.textContent!.includes(GOOD), "plaintext never rendered");
		}
	});
}

test("a truncated paste is rejected with the server's 400 message and nothing is stored", async () => {
	const state = await fixture();
	await click(byTest(`${READ_ALOUD_ROW}-row`));
	await paste(byTest(`${READ_ALOUD_ROW}-input`), "short");
	await click(byTest(`${READ_ALOUD_ROW}-save`));
	assert.match(byTest(`${READ_ALOUD_ROW}-error`).textContent!, /ELEVENLABS_API_KEY must be at least 20 characters with no whitespace/);
	assert.equal(state.stored, undefined);
	await click(byTest(`${READ_ALOUD_ROW}-cancel`));
	assert.match(byTest(`${READ_ALOUD_ROW}-status`).textContent!, /not set/);
	assert.match(byTest(`${DICTATION_ROW}-status`).textContent!, /not set/);
});

test("each group's help names the ElevenLabs permissions, the caveat, and links to the console", async () => {
	await fixture();
	const dictationHint = byTest("dictation-elevenlabs-hint");
	const readAloudHint = byTest("read-aloud-setup-hint");
	assert.ok(byTest("group-dictation").contains(dictationHint));
	assert.ok(byTest("group-read-aloud").contains(readAloudHint));
	assert.notEqual(dictationHint.textContent, readAloudHint.textContent, "group-specific copy");
	for (const hint of [dictationHint, readAloudHint]) {
		for (const scope of ["speech_to_text", "text_to_speech", "voices_read", "models_read"]) assert.ok(hint.textContent!.includes(scope), scope);
		assert.match(hint.textContent!, /broader key/);
		const links = hint.querySelectorAll("a");
		assert.equal(links.length, 1);
		assert.equal(links[0]!.getAttribute("href"), "https://elevenlabs.io/app/settings/api-keys");
	}
	assert.match(dictationHint.textContent!, /dictation/i);
	assert.match(readAloudHint.textContent!, /read aloud/i);
});

test("a deep link to the key id unfolds only the Dictation group's ElevenLabs row", async () => {
	await fixture(ID);
	assert.ok(byTest(`${DICTATION_ROW}-editor`));
	assert.equal(document.querySelector(`[data-testid="${READ_ALOUD_ROW}-editor"]`), null);
});

test("a deep link to the read-aloud target unfolds only the Read aloud group's ElevenLabs row", async () => {
	await fixture(keyRowTarget(ID, "read-aloud"));
	assert.ok(byTest(`${READ_ALOUD_ROW}-editor`));
	assert.equal(document.querySelector(`[data-testid="${DICTATION_ROW}-editor"]`), null);
});

test("clicking one ElevenLabs row unfolds that row alone", async () => {
	await fixture();
	await click(byTest(`${READ_ALOUD_ROW}-row`));
	assert.ok(byTest(`${READ_ALOUD_ROW}-editor`));
	assert.equal(document.querySelector(`[data-testid="${DICTATION_ROW}-editor"]`), null);
});
