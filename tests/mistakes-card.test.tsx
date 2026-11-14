/**
 * The Why on an answered card (hidden by default): one collapsed toggle. A
 * miss opens to the error analysis, an "I don't know" to the short Why only,
 * and the pending line shows once opened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
(globalThis as { React?: typeof React }).React = React;
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { MistakesContext } from "../components/mistakes-context.ts";
import type { MistakeRecord } from "../src/core/mistakes.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const answer: QuestionAnswerData = {
	kind: "quiz",
	questionText: "Friction on the block?",
	options: [{ index: 1, label: "69 N" }, { index: 2, label: "50 N" }],
	correctIndices: [2],
	answers: [{ label: "69 N", value: "a", index: 1 }],
	dontKnow: false,
	correct: false,
	explanation: "Static friction balances the pull.",
	answeredAt: "2026-10-27T10:00:00.000Z",
};

const record = (over: Partial<MistakeRecord>): MistakeRecord => ({
	id: "c1:q1", chatId: "c1", kind: "missed", origin: "quiz", question: "q", yourAnswer: "69 N", correctAnswer: "50 N",
	answeredAt: "x", createdAt: "x", sessionTitle: "Friction", sessionKind: "teach", sources: [], status: "ready",
	analysis: { errorType: "setup-error", topic: "static friction", whatYouDid: "You used mu N.", correct: "It is 50 N.", rule: "mu N is the ceiling." },
	...over,
});

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const card = (map: Map<string, MistakeRecord>, mistakeId?: string, a: QuestionAnswerData = answer) => (
	<MistakesContext.Provider value={map}>
		<AnsweredCard answer={a} mistakeId={mistakeId} />
	</MistakesContext.Provider>
);

/** Render, then optionally click the Why toggle; returns the card's HTML. */
async function render(map: Map<string, MistakeRecord>, mistakeId?: string, open = false, a: QuestionAnswerData = answer) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(card(map, mistakeId, a)));
		if (open) {
			const why = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Why");
			assert.ok(why, "the Why toggle is present");
			await act(async () => why.click());
		}
		return host.innerHTML;
	} finally { await act(async () => root.unmount()); host.remove(); }
}

describe("AnsweredCard mistake analysis", () => {
	it("hides the analysis until Why is clicked", async () => {
		const out = await render(new Map([["c1:q1", record({})]]), "c1:q1");
		assert.match(out, /tucked-explanation/);
		assert.doesNotMatch(out, /mistake-why/);
		assert.doesNotMatch(out, /You used mu N\./);
	});
	it("a miss opens to the error type, what happened, what is right, and the rule", async () => {
		const out = await render(new Map([["c1:q1", record({})]]), "c1:q1", true);
		assert.match(out, /data-testid="mistake-why"/);
		assert.match(out, /Setup error/);
		assert.match(out, /You used mu N\./);
		assert.match(out, /It is 50 N\./);
		assert.match(out, /Next time: /);
		assert.match(out, /mu N is the ceiling\./);
	});
	it("an \"I don't know\" opens to the short Why only — no error type, no 'what you did'", async () => {
		const idk = { ...answer, dontKnow: true, answers: [] };
		const out = await render(new Map([["c1:q1", record({ kind: "unanswered" })]]), "c1:q1", true, idk);
		assert.match(out, /data-testid="mistake-why"/);
		assert.match(out, /It is 50 N\./);
		assert.match(out, /mu N is the ceiling\./);
		assert.doesNotMatch(out, /Setup error|mistake-why-type|You used mu N\./);
	});
	it("shows a quiet line while the analysis is being written, once opened", async () => {
		const m = new Map([["c1:q1", record({ status: "pending", analysis: undefined })]]);
		const out = await render(m, "c1:q1", true, { ...answer, explanation: undefined });
		assert.match(out, /Working out why/);
		assert.doesNotMatch(out, /mistake-why"/);
	});
	it("falls back to the teacher's explanation for an unrecorded answer, a failed analysis, or no context", async () => {
		for (const out of [
			await render(new Map(), "c1:q1", true),
			await render(new Map([["c1:q1", record({ status: "failed", analysis: undefined })]]), "c1:q1", true),
		]) {
			assert.doesNotMatch(out, /mistake-why|Working out why/);
			assert.match(out, /Static friction balances the pull\./);
		}
		assert.doesNotMatch(renderToStaticMarkup(<AnsweredCard answer={answer} />), /mistake-why/);
	});
});
