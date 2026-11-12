import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Quote } from "lucide-react";
import { SelectionToolbarButtons, runSelectionAction, type SelectionAction } from "../components/selection-toolbar.tsx";
import type { CapturedSelection } from "../components/selection-text.ts";

const capture = { messageId: "m", range: {} as Range, selector: { text: "x", start: 0, end: 1, prefix: "", suffix: "" } } satisfies CapturedSelection;
const action = (over: Partial<SelectionAction>): SelectionAction => ({
	id: "a", label: "A", ariaLabel: "Do A", icon: Quote, visible: () => true, onSelect: () => true, ...over,
});
const documentFor = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;

describe("SelectionToolbarButtons", () => {
	it("shows one button per visible action", () => {
		const document = documentFor(<SelectionToolbarButtons capture={capture} actions={[action({}), action({ id: "b", label: "B", visible: () => false })]} onDone={() => {}} />);
		assert.deepEqual([...document.querySelectorAll("button")].map((b) => b.textContent), ["A"]);
	});

	it("renders a disabled action with its replacement label", () => {
		const document = documentFor(<SelectionToolbarButtons capture={capture} actions={[action({ disabledLabel: () => "Shorten selection" })]} onDone={() => {}} />);
		const button = document.querySelector("button")!;
		assert.equal(button.textContent, "Shorten selection");
		assert.ok(button.hasAttribute("disabled"));
	});
});

describe("toolbar button surface", () => {
	it("is opaque in dark mode too (the outline variant's dark fill is translucent)", () => {
		const document = documentFor(<SelectionToolbarButtons capture={capture} actions={[action({})]} onDone={() => {}} />);
		const classes = document.querySelector("button")!.getAttribute("class")!.split(/\s+/);
		assert.ok(classes.includes("dark:bg-popover"), classes.join(" "));
		assert.ok(!classes.includes("dark:bg-input/30"));
		assert.ok(!classes.includes("dark:hover:bg-input/50"));
	});
});

describe("runSelectionAction", () => {
	it("reports done only when the action handled the selection", () => {
		assert.equal(runSelectionAction(action({ onSelect: () => true }), capture), true);
		assert.equal(runSelectionAction(action({ onSelect: () => false }), capture), false);
		assert.equal(runSelectionAction(action({ disabledLabel: () => "no", onSelect: () => assert.fail("disabled") }), capture), false);
	});
});
