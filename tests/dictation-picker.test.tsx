import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { AUTH_KEYS, DICTATION_LANGUAGES, localDictationEndpoint, type AuthKeyStatus, type ModelCatalogEntry, type UserSettings } from "../src/core/index.ts";
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
		credential: undefined as { url: string; key: string } | undefined,
		credentialWrites: 0,
		connectionCalls: [] as unknown[],
		connectionResult: { status: "ready" } as { status?: string; error?: string },
		connectionStatus: 200,
		nextConnection: undefined as Promise<Response> | undefined,
		failKeyWrite: false,
		failDelete: false,
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
			if (url === "/api/stt/test") {
				assert.equal(init?.method, "POST");
				state.connectionCalls.push(JSON.parse(init.body as string));
				return state.nextConnection ?? Response.json(state.connectionResult, { status: state.connectionStatus });
			}
			if (url === "/api/stt/local") {
				assert.equal(init?.method, "DELETE");
				if (state.failDelete) return Response.json({ error: "delete failed" }, { status: 500 });
				const { local: _local, ...dictation } = state.record.dictation!;
				state.record = { ...state.record, dictation };
				state.credential = undefined;
				return Response.json({ settings: state.record });
			}
			if (url === "/api/stt/credentials") {
				if (init?.method === "PUT") {
					const { server, url, key } = JSON.parse(init.body as string);
					state.credential = { url: localDictationEndpoint({ server, url }), key };
					state.credentialWrites++;
					return Response.json({ ok: true });
				}
				return Response.json({ keyPresent: Boolean(state.credential?.key && state.record.dictation?.local && state.credential.url === localDictationEndpoint(state.record.dictation.local)) });
			}
			if (url === "/api/custom-provider") return Response.json({ baseUrl: "" });
			if (url === "/api/keys/DEEPGRAM_API_KEY") {
				if (state.failKeyWrite) return Response.json({ error: "Key save failed" }, { status: 500 });
				state.keys = init?.method === "DELETE" ? [] : [{ id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!, present: true, masked: "…test (32 chars)", source: "file", shadowedByEnv: false }];
				return Response.json({ ok: true });
			}
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

