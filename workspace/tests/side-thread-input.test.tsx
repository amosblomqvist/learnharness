import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { SideThreadBody } from "../components/side-thread.tsx";
import { useEnterSubmits } from "../components/enter-submits.ts";
import type { SideThreadState } from "../components/use-side-thread.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function fixture(draft = "", mode: "popover" | "panel" = "popover") {
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
	let saved = draft; let mainSubmits = 0;
	const state: SideThreadState = { threadId: "side_lesson", segmentId: "lesson", messages: [], answering: false,
		streamText: "", mode, anchor: { kind: "composer" } };
	function Harness() {
		useEnterSubmits(() => { mainSubmits++; });
		return <SideThreadBody state={state} draft={draft} readDraft={() => saved}
			onDraftChange={(text) => { saved = text; }}
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
	return { dom, sent, saved: () => saved, mainSubmits: () => mainSubmits };
}

test("side Send submits and clears the typed draft", async () => {
	const f = await fixture("Typed clarification");
	const send = document.querySelector<HTMLButtonElement>('[aria-label="Send side question"]')!;
	assert.equal(send.disabled, false);
	await act(async () => send.click());
	assert.deepEqual(f.sent, ["Typed clarification"]);
	assert.equal(f.saved(), "");
	assert.equal(send.disabled, true);
});

test("docked side-control Enter stays native and cannot submit the main question", async () => {
	const f = await fixture("typed question", "panel");
	const button = document.querySelector<HTMLButtonElement>('[aria-label="Send side question"]')!;
	const enter = Object.assign(new f.dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" });
	await act(async () => { button.dispatchEvent(enter); });
	assert.equal(f.mainSubmits(), 0);
	assert.equal(enter.defaultPrevented, false, "the browser still owns native button activation");
	await act(async () => button.click());
	assert.deepEqual(f.sent, ["typed question"]);
});
