import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { DICTATION_PROVIDER_ROW_ID, setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { UserSettings } from "../src/core/index.ts";

type Status = { state: "missing"; error?: string } | { state: "downloading"; receivedBytes: number; totalBytes: number } | { state: "ready"; diskBytes: number };

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const click = async (element: HTMLElement) => { assert(element); await act(async () => { element.click(); }); };
const settle = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function fixture(record: UserSettings, model: Status, initialRow?: string) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.scrollIntoView = () => {};
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
	const scrolls: { id: string | null; arg: unknown }[] = [];
	win.HTMLElement.prototype.scrollIntoView = function (arg?: unknown) { scrolls.push({ id: this.getAttribute("data-testid"), arg }); };
	const state = { scrolls, record, model, puts: [] as unknown[], modelCalls: [] as string[] };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/keys") return Response.json({ keys: [], providers: [] });
			if (url === "/api/claude-code") return Response.json({ state: "not-found", version: null, minimumVersion: "2.1.259" });
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/stt/parakeet") {
				const method = init?.method ?? "GET";
				state.modelCalls.push(method);
				if (method === "POST") state.model = { state: "downloading", receivedBytes: 0, totalBytes: 487_000_000 };
				if (method === "DELETE") state.model = { state: "missing" };
				return Response.json(state.model);
			}
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.puts.push(body);
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
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	await act(async () => { root.render(<KeysSection initialRow={initialRow} />); });
	await act(async () => { notifySettingsSaved("dictation"); });
	await settle(); await settle();
	return state;
}

const parakeet: UserSettings = { version: 1, dictation: { language: "pl", provider: "parakeet" } };
const rowIds = () => [...byTest("group-dictation").lastElementChild!.children].map((el) => el.getAttribute("data-testid"));

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("Deepgram keeps today's group: key, Provider, Language, the unchanged setup hint, no model traffic", async () => {
	const state = await fixture({ version: 1, dictation: { language: "en" } }, { state: "missing" });
	assert.deepEqual(rowIds(), ["key-deepgram_api_key", "row-dictation-provider", "row-dictation-language", "dictation-setup-hint"]);
	assert.equal(byTest("dictation-provider").textContent, "Deepgram▾");
	assert.match(byTest("dictation-setup-hint").textContent!, /Deepgram API key/);
	assert.equal(byTest("dictation-parakeet-note"), null);
	assert.doesNotMatch(byTest("row-dictation-language").className, /opacity-40/);
	assert.deepEqual(state.modelCalls, []);
});

test("Parakeet, model missing: dimmed Auto-detect language, Download row, and the local-audio note", async () => {
	await fixture(parakeet, { state: "missing" });
	assert.deepEqual(rowIds(), ["key-deepgram_api_key", "row-dictation-provider", "row-dictation-language", "row-dictation-model", "dictation-parakeet-note"]);
	assert.equal(byTest("dictation-provider").textContent, "Parakeet (local)▾");
	assert.match(byTest("row-dictation-language").className, /opacity-40/);
	assert.equal(byTest("dictation-language").textContent, "Auto-detect▾");
	assert.equal(byTest("dictation-language").disabled, true);
	await click(byTest("dictation-language"));
	assert.equal(document.querySelector('[data-testid="dictation-language-menu"]'), null);
	assert.match(byTest("row-dictation-model").textContent!, /Parakeet TDT 0\.6B v3 · int8 · 487 MB download/);
	assert.equal(byTest("dictation-model-action").textContent, "Download");
	assert.equal(byTest("dictation-setup-hint"), null);
	assert.equal(byTest("dictation-parakeet-note").textContent, "Audio stays on this computer. Text appears when you stop dictating (Ctrl+D).");
});

test("a failed download shows its error in the hint, and Download starts it with a progress bar", async () => {
	const state = await fixture(parakeet, { state: "missing", error: "Download failed: disk full" });
	assert.match(byTest("row-dictation-model").textContent!, /Download failed: disk full/);
	await click(byTest("dictation-model-action"));
	assert.deepEqual(state.modelCalls.filter((m) => m !== "GET"), ["POST"]);
	assert.equal(byTest("dictation-model-action").textContent, "Cancel");
	assert.match(byTest("row-dictation-model").textContent!, /Downloading… 0 \/ 487 MB/);
});

