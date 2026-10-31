import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { askUserQuestionTool, createTeacherTools, teachQuizToolFor, teachExplainToolFor } from "../src/agent/tools.ts";
import { createProberAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { planApprovalPending } from "../src/core/plan-approval.ts";
import { hasProbeDone, newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { buildAnswer, normalizeOptions, type QuestionData } from "../src/core/question-core.ts";
import { parseAskInput } from "../src/core/tool-parts.ts";
import { phaseAt3, phaseAt3Lh } from "../src/core/phases.ts";
import { projectView } from "../src/core/view.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";

const ids: string[] = [];
after(() => { for (const id of ids) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true }); });
const review = { purpose: "plan_review" as const, question: "Ce parcours te convient-il ?", options: [
	{ label: "Commencer", value: "accept" }, { label: "Modifier", value: "revise" },
	{ label: "Je préfère poursuivre encore le diagnostic.", value: "probe" },
] };
const quiz = { question: "Which quantity is larger?", options: [{ label: "0.8" }, { label: "0.75" }],
	correctAnswer: "0.8", explanation: "Eight tenths", type: "predict" as const, nodeId: "quantities" };
function call(id: string, name: string, args = {}): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: 1,
	} as LhMessage;
}
function result(id: string, name: string, details: Extract<LhMessage, { role: "toolResult" }>["details"] = { ok: true }): LhMessage {
	return {
		id: `${id}-result`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: 2,
	};
}
const plan = (id: string) => [call(id, "plan_init"), result(id, "plan_init", { ok: true, approvalRequired: true })];
const prefix = [call("done", "probe_done"), result("done", "probe_done"), ...plan("plan"), call("review", "ask_user_question", review)];
function answer(value: string) {
	const parsed = parseAskInput(review)!;
	assert.equal(parsed.purpose, "plan_review", "display parsing preserves the workflow purpose");
	const question: QuestionData = { id: "review", kind: "ask", question: parsed.question,
		mode: "single-select", options: normalizeOptions(parsed.options), createdAt: new Date().toISOString() };
	return buildAnswer(question, { values: [value], thinking: "My foundations still need diagnosis." }, "ask_user_question");
}
function newChat(messages = prefix) {
	const chat = chatStore.createChat("Plan confirmation regression"); ids.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "quantities", title: "Quantities" }], edges: [], version: 1 });
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

for (const choice of ["accept", "revise", "probe"]) {
	test(`plan review choice ${choice} survives answer transport and reload`, async () => {
		const chatId = newChat();
		const appends = inputAppends({ messages: prefix }, { type: "answer", toolCallId: "review", answer: answer(choice) });
		chatStore.saveMessages(chatId, [...prefix, ...appends]);
		const record = chatStore.getChat(chatId)!;
		assert.equal(planApprovalPending(record.messages), choice !== "accept");
		assert.equal(hasProbeDone(record.messages), choice !== "probe");
		assert.equal(phaseAt3Lh(record.messages), choice === "probe" ? "probe" : "plan");
		assert.equal(phaseAt3(projectView(record.messages)), choice === "probe" ? "probe" : "plan");
		for (const tool of [teachQuizToolFor({ chatId, chatStore }), teachExplainToolFor({ chatId, chatStore })]) {
			const posed = await tool.execute("attempt", { ...quiz, correctAnswer: tool.name === "quiz" ? "0.8" : "Eight tenths" });
			assert.equal(Boolean(posed.isError), choice !== "accept");
		}
	});
}

test("a review authorizes only its own presentation, and a resumed diagnostic requires fresh approval", () => {
	const accept = newAnswerResult("review", "ask_user_question", answer("accept"));
	assert.equal(planApprovalPending([...prefix, accept]), false);
	assert.equal(planApprovalPending([...prefix, ...plan("replacement"), accept]), true, "stale approval cannot authorize a replacement");
	const reopened = [...prefix, accept, call("resume", "resume_probe"), result("resume", "resume_probe")];
	assert.equal(planApprovalPending(reopened), true);
	assert.equal(planApprovalPending([...reopened, ...plan("replacement")]), true);
	assert.equal(planApprovalPending([]), false, "pre-protocol records retain established behavior");
});

test("dismissal, Other, plain prose and unrelated choices do not authorize the plan", () => {
	for (const change of [{ dismissed: true }, { dontKnow: true }, { other: "continue diagnostic" }, { answers: [] }]) {
		const messages = [...prefix, newAnswerResult("review", "ask_user_question", { ...answer("accept"), ...change })];
		assert.equal(planApprovalPending(messages), true);
	}
	const ordinary = [...prefix.slice(0, -1), call("review", "ask_user_question", { ...review, purpose: undefined }), newAnswerResult("review", "ask_user_question", answer("accept"))];
	assert.equal(planApprovalPending(ordinary), true);
	assert.equal(hasProbeDone([...prefix.slice(0, -1), call("review", "ask_user_question", { ...review, purpose: undefined }), newAnswerResult("review", "ask_user_question", answer("probe"))]), true);
});

