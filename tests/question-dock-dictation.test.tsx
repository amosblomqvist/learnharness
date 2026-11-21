import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { AskToolInput, QuizToolInput } from "../src/core/question-core.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const quiz: QuizToolInput = { question: "Pick", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "" } as QuizToolInput;
const explain = { question: "Explain it" } as AskToolInput;

async function dock(props: Partial<React.ComponentProps<typeof QuestionDock>>) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	let prepared = 0;
	const render = (next: Partial<React.ComponentProps<typeof QuestionDock>>) => act(async () => root.render(
		<QuestionDock toolName="quiz" toolCallId="q1" input={quiz} expanded onExpand={() => {}} onSubmit={() => {}}
			onPrepareSubmission={() => { prepared++; }} {...props} {...next} />));
	await render({});
	const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
	return { host, submit, render, get prepared() { return prepared; }, close: () => act(async () => { root.unmount(); host.remove(); }) };
}

test("Submit is enabled while dictating into an empty field and reaches the prepared path", async () => {
	for (const props of [{ toolName: "ask_user_question" as const, input: explain }, { toolName: "quiz" as const, input: quiz }]) {
		const d = await dock(props);
		try {
			assert.equal(d.submit().disabled, true);
			await d.render({ dictating: true });
			assert.equal(d.submit().disabled, false);
			await act(async () => { d.submit().closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
			assert.equal(d.prepared, 1);
		} finally { await d.close(); }
	}
});

test("thinking without a clicked option submits and says the option is read from it", async () => {
	const d = await dock({});
	try {
		await act(async () => {
			const editor = d.host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
			editor.textContent = "I'd say yes";
			editor.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		assert.equal(d.submit().disabled, false);
		assert.match(d.host.textContent!, /option read from your thinking/);
		await d.render({ onPrepareSubmission: undefined });
		assert.equal(d.submit().disabled, true, "the unprepared path still needs a click");
	} finally { await d.close(); }
});
