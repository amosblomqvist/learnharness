import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingTurnIndicator } from "../components/chat.tsx";
import { SessionModel, type SessionState } from "../components/session-core.ts";
import type { ChatInput, LhMessage, PluginProblemSnapshot, PluginQuestionSnapshot } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const deferred = <T,>() => {
	let resolve!: (value: T) => void, reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};
const occurrence = { messageId: "pose", contentIndex: 0, toolCallId: "call", toolName: "custom_pose" };

async function fixture(kind: "question" | "practice", enabled = true) {
	// Deliberately not the coding plugin: only frozen host capability flags
	// decide the label, never plugin identity or similarly named payload fields.
	const payload = { requiresGrading: true, requiresProcessing: true };
	const question: PluginQuestionSnapshot = {
		protocolVersion: enabled ? 2 : 1, ...(enabled ? { requiresGrading: true as const } : {}),
		questionId: "q", pluginId: "arbitrary-plugin", typeId: "custom", label: "Custom", variant: "probe", contractVersion: 1, occurrence,
		input: { question: "Question", payload }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: true, requiresAnswerRefinement: false,
	};
	const problem: PluginProblemSnapshot = {
		protocolVersion: 1, problemId: "p", pluginId: "arbitrary-plugin", typeId: "custom", label: "Custom", contractVersion: 1,
		input: { statement: "Problem", mode: "composition", modelSolution: "Committed solution", payload },
		problemSchema: { type: "object" }, submissionSchema: { type: "string" }, requiresProcessing: enabled, requiresSubmissionRefinement: false,
	};
	const messages = (kind === "question" ? [{ id: "pose", role: "assistant", content: [{ type: "toolCall", id: "call", name: occurrence.toolName, arguments: question.input }], lhQuestions: { "0": question } }]
		: [{ id: "pose", role: "assistant", content: [{ type: "toolCall", id: "call", name: occurrence.toolName, arguments: problem.input }] },
			{ id: "ack", role: "toolResult", toolCallId: "call", toolName: occurrence.toolName, content: [], isError: false, details: { pluginProblem: problem } }]) as unknown as LhMessage[];
	const input: ChatInput = kind === "question" ? { type: "plugin-question-answer", questionId: "q", occurrence, answer: "learner input", thinking: "learner thinking" }
		: { type: "plugin-problem-submission", problemId: "p", occurrence, submission: "learner input", thinking: "learner thinking" };
	const posts: ReturnType<typeof deferred<Response>>[] = [], streams: ReturnType<typeof deferred<Response>>[] = [];
	const streamStarted = deferred<void>();
	const frames: SessionState[] = [];
	const model = new SessionModel({ chatId: "fixture", initialMessages: messages, onChange: () => frames.push(model.getState()), fetch: async (url, init) => {
		if (init?.method === "POST") { const post = deferred<Response>(); posts.push(post); return post.promise; }
		if (String(url).endsWith("/stream")) { const stream = deferred<Response>(); streams.push(stream); streamStarted.resolve(); return stream.promise; }
		assert.equal(String(url), "/api/chats/fixture");
		return Response.json({ messages, pluginQuestionAvailability: { questionId: "q", status: "available" }, pluginProblemAvailability: { problemId: "p", status: "available" } });
	} });
	await model.reconcile();
	const draft = kind === "question" ? model.pluginQuestionDraft(question) : model.pluginProblemDraft(problem);
	draft.thinking = "retained draft thinking";
	return { model, input, posts, streams, streamStarted, frames, draft };
}