test("plan review authoring rejects ambiguous options and multi-select", async () => {
	for (const input of [{ ...review, multiSelect: true }, { ...review, options: review.options.slice(0, 2) }]) {
		assert.equal((await askUserQuestionTool.execute("invalid", input)).isError, true);
	}
	assert.equal(Boolean((await askUserQuestionTool.execute("valid", review)).isError), false);
});

test("presenting a new plan blocks teaching in the same run before results are persisted", async () => {
	const chatId = newChat(prefix.slice(0, 2));
	const tools = createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} });
	const presented = await tools.plan_init!.execute("new-plan", { mermaid: "graph TD\nquantities[Quantities] --> goal[Goal]" });
	assert.equal((presented.details as { approvalRequired: boolean }).approvalRequired, true);
	const posed = await tools.quiz!.execute("premature", quiz);
	assert.equal(posed.isError, true);
	assert.match(JSON.stringify(posed.content), /learner approval/);
});

test("an actual teacher run cannot push past a rejected plan; the selected diagnostic rebuilds a prober", async () => {
	const rejected = [...prefix, newAnswerResult("review", "ask_user_question", answer("probe"))];
	const chatId = newChat(rejected);
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("quiz", quiz, { id: "premature" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "What foundation should we diagnose?" }, { id: "ask" })], { stopReason: "toolUse" }),
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const ctx = { chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} };
	const teacher = createTeacherAgent(ctx, { engine, messages: rejected });
	await teacher.prompt("Continue diagnostic");
	assert.ok(teacher.state.messages.some((m) => m.role === "toolResult" && m.toolCallId === "premature" && m.isError));
	assert.equal(hasProbeDone(rejected), false);
	const prober = createProberAgent(ctx, { engine, messages: rejected });
	assert.ok(prober.state.tools.some((t) => t.name === "probe"));
	assert.equal(prober.state.tools.some((t) => t.name === "quiz"), false);
});

test("the chat handler selects the dedicated prober directly from the submitted French diagnostic choice", async () => {
	process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
	const { handleChatRequest } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const chatId = newChat();
	chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("probe", {
		question: "Which quantity is larger?", options: [{ label: "0.8" }, { label: "0.75" }],
		correctAnswer: "0.8", explanation: "Eight tenths",
	}, { id: "diagnostic-question" })], { stopReason: "toolUse" })]);
	let selectedTeacher: boolean | undefined;
	const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST",
		headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId,
			input: { type: "answer", toolCallId: "review", answer: answer("probe") } }),
	}), (opts) => {
		selectedTeacher = opts.teaching;
		return createProberAgent({ chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} },
			{ ...opts, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	});
	assert.equal(response.status, 200);
	const turn = runningTurn(chatId);
	if (turn) await new Response(turn.subscribe()).text();
	assert.equal(selectedTeacher, false, "routing happens before generation, independent of model interpretation");
	const saved = chatStore.getChat(chatId)!;
	assert.ok(saved.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.name === "probe")));
	assert.equal(phaseAt3Lh(saved.messages), "probe");
	assert.equal(phaseAt3(projectView(saved.messages)), "probe");
});

test("a mid-lesson map rewrite keeps teaching available, but a reopened diagnostic requires another review", async () => {
	const accepted = [...prefix, newAnswerResult("review", "ask_user_question", answer("accept")), call("quiz", "quiz", quiz)];
	const chatId = newChat(accepted);
	const tools = createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {}, deliver: () => {} });
	const rewrite = await tools.plan_init!.execute("rewrite", { mermaid: "graph TD\nquantities[Quantities] --> goal[Goal]" });
	assert.equal((rewrite.details as { approvalRequired: boolean }).approvalRequired, false);
	assert.equal(Boolean((await tools.quiz!.execute("continue", quiz)).isError), false);
	const reopened = [...accepted, call("resume", "resume_probe"), result("resume", "resume_probe"),
		call("done-again", "probe_done"), result("done-again", "probe_done"), ...plan("revised"), call("review-again", "ask_user_question", review)];
	assert.equal(planApprovalPending(reopened), true);
	assert.equal(planApprovalPending([...reopened, newAnswerResult("review-again", "ask_user_question", answer("accept"))]), false);
});
