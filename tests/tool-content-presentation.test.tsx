import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { answerForPresentation, buildAnswer, normalizeOptions, parseAskInput, parseExplainInput, parseQuizInput,
	repairMathForDisplay, resolveCorrect, type QuestionAnswerData, type QuestionData } from "../src/core/index.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/tool-rendering/matrix-regressions.json", import.meta.url), "utf8")) as {
	cases: Array<{ chatId: string; source: string; raw: string; oldDisplay: string }>;
};
const a = String.raw`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`;
const b = String.raw`$\begin{pmatrix}p&q\\r&s\end{pmatrix}$`;
const brokenA = a.replace(String.raw`\\c`, String.raw`\c`);
const brokenB = b.replace(String.raw`\\r`, String.raw`\r`);
const doubled = String.raw`$\\nabla f$`;
const input = { question: a, options: [{ label: a, value: "a" }, { label: b, value: "b" }], correctAnswer: "a", explanation: a };
const dom = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;
const render = (text: string, recovered = true) => renderToStaticMarkup(
	recovered ? <ToolContentResponse mode="static">{text}</ToolContentResponse> : <MessageResponse mode="static">{text}</MessageResponse>);
const tex = (html: string) => [...dom(html).querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent);

for (const fixture of fixtures.cases) test(`preserves corpus matrix rows: ${fixture.chatId} ${fixture.source}`, () => {
	assert.notEqual(fixture.raw, fixture.oldDisplay);
	assert.equal(repairMathForDisplay(fixture.raw), fixture.raw);
	const expected = dom(render(fixture.raw, false));
	const actual = dom(render(fixture.raw));
	assert.deepEqual(tex(actual.body.innerHTML), tex(expected.body.innerHTML));
	assert.equal(actual.querySelectorAll("mtr").length, expected.querySelectorAll("mtr").length);
	assert.ok(actual.querySelectorAll("mtr").length > dom(render(fixture.oldDisplay, false)).querySelectorAll("mtr").length);
	assert.equal(actual.querySelectorAll(".katex-error").length, 0);
});