for (const source of ["none", "file", "env"] as const) test(`Deepgram editor preserves language controls for ${source}-owned keys`, async () => {
	const f = await fixture();
	f.state.keys = [{
		id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!,
		present: source !== "none", masked: source === "none" ? null : "…test (32 chars)", source, shadowedByEnv: false,
	}];
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	if (source === "none") await addDictationProvider("deepgram");
	else await click(byTest("dictation-deepgram-row"));
	const editor = byTest("dictation-deepgram-editor");
	assert.equal(editor.children[0]!.getAttribute("data-testid"), "key-deepgram_api_key");
	assert.equal(editor.children[1]!.getAttribute("data-testid"), "dictation-setup-hint");
	assert.equal(editor.children[2]!.getAttribute("data-testid"), "row-dictation-language");
	assert(byTest("row-dictation-language").classList.contains("justify-start"));
	assert.equal(byTest("dictation-setup-hint").querySelector("a")!.href, "https://console.deepgram.com/");
	assert.equal(trigger().disabled, false);
	if (source === "env") assert.equal(document.querySelector('[data-testid="key-deepgram_api_key-input"]'), null);
	else assert(byTest("key-deepgram_api_key-editor"));
	await click(trigger()); assert(menu());
	await key(input(), "Escape");
	assert.equal(menu(), null); assert.equal(f.state.outerEscapes, 0);
	assert(byTest("dictation-deepgram-editor"), "first Escape closes only the language menu");
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


async function selectValue(label: string, value: string) {
	const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
	assert(select);
	await act(async () => {
		const options = [...select.querySelectorAll("option")];
		for (const option of options) option.selected = false;
		options.find((option) => option.value === value)!.selected = true;
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}
const localInput = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const settingsButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;

test("local settings collapse after saving and reopen confirmed values, including after remount", async () => {
	const f = await fixture();
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("local");
	await selectValue("Local dictation server", "whisper.cpp");
	await search("http://localhost:8081", localInput("Base URL"));
	await chooseLocalLanguage("French");
	await search("whisper-large", localInput("Dictation model ID"));
	await search("secret-key", localInput("Local dictation bearer key"));
	assert.equal(byTest("dictation-local-save").textContent, "Connect");
	await click(byTest("dictation-local-save"));
	assert(![...document.querySelectorAll('[role="status"]')].some((element) => element.textContent === "Saved"));
	assert.deepEqual(f.state.record.dictation, {
		language: "multi", local: { server: "whisper.cpp", url: "http://localhost:8081/", model: "whisper-large", language: "fr" },
	});
	assert.deepEqual(f.state.credential, { url: "http://localhost:8081/inference", key: "secret-key" });
	assert.equal(document.querySelector('[data-testid="dictation-settings-editor"]'), null);
	assert.equal(byTest("dictation-local-row").getAttribute("aria-expanded"), "false");
	assert.equal(byTest("dictation-local-status").textContent, "whisper.cpp · http://localhost:8081 · whisper-large · French · API key");
	assert(!byTest("dictation-local-status").textContent!.includes("secret-key"));
	await click(byTest("dictation-local-row"));
	assert.equal(byTest("dictation-local-row").getAttribute("aria-expanded"), "true");
	assert.equal(localInput("Local dictation bearer key").value, "");
	assert.equal(localInput("Local dictation bearer key").placeholder, "Key saved for this endpoint");
	await f.render(<div />);
	await f.render(<KeysSection />);
	assert.equal(document.querySelector('[data-testid="dictation-settings-editor"]'), null);
	assert.equal(byTest("dictation-local-row").getAttribute("aria-expanded"), "false");
	await click(byTest("dictation-local-row"));
	assert.equal(localInput("Base URL").value, "http://localhost:8081");
	assert.equal(localInput("Dictation model ID").value, "whisper-large");
	assert.match(byTest("local-dictation-language").textContent!, /French/);
	await click(settingsButton("Remove key"));
	assert.equal(f.state.credential?.key, "");
	assert.equal(localInput("Local dictation bearer key").placeholder, "Keyless");
});

test("local settings reject invalid URLs, lock during dictation, and keep drafts after failed saves", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("local");
	await search("file:///tmp/audio", localInput("Base URL"));
	await click(byTest("dictation-local-save"));
	assert.match(document.querySelector('[role="alert"]')!.textContent!, /HTTP/);
	assert.equal(f.state.writes.length, 0);
	await search("http://localhost:8080", localInput("Base URL"));
	await search("lfm3", localInput("Dictation model ID"));
	f.state.failWrite = true;
	await click(byTest("dictation-local-save"));
	assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not save/);
	assert.equal(localInput("Dictation model ID").value, "lfm3");
	await act(async () => { setDictationActive(true); });
	assert(byTest("dictation-local-save").disabled);
	assert(document.querySelector("fieldset")!.hasAttribute("disabled"));
	await act(async () => { setDictationActive(false); });
	f.state.failWrite = false;
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.local?.model, "lfm3");
	assert.equal(f.state.record.dictation?.local?.language, "auto");
});

test("legacy endpoint settings reopen as a base URL and retain their saved key on save", async () => {
	const f = await fixture();
	const local = { server: "llama.cpp" as const, url: "http://localhost:8080/speech/v1/audio/transcriptions", language: "auto" };
	f.state.record.dictation = { provider: "local", local };
	f.state.credential = { url: local.url, key: "legacy-key" };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await click(byTest("dictation-local-row"));
	assert.equal(localInput("Base URL").value, "http://localhost:8080/speech");
	assert.equal(localInput("Local dictation bearer key").placeholder, "Key saved for this endpoint");
	await selectValue("Local dictation server", "whisper.cpp");
	assert.equal(localInput("Local dictation bearer key").placeholder, "Keyless");
	await selectValue("Local dictation server", "llama.cpp");
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.local?.url, "http://localhost:8080/speech");
	assert.deepEqual(f.state.credential, { url: local.url, key: "legacy-key" });
	assert.equal(f.state.credentialWrites, 0);
	assert.match(byTest("dictation-local-status").textContent!, /API key/);
});

