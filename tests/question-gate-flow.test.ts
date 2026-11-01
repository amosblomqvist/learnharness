/**
 * The pre-delivery gate at the TURN level (#417): a real `handleChatRequest`
 * turn with a scripted teacher model and an injected gate verdict, proving:
 *
 *  - a rejected card never becomes answerable, the tutor sees the problems as
 *    an ordinary tool error, and it re-poses a fixed card in the SAME turn;
 *  - the learner projection shows exactly ONE card (the repaired one) while
 *    the record keeps the rejected attempt and the model context is intact;
 *  - a verifier failure fails OPEN (the card is delivered, the lesson moves);
 *  - the per-turn bounce budget delivers the third pose unverified.
 *
 * No network: the teacher engine is pi-ai's faux core; the gate is a scripted
 * function injected through the teacher tool context (the same seam the
 * composition root uses).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent, composeInstructions } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import {
	danglingQuestionOf,
	malformedQuestionsOf,
	pendingQuestionOf,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import { QUESTION_GATE_REJECTION_HEAD, type QuestionGateFn, type QuestionGateOutcome } from "../src/agent/question-gate.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

// The key-presence turn gate (the chat-flow precedent): a scripted turn pins
// openrouter per chat, and the gate reads env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus", value: "venus" },
		{ label: "Mercury", value: "mercury" },
		{ label: "Mars", value: "mars" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury orbits nearest the sun.",
	type: "check" as const,
	nodeId: "planet-order",
};

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* scratch cleanup, best effort */
		}
	}
});

/** A chat with the per-chat conversation pin and the plan tree the teach quiz
 *  validates nodeId against (the chat-flow setup, verbatim). */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "planet-order", title: "Planet order" }],
		edges: [],
		version: 1,
	});
	createdChats.push(chat.id);
	return chat;
}

function scriptedTeacher(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function quizStep(callId: string, correctAnswer = QUIZ.correctAnswer): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall("quiz", { ...QUIZ, correctAnswer }, { id: callId })], { stopReason: "toolUse" });
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

/** The agent factory seam: the handler hands the native build options; the
 *  test injects the scripted engine AND the gate through the real teacher
 *  tool context the composition root uses. */
function gatedFactory(chatId: string, engine: PiEngine, gate: QuestionGateFn): Parameters<typeof handleChatRequest>[1] {
	return (opts) =>
		createTeacherAgent(
			{ chatId, chatStore, jobStore, spawn: () => {}, questionGate: gate },
			{ engine, messages: opts.messages },
		);
}

