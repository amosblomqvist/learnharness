import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { SessionModel } from "../components/session-core.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import { pendingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import type { QuizToolInput } from "../src/core/question-core.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

function question(id: string, callId: string, text: string): LhMessage {
	return { id, role: "assistant", content: [{ type: "toolCall", id: callId, name: "quiz", arguments: {
		question: text, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "Yes is correct.",
	} }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage;
}

// The same keyed-content boundary as Chat's DockOverlay. This exercises the
// actual form state under synthetic DOM, not CSS layout or a live provider.
for (const reusedId of [false, true]) {
	test(`question form resets on a newer question (${reusedId ? "reused" : "unique"} call id)`, async () => {
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		const render = async (messages: LhMessage[]) => {
			const pending = pendingQuestionOf(messages)!;
			await act(async () => root.render(<QuestionDock key={`question:${pending.key}`}
				toolName="quiz" toolCallId={pending.toolCallId} input={pending.input as QuizToolInput}
				expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
		};
		try {
			const old = question("old", "q1", "OLD question");
			await render([old]);
			const oldForm = host.querySelector('[data-testid="question-dock"]');
			await act(async () => { host.querySelector<HTMLButtonElement>('[role="radio"]')!.click(); });
			assert.ok(host.querySelector('[role="radio"][aria-checked="true"]'));
			await render([old, question("new", reusedId ? "q1" : "q2", "NEW question")]);
			assert.notEqual(host.querySelector('[data-testid="question-dock"]'), oldForm);
			assert.equal(host.querySelector('[role="radio"][aria-checked="true"]'), null);
			assert.match(host.textContent!, /NEW question/);
			assert.doesNotMatch(host.textContent!, /OLD question/);
		} finally { await act(async () => root.unmount()); host.remove(); }
	});
}

test("live question validation → turn_end placeholder → canonical sync keeps the same form and typed reasoning", async () => {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const encoder = new TextEncoder();
	let wire!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
	const model = new SessionModel({ chatId: "fixture", initialMessages: [], fetch: async () => new Response(body) });
	let submitted: { thinking?: string } | undefined;
	const render = () => {
		const state = model.getState();
		const pending = findPendingToolCall(state.messages, pendingQuestionOf(state.nativeMessages));
		root.render(pending ? <QuestionDock key={`question:${pending.key}`}
			toolName="quiz" toolCallId={pending.toolCallId} input={pending.input as QuizToolInput}
			expanded onExpand={() => {}} onSubmit={answer => { submitted = answer; }} dictationClaim={false} /> : null);
	};
	model.onChange = render;
	const event = async (value: unknown) => {
		await act(async () => { wire.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); });
	};
	let consume: Promise<void> | undefined;
	try {
		await act(async () => { consume = model.resumeStream(false); });
		const saved = question("saved", "q1", "Streamed question");
		const { id: _savedId, ...message } = saved;
		await event({ type: "message_start", message });
		await event({ type: "message_end", message });
		assert.equal(host.querySelector('[data-testid="question-dock"]'), null, "validation still gates the form");
		await event({ type: "tool_execution_end", toolCallId: "q1", toolName: "quiz", isError: false,
			result: { content: [{ type: "text", text: "Question posed" }], details: null } });
		const form = host.querySelector('[data-testid="question-dock"]');
		assert.ok(form);
		const occurrence = pendingQuestionOf(model.getState().nativeMessages)!;
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
			const editor = host.querySelector<HTMLElement>('[data-testid="thinking-field"] [data-file-path-input]')!;
			editor.textContent = "Keep my typed reasoning";
			editor.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await event({ type: "turn_end", message, toolResults: [{ role: "toolResult", toolCallId: "q1", toolName: "quiz",
			content: [{ type: "text", text: "Question posed" }], details: null, isError: false, timestamp: 1 }] });
		assert.ok(host.querySelector('[data-testid="question-dock"]') === form, "placeholder must never unmount the form");
		assert.deepEqual(pendingQuestionOf(model.getState().nativeMessages), occurrence, "exact native occurrence stays pending");
		await act(async () => { model.setMessages([saved]); });
		assert.ok(host.querySelector('[data-testid="question-dock"]') === form, "canonical save must not reset the form either");
		assert.ok(host.querySelector('[role="radio"][aria-checked="true"]'));
		assert.equal(host.querySelector('[data-testid="thinking-field"] [data-file-path-input]')!.textContent, "Keep my typed reasoning");
		await act(async () => { host.querySelector('form')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
		assert.equal(submitted?.thinking, "Keep my typed reasoning", "the React form state, not only DOM text, survived");
	} finally {
		await act(async () => {
			wire.enqueue(encoder.encode("data: [DONE]\n\n")); wire.close();
			await consume;
			root.unmount();
		});
		model.onChange = undefined;
		host.remove();
	}
});

test("saving a unique live question preserves its mounted form and selection", async () => {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const live = question("c_live", "unique-q", "Same question");
	const saved = { ...live, id: "saved" };
	const render = async (messages: LhMessage[]) => {
		const pending = pendingQuestionOf(messages)!;
		await act(async () => root.render(<QuestionDock key={`question:${pending.key}`}
			toolName="quiz" toolCallId={pending.toolCallId} input={pending.input as QuizToolInput}
			expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
	};
	try {
		await render([live]);
		const form = host.querySelector('[data-testid="question-dock"]');
		await act(async () => { host.querySelector<HTMLButtonElement>('[role="radio"]')!.click(); });
		// Append-only adoption can briefly retain the live copy beside the saved one.
		await render([saved, live]);
		await render([saved]);
		assert.equal(host.querySelector('[data-testid="question-dock"]'), form);
		assert.ok(host.querySelector('[role="radio"][aria-checked="true"]'));
	} finally { await act(async () => root.unmount()); host.remove(); }
});
