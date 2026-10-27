import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { AUTH_KEYS, DICTATION_LANGUAGES, type AuthKeyStatus, type ModelCatalogEntry, type UserSettings } from "../src/core/index.ts";
import { ModelMenuList } from "../components/settings/model-menu.tsx";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const trigger = () => byTest("dictation-language");
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Search dictation languages"]')!;
const menu = () => document.querySelector('[data-testid="dictation-language-menu"]');
const click = async (element: HTMLElement) => { assert(element); await act(async () => { element.click(); }); };
async function key(element: HTMLElement, value: string) {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: value });
		element.dispatchEvent(event);
	});
}
async function search(value: string, element = input()) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function fixture(failRead = false) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.scrollIntoView = () => {};
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
	const state = {
		record: { version: 1, dictation: { language: "en" } } as UserSettings,
		writes: [] as string[], failWrite: false, outerEscapes: 0,
		failRead,
		keys: [] as AuthKeyStatus[],
		nextWrite: undefined as Promise<Response> | undefined,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/keys") return Response.json({ keys: state.keys, providers: [] });
			if (url === "/api/settings") return state.failRead ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.writes.push(body.language);
			if (state.nextWrite) { const next = state.nextWrite; state.nextWrite = undefined; return next; }
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
	// Register the outer dialog listener first: one Escape must close only
	// the language menu, even when the settings dialog owns another listener.
	doc.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") state.outerEscapes++; });
	const { createRoot } = await import("react-dom/client");
	const { DictationLanguageSetting } = await import("../components/dictation-language.tsx");
	let root = createRoot(doc.getElementById("root")!);
	const mount = async () => { await act(async () => { root.render(<DictationLanguageSetting />); }); };
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	await mount();
	// Fixtures represent distinct server records; remounts within a fixture
	// deliberately keep the window-lifetime confirmed preference.
	await act(async () => { notifySettingsSaved("dictation"); });
	return {
		state,
		render: async (element: React.ReactNode) => { await act(async () => { root.render(element); }); },
		remount: async () => { await dispose!(); root = createRoot(doc.getElementById("root")!); await mount(); },
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("an initial load failure is visible and opening the menu again can retry", async () => {
	const f = await fixture(true);
	await click(trigger());
	assert.match(menu()!.querySelector('[role="alert"]')!.textContent!, /Could not load/);
	f.state.failRead = false;
	await click(trigger());
	await click(trigger());
	assert.equal(menu()!.querySelector('[role="alert"]'), null);
	await search("Polish");
	await key(input(), "Enter");
	assert.match(trigger().textContent!, /Polish/);
});

test("the real picker searches by language, chooses with Arrow/Enter, and restores focus", async () => {
	const f = await fixture();
	assert.match(trigger().textContent!, /English/);
	for (const token of ["h-7", "rounded-sm", "border-border", "bg-background", "font-ui", "text-xs"]) {
		assert.ok(trigger().className.split(" ").includes(token), `shared settings trigger: ${token}`);
	}
	await click(trigger());
	assert.match(input().className, /lh-input/);
	assert.equal(document.activeElement, input());
	assert.equal(document.querySelector('[data-testid="dictation-language-list"] button')!.textContent, "Multilingual");
	await search("Polish");
	assert.equal(document.querySelectorAll('[data-testid="dictation-language-list"] button').length, 1);
	await key(input(), "ArrowDown");
	await key(input(), "Enter");
	assert.deepEqual(f.state.writes, ["pl"]);
	assert.match(trigger().textContent!, /Polish/);
	assert.equal(menu(), null);
	assert.equal(document.activeElement, trigger());
	await f.remount();
	assert.match(trigger().textContent!, /Polish/);
});

test("Enter on a focused option preserves native button activation", async () => {
	const f = await fixture();
	await click(trigger());
	const option = byTest("dictation-language-multi");
	option.focus();
	let prevented = false;
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Enter" });
		option.dispatchEvent(event);
		prevented = event.defaultPrevented;
		// linkedom does not implement native keyboard activation. Follow the
		// browser's default action only if the handler left it uncancelled.
		if (!prevented) option.click();
	});
	assert.equal(prevented, false, "focused option Enter must retain its native click");
	assert.deepEqual(f.state.writes, ["multi"]);
	assert.equal(menu(), null);
	assert.match(trigger().textContent!, /Multilingual/);
});

