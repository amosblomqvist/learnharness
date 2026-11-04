/**
 * The composer surface under the i18n provider: the composer row, the
 * question dock and the answered card render Spanish copy inside
 * <I18nProvider initialLanguage="es">, and English with no provider.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../components/i18n.tsx";
import { Composer } from "../components/composer.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { AbortTurnBody } from "../components/abort-turn-dialog.tsx";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function quizQD(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

const es = (node: React.ReactNode) =>
	renderToStaticMarkup(<I18nProvider initialLanguage="es">{node}</I18nProvider>);

const composer = (
	<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend nextProblem={false} />
);
const dock = (
	<QuestionDock
		toolName="quiz"
		toolCallId="q1"
		input={quizInput as never}
		expanded
		onExpand={() => {}}
		onSubmit={() => {}}
	/>
);
const answered = <AnsweredCard answer={buildAnswer(quizQD(), { values: ["Venus"], thinking: "Hot planet" })} />;
const abort = <AbortTurnBody mode="question" onClose={() => {}} onConfirm={() => {}} busy />;

describe("composer surface in Spanish", () => {
	it("the composer row", () => {
		const html = es(composer);
		assert.ok(html.includes('placeholder="Pregunta, responde o guía la lección…"'));
		assert.ok(html.includes('aria-label="Enviar"'));
	});

	it("the question dock", () => {
		const html = es(dock);
		assert.ok(html.includes(">Comprobación<"));
		assert.ok(html.includes("No lo sé"));
		assert.ok(html.includes(">Confianza<"));
		assert.ok(html.includes("TU RAZONAMIENTO"));
		assert.ok(html.includes('aria-valuetext="50 por ciento"'));
		assert.ok(html.includes("Enviar respuesta"));
	});

	it("the answered card and the abort dialog", () => {
		const card = es(answered);
		assert.ok(card.includes(">incorrecta<"));
		assert.ok(card.includes(">Por qué<"));
		const dialog = es(abort);
		assert.ok(dialog.includes("¿Descartar esta pregunta?"));
		assert.ok(dialog.includes("Omitida — el profesor sigue sin ella. El turno en curso también se detiene."));
		assert.ok(dialog.includes(">Cancelar<"));
	});
});

describe("composer surface without a provider", () => {
	it("renders English", () => {
		assert.ok(renderToStaticMarkup(composer).includes('placeholder="Ask, answer, or steer the lesson…"'));
		const dockHtml = renderToStaticMarkup(dock);
		assert.ok(dockHtml.includes(">Check<"));
		assert.ok(dockHtml.includes("Submit answer"));
		assert.ok(renderToStaticMarkup(answered).includes(">incorrect<"));
		assert.ok(renderToStaticMarkup(abort).includes("Dismiss this question?"));
	});
});