test("downloading shows real decimal MB, a progressbar, a Cancel that DELETEs, and polls about every 500 ms", async () => {
	const state = await fixture(parakeet, { state: "downloading", receivedBytes: 205_400_000, totalBytes: 487_000_000 });
	assert.match(byTest("row-dictation-model").textContent!, /Downloading… 205 \/ 487 MB/);
	const bar = document.querySelector('[role="progressbar"]')!;
	assert.equal(bar.getAttribute("aria-label"), "Model download");
	assert.equal(bar.getAttribute("aria-valuenow"), "42");
	assert.equal(bar.getAttribute("aria-valuemin"), "0");
	assert.equal(bar.getAttribute("aria-valuemax"), "100");
	const before = state.modelCalls.length;
	state.model = { state: "downloading", receivedBytes: 300_000_000, totalBytes: 487_000_000 };
	await settle(1100);
	assert.ok(state.modelCalls.length >= before + 2, `polled: ${state.modelCalls.length - before}`);
	assert.match(byTest("row-dictation-model").textContent!, /Downloading… 300 \/ 487 MB/);
	await click(byTest("dictation-model-action"));
	assert.equal(state.modelCalls.at(-1), "DELETE");
	assert.equal(document.querySelector('[role="progressbar"]'), null);
	assert.equal(byTest("dictation-model-action").textContent, "Download");
});

test("ready shows disk usage with Remove, does not poll, and Remove DELETEs", async () => {
	const state = await fixture(parakeet, { state: "ready", diskBytes: 670_300_000 });
	assert.match(byTest("row-dictation-model").textContent!, /Ready · 670 MB on disk/);
	assert.equal(document.querySelector('[role="progressbar"]'), null);
	const before = state.modelCalls.length;
	await settle(700);
	assert.equal(state.modelCalls.length, before, "no polling outside a download");
	await click(byTest("dictation-model-action"));
	assert.equal(state.modelCalls.at(-1), "DELETE");
	assert.equal(byTest("dictation-model-action").textContent, "Download");
});

test("choosing Parakeet saves the provider together with the stored language", async () => {
	const state = await fixture({ version: 1, dictation: { language: "pl" } }, { state: "missing" });
	await click(byTest("dictation-provider"));
	assert.ok(byTest("dictation-provider-menu"));
	await click(byTest("dictation-provider-parakeet"));
	assert.deepEqual(state.puts, [{ language: "pl", provider: "parakeet" }]);
	assert.equal(byTest("dictation-provider-menu"), null);
	await settle();
	assert.ok(byTest("row-dictation-model"));
	assert.match(byTest("row-dictation-language").className, /opacity-40/);
});

test("provider and language controls lock while a dictation run is active", async () => {
	await fixture(parakeet, { state: "ready", diskBytes: 670_000_000 });
	await act(async () => { setDictationActive(true); });
	assert.equal(byTest("dictation-provider").disabled, true);
	assert.equal(byTest("dictation-language").disabled, true);
	assert.equal(byTest("dictation-model-action").disabled, true);
	await act(async () => { setDictationActive(false); });
	assert.equal(byTest("dictation-provider").disabled, false);
});

test("the missing-model deep link scrolls the Dictation group into view without unfolding a key row", async () => {
	const state = await fixture(parakeet, { state: "missing" }, DICTATION_PROVIDER_ROW_ID);
	const group = state.scrolls.filter((s) => s.id === "group-dictation");
	assert.equal(group.length, 1);
	assert.deepEqual(group[0]!.arg, { block: "start" });
	assert.equal(document.querySelectorAll('[aria-expanded="true"]').length, 0);
});

test("the Deepgram key deep link still unfolds its row and does not scroll the Dictation group", async () => {
	const state = await fixture({ version: 1, dictation: { language: "en" } }, { state: "missing" }, "DEEPGRAM_API_KEY");
	assert.equal(state.scrolls.some((s) => s.id === "group-dictation"), false);
	assert.ok(document.querySelector('[data-testid="group-dictation"] [aria-expanded="true"], [data-testid="group-dictation"] input'));
});

test("opening Settings Keys without a row scrolls nothing", async () => {
	const state = await fixture(parakeet, { state: "missing" });
	assert.deepEqual(state.scrolls, []);
});