test("empty results cannot save; Escape and outside click close the menu without closing settings", async () => {
	const f = await fixture();
	await click(trigger());
	await search("zzzz-no-language");
	assert.match(menu()!.textContent!, /No languages match/);
	await key(input(), "Enter");
	assert.deepEqual(f.state.writes, []);
	await key(input(), "Escape");
	assert.equal(menu(), null);
	assert.equal(f.state.outerEscapes, 0);
	await click(trigger());
	await key(trigger(), "Escape");
	assert.equal(menu(), null);
	assert.equal(f.state.outerEscapes, 0);
	await click(trigger());
	await act(async () => { document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
	assert.equal(menu(), null);
});

test("failed saves retain the confirmed choice and the same menu can retry", async () => {
	const f = await fixture();
	f.state.failWrite = true;
	await click(trigger());
	await search("Polish");
	await key(input(), "Enter");
	assert.match(trigger().textContent!, /English/);
	assert.match(menu()!.querySelector('[role="alert"]')!.textContent!, /Could not save/);
	f.state.failWrite = false;
	await click(byTest("dictation-language-pl"));
	assert.equal(menu(), null);
	assert.match(trigger().textContent!, /Polish/);
	assert.deepEqual(f.state.writes, ["pl", "pl"]);
});

test("a remounted picker stays disabled throughout an outstanding save", async () => {
	const f = await fixture();
	let complete!: (response: Response) => void;
	f.state.nextWrite = new Promise((resolve) => { complete = resolve; });
	await click(trigger());
	await click(byTest("dictation-language-multi"));
	assert.equal(trigger().disabled, true);
	await f.remount();
	assert.equal(trigger().disabled, true);
	await click(trigger());
	assert.equal(menu(), null);
	f.state.record.dictation = { language: "multi" };
	await act(async () => { complete(Response.json({ settings: f.state.record })); });
	assert.equal(trigger().disabled, false);
	assert.match(trigger().textContent!, /Multilingual/);
	assert.deepEqual(f.state.writes, ["multi"]);
});

test("capture locks the row and dismisses an open language menu until capture ends", async () => {
	await fixture();
	await click(trigger());
	await act(async () => { setDictationActive(true); });
	assert.equal(trigger().disabled, true);
	assert.match(byTest("row-dictation-language").className, /opacity-40/);
	assert.equal(menu(), null);
	await act(async () => { setDictationActive(false); });
	assert.equal(trigger().disabled, false);
	await click(trigger());
	assert(menu());
});

for (const source of ["none", "file", "env"] as const) test(`Language is below the full key row for ${source}-owned keys, including editing`, async () => {
	const f = await fixture();
	f.state.keys = [{
		id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!,
		present: source !== "none", masked: source === "none" ? null : "…test (32 chars)",
		source, shadowedByEnv: false,
	}];
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	const group = byTest("group-dictation");
	const rows = group.lastElementChild!.children;
	assert.equal(rows[0]!.getAttribute("data-testid"), "key-deepgram_api_key");
	assert.equal(rows[1]!.getAttribute("data-testid"), "row-dictation-language");
	assert.equal(rows[2]!.getAttribute("data-testid"), "dictation-setup-hint");
	assert.equal(byTest("dictation-setup-hint").textContent, "Create a Deepgram API key with the Member role or higher, then add it above.");
	assert.match(byTest("dictation-setup-hint").className, /text-muted-foreground/);
	assert.equal(byTest("dictation-setup-hint").querySelector("a")!.href, "https://console.deepgram.com/");
	assert.equal(byTest("dictation-setup-hint").querySelector("a")!.textContent, "Deepgram API key");
	assert.equal(byTest("dictation-setup-hint").querySelectorAll("a").length, 1);
	assert.match(rows[1]!.querySelector(".font-prose")!.className, /text-\(length:--lh-prose-size\)/);
	assert.equal(trigger().disabled, false, "language is independent of key ownership");
	await click(byTest("key-deepgram_api_key-row"));
	if (source !== "env") assert.ok(byTest("key-deepgram_api_key-editor"));
	assert.ok(byTest("dictation-setup-hint"), "guidance remains visible while the key is edited");
	await click(trigger());
	assert(menu());
	await key(input(), "Escape");
	assert.equal(menu(), null);
	assert.equal(f.state.outerEscapes, 0);
	if (source !== "env") assert.ok(byTest("key-deepgram_api_key-editor"), "first Escape closes only the menu");
});

test("the shared model menu preserves ranking, provider identity, keyboard clamping, and row content", async () => {
	const f = await fixture();
	const model = (id: string, provider: string): ModelCatalogEntry => ({
		id, provider, name: `Model ${id}`, contextWindow: 32000, maxTokens: 4096,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		input: ["text"], reasoning: false, supportedLevels: [],
	});
	const models = [model("beta", "p1"), model("alpha", "p1"), model("alpha", "p2")];
	const picked: ModelCatalogEntry[] = [];
	await f.render(<ModelMenuList models={models} effectiveId="alpha" effectiveProvider="p2" onPick={(m) => picked.push(m)} footer="Model footer" />);
	const modelInput = document.querySelector<HTMLInputElement>('[data-testid="model-search"]')!;
	const options = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="model-list"] button')];
	assert.equal(document.activeElement, modelInput);
	assert.match(options()[0]!.textContent!, /p1 · alpha/);
	assert.match(options()[1]!.textContent!, /p2 · alpha/);
	assert.ok(!options()[0]!.className.includes("bg-muted/60"));
	assert.ok(options()[1]!.className.includes("bg-muted/60"));
	assert.match(options()[0]!.textContent!, /\$1\.00\/\$2\.00/);
	assert.match(options()[0]!.textContent!, /32k/);
	assert.match(document.body.textContent!, /Model footer/);
	await key(modelInput, "Enter");
	assert.equal(picked[0], models[1], "Enter without walking selects the first ranked result");
	await key(modelInput, "ArrowUp");
	await key(modelInput, "Enter");
	assert.equal(picked[1], models[0], "ArrowUp enters at the last result");
	await key(modelInput, "ArrowDown");
	await key(modelInput, "ArrowDown");
	await key(modelInput, "Enter");
	assert.equal(picked[2], models[0], "ArrowDown clamps at the last result");
	await search("p2", modelInput);
	assert.equal(options().length, 1);
	await key(modelInput, "Enter");
	assert.equal(picked[3], models[2], "search resets the walked index and includes provider identity");
	await search("no-model-matches", modelInput);
	await key(modelInput, "Enter");
	assert.equal(picked.length, 4);
	assert.match(document.body.textContent!, /No models match/);
});

test("clearing each search restores the complete catalog order with Multilingual first", async () => {
	await fixture();
	await click(trigger());
	const order = () => [...document.querySelectorAll('[data-testid="dictation-language-list"] button')].map((item) => item.getAttribute("data-testid")!.replace("dictation-language-", ""));
	const expected = DICTATION_LANGUAGES.map((item) => item.code);
	assert.deepEqual(order(), expected);
	for (const query of ["en", "multi", "Polish", "zzzzz"]) {
		await search(query);
		await search("");
		assert.deepEqual(order(), expected, `catalog order after clearing ${query}`);
	}
});