test("generic nested environments, comments, and bare row-leading command names are protected", () => {
	for (const environment of ["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "array", "aligned", "cases"]) {
		const source = `$\\begin{${environment}}a&b\\\\beta&d\\end{${environment}}$`;
		assert.equal(repairMathForDisplay(source), source);
	}
	const nested = "$$\n" + String.raw`\begin{aligned}x&=\begin{pmatrix}a&b\\c&d\end{pmatrix}\\% \end{aligned} is a comment` + "\n" + String.raw`r&=s\end{aligned}` + "\n$$";
	assert.equal(repairMathForDisplay(nested), nested);
	const spaced = String.raw`$\begin {pmatrix}a&b\\c&d\end {pmatrix}$`;
	assert.equal(repairMathForDisplay(spaced), spaced);
	const mixed = String.raw`$\\lambda+\begin{pmatrix}a&b\\c&d\end{pmatrix}$`;
	assert.equal(repairMathForDisplay(mixed), mixed.replace(String.raw`\\lambda`, String.raw`\lambda`));
});

test("corpus document framing and final-display percentages recover without new errors", () => {
	const cases = JSON.parse(readFileSync(new URL("./fixtures/tool-rendering/document-percent-regressions.json", import.meta.url), "utf8"));
	for (const fixture of cases) {
		const recovered = repairMathForDisplay(fixture.raw);
		const document = dom(render(fixture.raw));
		assert.equal(document.querySelectorAll(".katex-error").length, 0, fixture.chatId);
		assert.equal(repairMathForDisplay(recovered), recovered, fixture.chatId);
		if (fixture.kind === "percent-at-display-end") {
			assert.ok([...document.querySelectorAll(".katex-html")].some(node => node.textContent?.includes("%")), fixture.chatId);
			assert.ok(!recovered.includes("\\\\%"), fixture.chatId);
		} else {
			assert.match(recovered, /\n\$\$\n/);
			assert.match(recovered, /\n\$\$$/);
		}
	}
});
test("mixed-escaped environment markers retain existing recovery rather than treating an opener as native", () => {
	const mixedFixtures = JSON.parse(readFileSync(new URL("./fixtures/tool-rendering/mixed-escaping-regressions.json", import.meta.url), "utf8")) as typeof fixtures;
	assert.equal(mixedFixtures.cases.length, 2);
	for (const fixture of mixedFixtures.cases) {
		const recovered = repairMathForDisplay(fixture.raw);
		assert.equal(repairMathForDisplay(recovered), recovered, fixture.chatId);
		assert.doesNotMatch(recovered, /\\\\end\{/);
		assert.equal(dom(render(fixture.raw)).querySelectorAll(".katex-error").length, 0);
	}
});

test("presentation-equivalent labels cannot make a source-invalid correctAnswer gradeable", () => {
	const source = { question: "Which?", options: [{ label: String.raw`$\nabla f$` }, { label: "no" }],
		correctAnswer: doubled, explanation: "A model-authored identity mismatch" };
	const before = structuredClone(source);
	assert.equal(repairMathForDisplay(doubled), source.options[0]!.label);
	assert.equal(parseQuizInput(source), undefined);
	assert.deepEqual(source, before);
});

test("shape parsers retain source text and identities; recovery is presentation only", () => {
	const quiz = { ...input, question: doubled, explanation: "$\forall x$", options: [{ label: doubled }, { label: "no" }], correctAnswer: doubled };
	const ask = { question: doubled, options: [{ label: doubled, value: doubled, description: doubled }, { label: "no" }] };
	const explain = { question: doubled, correctAnswer: "$\forall x$" };
	const before = structuredClone({ quiz, ask, explain });
	assert.equal(parseQuizInput(quiz)!.question, doubled);
	assert.equal(parseQuizInput(quiz)!.explanation, quiz.explanation);
	assert.equal(parseQuizInput(quiz)!.correctAnswer, doubled);
	assert.deepEqual(parseAskInput(ask), ask);
	assert.deepEqual(parseExplainInput(explain), explain);
	assert.deepEqual(tex(render(doubled)), [String.raw`\nabla f`]);
	assert.deepEqual(tex(render(doubled, false)), [String.raw`\\nabla f`]);
	assert.deepEqual({ quiz, ask, explain }, before);
});

test("the live dock recovers only its rendering, including question, context and option labels", () => {
	const source = { question: doubled, details: doubled, options: [{ label: doubled }, { label: "no" }] };
	const before = structuredClone(source);
	const html = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="source_q" input={source} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.deepEqual(tex(html), Array(3).fill(String.raw`\nabla f`));
	assert.deepEqual(source, before);
});

test("answers snapshot source text, not recovered labels or identities", () => {
	const source = { ...input, question: doubled, explanation: doubled, options: [{ label: doubled }, { label: "no" }], correctAnswer: doubled };
	const parsed = parseQuizInput(source)!;
	const options = normalizeOptions(parsed.options);
	const qd: QuestionData = { id: "source", kind: "quiz", question: parsed.question, mode: "single-select", options,
		correctIndices: resolveCorrect(parsed.correctAnswer, options).indices, explanation: parsed.explanation, createdAt: "synthetic" };
	const answer = buildAnswer(qd, { values: [doubled], confidence: 70 }, "probe");
	assert.equal(answer.questionText, doubled);
	assert.equal(answer.options![0]!.label, doubled);
	assert.equal(answer.answers[0]!.value, doubled);
	assert.equal(answer.answers[0]!.label, doubled);
	assert.equal(answer.explanation, doubled);
	assert.equal(answer.correct, true);
	const before = structuredClone(answer);
	assert.deepEqual(tex(renderToStaticMarkup(<AnsweredCard answer={answer} input={source} />)), Array(2).fill(String.raw`\nabla f`));
	assert.deepEqual(answer, before);
});

function historical(): QuestionAnswerData {
	return { kind: "quiz", questionText: brokenA, options: [{ index: 1, label: brokenB }, { index: 2, label: brokenA }],
		answers: [{ index: 1, label: brokenB, value: "b" }], correct: false, correctIndices: [2], dontKnow: false,
		explanation: brokenA, confidence: 70, answeredAt: "synthetic" };
}
test("historical source join restores matrices while retaining recorded order, answer and grade", () => {
	const answer = historical();
	const before = structuredClone({ answer, input });
	const projection = answerForPresentation(answer, input);
	assert.equal(projection.questionText, a);
	assert.equal(projection.explanation, a);
	assert.deepEqual(projection.options, [{ index: 1, label: b }, { index: 2, label: a }]);
	assert.equal(projection.answers, answer.answers);
	assert.equal(projection.correctIndices, answer.correctIndices);
	assert.equal(projection.correct, false);
	assert.equal(projection.confidence, 70);
	const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
	assert.deepEqual(tex(html), [a.slice(1,-1), b.slice(1,-1), a.slice(1,-1)]);
	assert.match(html, /incorrect/);
	assert.deepEqual({ answer, input }, before);
});

test("historical ambiguous options and absent/invalid original calls retain their snapshots", () => {
	const source = { ...input, options: [...input.options, { label: String.raw`$\begin{matrix}x\\y\end{matrix}$`, value: "c" }] };
	const answer = { ...historical(), answers: [], dontKnow: true, options: [
		{ index: 1, label: brokenB }, { index: 2, label: brokenA }, { index: 3, label: String.raw`$\begin{matrix}x\y\end{matrix}$` },
	] };
	assert.deepEqual(answerForPresentation(answer, source).options, answer.options);
	assert.equal(answerForPresentation(answer, undefined), answer);
	assert.equal(answerForPresentation(answer, { question: a }), answer);
	const dismissed = { kind: "quiz", dismissed: true } as QuestionAnswerData;
	assert.equal(answerForPresentation(dismissed, input), dismissed);
	const before = structuredClone(answer);
	renderToStaticMarkup(<AnsweredCard answer={answer} />);
	assert.deepEqual(answer, before);
});
