import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RenameRow } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

const dom = parseHTML("<html><head></head><body></body></html>");
dom.window.HTMLInputElement.prototype.select = function () {};
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

async function key(target: Element, name: string, extra: Record<string, unknown> = {}) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	for (const [prop, value] of Object.entries({ key: name, keyCode: name === "Enter" ? 13 : 27, isComposing: false, ...extra })) Object.defineProperty(event, prop, { value });
	await act(async () => { target.dispatchEvent(event); });
}

it("session rename leaves Enter and Escape to an IME that is still composing", async () => {
	const chat = { id: "c1", title: "Wave mechanics", updatedAt: new Date().toISOString(), busy: false } as unknown as ChatListItem;
	let cancels = 0, blurs = 0;
	dom.window.HTMLElement.prototype.blur = function () { blurs++; };
	const host = document.createElement("div"); document.body.appendChild(host);
	const root = createRoot(host);
	try {
		await act(async () => { root.render(<RenameRow chat={chat} onCommit={() => {}} onCancel={() => { cancels++; }} />); });
		const input = document.querySelector('[data-testid="session-rename-input"]')!;
		// Chrome on macOS: a Korean Enter arrives as keyCode 229 while the last syllable composes.
		await key(input, "Enter", { isComposing: true, keyCode: 229 });
		// A Japanese Escape cancels the conversion, not the rename.
		await key(input, "Escape", { isComposing: true, keyCode: 229 });
		assert.equal(blurs, 0, "a composing Enter does not end the rename");
		assert.equal(cancels, 0, "a composing Escape does not discard the rename");
		await key(input, "Enter");
		assert.equal(blurs, 1, "the Enter after the composition commits as before");
		await key(input, "Escape");
		assert.equal(cancels, 1, "a plain Escape still discards");
	} finally { await act(async () => { root.unmount(); }); }
});
