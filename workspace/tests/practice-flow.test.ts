/**
 * Practice-flow integration test (practice sessions, owner design
 * 2026-10-04) — the full practice loop with zero tokens, mirroring
 * chat-flow.test.ts's harness (handleChatRequest + the faux engine):
 *
 *   learner opens → practice agent poses (problem, terminate) → thinking
 *   arrives as a labeled message → agent concludes + reveals + wraps
 *   → Esc dismissal synthesizes the conclude pair on the next input.
 *
 * The record law under pin: the pose ack PERSISTS (unlike a question's
 * placeholder) and a record ending on it owes no continuation.
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
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { activeProblemOf, needsContinuation } from "../src/core/index.ts";
import { PATHS } from "../config.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

// The BYOK key-presence gate reads env-first (chat-flow.test.ts's idiom).
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

/** A valid problem pose — the slim schema: statement, mode, target,
 *  modelSolution (the commitment, which is also the reveal). */
const POSE = {
	statement: "Prove that every finite group of prime order is cyclic.",
	mode: "recall",
	target: ["group-order"],
	modelSolution: "Let |G| = p. Any x ≠ e generates a subgroup whose order divides p…",
} as const;

/** A valid conclude — no reveal field; the pose's modelSolution is the reveal. */
const CONCLUDE = {
	outcome: "solved",
	verdict: "The subgroup-order argument is credited in full.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

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

function createPracticeChat(title: string) {
	const chat = chatStore.createChat(title, "practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

/** CONNECTION DIET B (owner, 2026-10-10): POST acks and closes; the turn's
 *  wire is the reattach stream. Mirrors drain(): 200-ack assert + the fully
 *  drained SSE body via runningTurn + subscribe (subscribe immediately —
 *  faux turns settle in microtask rounds). */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn settled inside the handler — completion already happened
	return new Response(handle.subscribe()).text();
}

/** The practice agent factory (the handler's kind branch, test-shaped). */
function practiceFactory(chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createPracticeAgent({ chatId, chatStore }, { engine, messages: opts.messages });
}

/** Each step records the prompt it received — the transcript the model
 *  saw (the chat-flow capture idiom). */
function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			calls.push(
				context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"),
			);
			return typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

const lastSaw = (calls: string[], needle: string) => calls[calls.length - 1]!.includes(needle);

describe("practice flow (scripted model)", () => {
	it("pose → thinking commit → conclude + reveal; the pose ack persists and owes nothing", async () => {
		const chat = createPracticeChat("Test: practice groups");
		const { engine, calls } = scripted([
			// Turn 1: the agent poses immediately (terminate:true ends the run).
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p1" })], { stopReason: "toolUse" }),
			// Turn 2 (after the commit): conclude (non-terminating) …
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			// … the loop continues: reveal text ends the turn.
			() => fauxAssistantMessage([fauxText("Clean proof. Ready for the next one?")]),
		]);
		const factory = practiceFactory(chat.id, engine);

		// ── Turn 1: the opening text; the agent poses ──
		await drainTurn(post(chat.id, { type: "text", text: "practice group theory" }), factory);
		const afterPose = chatStore.getChat(chat.id)!.messages;
		const ack = afterPose[afterPose.length - 1] as LhMessage & ToolResultMessage;
		assert.equal(ack.role, "toolResult");
		assert.equal(ack.toolName, "problem");
		assert.equal(ack.isError, false);
		assert.equal(needsContinuation(afterPose), false);
		assert.equal(activeProblemOf(afterPose)?.toolCallId, "call-p1");

		// ── Turn 2: the submission arrives as a single-lane thinking message ──
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p1", text: "|G|=p; ⟨x⟩ has order dividing p" }), factory);
		// The model saw the one label (owner round 2, 2026-10-05): the
		// register is read from the text, not declared by a button.
		assert.ok(lastSaw(calls, "Your thinking:"), "the conclude turn's prompt carries the thinking");
		const afterConclude = chatStore.getChat(chat.id)!.messages;
		const concludeAck = afterConclude.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as LhMessage & ToolResultMessage;
		assert.ok(concludeAck, "the conclude ack persisted");
		// Owner round 16: the ack carries the turn-ends law (no more tools,
		// the learner's go-ahead paces the next problem).
		assert.ok((concludeAck.content[0] as { text: string }).text.includes("END YOUR TURN"));
		// The turn continued past conclude to the reveal text.
		assert.ok(afterConclude.some((m) => (m as { role?: string }).role === "assistant" && JSON.stringify((m as { content?: unknown }).content).includes("Clean proof.")));
		assert.equal(activeProblemOf(afterConclude), null);
	});

	it("a working-trace submission keeps the problem active", async () => {
		const chat = createPracticeChat("Test: practice nudge");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("R0: reread the subgroup constraint.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p2", text: "stuck at the second step" }), factory);
		assert.ok(lastSaw(calls, "Your thinking:"), "the turn's prompt carries the thinking");
		// The problem is still active — a trace never concludes.
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-p2");
	});

	it("Esc dismissal marks silently; the next input rides the synthesized conclude pair", async () => {
		const chat = createPracticeChat("Test: practice dismiss");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p3" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Dropped. Something else, then.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);

		// The silent dismissal route (the same POST the client's Esc takes).
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
		const dismissRes = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chat.id}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId: "call-p3" } }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(dismissRes.status, 200);
		const marked = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeProblemOf(marked), null, "the marker deactivates at Esc time");

		// The next plain input synthesizes the conclude pair ahead of itself.
		await drainTurn(post(chat.id, { type: "text", text: "something easier" }), factory);
		const msgs = chatStore.getChat(chat.id)!.messages;
		const synth = msgs.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as (LhMessage & ToolResultMessage) | undefined;
		assert.ok(synth, "the synthesized conclude result persisted");
		assert.ok(
			(synth.content[0] as { text: string }).text.includes(CONCLUDE_ACK_TEXT),
			"the pair carries the shared conclude ack text",
		);
		assert.ok(lastSaw(calls, "dismissed"), "the model saw the dismissed outcome");
	});
});