test("Test connection uses draft settings and reports ready, loading and failures without saving", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("local");
	assert(byTest("dictation-local-test").disabled);
	await selectValue("Local dictation server", "whisper.cpp");
	await search("http://localhost:9999/proxy", localInput("Base URL"));
	await search("draft-key", localInput("Local dictation bearer key"));
	const original = structuredClone(f.state.record);
	await click(byTest("dictation-local-test"));
	assert.deepEqual(f.state.connectionCalls, [{ server: "whisper.cpp", url: "http://localhost:9999/proxy", key: "draft-key" }]);
	assert.equal(byTest("dictation-local-connection").textContent, "Ready");
	assert.equal(byTest("dictation-local-connection").getAttribute("role"), "status");
	assert(byTest("dictation-local-connection").classList.contains("text-green-500"));
	assert.equal(byTest("dictation-local-test").nextElementSibling, byTest("dictation-local-connection"));
	await search("http://localhost:8888", localInput("Base URL"));
	assert.equal(document.querySelector('[data-testid="dictation-local-connection"]'), null);
	f.state.connectionResult = { status: "loading" };
	await click(byTest("dictation-local-test"));
	assert.equal(byTest("dictation-local-connection").textContent, "Model loading");
	assert(byTest("dictation-local-connection").classList.contains("text-amber-500"));
	f.state.connectionStatus = 502;
	f.state.connectionResult = { error: "Could not connect to the server. Check the base URL and port." };
	await click(byTest("dictation-local-test"));
	assert.match(byTest("dictation-local-connection").textContent!, /base URL and port/);
	assert.equal(byTest("dictation-local-connection").getAttribute("role"), "alert");
	assert(byTest("dictation-local-connection").classList.contains("text-destructive"));
	assert.deepEqual(f.state.record, original);
	assert.equal(f.state.credentialWrites, 0);
	assert.equal(f.state.writes.length, 0);
	assert(byTest("dictation-settings-editor"));
});

test("connection testing shows progress and disables duplicate actions and capture-time checks", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("local");
	await search("http://localhost:8080", localInput("Base URL"));
	let finish!: (response: Response) => void;
	f.state.nextConnection = new Promise((resolve) => { finish = resolve; });
	await click(byTest("dictation-local-test"));
	assert.equal(byTest("dictation-local-test").textContent, "Testing…");
	assert(byTest("dictation-local-test").disabled);
	assert(byTest("dictation-local-save").disabled);
	await act(async () => { finish(Response.json({ status: "ready" })); });
	assert.equal(byTest("dictation-local-test").textContent, "Test connection");
	assert(!byTest("dictation-local-test").disabled);
	await act(async () => { setDictationActive(true); });
	assert(byTest("dictation-local-test").disabled);
});


test("saved local summary keeps confirmed values while editing and failed saves stay open", async () => {
	const f = await fixture();
	f.state.record.dictation = { language: "en", provider: "local", local: { server: "llama.cpp", url: "http://localhost:8080/v1/audio/transcriptions", model: "lfm3", language: "auto" } };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	assert.equal(document.querySelector('[data-testid="dictation-settings-editor"]'), null);
	assert.match(byTest("dictation-local-status").textContent!, /llama.cpp.*lfm3.*Auto-detect.*keyless/);
	await act(async () => { setDictationActive(true); });
	assert(byTest("dictation-local-row").disabled);
	await act(async () => { setDictationActive(false); });
	await click(byTest("dictation-local-row"));
	await search("unsaved-model", localInput("Dictation model ID"));
	assert.match(byTest("dictation-local-status").textContent!, /lfm3/);
	await click(byTest("dictation-local-row"));
	await click(byTest("dictation-local-row"));
	assert.equal(localInput("Dictation model ID").value, "lfm3");
	await search("new-model", localInput("Dictation model ID"));
	f.state.failWrite = true;
	await click(byTest("dictation-local-save"));
	assert.equal(byTest("dictation-local-row").getAttribute("aria-expanded"), "true");
	assert.equal(localInput("Dictation model ID").value, "new-model");
	assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not save/);
	assert.match(byTest("dictation-local-status").textContent!, /lfm3/);
	f.state.failWrite = false;
	await click(byTest("dictation-local-save"));
	assert.equal(document.querySelector('[data-testid="dictation-settings-editor"]'), null);
	assert.match(byTest("dictation-local-status").textContent!, /new-model/);
});


