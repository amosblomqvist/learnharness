/**
 * LESSON FLOW (lesson mode) — the scripted integration test, the
 * practice-flow/chat-flow pattern applied to kind:"lesson":
 *
 *   learner opens a lesson chat → (optional) ask_user_question
 *   calibration → plan_init IS the syllabus (one node = one section) →
 *   section document + ONE nodeId-tagged type:"check" exit ticket →
 *   answer → next section.
 *
 * Pins the mode's structural laws: the lesson agent runs from turn 1
 * (no probe_done is ever required or fired), pre-syllabus QUIZ calls are
 * rejected back to the model (nodeId needs the tree — calibration rides
 * ask_user_question), the question stopper ends the turn at the exit
 * ticket, and the phase fold flips plan→teach at the first tagged check.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createLessonAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { PATHS } from "../config.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// The BYOK key-presence gate reads env-first (the chat-flow idiom).
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

/** The syllabus: one node = one section (the mermaid the lesson writes). */
const SYLLABUS = "graph TD\n  signals[What a signal is] --> fourier[The Fourier idea]";

const SECTION_1_CHECK = {
	type: "check",
	nodeId: "signals",
	question: "Why can every signal be built from sine waves?",
	options: [
		{ label: "Sine waves are the only smooth functions" },
		{ label: "Adding sine waves of different frequencies composes any signal" },
		{ label: "Signals are always periodic" },
	],
	correctAnswer: "Adding sine waves of different frequencies composes any signal",
	explanation: "A sum of sinusoids at different frequencies is exactly what the decomposition claims.",
} as const;

const SECTION_2_CHECK = {
	...SECTION_1_CHECK,
	nodeId: "fourier",
	question: "What does the Fourier transform of a pure sine wave look like?",
	options: [
		{ label: "A flat line" },
		{ label: "A single spike at the wave's frequency" },
		{ label: "A circle" },
	],
	correctAnswer: "A single spike at the wave's frequency",
	explanation: "One frequency present means one spike — the transform exposes the recipe's ingredients.",
} as const;

const CALIBRATION = {
	question: "How much calculus have you seen?",
	options: [{ label: "None" }, { label: "Derivatives only" }, { label: "Through integration" }],
} as const;

/** Each step records the prompt it received (the chat-flow capture idiom). */
function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"));
			return typeof step === "function"
				? await (step as (ctx: TranscriptContext) => AssistantMessage)(context)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

/** A configured lesson chat (BYOK turn gate): the record carries NO tree —
 *  the syllabus turn creates it, which is the flow under test. */
function createLessonChat(title: string) {
	const chat = chatStore.createChat(title, "lesson");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

/** The lesson agent factory (the handler's kind branch, test-shaped — the
 *  practice-flow precedent): the TEACHER tool context, real executes. */
function lessonFactory(chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) =>
		createLessonAgent(
			{
				chatId,
				chatStore,
				jobStore,
				spawn: () => {},
				searchAvailable: () => false,
			},
			{ engine, messages: opts.messages },
		);
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return; // settled inside the handler — completion already happened
	await new Response(handle.subscribe()).text();
}

