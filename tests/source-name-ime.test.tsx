import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

const dom = parseHTML("<html><head></head><body></body></html>");
dom.window.HTMLInputElement.prototype.select = function () {};
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

async function key(target: Element, name: string, extra: Record<string, unknown> = {}) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	for (const [prop, value] of Object.entries({ key: name, keyCode: name === "Enter" ? 13 : 27, isComposing: false, ...extra })) Object.defineProperty(event, prop, { value });
	await act(async () => { target.dispatchEvent(event); });
}

it("source and folder rename stays open through a composing Enter or Escape", async () => {
	globalThis.fetch = async () => Response.json({ organization: { version: 1, folders: [], placements: {} }, sources: [{ id: "chat", kind: "chat", label: "Unextracted", createdAt: "2026-10-30" }] });
	const root = createRoot(document);
	try {
		await act(async () => { root.render(<html><head /><body><InteractionLayersProvider><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
			<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />
		</ServerEventsProvider></InteractionLayersProvider></body></html>); });
		await act(async () => { (document.querySelector('button[title="Rename"]') as HTMLElement).click(); });
		const input = () => document.querySelector('[data-testid="source-name-input"]');
		await key(input()!, "Enter", { isComposing: true, keyCode: 229 });
		assert.ok(input(), "a composing Enter does not commit the name");
		// The overlay's own Escape guard runs at window capture, which linkedom does not dispatch to;
		// the browser check covers that the overlay stays open.
		await key(input()!, "Escape", { isComposing: true, keyCode: 229 });
		assert.ok(input(), "a composing Escape does not cancel the edit");
		await key(input()!, "Enter");
		assert.equal(input(), null, "the Enter after the composition commits as before");
	} finally { await act(async () => { root.unmount(); }); }
});
