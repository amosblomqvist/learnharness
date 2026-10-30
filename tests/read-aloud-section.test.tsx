/**
 * Settings → Read aloud (ElevenLabs voice slice 9), rendered inside the real
 * dialog with only fetch faked: the account's voices (cloned included, name
 * plus category) and TTS models, the default shown when unset (Alice; the
 * resolved model, including the fallback for a model no longer listed), a
 * save that sends the whole section, a clear error instead of a stale list,
 * the keyless link into Keys → Read aloud, and the billing note.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AUTH_KEYS, type AuthKeyStatus, type UserSettings } from "../src/core/index.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const select = (id: string) => byTest(id) as HTMLSelectElement;
const options = (id: string) => [...select(id).querySelectorAll("option")].map((o) => o.textContent);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
// The voice picker is the app's searchable menu (as the dictation language picker).
const trigger = () => byTest("read-aloud-voice") as HTMLButtonElement;
const voiceMenu = () => byTest("read-aloud-voice-menu");
const voiceInput = () => byTest("read-aloud-voice-search") as HTMLInputElement;
const voiceRows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="read-aloud-voice-list"] button')];
const openVoices = async () => { await act(async () => { trigger().click(); }); };
async function key(element: HTMLElement, value: string) {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: value });
		element.dispatchEvent(event);
	});
}
async function search(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(voiceInput(), value);
		voiceInput().dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

const VOICES = [
	{ id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", category: "premade" },
	{ id: "clone1", name: "My Voice", category: "cloned" },
];
const MODELS = [
	{ id: "eleven_v4_turbo", name: "Eleven v4 Turbo", maxChars: 10000 },
	{ id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", maxChars: 40000 },
];

interface Setup {
	readAloud?: UserSettings["readAloud"];
	voices?: () => Response;
	models?: () => Response;
	failWrite?: boolean;
}

async function fixture(setup: Setup = {}, standalone = false) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.scrollIntoView = () => {};
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
	const state = {
		record: { version: 1, ...(setup.readAloud ? { readAloud: setup.readAloud } : {}) } as UserSettings,
		writes: [] as unknown[],
	};
	const keyStatuses = (): AuthKeyStatus[] => AUTH_KEYS.map((info) => ({ id: info.id, info, present: false, masked: null, source: "none", shadowedByEnv: false }));
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/tts/voices") return (setup.voices ?? (() => Response.json(VOICES)))();
			if (url === "/api/tts/models") return (setup.models ?? (() => Response.json(MODELS)))();
			if (url === "/api/keys") return Response.json({ keys: keyStatuses(), providers: [] });
			if (url === "/api/settings/readAloud") {
				const body = JSON.parse(init!.body as string);
				state.writes.push(body);
				if (setup.failWrite) return Response.json({}, { status: 500 });
				state.record = { ...state.record, readAloud: body };
				return Response.json({ settings: state.record });
			}
			return Response.json({});
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
	const { SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	// `standalone` mounts the section under the real provider, so its Keys link
	// opens the real dialog (the body alone has no opener).
	const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
	const { ReadAloudSection } = await import("../components/settings/read-aloud-section.tsx");
	await act(async () => {
		root.render(standalone
			? <SettingsDialogProvider><ReadAloudSection /></SettingsDialogProvider>
			: <SettingsDialogBody onClose={() => {}} initialSection="readAloud" />);
	});
	await act(async () => { notifySettingsSaved("readAloud"); }); // a fresh record per fixture
	await settle();
	await settle();
	return state;
}

async function choose(id: string, value: string) {
	await act(async () => {
		// linkedom's select.value is read-only: select the option instead.
		for (const option of select(id).querySelectorAll("option")) {
			if (option.getAttribute("value") === value) option.setAttribute("selected", "");
			else option.removeAttribute("selected");
		}
		select(id).dispatchEvent(new window.Event("change", { bubbles: true }));
	});
	await settle();
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("the section is in the dialog nav and says billing is separate", async () => {
	await fixture();
	assert.equal(byTest("settings-nav-readAloud")!.textContent, "Read aloud");
	assert.equal(byTest("section-read-aloud") !== null, true);
	const note = byTest("read-aloud-billing-note")!.textContent!;
	assert(note.includes("ElevenLabs bills your account separately"));
	assert(note.includes("cost meter"));
});

test("the voice menu lists the account's voices: name, with the category as quiet secondary text, cloned included", async () => {
	await fixture();
	assert.equal(voiceMenu(), null, "closed until opened");
	await openVoices();
	assert.equal(document.activeElement, voiceInput());
	assert.deepEqual(voiceRows().map((row) => row.querySelector(".text-card-foreground")!.textContent), ["Alice", "My Voice"]);
	assert.deepEqual(voiceRows().map((row) => row.querySelector(".text-muted-foreground")!.textContent), ["premade", "cloned"]);
});

test("with nothing saved the voice picker shows Alice and the model picker the default model", async () => {
	await fixture();
	assert.match(trigger().textContent!, /Alice/);
	assert.equal(select("read-aloud-model").value, "eleven_v4_turbo");
	await openVoices();
	assert.match(byTest("read-aloud-voice-Xb7hH8MSUJpSbSDYk0k2")!.className, /bg-muted\/60/, "Alice is the marked row");
});

test("the model picker lists only what the models route returned (TTS-capable) and shows a saved one", async () => {
	await fixture({ readAloud: { modelId: "eleven_flash_v2_5", voiceId: "clone1" } });
	assert.deepEqual(options("read-aloud-model"), ["Eleven v4 Turbo", "Eleven Flash v2.5"]);
	assert.equal(select("read-aloud-model").value, "eleven_flash_v2_5");
	assert.match(trigger().textContent!, /My Voice/);
});

test("a saved voice that is no longer on the account shows Alice, the voice actually used, and writes nothing", async () => {
	const state = await fixture({ readAloud: { voiceId: "removed-voice" } });
	assert.match(trigger().textContent!, /Alice/);
	assert.doesNotMatch(trigger().textContent!, /removed-voice|not on this account/);
	await openVoices();
	assert.match(byTest("read-aloud-voice-Xb7hH8MSUJpSbSDYk0k2")!.className, /bg-muted\/60/);
	assert.deepEqual(state.writes, [], "showing the fallback never writes it back");
});

test("a saved model that is no longer listed shows the model actually used", async () => {
	const state = await fixture({ readAloud: { modelId: "retired_model" } });
	assert.equal(select("read-aloud-model").value, "eleven_v4_turbo");
	assert.deepEqual(state.writes, [], "merely showing the fallback writes nothing");
});

test("with v4 Turbo gone the picker shows Flash, then the first listed", async () => {
	await fixture({ models: () => Response.json([{ id: "eleven_v3", name: "v3", maxChars: 5 }, { id: "eleven_flash_v2_5", name: "Flash", maxChars: 5 }]) });
	assert.equal(select("read-aloud-model").value, "eleven_flash_v2_5");
	await dispose!();
	restore!();
	await fixture({ models: () => Response.json([{ id: "eleven_v3", name: "v3", maxChars: 5 }]) });
	assert.equal(select("read-aloud-model").value, "eleven_v3");
});

test("choosing a voice saves the whole section, keeping the model, and closes the menu", async () => {
	const state = await fixture({ readAloud: { modelId: "eleven_flash_v2_5" } });
	await openVoices();
	await act(async () => { byTest("read-aloud-voice-clone1")!.click(); });
	await settle();
	assert.deepEqual(state.writes, [{ voiceId: "clone1", modelId: "eleven_flash_v2_5" }]);
	assert.match(trigger().textContent!, /My Voice/);
	assert.equal(voiceMenu(), null);
	assert.equal(document.activeElement, trigger());
});

test("searching filters voices by name and by category", async () => {
	await fixture();
	await openVoices();
	await search("my vo");
	assert.deepEqual(voiceRows().map((row) => row.getAttribute("data-testid")), ["read-aloud-voice-clone1"]);
	await search("premade");
	assert.deepEqual(voiceRows().map((row) => row.getAttribute("data-testid")), ["read-aloud-voice-Xb7hH8MSUJpSbSDYk0k2"]);
	await search("zzzz");
	assert.equal(voiceRows().length, 0);
	assert.match(voiceMenu()!.textContent!, /No voices match/);
});

test("arrow keys walk the results and Enter chooses; Enter on no results saves nothing", async () => {
	const state = await fixture();
	await openVoices();
	await key(voiceInput(), "ArrowDown");
	await key(voiceInput(), "ArrowDown");
	await key(voiceInput(), "Enter");
	await settle();
	assert.deepEqual(state.writes, [{ voiceId: "clone1" }]);
	assert.equal(voiceMenu(), null);
	await openVoices();
	await search("zzzz");
	await key(voiceInput(), "Enter");
	assert.equal(state.writes.length, 1);
});

test("Escape closes only the voice menu, returning focus to its trigger", async () => {
	await fixture();
	let outer = 0;
	document.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") outer++; });
	await openVoices();
	await key(voiceInput(), "Escape");
	assert.equal(voiceMenu(), null);
	assert.equal(outer, 0, "the dialog's own Escape did not run");
	assert.equal(document.activeElement, trigger());
});

test("choosing a model saves the whole section, keeping the voice", async () => {
	const state = await fixture({ readAloud: { voiceId: "clone1" } });
	await choose("read-aloud-model", "eleven_flash_v2_5");
	assert.deepEqual(state.writes, [{ voiceId: "clone1", modelId: "eleven_flash_v2_5" }]);
	assert.equal(select("read-aloud-model").value, "eleven_flash_v2_5");
});

test("a failed save keeps the previous voice and says so", async () => {
	await fixture({ failWrite: true });
	await openVoices();
	await act(async () => { byTest("read-aloud-voice-clone1")!.click(); });
	await settle();
	assert.match(trigger().textContent!, /Alice/);
	assert(byTest("read-aloud-save-error")!.textContent!.includes("Could not save"));
	assert(voiceMenu()!.querySelector('[role="alert"]'), "the open menu shows it too");
});

test("a list that cannot load shows a clear line, not a stale or fake list", async () => {
	await fixture({
		voices: () => Response.json({ message: "ElevenLabs error (401): missing voices_read" }, { status: 502 }),
		models: () => { throw new Error("offline"); },
	});
	assert.equal(byTest("read-aloud-voices-error")!.textContent, "ElevenLabs error (401): missing voices_read");
	assert.equal(byTest("read-aloud-models-error")!.textContent, "Could not load models");
	assert.equal(byTest("read-aloud-voice"), null);
	assert.equal(byTest("read-aloud-model"), null);
});

test("without an ElevenLabs key the section links to Keys → Read aloud", async () => {
	await fixture({
		voices: () => Response.json({ message: "No ELEVENLABS_API_KEY", keyless: "ELEVENLABS_API_KEY" }, { status: 503 }),
		models: () => Response.json({ message: "No ELEVENLABS_API_KEY", keyless: "ELEVENLABS_API_KEY" }, { status: 503 }),
	}, true);
	assert.equal(byTest("read-aloud-voice"), null);
	assert(byTest("read-aloud-billing-note"), "the billing note stays");
	await act(async () => { byTest("read-aloud-keyless")!.click(); });
	await settle();
	await settle();
	assert(byTest("section-keys"), "the Providers section opened");
	assert(byTest("key-elevenlabs_api_key-read-aloud"), "the Read aloud group's ElevenLabs row exists");
	assert.equal(byTest("key-elevenlabs_api_key-read-aloud")!.querySelector("input") !== null, true, "and it is unfolded");
});

const toggle = () => byTest("toggle-read-replies-aloud") as HTMLButtonElement;

test("Read replies aloud is a toggle, off by default", async () => {
	const state = await fixture();
	assert.equal(byTest("row-read-aloud-auto")!.textContent!.includes("Read replies aloud"), true);
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert.deepEqual(state.writes, []);
});

test("switching it on saves the whole section, keeping voice and model", async () => {
	const state = await fixture({ readAloud: { voiceId: "clone1", modelId: "eleven_flash_v2_5" } });
	await act(async () => { toggle().click(); });
	await settle();
	assert.deepEqual(state.writes, [{ voiceId: "clone1", modelId: "eleven_flash_v2_5", autoRead: true }]);
	assert.equal(toggle().getAttribute("aria-checked"), "true");
});

test("a saved-on toggle shows on, and switching off saves false", async () => {
	const state = await fixture({ readAloud: { autoRead: true } });
	assert.equal(toggle().getAttribute("aria-checked"), "true");
	await act(async () => { toggle().click(); });
	await settle();
	assert.deepEqual(state.writes, [{ autoRead: false }]);
	assert.equal(toggle().getAttribute("aria-checked"), "false");
});

test("choosing a voice or a model keeps auto-read on", async () => {
	const state = await fixture({ readAloud: { autoRead: true } });
	await openVoices();
	await act(async () => { byTest("read-aloud-voice-clone1")!.click(); });
	await settle();
	await choose("read-aloud-model", "eleven_flash_v2_5");
	assert.deepEqual(state.writes, [
		{ voiceId: "clone1", autoRead: true },
		{ voiceId: "clone1", modelId: "eleven_flash_v2_5", autoRead: true },
	]);
});

test("a failed toggle save keeps the previous state and says so", async () => {
	await fixture({ failWrite: true });
	await act(async () => { toggle().click(); });
	await settle();
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(byTest("read-aloud-save-error")!.textContent!.includes("Could not save"));
});
