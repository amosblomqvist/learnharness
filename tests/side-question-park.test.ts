import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { commitSideQuestion, flushParkedSideQuestions } from "../src/server/side-questions.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { subscribe } from "../src/core/events.ts";
import { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, endsInDismissal, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { newSideQuestionMarker } from "../src/core/side-questions.ts";
import type { PiEngine } from "../src/agent/models.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");

const created: string[] = [];
after(() => { for (const id of created) chatStore.deleteChat(id); });

const QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

function chat(): string {
	const c = chatStore.createChat("side question park");
	created.push(c.id);
	chatStore.saveSettings(c.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(c.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return c.id;
}

function engineOf(steps: FauxResponseStep[]): { engine: PiEngine; seen: string[] } {
	const seen: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => (context, ...rest) => {
		seen.push(JSON.stringify(context.messages.map((m) => (m as { content: unknown }).content)));
		return typeof step === "function" ? step(context, ...rest) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

const factory = (engine: PiEngine): Parameters<typeof handleChatInput>[2] => (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });

async function turn(chatId: string, input: Parameters<typeof handleChatInput>[1], engine: PiEngine): Promise<void> {
	const res = await handleChatInput(chatId, input, factory(engine));
	assert.equal(res.status, 200, await res.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	assert.equal(isTurnRunning(chatId), false);
}

const marker = (id: string, told = true) =>
	newSideQuestionMarker(id, { thread: [{ question: "Why?", answer: "Because." }], note: `NOTE-${id}`, toldTutor: told });

function answer() {
	const options = normalizeOptions(QUIZ.options);
	const qd: QuestionData = {
		id: "call-q", kind: "quiz", question: QUIZ.question, mode: "single-select", options,
		correctIndices: resolveCorrect(QUIZ.correctAnswer, options).indices, explanation: QUIZ.explanation, createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values: ["Mercury"] });
}

const ids = (chatId: string) => chatStore.getChat(chatId)!.messages.map((m) => m.id);
const quizTurn = () => fauxAssistantMessage([fauxText("Check:"), fauxToolCall("quiz", QUIZ, { id: "call-q" })], { stopReason: "toolUse" });

describe("committing a closed side thread", () => {
	it("appends at once while the lesson is idle", () => {
		const id = chat();
		chatStore.saveMessages(id, [newUserMessage("hi") as LhMessage]);
		assert.equal(commitSideQuestion(chatStore, id, marker("side_idle")), "committed");
		assert.equal(ids(id).at(-1), "side_idle");
	});

	it("parks during a turn and lands after its messages, before turn-settled", async () => {
		const id = chat();
		let result: string | undefined;
		const { engine } = engineOf([() => {
			result = commitSideQuestion(chatStore, id, marker("side_mid"));
			return fauxAssistantMessage("Hello there.");
		}]);
		let atSettle: string[] = [];
		const off = subscribe((e) => { if (e.type === "turn-settled" && e.chatId === id) atSettle = ids(id); });
		await turn(id, { type: "text", text: "hi" }, engine);
		off();
		assert.equal(result, "parked");
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(messages.at(-1)!.id, "side_mid");
		assert.equal(messages.at(-2)!.role, "assistant");
		assert.equal(atSettle.at(-1), "side_mid", "in the record by the time turn-settled fires");
	});

	it("stays parked behind a posed question, then follows the answer into the reaction turn", async () => {
		const id = chat();
		const { engine, seen } = engineOf([
			() => { commitSideQuestion(chatStore, id, marker("side_q")); return quizTurn(); },
			fauxAssistantMessage("Right."),
		]);
		await turn(id, { type: "text", text: "quiz me" }, engine);
		assert.ok(danglingQuestionOf(chatStore.getChat(id)!.messages), "the quiz waits");
		assert.ok(!ids(id).includes("side_q"), "held while the question waits");
		await turn(id, { type: "answer", toolCallId: "call-q", answer: answer() }, engine);
		const messages = chatStore.getChat(id)!.messages;
		const at = messages.findIndex((m) => m.id === "side_q");
		assert.equal(messages[at - 1]!.role, "toolResult", "right after the answer's result");
		assert.match(seen[1]!, /NOTE-side_q/, "the reaction turn reads the note");
	});

	it("follows a dismissal and keeps the dismissal pause", async () => {
		const id = chat();
		const { engine } = engineOf([() => { commitSideQuestion(chatStore, id, marker("side_d")); return quizTurn(); }]);
		await turn(id, { type: "text", text: "quiz me" }, engine);
		const res = await dismissRoute.POST(
			new Request("http://x", { method: "POST", body: JSON.stringify({ input: { type: "dismiss", toolCallId: "call-q", answer: dismissedAnswer("quiz", QUIZ.question) } }) }),
			{ params: Promise.resolve({ id }) },
		);
		assert.equal(res.status, 200);
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(messages.at(-1)!.id, "side_d");
		assert.equal(messages.at(-2)!.role, "toolResult");
		assert.equal(endsInDismissal(messages), true);
	});

	it("lands after a failed turn", async () => {
		const id = chat();
		const { engine } = engineOf([() => {
			commitSideQuestion(chatStore, id, marker("side_fail"));
			return fauxAssistantMessage([fauxText("par")], { stopReason: "error", errorMessage: "boom" });
		}]);
		await turn(id, { type: "text", text: "hi" }, engine);
		assert.equal(ids(id).at(-1), "side_fail");
	});

	it("keeps two closes in order, and a later text message follows them", async () => {
		const id = chat();
		const { engine, seen } = engineOf([
			() => { commitSideQuestion(chatStore, id, marker("side_1")); commitSideQuestion(chatStore, id, marker("side_2", false)); return quizTurn(); },
			fauxAssistantMessage("ok"),
		]);
		await turn(id, { type: "text", text: "quiz me" }, engine);
		// The learner leaves the question by dismissing it; flushing again is a no-op.
		await dismissRoute.POST(
			new Request("http://x", { method: "POST", body: JSON.stringify({ input: { type: "dismiss", toolCallId: "call-q", answer: dismissedAnswer("quiz", QUIZ.question) } }) }),
			{ params: Promise.resolve({ id }) },
		);
		flushParkedSideQuestions(chatStore, id);
		assert.deepEqual(ids(id).slice(-2), ["side_1", "side_2"]);
		await turn(id, { type: "text", text: "next" }, engine);
		assert.match(seen[1]!, /NOTE-side_1/);
		assert.doesNotMatch(seen[1]!, /NOTE-side_2/, "an untold note never reaches the tutor");
	});

	it("rides just before a text message when one arrives first", async () => {
		const id = chat();
		chatStore.saveMessages(id, [newUserMessage("hi") as LhMessage, { ...(fauxAssistantMessage("Hello.") as object), id: "a0" } as LhMessage]);
		// Parked by a turn that is no longer running (e.g. the settle flush failed).
		const g = globalThis as typeof globalThis & { __lhParkedSideQuestions?: Map<string, unknown[]> };
		(g.__lhParkedSideQuestions ??= new Map()).set(id, [marker("side_text")]);
		const { engine } = engineOf([fauxAssistantMessage("Sure.")]);
		await turn(id, { type: "text", text: "go on" }, engine);
		const messages = chatStore.getChat(id)!.messages;
		const at = messages.findIndex((m) => m.id === "side_text");
		assert.equal(messages[at + 1]!.role, "user");
		assert.equal((messages[at + 1] as { content: unknown }).content, "go on");
	});
});