/** POST (ack), then drain the turn's SSE body through the reattach stream. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

function fakeGate(outcomes: QuestionGateOutcome[]): { gate: QuestionGateFn; calls: string[] } {
	const calls: string[] = [];
	const gate: QuestionGateFn = async (request) => {
		calls.push(request.tool);
		return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
	};
	return { gate, calls };
}

type ToolResultLike = {
	isError?: boolean;
	details?: { problems?: string[]; questionGate?: boolean };
	content?: Array<{ type: string; text?: string }>;
};

describe("pre-delivery gate — turn integration (#417)", () => {
	it("rejected card → the tutor repairs it in the SAME turn → exactly one answerable card", async () => {
		const chat = createConfiguredChat("Gate flow: repaired in turn");
		// Step 1: a structurally valid card with the wrong key. Step 2: fixed.
		const engine = scriptedTeacher([quizStep("bad-1", "mars"), quizStep("good-1")]);
		const { gate, calls } = fakeGate([
			{ accepted: false, problems: ["The stem asks for the closest planet but correctAnswer names Mars."] },
			{ accepted: true },
		]);

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), gatedFactory(chat.id, engine, gate));

		const saved = chatStore.getChat(chat.id)!;
		// user, assistant(bad call), toolResult(rejection), assistant(fixed call)
		assert.equal(saved.messages.length, 4, "the tutor retried within the same turn");
		const rejection = saved.messages[2] as unknown as ToolResultLike;
		assert.equal((saved.messages[2] as { role?: string }).role, "toolResult");
		assert.equal(rejection.isError, true, "the tutor saw a real tool error");
		assert.equal(rejection.details?.questionGate, true, "the record keeps the gate marker");
		assert.match(rejection.content?.[0]?.text ?? "", /closest planet/);
		assert.match(rejection.content?.[0]?.text ?? "", new RegExp(QUESTION_GATE_REJECTION_HEAD), "the head the projection hides on");

		assert.deepEqual(calls, ["quiz", "quiz"], "both structurally sound cards earned a verdict");

		// The clean card is the pending question; nothing is malformed.
		const pending = pendingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "good-1");
		assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "good-1");
		assert.deepEqual(malformedQuestionsOf(saved.messages), [], "a gate rejection is not a malformed-question recovery case");

		// The learner view carries the repaired card ONLY (the failed attempt
		// is record-only), and the dock's pending scan agrees.
		const view = projectView(saved.messages);
		const questionParts = view.flatMap((message) => message.parts).filter((part) => part.type.startsWith("tool-quiz"));
		assert.equal(questionParts.length, 1, "exactly one learner-visible card");
		assert.equal(questionParts[0]!.toolCallId, "good-1");
		assert.equal(questionParts[0]!.state, "input-available", "the dock arms on the repaired card");
		assert.equal(
			view.flatMap((message) => message.parts).some((part) => part.toolCallId === "bad-1"),
			false,
			"the rejected attempt is hidden from the transcript",
		);
		assert.ok(findPendingToolCall(view as never, pending), "the composer gate sees the repaired question");

		// The turn stopped on the clean pose (not on the rejection).
		assert.equal(isTurnRunning(chat.id), false);
	});

	it("a verifier failure fails open: the card is delivered and answerable", async () => {
		const chat = createConfiguredChat("Gate flow: fail-open");
		const engine = scriptedTeacher([quizStep("call-1")]);
		const gate: QuestionGateFn = async () => {
			throw new Error("verifier unavailable");
		};

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), gatedFactory(chat.id, engine, gate));

		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, 2, "no retry happened — the pose was delivered");
		const pending = pendingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-1", "the learner can answer the card");
		const view = projectView(saved.messages);
		const part = view.flatMap((message) => message.parts).find((p) => p.toolCallId === "call-1");
		assert.equal(part?.state, "input-available");
	});

	it("two rejections are the budget: the third pose is delivered unverified", async () => {
		const chat = createConfiguredChat("Gate flow: bounce budget");
		const engine = scriptedTeacher([quizStep("bad-1", "mars"), quizStep("bad-2", "venus"), quizStep("good-3")]);
		const { gate, calls } = fakeGate([{ accepted: false, problems: ["Key mismatch."] }]);

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), gatedFactory(chat.id, engine, gate));

		const saved = chatStore.getChat(chat.id)!;
		assert.equal(calls.length, 2, "the gate is not consulted past the bounce budget");
		const rejections = saved.messages.filter(
			(message) => (message as { role?: string }).role === "toolResult" && (message as unknown as ToolResultLike).details?.questionGate === true,
		);
		assert.equal(rejections.length, 2, "both rejected attempts stay in the record (audit trail)");
		const pending = pendingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "good-3", "the third card is delivered and answerable");
		const view = projectView(saved.messages);
		const parts = view.flatMap((message) => message.parts).filter((part) => part.type.startsWith("tool-quiz"));
		assert.equal(parts.length, 1);
		assert.equal(parts[0]!.toolCallId, "good-3");
	});
});

// #418's runtime half is deliberately prompt doctrine (the gate is #417 only):
// pin the rule in the composed TEACHER source prompt so a later prompt edit
// cannot silently drop the one-step-one-check discipline.
describe("teaching prompt — the one-new-idea rule (#418)", () => {
	it("the teacher's composed prompt carries the one-new-idea rule; the prober's does not", () => {
		const teacher = composeInstructions("teacher");
		assert.match(teacher, /One new idea per checking turn/);
		assert.match(teacher, /check the most load-bearing one/);
		const prober = composeInstructions("prober");
		assert.doesNotMatch(prober, /One new idea per checking turn/);
	});
});
