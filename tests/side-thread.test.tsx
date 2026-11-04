import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { noteStatus, parseBtw, SideThreadBody, sideThreadPlaceholder, createSideQuestionActions } from "../components/side-thread.tsx";
import type { SideThreadState } from "../components/use-side-thread.ts";
import { CitationActionsContext } from "../components/citation-chip.tsx";

const noop = () => {};
const handlers = { onAsk: noop, onSetTell: noop, onExpand: noop, onClose: noop };
const base: SideThreadState = { threadId: "side_1", pairs: [], draft: null, learnerTell: null, mode: "popover", anchor: { kind: "composer" } };
const answered: SideThreadState = { ...base, pairs: [{ question: "Why multiply?", answer: "The rates compose.", passage: "the derivatives multiply", tell: true, note: "Already clarified: chain rule." }] };

function documentFor(state: SideThreadState) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<SideThreadBody state={state} {...handlers} />)}</body></html>`).document;
}

describe("parseBtw", () => {
	it("recognizes the command and its question", () => {
		assert.deepEqual(parseBtw("/btw why multiply?"), { question: "why multiply?" });
		assert.deepEqual(parseBtw("  /btw   spaced  "), { question: "spaced" });
		assert.deepEqual(parseBtw("/btw"), { question: "" });
		assert.deepEqual(parseBtw("/btw\nmultiline\nquestion"), { question: "multiline\nquestion" });
		assert.equal(parseBtw("/btwx"), null);
		assert.equal(parseBtw("by the way /btw"), null);
	});
});

describe("SideThreadBody", () => {
	it("shows the header, the pair, the note and what happens to it", () => {
		const document = documentFor(answered);
		assert.match(document.body.textContent!, /Side question/);
		assert.match(document.body.textContent!, /Why multiply\?/);
		assert.match(document.body.textContent!, /the derivatives multiply/);
		assert.match(document.body.textContent!, /Already clarified: chain rule\./);
		assert.equal(document.querySelector('[data-testid="side-note-status"]')!.textContent, "Sent to the tutor when you close·Don't send");
		assert.equal(document.querySelector('[role="switch"]'), null);
		assert.deepEqual([...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")), ["Expand", "Close"]);
	});

	it("follows the learner's choice and hides Expand in the panel", () => {
		const document = documentFor({ ...answered, learnerTell: false, mode: "panel" });
		assert.equal(document.querySelector('[data-testid="side-note-status"]')!.textContent, "Kept private·Send to tutor");
		assert.equal(document.querySelector('button[aria-label="Expand"]'), null);
	});

	it("clamps a long note to two lines with Show more", () => {
		const long = { ...answered, pairs: [{ ...answered.pairs[0]!, note: "word ".repeat(60) }] };
		const document = documentFor(long);
		assert.match(document.querySelector('[data-testid="side-note"] p')!.getAttribute("class")!, /line-clamp-2/);
		assert.ok([...document.querySelectorAll("button")].some((b) => b.textContent === "Show more"));
		assert.ok(![...documentFor(answered).querySelectorAll("button")].some((b) => b.textContent === "Show more"), "a short note has no link");
	});

	it("reopened read-only: you can ask a follow-up, and a private thread can still be told", () => {
		const readOnly = { ...answered, readOnly: { thread: [{ question: "Why multiply?", answer: "x" }], note: "n", toldTutor: false } };
		const document = parseHTML(`<html><body>${renderToStaticMarkup(<SideThreadBody state={readOnly} {...handlers} onTellTutor={noop} />)}</body></html>`).document;
		assert.equal(document.querySelector('[data-testid="side-thread-input"]')!.getAttribute("placeholder"), "Ask a follow-up…");
		assert.equal(document.querySelector('[data-testid="side-note-status"]')!.textContent, "Kept private·Tell tutor");
		assert.deepEqual(noteStatus({ ...readOnly, readOnly: { ...readOnly.readOnly, toldTutor: true } }), { text: "Told the tutor" });
	});

	it("makes the header a drag handle only in the popover", () => {
		const html = (drag: boolean) => parseHTML(`<html><body>${renderToStaticMarkup(<SideThreadBody state={answered} {...handlers} {...(drag ? { onDragStart: noop } : {})} />)}</body></html>`).document;
		assert.match(html(true).querySelector('[data-testid="side-thread-header"]')!.getAttribute("class")!, /cursor-grab/);
		assert.doesNotMatch(html(false).querySelector('[data-testid="side-thread-header"]')!.getAttribute("class")!, /cursor-grab/);
	});

	it("links a quote back to the tutor text when its source is known", () => {
		const selector = { start: 4, end: 28, prefix: "and ", suffix: " here" };
		const linked = { ...answered, pairs: [{ ...answered.pairs[0]!, sourceMessageId: "msg_1", selector }] };
		const html = (state: SideThreadState) => parseHTML(`<html><body>${renderToStaticMarkup(
			<CitationActionsContext.Provider value={{ openSource: noop }}>
				<SideThreadBody state={state} chatId="chat_1" {...handlers} />
			</CitationActionsContext.Provider>,
		)}</body></html>`).document;
		assert.match(html(linked).querySelector('[data-testid="side-passage-link"]')!.textContent!, /the derivatives multiply/);
		const textOnly = { ...answered, pairs: [{ ...answered.pairs[0]!, sourceMessageId: "msg_1" }] };
		assert.ok(html(textOnly).querySelector('[data-testid="side-passage-link"]'), "older threads link by text");
		assert.equal(html(answered).querySelector('[data-testid="side-passage-link"]'), null, "no source message, plain quote");
	});

	it("shows the answer streaming in", () => {
		const document = documentFor({ ...base, draft: { question: "q?", answer: "", activity: "read notes.md" } });
		assert.match(document.body.textContent!, /read notes\.md/);
	});
});

describe("sideThreadPlaceholder", () => {
	it("follows the thread's state", () => {
		assert.equal(sideThreadPlaceholder(base), "Ask a side question…");
		assert.equal(sideThreadPlaceholder({ ...base, pendingPassage: { text: "p", sourceMessageId: "m" } }), "Ask about this passage…");
		assert.equal(sideThreadPlaceholder(answered), "Ask a follow-up…");
		assert.equal(sideThreadPlaceholder({ ...base, pairs: Array.from({ length: 20 }, () => answered.pairs[0]!) }), "This side thread is full. Close it to start a new one.");
	});
});

describe("createSideQuestionActions", () => {
	it("offers Ask with no thread open, and New question / Add to question with one", () => {
		let open = false;
		const actions = createSideQuestionActions({ threadOpen: () => open, open: noop, addPassage: noop });
		const capture = { messageId: "m", range: {} as Range, selector: { text: "x", start: 0, end: 1, prefix: "", suffix: "" } };
		assert.deepEqual(actions.filter((a) => a.visible(capture)).map((a) => a.label), ["Ask"]);
		open = true;
		assert.deepEqual(actions.filter((a) => a.visible(capture)).map((a) => a.label), ["New question", "Add to question"]);
		const long = { ...capture, selector: { ...capture.selector, text: "x".repeat(8_001) } };
		assert.equal(actions[0]!.disabledLabel!(long), "Shorten selection");
	});
});
