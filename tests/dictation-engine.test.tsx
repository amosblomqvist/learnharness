/**
 * Settings → Providers → Dictation: the engine and Groq model pickers, the Groq
 * key row beside Deepgram's, and the engine-specific setup note. Deepgram, the
 * default, must look and behave as before.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DictationEngineSettings, DictationSetupHint } from "../components/dictation-engine.tsx";
import { DictationLanguageSetting } from "../components/dictation-language.tsx";
import { DictationBar, DICTATION_KEYLESS, type Dictation } from "../components/dictation.tsx";
import { GROQ_DICTATION_KEYLESS, GROQ_DICTATION_ROW } from "../components/dictation-groq.ts";
import { LOCAL_DICTATION_NO_MODEL } from "../components/dictation-local.ts";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { KeysSection } from "../components/settings/keys-section.tsx";
import type { AuthKeyStatus, UserSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
Object.assign(dom.document, { oninput: null }); // React only listens for `input` where the document declares support
let focused: Element = dom.document.body;
Object.defineProperty(dom.document, "activeElement", { get: () => focused });
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
Object.assign(dom.window, { lh: { expandWindow() {} } });

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const status = (id: string, present = true, source: AuthKeyStatus["source"] = "file"): AuthKeyStatus => ({
	id, info: null, present, masked: present ? "…wxyz (56 chars)" : null, source: present ? source : "none", shadowedByEnv: false,
});

async function fixture(options: { dictation?: UserSettings["dictation"]; keys?: AuthKeyStatus[]; failWrite?: boolean } = {}) {
	const state = {
		record: { version: 1, ...(options.dictation ? { dictation: options.dictation } : {}) } as UserSettings,
		keys: options.keys ?? [],
		puts: [] as unknown[],
		keyPuts: [] as { id: string; value: string }[],
		failWrite: options.failWrite ?? false,
	};
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: state.record });
		if (url === "/api/settings/dictation") {
			state.puts.push(JSON.parse(init!.body as string));
			if (state.failWrite) return Response.json({}, { status: 500 });
			state.record = { ...state.record, dictation: state.puts.at(-1) as UserSettings["dictation"] };
			return Response.json({ settings: state.record });
		}
		if (url === "/api/keys") return Response.json({ keys: state.keys, providers: [{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" }] });
		if (url.startsWith("/api/keys/") && init?.method === "PUT") {
			const id = decodeURIComponent(url.slice("/api/keys/".length));
			state.keyPuts.push({ id, value: JSON.parse(init.body as string).value });
			state.keys = [...state.keys.filter((k) => k.id !== id), status(id)];
			return Response.json({ ok: true });
		}
		if (url === "/api/claude-code") return Response.json({ state: "not-found", version: null, minimumVersion: "2.1.259" });
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
	// A fresh record per fixture: drop the previous fixture's window-lifetime preference.
	return state;
}

async function mount(element: React.ReactNode) {
	// Loaded here, after the fake DOM globals exist: react-dom probes the document at import time.
	const { createRoot } = await import("react-dom/client");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(element));
	await act(async () => { notifySettingsSaved("dictation"); });
}

afterEach(async () => {
	await act(async () => { setDictationActive(false); root?.unmount(); });
	host?.remove();
	root = host = undefined;
	globalThis.fetch = realFetch;
});

const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const select = (id: string) => byTest(id) as HTMLSelectElement;
async function choose(id: string, value: string) {
	const element = select(id);
	await act(async () => {
		Object.defineProperty(element, "value", { configurable: true, writable: true, value });
		element.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}
const Picker = () => <><DictationEngineSettings /><DictationLanguageSetting /><DictationSetupHint /></>;

test("Deepgram is the default engine and there is no Groq model row", async () => {
	await fixture({ dictation: { language: "pl" } });
	await mount(<Picker />);
	assert.equal(select("select-dictation-engine").value, "deepgram");
	assert.deepEqual([...select("select-dictation-engine").options].map((o) => [o.value, o.textContent]), [["deepgram", "Deepgram"], ["groq", "Groq (Whisper)"], ["local", "Local (on this device)"]]);
	assert.equal(byTest("row-dictation-groq-model"), null);
});

test("choosing Groq saves it with the language, shows the model row (turbo by default) and the Groq note", async () => {
	const f = await fixture({ dictation: { language: "pl" } });
	await mount(<Picker />);
	await choose("select-dictation-engine", "groq");
	assert.deepEqual(f.puts, [{ language: "pl", provider: "groq" }]);
	assert.equal(select("select-dictation-engine").disabled, false);
	assert.equal(select("select-dictation-groq-model").value, "whisper-large-v3-turbo");
	assert.deepEqual([...select("select-dictation-groq-model").options].map((o) => o.value), ["whisper-large-v3-turbo", "whisper-large-v3"]);
	const hint = byTest("dictation-setup-hint")!;
	assert.equal(hint.getAttribute("data-engine"), "groq");
	assert.match(hint.textContent!.replace(/\s+/g, " "), /in short pieces while you talk, through this app's local server to Groq/);
	assert.match(hint.textContent!, /text appears when you stop \(up to 20 minutes at a time\)/);
	assert.match(hint.textContent!, /same one as the Groq model provider/);
	assert.equal(hint.querySelector("a")!.getAttribute("href"), "https://console.groq.com/keys");
});

test("choosing Local saves it, hides the Groq model row and leaves its note to the Local rows", async () => {
	const f = await fixture({ dictation: { language: "pl" } });
	await mount(<Picker />);
	await choose("select-dictation-engine", "local");
	assert.deepEqual(f.puts, [{ language: "pl", provider: "local" }]);
	assert.equal(select("select-dictation-engine").value, "local");
	assert.equal(byTest("row-dictation-groq-model"), null);
	// Local's note sits under the Engine select inside settings/dictation-local.tsx
	// (tests/dictation-local-settings.test.tsx), so the shared hint renders nothing.
	assert.equal(byTest("dictation-setup-hint"), null);
});

test("choosing a model keeps the engine and language, and a later language change keeps both", async () => {
	const f = await fixture({ dictation: { language: "en", provider: "groq" } });
	await mount(<Picker />);
	assert.ok(byTest("row-dictation-groq-model"));
	await choose("select-dictation-groq-model", "whisper-large-v3");
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "groq", groqModel: "whisper-large-v3" });
	await act(async () => { byTest("dictation-language")!.click(); });
	await act(async () => { byTest("dictation-language-fr")!.click(); });
	assert.deepEqual(f.puts.at(-1), { language: "fr", provider: "groq", groqModel: "whisper-large-v3" });
});

test("switching back to Deepgram writes the old shape and hides the model row", async () => {
	const f = await fixture({ dictation: { language: "pl", provider: "groq" } });
	await mount(<Picker />);
	await choose("select-dictation-engine", "deepgram");
	assert.deepEqual(f.puts, [{ language: "pl" }]);
	assert.equal(byTest("row-dictation-groq-model"), null);
});

test("both selects lock while a dictation run is live", async () => {
	await fixture({ dictation: { language: "pl", provider: "groq" } });
	await mount(<Picker />);
	assert.equal(select("select-dictation-engine").disabled, false);
	await act(async () => { setDictationActive(true); });
	assert.equal(select("select-dictation-engine").disabled, true);
	assert.equal(select("select-dictation-groq-model").disabled, true);
	assert.match(byTest("row-dictation-engine")!.className, /opacity-40/);
});

test("a failed save keeps the previous engine and says so", async () => {
	const f = await fixture({ dictation: { language: "pl" }, failWrite: true });
	await mount(<Picker />);
	await choose("select-dictation-engine", "groq");
	// (React restores a controlled select's DOM value after the handler; this fake DOM does not.)
	assert.equal(byTest("row-dictation-groq-model"), null, "the confirmed engine is still Deepgram");
	assert.equal(byTest("dictation-setup-hint")!.getAttribute("data-engine"), null);
	assert.match(byTest("dictation-engine-error")!.textContent!, /Could not save dictation engine/);
	f.failWrite = false;
	await choose("select-dictation-engine", "groq");
	assert.equal(select("select-dictation-engine").value, "groq");
	assert.equal(byTest("dictation-engine-error"), null);
});

async function mountKeys(initialRow?: string) {
	await mount(<KeysSection initialRow={initialRow} />);
	// Let the keys fetch land.
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("the Groq key row in the Dictation group starts unset and links to the Groq console", async () => {
	await fixture({ dictation: { language: "en" } });
	await mountKeys();
	assert.equal(byTest("key-dictation-groq-status")!.textContent, "not set");
	assert.equal(byTest("key-dictation-groq")!.querySelector("a")!.getAttribute("href"), "https://console.groq.com/keys");
});

test("the Groq row shows whether the existing GROQ_API_KEY is set, and the same key still appears under Model API keys", async () => {
	await fixture({ keys: [status("GROQ_API_KEY")] });
	await mountKeys();
	assert.equal(byTest("key-dictation-groq-status")!.textContent, "…wxyz · 56");
	assert.ok(byTest("key-groq_api_key")!.closest('[data-testid="group-provider-keys"]'), "the model-provider row is unchanged");
	assert.ok(byTest("key-dictation-groq")!.closest('[data-testid="group-dictation"]'));
	assert.equal(byTest("key-deepgram_api_key-status")!.textContent, "not set", "Deepgram's own row is independent");
});

test("the keyless deep link unfolds only the Dictation group's Groq row and saves the shared key", async () => {
	const f = await fixture({ keys: [status("GROQ_API_KEY", false)] });
	await mountKeys(GROQ_DICTATION_ROW);
	const input = byTest("key-dictation-groq-input") as HTMLInputElement;
	assert.ok(input, "the Groq dictation editor is open");
	assert.equal(byTest("key-deepgram_api_key-input"), null);
	assert.equal(byTest("key-dictation-groq-delete"), null, "no Delete: it would remove the Groq model key too");
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "gsk_test_0123456789abcdefghij");
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
	await act(async () => { byTest("key-dictation-groq-save")!.click(); });
	assert.deepEqual(f.keyPuts, [{ id: "GROQ_API_KEY", value: "gsk_test_0123456789abcdefghij" }]);
	assert.equal(byTest("key-dictation-groq-input"), null, "the editor folds after saving");
	assert.equal(byTest("key-dictation-groq-status")!.textContent, "…wxyz · 56");
});

test("the Deepgram deep link still opens the Deepgram row, not Groq's", async () => {
	await fixture({ keys: [status("GROQ_API_KEY")] });
	await mountKeys("DEEPGRAM_API_KEY");
	assert.ok(byTest("key-deepgram_api_key-input"));
	assert.equal(byTest("key-dictation-groq-input"), null);
	assert.equal(byTest("key-groq_api_key-input"), null);
});

test("opening a present Groq key from Model API keys does not also open the dictation row", async () => {
	await fixture({ keys: [status("GROQ_API_KEY")] });
	await mountKeys("GROQ_API_KEY");
	assert.ok(byTest("key-groq_api_key-input"), "the provider row opens");
	assert.equal(byTest("key-dictation-groq-input"), null);
});

const idleWithError = (error: string): Dictation => ({
	phase: "idle", error, notice: null, levelRef: { current: 0 }, active: false, transcribing: false,
	retryable: false, retry() {}, toggle() {}, stop() {}, finish: async () => true, cancel() {}, clearError() {},
});

for (const [name, error, row, other] of [
	["Groq", GROQ_DICTATION_KEYLESS, "key-dictation-groq-input", "key-deepgram_api_key-input"],
	["Deepgram", DICTATION_KEYLESS, "key-deepgram_api_key-input", "key-dictation-groq-input"],
] as const) {
	test(`the ${name} keyless button deep-links Settings to that engine's key row`, async () => {
		await fixture({ keys: [status("GROQ_API_KEY", false)] });
		await mount(<SettingsDialogProvider><DictationBar dictation={idleWithError(error)} /></SettingsDialogProvider>);
		assert.equal(byTest(row), null, "closed before the click");
		await act(async () => { byTest("dictation-toggle")!.click(); });
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.ok(byTest(row), `${name}'s editor is open`);
		assert.equal(byTest(other), null);
	});
}

test("the Local no-model button opens Settings on the Dictation group, with no key row unfolded", async () => {
	await fixture({ keys: [status("GROQ_API_KEY", false)] });
	await mount(<SettingsDialogProvider><DictationBar dictation={idleWithError(LOCAL_DICTATION_NO_MODEL)} /></SettingsDialogProvider>);
	assert.equal(byTest("group-dictation"), null, "Settings is closed before the click");
	await act(async () => { byTest("dictation-toggle")!.click(); });
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	assert.ok(byTest("group-dictation"), "the Dictation group is on screen");
	assert.equal(byTest("key-dictation-groq-input"), null);
	assert.equal(byTest("key-deepgram_api_key-input"), null);
});

test("the Dictation rows fit a narrow dialog and the selects show keyboard focus", async () => {
	await fixture({ dictation: { language: "en", provider: "groq" } });
	await mount(<Picker />);
	// A control that does not fit beside its label drops to its own line, not under it.
	for (const id of ["row-dictation-engine", "row-dictation-groq-model", "row-dictation-language"]) {
		assert.match(byTest(id)!.getAttribute("class")!, /\bflex-wrap\b/, id);
	}
	// A long option label shortens the select instead of overflowing its row.
	for (const id of ["select-dictation-engine", "select-dictation-groq-model"]) {
		const classes = select(id).getAttribute("class")!;
		assert.match(classes, /\bmin-w-0\b/, id);
		assert.match(classes, /\bmax-w-full\b/, id);
		// The app removes every browser outline, so focus has to be drawn by the control.
		assert.match(classes, /focus-visible:ring-1/, id);
		assert.match(classes, /focus-visible:ring-ring/, id);
		assert.match(classes, /focus-visible:border-ring/, id);
	}
});