async function addDictationProvider(provider: "deepgram" | "local") {
	await click(byTest("dictation-add-provider"));
	await click(byTest(`provider-option-${provider}`));
	assert.equal(document.querySelector('[data-testid="dictation-add-provider-menu"]'), null);
}


async function activateDictation(provider: "deepgram" | "local") {
	const radio = document.querySelector<HTMLInputElement>(`[data-testid="dictation-active-${provider}"]`)!;
	assert(radio);
	await act(async () => {
		// linkedom lacks radio activation; supply the native checked state before click.
		radio.checked = true;
		radio.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}

test("dictation Add menu offers only unconfigured providers and opens the matching editor", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	assert.equal(document.querySelector('[data-testid="dictation-deepgram-row"]'), null);
	assert.equal(document.querySelector('[data-testid="dictation-local-row"]'), null);
	assert.equal(document.querySelector('select[aria-label="Dictation provider"]'), null);
	await click(byTest("dictation-add-provider"));
	assert.deepEqual([...document.querySelectorAll('[data-testid="provider-list"] button')].map((option) => option.getAttribute("data-testid")), ["provider-option-deepgram", "provider-option-local"]);
	await key(byTest("provider-search"), "ArrowDown");
	await key(byTest("provider-search"), "Enter");
	assert(byTest("dictation-deepgram-editor"));
	assert(byTest("key-deepgram_api_key-input"));
	assert.equal(document.querySelector('input[aria-label="Base URL"]'), null);
	await click(byTest("key-deepgram_api_key-cancel"));
	await addDictationProvider("local");
	assert(localInput("Base URL"));
	assert.equal(document.querySelector('[data-testid="dictation-deepgram-editor"]'), null);
	assert.equal(f.state.writes.length, 0, "opening setup never activates or saves a provider");
});

test("setup and edits never activate providers; only Active radios switch the saved choice", async () => {
	const f = await fixture();
	const local = { server: "llama.cpp" as const, url: "http://localhost:8080/v1/audio/transcriptions", model: "lfm3", language: "auto" };
	f.state.record.dictation = { language: "multi", provider: "local", local };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("deepgram");
	await search("deepgram-test-key", localInput("Deepgram key"));
	f.state.failKeyWrite = true;
	await click(byTest("key-deepgram_api_key-save"));
	assert(byTest("dictation-deepgram-editor"));
	assert.match(byTest("key-deepgram_api_key-error").textContent!, /Key save failed/);
	f.state.failKeyWrite = false;
	await click(byTest("key-deepgram_api_key-save"));
	assert.equal(document.querySelector('[data-testid="dictation-deepgram-editor"]'), null);
	assert.equal(f.state.record.dictation?.provider, "local");
	assert(document.querySelector<HTMLInputElement>('[data-testid="dictation-active-local"]')!.checked);
	await click(byTest("dictation-add-provider"));
	assert.equal(document.querySelectorAll('[data-testid="provider-list"] button').length, 0);
	await click(byTest("dictation-add-provider"));
	await activateDictation("deepgram");
	assert.equal(f.state.record.dictation?.provider, "deepgram");
	assert.deepEqual(f.state.record.dictation?.local, local);
	assert.equal(f.state.record.dictation?.language, "multi");
	await click(byTest("dictation-local-row"));
	await search("updated-model", localInput("Dictation model ID"));
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.provider, "deepgram");
	assert.equal(f.state.record.dictation?.local?.model, "updated-model");
	await activateDictation("local");
	assert.equal(f.state.record.dictation?.provider, "local");
	await click(byTest("dictation-deepgram-row"));
	await click(trigger());
	await click(byTest("dictation-language-pl"));
	assert.equal(f.state.record.dictation?.language, "pl");
	assert.equal(f.state.record.dictation?.provider, "local");
	assert.equal(document.querySelector('[data-testid="dictation-deepgram-editor"]'), null);
});

