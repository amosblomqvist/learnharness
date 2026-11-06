import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { SideThreadBody } from "../components/side-thread.tsx";
import type { SideThreadState } from "../components/use-side-thread.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function fixture(recording: boolean) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	// Linkedom has no native oninput property; advertise modern input
	// support so React does not select its legacy IE value-change polyfill.
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document,
		navigator: { userAgent: "", platform: "" }, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const sent: string[] = [];
	let saved = ""; let toggles = 0; let finishes = 0;
	const state: SideThreadState = { threadId: "side_lesson", segmentId: "lesson", messages: [], answering: false,
		streamText: "", contextFrozen: false, mode: "popover", anchor: { kind: "composer" } };
	function Harness() {
		const [draft, setDraft] = useState(saved);
		const [active, setActive] = useState(recording);
		return <SideThreadBody state={state} draft={draft} readDraft={() => saved}
			onDraftChange={(text) => { saved = text; }}
			dictation={{ active, phase: active ? "recording" : "idle", blocked: false, error: null,
				toggle: () => { toggles++; }, finish: async () => {
					finishes++; saved = "Dictated clarification"; setDraft(saved); setActive(false);
				} }}
			onAsk={async (text) => { sent.push(text); return true; }} onStop={() => {}} onExpand={() => {}} onFloat={() => {}} onClose={() => {}} />;
	}
	dispose = async () => {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	await act(async () => root.render(<Harness />));
	return { dom, sent, saved: () => saved, finishes: () => finishes, toggles: () => toggles };
}

test("side Send finishes speech before reading the authoritative draft, even before React commits", async () => {
	const f = await fixture(true);
	const send = document.querySelector<HTMLButtonElement>('[aria-label="Send side question"]')!;
	assert.equal(send.disabled, false, "a speech-only draft can be submitted");
	await act(async () => { send.click(); });
	assert.equal(f.finishes(), 1);
	assert.deepEqual(f.sent, ["Dictated clarification"]);
	assert.equal(f.saved(), "");
});

test("the dictate chord in the side composer is consumed locally, not also sent to the main recorder", async () => {
	const f = await fixture(false);
	let reachedWindow = 0;
	window.addEventListener("keydown", () => { reachedWindow++; });
	const chord = Object.assign(new f.dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
		key: "d", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
	});
	await act(async () => { document.querySelector("textarea")!.dispatchEvent(chord); });
	assert.equal(f.toggles(), 1);
	assert.equal(chord.defaultPrevented, true);
	assert.equal(reachedWindow, 0);
});
