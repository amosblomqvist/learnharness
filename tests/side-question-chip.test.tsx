import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SideQuestionChip } from "../components/side-question-chip.tsx";

const textOf = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document.querySelector('[data-testid="side-question-chip"]')!.textContent!;

describe("SideQuestionChip", () => {
	it("shows the first question, the quoted passage and that the tutor was told", () => {
		const text = textOf(<SideQuestionChip onOpen={() => {}} onTell={async () => true} details={{ thread: [{ question: "Why multiply?", answer: "a", passage: "the derivatives multiply" }, { question: "And?", answer: "b" }], note: "n", toldTutor: true }} />);
		assert.equal(text.replace(/\s+/g, " ").trim(), "Side question: Why multiply? “the derivatives multiply” · told tutor");
	});

	it("offers Tell tutor below the pill only while the thread is private", () => {
		const html = (toldTutor: boolean) => parseHTML(`<html><body>${renderToStaticMarkup(<SideQuestionChip onOpen={() => {}} onTell={async () => true} details={{ thread: [{ question: "Why?", answer: "a" }], note: "n", toldTutor }} />)}</body></html>`).document;
		assert.equal(html(false).querySelector('[data-testid="side-question-tell"]')!.textContent, "Tell tutor");
		assert.equal(html(true).querySelector('[data-testid="side-question-tell"]'), null);
	});

	it("leaves out the passage and the told mark when there are none", () => {
		const text = textOf(<SideQuestionChip onOpen={() => {}} onTell={async () => true} details={{ thread: [{ question: "Why?", answer: "a" }], note: "n", toldTutor: false }} />);
		assert.equal(text.replace(/\s+/g, " ").trim(), "Side question: Why?");
	});

	it("clips long text at 80 characters", () => {
		const text = textOf(<SideQuestionChip onOpen={() => {}} onTell={async () => true} details={{ thread: [{ question: "q".repeat(200), answer: "a" }], note: "n", toldTutor: false }} />);
		assert.equal(text.replace(/\s+/g, " ").trim(), `Side question: ${"q".repeat(80)}…`);
	});
});
