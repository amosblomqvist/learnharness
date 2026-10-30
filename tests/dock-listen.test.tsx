/**
 * The Listen button on the pending question in the dock (ElevenLabs voice
 * slice 11): it reads the PROMPT only (never an option), keeps the message
 * button's states, and uses its own source id so it never collides with a
 * message's. Rendered like tests/pending-question-form.test.tsx; fakes at the
 * boundary only (the player's fetch and audio element).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";
import { createReadAloudPlayer, type AudioLike } from "../components/read-aloud-player.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => { assert(element); await act(async () => { element.click(); }); };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

class FakeAudio implements AudioLike {
	src = "";
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	async play() {}
	pause() {}
}

const AUDIO = () => new Response("mp3", { status: 200, headers: { "content-type": "audio/mpeg" } });

type Input = Record<string, unknown>;

async function fixture(
	toolName: "quiz" | "ask_user_question",
	input: Input,
	handler: (text: string) => Response = AUDIO,
	toolCallId = "call-7",
	startExpanded = true,
) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () {};
	win.HTMLElement.prototype.scrollIntoView = () => {};
	const requested: string[] = [];
	const keyStatuses = (): AuthKeyStatus[] => AUTH_KEYS.map((info) => ({ id: info.id, info, present: false, masked: null, source: "none", shadowedByEnv: false }));
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string) => {
			if (url === "/api/keys") return Response.json({ keys: keyStatuses(), providers: [] });
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
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
			const { text } = JSON.parse(init.body as string) as { text: string };
			requested.push(text);
			return handler(text);
		}) as unknown as typeof fetch,
		createAudio: () => new FakeAudio(),
		createObjectURL: () => "blob:x",
		revokeObjectURL: () => {},
	});
	const { createRoot } = await import("react-dom/client");
	const { QuestionDock } = await import("../components/question-dock.tsx");
	const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
	const root = createRoot(doc.getElementById("root")!);
	dispose = async () => { await act(async () => { player.stop(); root.unmount(); }); };
	const render = (expanded: boolean) =>
		act(async () => {
			root.render(
				<SettingsDialogProvider>
					<QuestionDock
						toolName={toolName} toolCallId={toolCallId} input={input as never}
						expanded={expanded} reveal={!expanded} onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} player={player}
					/>
				</SettingsDialogProvider>,
			);
		});
	await render(startExpanded);
	await settle();
	return { requested, player, render };
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

const quiz = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Mercury-OPTION", value: "mercury" }, { label: "Venus-OPTION", value: "venus" }],
	correctAnswer: "mercury",
	explanation: "EXPLANATION-SECRET",
};

test("a pending quiz shows a Listen button; clicking it speaks the prompt and no option, and it becomes Stop", async () => {
	const { requested, player } = await fixture("quiz", quiz);
	const button = byTest("listen-button")!;
	assert.equal(button.getAttribute("aria-label"), "Read aloud");
	await click(button);
	await settle();
	assert.deepEqual(requested, ["Which planet is closest to the sun?"]);
	assert.equal(player.getSnapshot().sourceId, "q-call-7", "its own source id, derived from the tool call id");
	assert.equal(byTest("listen-button")!.getAttribute("aria-label"), "Stop reading aloud");
	await click(byTest("listen-button"));
	assert.equal(player.getSnapshot().sourceId, null);
	assert.equal(byTest("listen-button")!.getAttribute("aria-label"), "Read aloud");
});

test("a free-text ask reads the question and its details, still no options", async () => {
	const { requested } = await fixture("ask_user_question", { question: "What did you try?", details: "Be specific." });
	await click(byTest("listen-button"));
	await settle();
	assert.deepEqual(requested, ["What did you try? Be specific."]);
});

test("a select ask never reads its options or their descriptions", async () => {
	const { requested } = await fixture("ask_user_question", {
		question: "Which do you prefer?",
		options: [{ label: "Tea-OPTION", description: "DESC" }, { label: "Coffee-OPTION" }],
		multiSelect: true,
	});
	await click(byTest("listen-button"));
	await settle();
	assert.deepEqual(requested, ["Which do you prefer?"]);
});

test("one Listen button in the dock", async () => {
	await fixture("quiz", quiz);
	assert.equal(document.querySelectorAll('[data-testid="listen-button"]').length, 1);
});

test("an upstream failure shows inline next to the dock's button", async () => {
	await fixture("quiz", quiz, () => Response.json({ message: "ElevenLabs error (401): quota" }, { status: 502 }));
	await click(byTest("listen-button"));
	await settle();
	assert.equal(byTest("listen-error")!.textContent, "ElevenLabs error (401): quota");
});

test("no key: the keyless line deep-links to Settings", async () => {
	await fixture("quiz", quiz, () => Response.json({ message: "No ELEVENLABS_API_KEY", keyless: "ELEVENLABS_API_KEY" }, { status: 503 }));
	await click(byTest("listen-button"));
	await settle();
	assert.equal(byTest("listen-keyless")!.textContent, "Read aloud needs an ElevenLabs key");
	await click(byTest("listen-keyless"));
	await settle();
	assert.ok(byTest("settings-backdrop"), "Settings opened");
});

test("submitting an answer stops the question being read aloud", async () => {
	const { player } = await fixture("quiz", quiz);
	await click(byTest("listen-button"));
	await settle();
	assert.equal(player.getSnapshot().sourceId, "q-call-7", "the prompt is playing");
	await click(document.querySelector<HTMLElement>('[role="radio"]'));
	await act(async () => { document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
	assert.equal(player.getSnapshot().sourceId, null, "submit silenced it");
});

test("while a teach check is collapsed its Listen button is hidden and inert; after the reveal it reads the prompt", async () => {
	const { requested, render } = await fixture("quiz", quiz, AUDIO, "call-7", false);
	const hidden = byTest("listen-button")!.closest("[inert]");
	assert.ok(hidden, "the collapsed form (and its Listen button) is inert, so it can't be focused or clicked");
	assert.ok(hidden.classList.contains("invisible"), "and invisible");
	assert.ok(document.body.textContent?.includes("Check your understanding"), "the invitation is what shows");
	await render(true);
	assert.equal(byTest("listen-button")!.closest("[inert]"), null, "revealed: reachable");
	await click(byTest("listen-button"));
	await settle();
	assert.deepEqual(requested, ["Which planet is closest to the sun?"]);
});
