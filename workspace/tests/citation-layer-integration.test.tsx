import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { CitationChip } from "../components/citation-chip.tsx";
import { CitationCommentPopover } from "../components/citation-comment-popover.tsx";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";

const citation = { version: 1 as const, chatId: "chat", messageId: "teacher", text: "A public quotation", start: 0, end: 18, prefix: "", suffix: "" };
async function fixture(run: (f: { controller: InteractionLayersController; dismissals(): number; escape(target?: HTMLElement): Promise<Event>; cover(): Promise<() => Promise<void>> }) => Promise<void>, comment = false) {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div><div id='composer' contenteditable='true'></div></body></html>");
	Object.assign(dom.window, { getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0 }) });
	const globals = { React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	let controller!: InteractionLayersController;
	let dismissals = 0;
	function Harness() {
		controller = useInteractionLayers();
		const [open, setOpen] = React.useState(true);
		return comment ? (open ? <CitationCommentPopover target={{ citation, start: 0, link: "", host: document.getElementById("composer")! }} transcript={null} composer={() => document.getElementById("composer")} onClose={() => { dismissals++; setOpen(false); }} onSend={() => {}} /> : null) : <CitationChip citation={citation} variant="transcript" />;
	}
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>));
		await run({ controller, dismissals: () => dismissals,
			async escape(target) {
				const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
				await act(async () => { controller.captureKeyDown(event as KeyboardEvent); (target ?? document).dispatchEvent(event); });
				return event;
			},
			async cover() {
				const covering = document.createElement("div"); document.body.append(covering);
				let retire!: () => void;
				await act(async () => { retire = controller.register({ id: "cover", kind: "modal", rootRef: { current: covering }, ownerId: null, onClose: () => "blocked" }); });
				await act(async () => covering.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
				assert.equal(dismissals, 0, "a covering modal's outside click cannot dismiss the underlying citation editor");
				return async () => { await act(async () => retire()); covering.remove(); };
			},
		});
	} finally {
		await act(async () => root.unmount()); restoreModalDom();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
}

test("a citation comment popup respects the current Escape owner and survives keys targeting its covered field", async () => fixture(async f => {
	assert.equal(f.controller.getTopLayer()?.kind, "popup");
	const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
	const uncover = await f.cover();
	await f.escape(area);
	assert.equal(f.dismissals(), 0);
	await uncover();
	await f.escape();
	assert.equal(f.dismissals(), 1);
	assert.equal(document.querySelector("[data-testid='citation-comment-popover']"), null);
}, true));

test("the sent citation quote card has a real Escape owner; a covering modal cannot close it", async () => fixture(async f => {
	await act(async () => document.querySelector<HTMLButtonElement>("[data-testid='citation-chip'] button")!.click());
	assert.equal(f.controller.getTopLayer()?.kind, "popup");
	assert.ok(document.querySelector("[data-testid='citation-quote-card']"));
	const uncover = await f.cover();
	await f.escape();
	assert.ok(document.querySelector("[data-testid='citation-quote-card']"));
	await uncover();
	const escape = await f.escape();
	assert.equal(escape.defaultPrevented, true);
	assert.equal(document.querySelector("[data-testid='citation-quote-card']"), null);
	assert.equal(f.controller.getTopLayer(), null);
}));
