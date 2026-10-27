/**
 * Learning UI in Spanish — the question dock and the sub-agent dispatch
 * card render their Spanish strings inside an es LocaleProvider and stay
 * English without one (the default every other render test relies on).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../components/locale.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import type { JobRecord } from "../src/core/contracts.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

const quizDock = () => (
	<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}} />
);

const refusedDispatch = () => {
	const now = new Date().toISOString();
	const job: JobRecord = {
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "error",
		activity: "",
		error: "No model configured — set up your models first (missing: cheap)",
		createdAt: now,
		updatedAt: now,
	};
	return (
		<JobsContext.Provider value={[job]}>
			<DispatchCard toolCallId="t1" kind="research" />
		</JobsContext.Provider>
	);
};

describe("learning UI in Spanish", () => {
	it("renders the quiz dock in Spanish inside an es provider", () => {
		const html = renderToStaticMarkup(<LocaleProvider locale="es">{quizDock()}</LocaleProvider>);
		for (const text of ["Comprobación", "No lo sé", "Confianza", "TU PENSAMIENTO", "Enviar respuesta", "50 por ciento"]) {
			assert.ok(html.includes(text), `missing ${JSON.stringify(text)}`);
		}
		assert.ok(!html.includes("Submit answer"));
		// The model's own words are never translated.
		assert.ok(html.includes("Which planet is closest to the sun?"));
	});

	it("keeps the quiz dock English without a provider", () => {
		const html = renderToStaticMarkup(quizDock());
		for (const text of ["Check", "I don&#x27;t know", "Confidence", "YOUR THINKING", "Submit answer", "50 percent"]) {
			assert.ok(html.includes(text), `missing ${JSON.stringify(text)}`);
		}
		assert.ok(!html.includes("Enviar respuesta"));
	});

	it("translates the dispatch card's label and the server's refusal line at display", () => {
		const es = renderToStaticMarkup(<LocaleProvider locale="es">{refusedDispatch()}</LocaleProvider>);
		assert.ok(es.includes("Agente de investigación"));
		assert.ok(es.includes("requiere configurar un modelo"));
		const en = renderToStaticMarkup(refusedDispatch());
		assert.ok(en.includes("Research agent"));
		assert.ok(en.includes("needs model setup"));
	});
});
