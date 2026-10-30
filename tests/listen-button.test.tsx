/**
 * The Listen/Stop button on assistant messages (components/read-aloud.tsx,
 * ElevenLabs voice slice 6): its states, its speech source, the one-at-a-time
 * hand-off between two messages, the inline failure line, and the keyless
 * deep link into Settings → Keys → the Read aloud group's ElevenLabs row.
 * Fakes at the boundary only: the player's fetch and audio element.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";
import { createReadAloudPlayer, type AudioLike } from "../components/read-aloud-player.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string, within: ParentNode = document) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (element: HTMLElement | null) => { assert(element); await act(async () => { element.click(); }); };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

class FakeAudio implements AudioLike {
	src = "";
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	async play() {}
	pause() {}
}

type TtsHandler = (text: string) => Response | Promise<Response>;

async function fixture(
	handler: TtsHandler,
	messages: Array<{ id: string; markdown: string }>,
	readAloud?: { voiceId?: string; modelId?: string },
) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () {};
	win.HTMLElement.prototype.scrollIntoView = () => {};
	const requested: string[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	const keyStatuses = (): AuthKeyStatus[] => AUTH_KEYS.map((info) => ({ id: info.id, info, present: false, masked: null, source: "none", shadowedByEnv: false }));
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		// The settings dialog's own reads (the keyless deep link opens it).
		fetch: async (url: string) => {
			if (url === "/api/keys") return Response.json({ keys: keyStatuses(), providers: [] });
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" }, ...(readAloud ? { readAloud } : {}) } });
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
	const player = createReadAloudPlayer({
		fetch: (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string) as { text: string };
			bodies.push(body);
			const text = body.text;
			requested.push(text);
			return handler(text);
		}) as unknown as typeof fetch,
		createAudio: () => new FakeAudio(),
		createObjectURL: () => "blob:x",
		revokeObjectURL: () => {},
	});
	const { createRoot } = await import("react-dom/client");
	const { ListenButton } = await import("../components/read-aloud.tsx");
	const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { player.stop(); root.unmount(); }); };
	await act(async () => {
		root.render(
			<SettingsDialogProvider>
				{messages.map((m) => <div key={m.id} data-message={m.id}><ListenButton sourceId={m.id} markdown={m.markdown} player={player} /></div>)}
			</SettingsDialogProvider>,
		);
	});
	await settle();
	return { requested, bodies, player };
}

const within = (id: string) => document.querySelector<HTMLElement>(`[data-message="${id}"]`)!;
const AUDIO = () => new Response("mp3", { status: 200, headers: { "content-type": "audio/mpeg" } });

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("idle: a Listen button, no error", async () => {
	await fixture(AUDIO, [{ id: "m1", markdown: "Hello." }]);
	const button = byTest("listen-button")!;
	assert.equal(button.getAttribute("aria-label"), "Read aloud");
	assert.equal(button.getAttribute("data-playing"), null);
	assert.equal(byTest("listen-error"), null);
	assert.equal(byTest("listen-keyless"), null);
});

test("clicking Listen reads the message's speech text and the button turns into Stop; clicking Stop stops", async () => {
	const { requested, player } = await fixture(AUDIO, [{ id: "m1", markdown: "## Hi\n\nSee **this**:\n\n```ts\nconst x = 1\n```" }]);
	await click(byTest("listen-button"));
	await settle();
	// Markdown became speech: heading flattened, emphasis dropped, code replaced by its marker.
	assert.deepEqual(requested, ["Hi. See this: Code shown on screen."]);
	const button = byTest("listen-button")!;
	assert.equal(button.getAttribute("aria-label"), "Stop reading aloud");
	assert.equal(button.getAttribute("data-playing"), "true");
	assert.equal(player.getSnapshot().sourceId, "m1");
	await click(button);
	assert.equal(byTest("listen-button")!.getAttribute("aria-label"), "Read aloud");
	assert.equal(player.getSnapshot().sourceId, null);
});

test("Listen requests carry the saved voice and model; nothing saved sends neither", async () => {
	const saved = await fixture(AUDIO, [{ id: "m1", markdown: "Hello." }], { voiceId: "VoiceId123", modelId: "eleven_flash_v2_5" });
	await click(byTest("listen-button"));
	await settle();
	assert.deepEqual(saved.bodies, [{ text: "Hello.", voiceId: "VoiceId123", modelId: "eleven_flash_v2_5" }]);
	await dispose!();
	restore!();
	dispose = restore = undefined;
	const unset = await fixture(AUDIO, [{ id: "m1", markdown: "Hello." }]);
	await click(byTest("listen-button"));
	await settle();
	assert.deepEqual(unset.bodies, [{ text: "Hello." }], "absent stays absent: the server defaults");
});

test("starting another message's Listen stops the first one's button", async () => {
	await fixture(AUDIO, [{ id: "a", markdown: "First." }, { id: "b", markdown: "Second." }]);
	await click(byTest("listen-button", within("a")));
	await settle();
	assert.equal(byTest("listen-button", within("a"))!.getAttribute("data-playing"), "true");
	assert.equal(byTest("listen-button", within("b"))!.getAttribute("data-playing"), null);
	await click(byTest("listen-button", within("b")));
	await settle();
	assert.equal(byTest("listen-button", within("a"))!.getAttribute("data-playing"), null);
	assert.equal(byTest("listen-button", within("b"))!.getAttribute("data-playing"), "true");
});

test("an upstream failure shows inline on that message only", async () => {
	await fixture(() => Response.json({ message: "ElevenLabs error (401): quota" }, { status: 502 }), [{ id: "a", markdown: "First." }, { id: "b", markdown: "Second." }]);
	await click(byTest("listen-button", within("a")));
	await settle();
	const alert = byTest("listen-error", within("a"))!;
	assert.equal(alert.textContent, "ElevenLabs error (401): quota");
	assert.equal(alert.getAttribute("role"), "alert");
	assert.equal(byTest("listen-error", within("b")), null);
	assert.equal(byTest("listen-button", within("a"))!.getAttribute("data-playing"), null, "back to Listen so it can be retried");
});

test("no key: the line says Read aloud needs an ElevenLabs key, and clicking it opens Settings at the Read aloud row", async () => {
	await fixture(() => Response.json({ message: "No ELEVENLABS_API_KEY", keyless: "ELEVENLABS_API_KEY" }, { status: 503 }), [{ id: "a", markdown: "First." }, { id: "b", markdown: "Second." }]);
	await click(byTest("listen-button", within("a")));
	await settle();
	assert.equal(all("listen-keyless").length, 1, "only the clicked message shows it");
	const link = byTest("listen-keyless", within("a"))!;
	assert.equal(link.textContent, "Read aloud needs an ElevenLabs key");
	assert.equal(byTest("settings-backdrop"), null);
	await click(link);
	await settle();
	assert.ok(byTest("settings-backdrop"), "Settings opened");
	assert.ok(byTest("key-elevenlabs_api_key-read-aloud-editor"), "the Read aloud group's row is unfolded");
	assert.equal(byTest("key-elevenlabs_api_key-editor"), null, "not the Dictation group's row");
	assert.equal(byTest("listen-keyless"), null, "the error cleared on the way out");
});