test("failed activation retains the confirmed provider and recording locks add/edit/activation", async () => {
	const f = await fixture();
	f.state.keys = [{ id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!, present: true, masked: "…test (32 chars)", source: "env", shadowedByEnv: false }];
	f.state.record.dictation = { language: "en", provider: "deepgram", local: { server: "whisper.cpp", url: "http://localhost:8081/inference" } };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	f.state.failWrite = true;
	await activateDictation("local");
	assert.equal(f.state.record.dictation?.provider, "deepgram");
	assert.match(document.querySelector('[data-testid="dictation-provider-settings"] [role="alert"]')!.textContent!, /Could not change/);
	assert(document.querySelector<HTMLInputElement>('[data-testid="dictation-active-deepgram"]')!.checked);
	assert.equal(document.querySelector<HTMLInputElement>('[data-testid="dictation-active-local"]')!.checked, false);
	await act(async () => { setDictationActive(true); });
	for (const id of ["dictation-add-provider", "dictation-active-deepgram", "dictation-active-local", "dictation-deepgram-row", "dictation-local-row"]) assert(byTest(id).disabled, id);
});

test("Deepgram shortcut opens unconfigured settings and removing its key never activates Local", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection initialRow="DEEPGRAM_API_KEY" />);
	assert(byTest("key-deepgram_api_key-input"));
	await search("deepgram-test-key", localInput("Deepgram key"));
	await click(byTest("key-deepgram_api_key-save"));
	assert.equal(f.state.record.dictation?.provider, undefined);
	await addDictationProvider("local");
	await search("http://localhost:8081", localInput("Base URL"));
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.provider, undefined);
	await click(byTest("dictation-deepgram-row"));
	await click(byTest("key-deepgram_api_key-delete"));
	assert.equal(document.querySelector('[data-testid="dictation-deepgram-row"]'), null);
	assert.equal(f.state.record.dictation?.provider, undefined, "legacy default remains Deepgram without silently activating Local");
	assert.equal(document.querySelector<HTMLInputElement>('[data-testid="dictation-active-local"]')!.checked, false);
});


async function chooseLocalLanguage(query: string) {
	await click(byTest("local-dictation-language"));
	const field = document.querySelector<HTMLInputElement>('[data-testid="local-dictation-language-search"]')!;
	await search(query, field);
	await key(field, "ArrowDown");
	await key(field, "Enter");
}

test("provider language controls share styling and keyboard search while saving independently", async () => {
	const f = await fixture();
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("deepgram");
	const cloudClass = trigger().className;
	await click(trigger());
	assert(byTest("dictation-language-multi"));
	assert.equal(document.querySelector('[data-testid="dictation-language-auto"]'), null);
	await key(input(), "Escape");
	await click(byTest("key-deepgram_api_key-cancel"));
	await addDictationProvider("local");
	assert.equal(byTest("local-dictation-language").className, cloudClass);
	const localRow = byTest("row-local-dictation-language");
	assert(localRow.classList.contains("justify-between"));
	assert.equal(localRow.previousElementSibling!.textContent, "Serverllama.cppwhisper.cpp", "Language follows Server");
	assert(localRow.nextElementSibling!.contains(localInput("Base URL")), "Base URL follows Language");
	assert.equal(localRow.children[0]!.textContent, "Language");
	assert(localRow.contains(byTest("local-dictation-language")));
	assert.match(byTest("local-dictation-language").textContent!, /Auto-detect/);
	await click(byTest("local-dictation-language"));
	const field = document.querySelector<HTMLInputElement>('[data-testid="local-dictation-language-search"]')!;
	assert.equal(document.activeElement, field);
	assert(byTest("local-dictation-language-auto"));
	assert.equal(document.querySelector('[data-testid="local-dictation-language-multi"]'), null);
	await search("French", field);
	await key(field, "ArrowDown"); await key(field, "Enter");
	assert.equal(document.querySelector('[data-testid="local-dictation-language-menu"]'), null);
	assert.equal(document.activeElement, byTest("local-dictation-language"));
	assert.match(byTest("local-dictation-language").textContent!, /French/);
	assert.equal(f.state.writes.length, 0, "local selection only updates the editor draft");
	assert.equal(f.state.record.dictation?.language, "multi");
	await search("http://localhost:8081", localInput("Base URL"));
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.local?.language, "fr");
	assert.equal(f.state.record.dictation?.language, "multi");
	assert.equal(f.state.record.dictation?.provider, undefined);
	await click(byTest("dictation-local-row"));
	assert.match(byTest("local-dictation-language").textContent!, /French/);
});

