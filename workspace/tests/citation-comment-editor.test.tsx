import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CitationCommentEditor, commentDismissalOutcome, commentKeyAction } from "../components/citation-comment-editor.tsx";

const documentFor = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
const key = (over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }>) =>
	({ key: "a", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...over });

describe("commentDismissalOutcome", () => {
	it("Escape always closes without saving", () => {
		assert.equal(commentDismissalOutcome({ reason: "escape", draft: "typed", saved: undefined }), "close");
	});
	it("commits typed text when dismissed by clicking away or leaving", () => {
		assert.equal(commentDismissalOutcome({ reason: "outside", draft: "typed", saved: undefined }), "commit");
		assert.equal(commentDismissalOutcome({ reason: "focus-out", draft: "edited", saved: "old" }), "commit");
	});
	it("closes when nothing changed", () => {
		assert.equal(commentDismissalOutcome({ reason: "outside", draft: null, saved: "old" }), "close");
		assert.equal(commentDismissalOutcome({ reason: "outside", draft: " old ", saved: "old" }), "close");
	});
	it("keeps the popover open instead of dropping an over-length draft", () => {
		assert.equal(commentDismissalOutcome({ reason: "outside", draft: "x".repeat(8_001), saved: undefined }), "keep-open");
	});
});

describe("commentKeyAction", () => {
	it("maps Enter, ⌘/Ctrl+Enter, Shift+Enter and Escape", () => {
		assert.equal(commentKeyAction(key({ key: "Enter" })), "save");
		assert.equal(commentKeyAction(key({ key: "Enter", metaKey: true })), "save-send");
		assert.equal(commentKeyAction(key({ key: "Enter", ctrlKey: true })), "save-send");
		assert.equal(commentKeyAction(key({ key: "Enter", shiftKey: true })), null);
		assert.equal(commentKeyAction(key({ key: "Escape" })), "cancel");
		assert.equal(commentKeyAction(key({ key: "Enter", isComposing: true })), null);
	});
});

describe("CitationCommentEditor", () => {
	it("renders the labelled textarea and both buttons", () => {
		const document = documentFor(<CitationCommentEditor initial={undefined} onDraftChange={() => {}} onSave={() => {}} onCancel={() => {}} />);
		const area = document.querySelector("textarea")!;
		assert.equal(area.getAttribute("aria-label"), "Comment on selected text");
		assert.equal(area.getAttribute("placeholder"), "Add an optional comment...");
		assert.deepEqual([...document.querySelectorAll("button")].map((b) => b.textContent), ["Cancel", "Save"]);
	});
	it("blocks saving an over-length comment and says why", () => {
		const document = documentFor(<CitationCommentEditor initial={"x".repeat(8_001)} onDraftChange={() => {}} onSave={() => {}} onCancel={() => {}} />);
		const save = [...document.querySelectorAll("button")].at(-1)!;
		assert.equal(save.textContent, "Shorten comment");
		assert.ok(save.hasAttribute("disabled"));
		assert.match(document.body.textContent!, /Comments can contain up to 8,000 characters\./);
	});
});
