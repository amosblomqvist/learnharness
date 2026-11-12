import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { serializeCitation } from "../src/core/citations.ts";
import { asAgentMessages, newThinkingMessage, toLlmMessages } from "../src/core/native-messages.ts";
import { createCiteAction, type CitationEditTarget } from "../components/citation-actions.ts";
import { INSERT_CITATION_EVENT, type InsertCitationDetail } from "../components/path-input.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";

const selector = { text: "Continuity preserves limits.", start: 0, end: 27, prefix: "", suffix: "" };
const link = serializeCitation({ ...selector, version: 1, chatId: "chat", messageId: "lesson", comment: "Why?" });
const answer: QuestionAnswerData = { kind: "quiz", questionText: "Which?", dontKnow: false, answers: [], answeredAt: "2026-11-05T00:00:00Z",
	text: link, thinking: link, readingThinking: link };

describe("Cite in learner thinking fields", () => {
	it("keeps the stored answer raw, but expands each learner-authored model field before JSON encoding", () => {
		const before = structuredClone(answer);
		const compact = compactAnswerForModel(answer);
		for (const key of ["text", "thinking", "thinkingWhileReading"]) {
			assert.match(String(compact[key]), /tutor-quote-1/);
			assert.match(String(compact[key]), /Continuity preserves limits/);
			assert.doesNotMatch(String(compact[key]), /lh-citation:/);
		}
		assert.deepEqual(JSON.parse(JSON.stringify(compact)), compact, "expanded quote blocks remain valid JSON string values");
		assert.deepEqual(answer, before, "citation links remain the durable representation");
	});
	it("expands citations in practice thinking without rewriting the custom message", () => {
		const marker = newThinkingMessage("problem", `My reasoning: ${link}`);
		const before = structuredClone(marker);
		const wire = toLlmMessages(asAgentMessages([marker]));
		assert.equal(wire[0]!.role, "user");
		assert.match(JSON.stringify(wire), /tutor-quote-1/);
		assert.doesNotMatch(JSON.stringify(wire), /lh-citation:/);
		assert.deepEqual(marker, before);
	});
	it("inserts through the chosen thinking host and retains that exact host for comment editing", () => {
		const { document } = parseHTML('<html><body><div data-file-path-input="" contenteditable="true"></div></body></html>');
		const input = document.querySelector<HTMLElement>("div")!;
		let target: CitationEditTarget | undefined;
		input.addEventListener(INSERT_CITATION_EVENT, (event) => {
			const detail = (event as CustomEvent<InsertCitationDetail>).detail;
			detail.onInserted?.({ start: 0, end: detail.link.length, spaceBefore: false, spaceAfter: false });
		});
		const action = createCiteAction({ chatId: "chat", composer: () => input, openEditor: (value) => { target = value; } });
		const capture = { messageId: "lesson", selector, range: document.createRange() };
		assert.equal(action.visible(capture), true);
		assert.equal(action.onSelect(capture), true);
		assert.equal(target?.input, input);
		assert.match(target!.link, /lh-citation:/);
	});
	it("hands the raw citation link to the shared chip-input engine in reading thinking", () => {
		const markup = renderToStaticMarkup(<ReadingThinkingField value={link} revision={0} onChange={() => {}} claim={false} />);
		const doc = parseHTML(`<html><body>${markup}</body></html>`).document;
		const input = doc.querySelector('[data-file-path-input]')!;
		assert.match(input.textContent!, /Tutor quote/);
		assert.doesNotMatch(input.textContent!, /Continuity preserves limits/);
		// PathInput materializes atomic DOM chips on mount, not during SSR.
		// The isolated browser check exercises that mounted behavior.
		assert.equal(input.textContent, link);
	});
});