for (const kind of ["question", "practice"] as const) {
	test(`${kind}: first busy frame evaluates, acknowledgement restores thinking before stream connection`, async () => {
		const f = await fixture(kind);
		assert.equal(f.model.getState().evaluating, false);
		let accepted = 0;
		const sending = f.model.send(f.input, () => { accepted++; assert.equal(f.model.getState().evaluating, false); });
		assert.equal(f.model.status, "submitted"); assert.equal(f.model.readyRef, false);
		assert.equal(f.model.getState().evaluating, true);
		assert.equal(f.frames.find(frame => frame.status === "submitted")!.evaluating, true, "No initial Thinking frame for an evaluating action");
		assert.equal(await f.model.send(f.input), false); assert.equal(f.posts.length, 1, "Busy gate is unchanged");
		assert.equal(accepted, 0, "Evaluation is not acceptance");
		f.posts[0]!.resolve(Response.json({ ok: true }));
		await f.streamStarted.promise;
		assert.equal(accepted, 1); assert.equal(f.model.status, "submitted");
		assert.equal(f.model.getState().evaluating, false, "Thinking covers the provider/stream connection gap");
		f.streams[0]!.resolve(new Response("data: [DONE]\n\n")); await sending;
		assert.equal(f.model.status, "ready"); assert.equal(f.model.getState().evaluating, false);
		assert.equal(f.draft.thinking, "retained draft thinking", "Presentation never clears learner input");
	});

	test(`${kind}: no optional step keeps Thinking despite misleading plugin payload fields`, async () => {
		const f = await fixture(kind, false); const sending = f.model.send(f.input);
		assert.equal(f.posts.length, 1); assert.equal(f.model.status, "submitted");
		assert.equal(f.model.getState().evaluating, false);
		f.posts[0]!.resolve(new Response("Refused", { status: 400 })); await sending;
		assert.ok(f.frames.every(frame => !frame.evaluating));
	});

	for (const failure of ["busy", "refused", "network"] as const) test(`${kind}: ${failure} clears evaluation without retrying or clearing the draft`, async () => {
		const f = await fixture(kind); let accepted = 0;
		const sending = f.model.send(f.input, () => { accepted++; });
		assert.equal(f.model.getState().evaluating, true);
		if (failure === "network") f.posts[0]!.reject(new Error("Connection lost"));
		else f.posts[0]!.resolve(new Response("Refused", { status: failure === "busy" ? 409 : 400 }));
		assert.equal(await sending, false);
		assert.equal(f.model.getState().evaluating, false); assert.equal(f.model.status, "error");
		assert.equal(accepted, 0); assert.equal(f.posts.length, 1); assert.equal(f.streams.length, 0);
		assert.equal(f.draft.thinking, "retained draft thinking");
	});

	for (const outcome of ["accepted", "refused", "network"] as const) test(`${kind}: detached old ${outcome} response cannot clear a newer evaluation`, async () => {
		const f = await fixture(kind); const old = f.model.send(f.input);
		assert.equal(f.model.getState().evaluating, true);
		f.model.stop(); assert.equal(f.model.getState().evaluating, false);
		const current = f.model.send(f.input); assert.equal(f.posts.length, 2);
		assert.equal(f.model.getState().evaluating, true);
		if (outcome === "network") f.posts[0]!.reject(new Error("Old connection lost"));
		else f.posts[0]!.resolve(outcome === "accepted" ? Response.json({ ok: true }) : new Response("Old refusal", { status: 400 }));
		await old;
		assert.equal(f.model.status, "submitted"); assert.equal(f.model.getState().evaluating, true);
		assert.equal(f.model.getState().error, null); assert.equal(f.streams.length, 0);
		f.posts[1]!.resolve(new Response("Current refusal", { status: 400 })); await current;
		assert.equal(f.model.getState().evaluating, false); assert.equal(f.model.status, "error");
	});

	test(`${kind}: returning-view reattach retains Thinking while a local POST is detached`, async () => {
		const f = await fixture(kind); const sending = f.model.send(f.input);
		assert.equal(f.model.getState().evaluating, true);
		const attaching = f.model.resumeStream(false); await f.streamStarted.promise;
		assert.equal(f.model.status, "submitted"); assert.equal(f.model.getState().evaluating, false);
		f.posts[0]!.resolve(Response.json({ ok: true })); await sending;
		assert.equal(f.model.getState().evaluating, false);
		f.streams[0]!.resolve(new Response("data: [DONE]\n\n")); await attaching;
	});
}

test("ordinary text submission keeps the existing Thinking placeholder", async () => {
	const post = deferred<Response>();
	const model = new SessionModel({ chatId: "ordinary", initialMessages: [], fetch: async () => post.promise });
	const sending = model.send({ type: "text", text: "hello" });
	assert.equal(model.status, "submitted"); assert.equal(model.getState().evaluating, false);
	post.resolve(new Response("Refused", { status: 400 })); await sending;
	assert.equal(model.getState().evaluating, false);
});

for (const evaluating of [true, false]) test(`pending indicator renders one unchanged spinner with ${evaluating ? "Evaluating" : "Thinking"} visible and accessible labels`, () => {
	const html = renderToStaticMarkup(<PendingTurnIndicator evaluating={evaluating} />);
	assert.equal((html.match(/data-testid="braille-spinner"/g) ?? []).length, 1);
	assert.match(html, new RegExp(`aria-label="${evaluating ? "Evaluating" : "Thinking"}"`));
	assert.ok(html.includes(evaluating ? "EVALUATING…" : "THINKING…"));
	assert.ok(!html.includes(evaluating ? "THINKING…" : "EVALUATING…"));
});
