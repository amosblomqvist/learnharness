/**
 * A side thread opened from the question WAITING for the learner (#402):
 * the wire accepts the call id and the learner's working, the server
 * refuses a call that isn't the waiting question, the side agent gets the
 * nudge-only instructions and the working but never the answer key, and
 * the thread opens beside the lesson.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { handleSideQuestion } from "../src/server/side-questions.ts";
import { chatStore } from "../src/store/chats.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { ChatInputError } from "../src/core/input-events.ts";
import { SIDE_WORKING_MAX_CHARS, parseSideQuestionInput, sideUserMessage } from "../src/core/side-questions.ts";
import { TUTOR_NOTE_TOOL, sideQuestionSystemPrompt } from "../src/agent/subagents/side-question.ts";
import { sideThreadReducer, type SideThreadState } from "../components/use-side-thread.ts";
import { sideThreadPlaceholder } from "../components/side-thread.tsx";
import type { PiEngine } from "../src/agent/models.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const created: string[] = [];
after(() => { for (const id of created) chatStore.deleteChat(id); });

const CALL = "call-waiting-1";

/** A chat whose newest message poses a quiz that is still waiting. */
function chatWithWaitingQuiz(): string {
	const c = chatStore.createChat("side question pending test");
	created.push(c.id);
	chatStore.saveSettings(c.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(c.id, [
		newUserMessage("Teach me about prime groups") as LhMessage,
		{
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "Let's check the idea." },
				{
					type: "toolCall",
					id: CALL,
					name: "quiz",
					arguments: { question: "Is every group of prime order cyclic?", options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes", explanation: "SECRET-EXPLANATION via Lagrange" },
				},
			],
		} as never,
	]);
	return c.id;
}

function scripted() {
	const seen: { system: string; user: string }[] = [];
	const faux = createFauxCore({});
	const step = ((context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }) => {
		const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
		seen.push({
			system: context.systemPrompt ?? context.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n"),
			user: text(context.messages[context.messages.length - 1]!.content),
		});
		return fauxAssistantMessage([fauxText("What does it mean for one element to generate the group?"), fauxToolCall(TUTOR_NOTE_TOOL, { tell: true, note: "Unsure what cyclic means." })], { stopReason: "toolUse" });
	}) as unknown as FauxResponseStep;
	faux.setResponses([step]);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engineFor: () => engine, seen };
}

const body = (extra: Record<string, unknown> = {}) => ({ threadId: "t_pending", thread: [], question: "Where do I start?", ...extra });

describe("the wire", () => {
	it("accepts the waiting question's id and the working, trimmed", () => {
		const parsed = parseSideQuestionInput(body({ questionCallId: CALL, working: "  Lagrange?  " }));
		assert.equal(parsed.questionCallId, CALL);
		assert.equal(parsed.working, "Lagrange?");
		assert.equal(parseSideQuestionInput(body({ questionCallId: CALL, working: "   " })).working, undefined);
	});

	it("rejects working without a question, a non-string, or an over-long one", () => {
		assert.throws(() => parseSideQuestionInput(body({ working: "x" })), ChatInputError);
		assert.throws(() => parseSideQuestionInput(body({ questionCallId: CALL, working: 3 })), ChatInputError);
		assert.throws(() => parseSideQuestionInput(body({ questionCallId: CALL, working: "x".repeat(SIDE_WORKING_MAX_CHARS + 1) })), /at most/);
		assert.throws(() => parseSideQuestionInput(body({ questionCallId: "" })), ChatInputError);
	});

	it("the agent's message says the thread is about the waiting question and carries the working", () => {
		const withWorking = sideUserMessage("[TUTOR] hi", { thread: [], question: "q", questionCallId: CALL, working: "I think Lagrange" });
		assert.match(withWorking, /<waiting_question>[\s\S]*Their working so far[\s\S]*I think Lagrange/);
		assert.match(sideUserMessage("t", { thread: [], question: "q", questionCallId: CALL }), /not written any working yet/);
		assert.doesNotMatch(sideUserMessage("t", { thread: [], question: "q" }), /waiting_question/);
	});
});

describe("the nudge instructions", () => {
	it("are appended only for a thread on the waiting question", () => {
		assert.match(sideQuestionSystemPrompt(true), /Never say which option is correct/);
		assert.match(sideQuestionSystemPrompt(true), /tell to true whenever the learner needed help/);
		assert.doesNotMatch(sideQuestionSystemPrompt(false), /Never say which option is correct/);
	});
});

describe("POST /api/chats/[id]/side-question with questionCallId", () => {
	it("400s a call that is not the waiting question", async () => {
		const res = await handleSideQuestion(chatWithWaitingQuiz(), body({ questionCallId: "call-elsewhere" }), scripted());
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /not the question waiting/);
	});

	it("400s once the question has been answered", async () => {
		const id = chatWithWaitingQuiz();
		const record = chatStore.getChat(id)!;
		chatStore.saveMessages(id, [...record.messages, { id: "r1", role: "toolResult", toolCallId: CALL, toolName: "quiz", content: [{ type: "text", text: "{}" }], isError: false, details: {}, timestamp: Date.now() } as never]);
		assert.equal((await handleSideQuestion(id, body({ questionCallId: CALL }), scripted())).status, 400);
	});

	it("nudges: sees the working and the waiting question, never the answer key, and the record is untouched", async () => {
		const id = chatWithWaitingQuiz();
		const before = chatStore.getChat(id)!.messages;
		const s = scripted();
		const res = await handleSideQuestion(id, body({ questionCallId: CALL, working: "Maybe Lagrange's theorem?" }), s);
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.match(text, /"tell":true/);
		assert.match(s.seen[0]!.system, /Never say which option is correct/);
		assert.match(s.seen[0]!.user, /Is every group of prime order cyclic\?/);
		assert.match(s.seen[0]!.user, /Maybe Lagrange's theorem\?/);
		assert.match(s.seen[0]!.user, /waiting for the learner's answer/);
		assert.doesNotMatch(s.seen[0]!.user, /SECRET-EXPLANATION|correctAnswer/);
		assert.deepEqual(chatStore.getChat(id)!.messages, before);
	});

	it("an ordinary side question keeps the plain prompt", async () => {
		const s = scripted();
		await (await handleSideQuestion(chatWithWaitingQuiz(), body(), s)).text();
		assert.doesNotMatch(s.seen[0]!.system, /Never say which option is correct/);
	});
});

describe("the thread on the client", () => {
	const anchor = { kind: "composer" } as const;

	it("opens beside the lesson (a panel), remembering the question", () => {
		const s = sideThreadReducer(null, { type: "open", threadId: "t1", anchor, questionCallId: CALL })!;
		assert.equal(s.mode, "panel");
		assert.equal(s.questionCallId, CALL);
		assert.equal(sideThreadReducer(null, { type: "open", threadId: "t2", anchor })!.mode, "popover");
		assert.equal(sideThreadReducer(null, { type: "open", threadId: "t2", anchor })!.questionCallId, undefined);
	});

	it("asks for a nudge in its empty placeholder only", () => {
		const open = sideThreadReducer(null, { type: "open", threadId: "t1", anchor, questionCallId: CALL })! as SideThreadState;
		assert.match(sideThreadPlaceholder(open), /Ask for a nudge/);
		const asked = sideThreadReducer(open, { type: "ask", question: "hm?" })!;
		assert.equal(sideThreadPlaceholder(asked), "Ask a follow-up…");
	});
});