/** The graded answer a client sends for a check quiz. */
function gradedAnswer(input: { question: string; options: ReadonlyArray<{ label: string }>; correctAnswer: string; explanation: string }, values: string[]) {
	const options = normalizeOptions([...input.options]);
	const qd: QuestionData = {
		id: "check",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

const toolCallsOf = (messages: LhMessage[]) =>
	messages.flatMap((m) =>
		m.role === "assistant" ? (m.content ?? []).filter((c) => c.type === "toolCall") : [],
	) as Array<{ name: string; id: string; arguments?: unknown }>;

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

describe("lesson flow (scripted model)", () => {
	it("calibration ask → syllabus via plan_init → section document + tagged exit ticket → answer → next section", async () => {
		const chat = createLessonChat("Test: Fourier for beginners");
		createdChats.push(chat.id);
		const { engine } = scripted([
			// Turn 1, step 1: a brief calibration question (ask — the quiz
			// tool needs the syllabus's tree; pre-syllabus graded questions
			// are structurally impossible).
			() => fauxAssistantMessage(
				[fauxText("One question first."), fauxToolCall("ask_user_question", CALIBRATION, { id: "cal-1" })],
				{ stopReason: "toolUse" },
			),
			// Turn 2 (after the calibration answer): the syllabus. plan_init
			// executes server-side; the follow-up text closes the turn.
			() => fauxAssistantMessage(
				[fauxThinking("Sections: signals, then the idea."), fauxToolCall("plan_init", { mermaid: SYLLABUS }, { id: "plan-1" })],
				{ stopReason: "toolUse" },
			),
			() => fauxAssistantMessage([fauxText("The map above is the syllabus — say the word and we start.")]),
			// Turn 3: section 1's document, then its ONE exit ticket.
			() => fauxAssistantMessage(
				[
					fauxText("## What a signal is\n\nBefore reading: how would you describe a sound to someone who cannot hear it?\n\nA signal is a function of time... take a guess, then read on.\n\n> [!IMPORTANT]\n> A signal is just a function of time — amplitude against time."),
					fauxToolCall("quiz", SECTION_1_CHECK, { id: "check-1" }),
				],
				{ stopReason: "toolUse" },
			),
			// Turn 4 (after the answer): feedback + section 2's document and check.
			() => fauxAssistantMessage(
				[
					fauxText("Right — composition is the whole trick. Next section.\n\n## The Fourier idea\n\nThe last section showed a signal is a function; this builds on it by decomposing that function."),
					fauxToolCall("quiz", SECTION_2_CHECK, { id: "check-2" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const factory = lessonFactory(chat.id, engine);

		// ── Turn 1: the calibration question; the stopper ends the turn at it ──
		await drainTurn(post(chat.id, { type: "text", text: "teach me the Fourier series" }), factory);
		let saved = chatStore.getChat(chat.id)!;
		let pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.tool, "ask_user_question", "calibration rides ask_user_question");
		assert.equal(pending?.toolCallId, "cal-1");
		// The turn ended at the clean question call — no placeholder result.
		assert.equal(saved.messages[saved.messages.length - 1]?.role, "assistant");
		assert.equal(phaseAt3Lh(saved.messages, undefined, "lesson"), "plan", "calibration stays in the syllabus phase");

		// ── Turn 2: the calibration answer → the syllabus ──
		await drainTurn(
			post(chat.id, {
				type: "answer",
				toolCallId: "cal-1",
				answer: { kind: "ask", questionText: CALIBRATION.question, dontKnow: false, answers: [], text: "Derivatives only", answeredAt: new Date().toISOString() },
			}),
			factory,
		);
		saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.tree, "plan_init persisted the syllabus tree");
		assert.deepEqual(
			saved.tree!.nodes.map((n) => n.id),
			["signals", "fourier"],
			"one node = one section",
		);
		assert.equal(phaseAt3Lh(saved.messages, undefined, "lesson"), "plan", "presenting the syllabus stays plan");

		// ── Turn 3: section 1's document + its exit ticket ──
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		saved = chatStore.getChat(chat.id)!;
		pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.tool, "quiz");
		assert.equal(pending?.toolCallId, "check-1");
		const checkArgs = pending?.input as { type?: string; nodeId?: string };
		assert.equal(checkArgs.type, "check", "the exit ticket is a check");
		assert.equal(checkArgs.nodeId, "signals", "tagged to the section's node");
		assert.equal(phaseAt3Lh(saved.messages, undefined, "lesson"), "teach", "the first tagged check flips the phase");
		// The document preceded the check in the same message.
		const sectionMsg = saved.messages[saved.messages.length - 1]!;
		assert.ok(sectionMsg.role === "assistant");
		const text = (sectionMsg.content ?? []).find((b) => b.type === "text") as { text?: string } | undefined;
		assert.match(text?.text ?? "", /## What a signal is/, "the section heading precedes the check");
		assert.match(text?.text ?? "", /\[!IMPORTANT\]/, "the key-point callout rides the document");

		// ── Turn 4: the answer → the next section's document + check ──
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "check-1", answer: gradedAnswer(SECTION_1_CHECK, [SECTION_1_CHECK.correctAnswer]) }), factory);
		saved = chatStore.getChat(chat.id)!;
		pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "check-2", "the next section's exit ticket is pending");
		assert.equal((pending?.input as { nodeId?: string }).nodeId, "fourier");
		assert.equal(phaseAt3Lh(saved.messages, undefined, "lesson"), "teach", "teaching holds across sections");

		// ── The mode's law: no probe_done anywhere — the lesson agent ran
		// from turn 1 with no prober seam. ──
		assert.equal(
			toolCallsOf(saved.messages).some((c) => c.name === "probe_done"),
			false,
			"a lesson never runs a probe",
		);
	});

	it("a pre-syllabus QUIZ is rejected back to the model — graded questions need the tree (the calibration decision, structural)", async () => {
		const chat = createLessonChat("Test: premature check");
		createdChats.push(chat.id);
		const { engine, calls } = scripted([
			// The model tries a graded check before any syllabus exists.
			() => fauxAssistantMessage(
				[fauxToolCall("quiz", SECTION_1_CHECK, { id: "early-1" })],
				{ stopReason: "toolUse" },
			),
			// The error result returns to the model; it plans instead.
			() => fauxAssistantMessage(
				[fauxToolCall("plan_init", { mermaid: SYLLABUS }, { id: "plan-1" })],
				{ stopReason: "toolUse" },
			),
			() => fauxAssistantMessage([fauxText("Syllabus stands. Begin when ready.")]),
		]);
		const factory = lessonFactory(chat.id, engine);

		await drainTurn(post(chat.id, { type: "text", text: "teach me signals" }), factory);
		const saved = chatStore.getChat(chat.id)!;
		// The premature quiz call FAILED authoring validation — an error
		// toolResult rides the record (the retry context the model saw)…
		const early = saved.messages.find((m) => m.role === "toolResult" && m.toolCallId === "early-1") as
			| { isError?: boolean; content?: Array<{ type: string; text?: string }> }
			| undefined;
		assert.ok(early, "the rejected call's error result persisted");
		assert.equal(early.isError, true);
		assert.match(early.content?.[0]?.text ?? "", /No plan map exists yet/, "the refusal names the missing tree");
		// …and the run did NOT stop at the failed question (the stopper only
		// ends cleanly-resolved questions): the model recovered in-turn.
		assert.ok(saved.tree, "the recovery plan_init persisted the syllabus");
		assert.equal(danglingQuestionOf(saved.messages), null, "nothing pends — the turn ended in prose");
		// The model saw its own rejected call in the next step's context.
		assert.match(calls[calls.length - 1]!, /No plan map exists yet/);
	});

	it("a steering message between sections keeps the flow — ordinary text turns, no next-signal required", async () => {
		const chat = createLessonChat("Test: simpler please");
		createdChats.push(chat.id);
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("plan_init", { mermaid: SYLLABUS }, { id: "plan-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Syllabus stands.")]),
			() => fauxAssistantMessage(
				[fauxText("## What a signal is\n\n…"), fauxToolCall("quiz", SECTION_1_CHECK, { id: "check-1" })],
				{ stopReason: "toolUse" },
			),
			// The learner answers (feedback turn — no tool)…
			() => fauxAssistantMessage([fauxText("Right — composition is the trick.")]),
			// …then steers: "simpler" — the agent re-renders the section
			// and re-checks with a variant.
			() => fauxAssistantMessage([fauxText("Simpler: a signal is a height that changes over time."), fauxToolCall("quiz", { ...SECTION_1_CHECK, question: "In one word, what is a signal?", options: [{ label: "A function of time" }, { label: "A number" }, { label: "A sound" }], correctAnswer: "A function of time" }, { id: "check-1b" })], { stopReason: "toolUse" }),
		]);
		const factory = lessonFactory(chat.id, engine);

		await drainTurn(post(chat.id, { type: "text", text: "teach me signals" }), factory);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "check-1", answer: gradedAnswer(SECTION_1_CHECK, [SECTION_1_CHECK.correctAnswer]) }), factory);
		await drainTurn(post(chat.id, { type: "text", text: "simpler" }), factory);
		const saved = chatStore.getChat(chat.id)!;
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "check-1b", "the steered re-render re-checks the same section (a variant)");
		assert.equal((pending?.input as { nodeId?: string }).nodeId, "signals", "still the same section's node");
	});
});