test("local picker supports custom backend codes, keeps Escape inside the menu, and locks during capture", async () => {
	const f = await fixture();
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("local");
	await click(byTest("local-dictation-language"));
	const field = document.querySelector<HTMLInputElement>('[data-testid="local-dictation-language-search"]')!;
	await search("xyz", field);
	assert.match(byTest("local-dictation-language-xyz").textContent!, /Use language code: xyz/);
	await key(field, "ArrowDown"); await key(field, "Enter");
	assert.equal(byTest("local-dictation-language").textContent, "xyz▾");
	await click(byTest("local-dictation-language"));
	const invalid = document.querySelector<HTMLInputElement>('[data-testid="local-dictation-language-search"]')!;
	await search("invalid!", invalid);
	assert.equal(document.querySelectorAll('[data-testid="local-dictation-language-list"] button').length, 0);
	await key(invalid, "Enter");
	assert(byTest("local-dictation-language-menu"), "invalid codes cannot select or submit");
	await key(invalid, "Escape");
	assert.equal(document.querySelector('[data-testid="local-dictation-language-menu"]'), null);
	assert(byTest("dictation-settings-editor"));
	assert.equal(f.state.outerEscapes, 0);
	await search("http://localhost:8081", localInput("Base URL"));
	await click(byTest("dictation-local-save"));
	assert.equal(f.state.record.dictation?.local?.language, "xyz");
	await click(byTest("dictation-local-row"));
	assert.match(byTest("local-dictation-language").textContent!, /xyz/);
	await click(byTest("local-dictation-language"));
	await act(async () => { setDictationActive(true); });
	assert(byTest("local-dictation-language").disabled);
	assert.equal(document.querySelector('[data-testid="local-dictation-language-menu"]'), null);
});


test("Local actions match Deepgram styles; Delete clears saved config and key without activating another provider", async () => {
	const f = await fixture();
	const local = { server: "llama.cpp" as const, url: "http://localhost:8080/v1/audio/transcriptions", model: "lfm3" };
	f.state.record.dictation = { provider: "local", language: "pl", local };
	f.state.credential = { url: local.url, key: "saved-local-key" };
	await act(async () => { notifySettingsSaved("dictation"); });
	const { KeysSection } = await import("../components/settings/keys-section.tsx");
	await f.render(<KeysSection />);
	await addDictationProvider("deepgram");
	const saveClass = byTest("key-deepgram_api_key-save").className;
	const cancelClass = byTest("key-deepgram_api_key-cancel").className;
	await click(byTest("key-deepgram_api_key-cancel"));
	await click(byTest("dictation-local-row"));
	assert.equal(byTest("dictation-local-save").className, saveClass);
	assert.equal(byTest("dictation-local-cancel").className, cancelClass);
	assert.match(byTest("dictation-local-delete").className, /hover:text-red-500/);
	await search("unsaved model", localInput("Dictation model ID"));
	await click(byTest("dictation-local-cancel"));
	assert.equal(f.state.record.dictation.local?.model, "lfm3");
	await click(byTest("dictation-local-row"));
	f.state.failDelete = true;
	await click(byTest("dictation-local-delete"));
	assert(byTest("dictation-settings-editor"));
	assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not delete/);
	assert(f.state.record.dictation.local);
	await act(async () => { setDictationActive(true); });
	for (const id of ["dictation-local-save", "dictation-local-cancel", "dictation-local-delete"]) assert(byTest(id).disabled);
	await act(async () => { setDictationActive(false); });
	f.state.failDelete = false;
	await click(byTest("dictation-local-delete"));
	assert.equal(document.querySelector('[data-testid="dictation-settings-editor"]'), null);
	assert.equal(document.querySelector('[data-testid="dictation-local-row"]'), null);
	assert.equal(f.state.record.dictation.local, undefined);
	assert.equal(f.state.credential, undefined);
	assert.equal(f.state.record.dictation.provider, "local");
	assert.equal(f.state.record.dictation.language, "pl");
	await addDictationProvider("local");
	assert.equal(localInput("Base URL").value, "");
	assert.equal(document.querySelector('[data-testid="dictation-local-delete"]'), null, "unsaved providers have nothing to delete");
});
