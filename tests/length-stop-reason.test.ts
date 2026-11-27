/**
 * Regression tests for issue #642: foreground turns ending with
 * `stopReason === "length"` and no visible text or tool calls must surface
 * as visible, retryable errors instead of silently stalling.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { CUSTOM_PROVIDER } from "../src/core/auth-keys.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-length-stop-reason-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { SessionModel } = await import("../components/session-core.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { endsInFailedTurn, failedResponseAtEnd } = await import("../src/core/input-events.ts");

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

function scripted(
	steps: FauxResponseStep[],
	modelOverrides?: Partial<PiEngine["model"]>,
) {
	const contexts: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => (context, options, state, model) => {
			contexts.push(context.messages.map((m) => m.role).filter((role) => role !== "system"));
			return typeof step === "function" ? step(context, options, state, model) : step;
		}),
	);
	const baseModel = faux.getModel();
	const model = modelOverrides ? { ...baseModel, ...modelOverrides } : baseModel;
	const engine: PiEngine = { model, streamFn: faux.streamSimple };
	return { engine, contexts };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

type AgentFactory = (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent;

async function turn(engine: PiEngine, chatId: string, input: unknown, buildAgent?: AgentFactory): Promise<Response> {
	const ack = await handleChatRequest(
		post(chatId, input),
		buildAgent ?? ((opts) => createTeacherAgent(undefined, { ...opts, engine })),
	);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

function createConfiguredChat(title: string, kind?: "practice") {
	const chat = chatStore.createChat(title, kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

describe("empty length-truncated foreground turns (issue #642)", () => {
	it("surfaces a thinking-only length stop as a retryable error and recovers cleanly on retry", async () => {
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxThinking("Spent the full output budget reasoning.")], { stopReason: "length" }),
			() => fauxAssistantMessage([fauxText("Here is the lesson plan.")]),
		]);
		const chat = createConfiguredChat("Test: thinking-only length stop");

		assert.equal((await turn(engine, chat.id, { type: "text", text: "plan my lesson" })).status, 200);
		const afterFirst = chatStore.getChat(chat.id)!.messages;
		const failed = afterFirst.at(-1);
		assert.equal(failed?.role, "assistant");
		assert.equal(failed.stopReason, "error");
		assert.match(failed.errorMessage ?? "", /output limit/i);
		assert.ok(
			failed.content.some((block) => block.type === "thinking" && block.thinking.includes("Spent the full output budget")),
			"thinking block should remain preserved on disk",
		);
		assert.equal(endsInFailedTurn(afterFirst), true);
		assert.equal(failedResponseAtEnd(afterFirst)?.id, failed.id);
		assert.equal(
			new SessionModel({ chatId: chat.id, initialMessages: afterFirst }).getState().error?.message,
			failed.errorMessage,
		);

		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);
		const afterRetry = chatStore.getChat(chat.id)!.messages;
		assert.equal(afterRetry.length, afterFirst.length + 1);
		assert.equal(endsInFailedTurn(afterRetry), false);
		assert.equal(new SessionModel({ chatId: chat.id, initialMessages: afterRetry }).getState().error, null);
		assert.deepEqual(contexts.at(-1), ["user"]);
		assert.match(JSON.stringify(afterRetry.at(-1)), /Here is the lesson plan/);
	});

	it("surfaces empty and whitespace-only length stops as retryable errors", async () => {
		for (const content of [[], [fauxText("   \n\t  ")]]) {
			const { engine } = scripted([() => fauxAssistantMessage(content, { stopReason: "length" })]);
			const chat = createConfiguredChat("Test: empty length stop");

			assert.equal((await turn(engine, chat.id, { type: "text", text: "hello" })).status, 200);
			const messages = chatStore.getChat(chat.id)!.messages;
			const last = messages.at(-1);
			assert.equal(last?.role, "assistant");
			assert.equal(last.stopReason, "error");
			assert.match(last.errorMessage ?? "", /output limit/i);
			assert.equal(endsInFailedTurn(messages), true);
		}
	});

	it("names the token limit and custom-endpoint settings location for custom providers", async () => {
		const { engine } = scripted(
			[() => fauxAssistantMessage([fauxThinking("Thinking until 4096 tokens...")], { stopReason: "length" })],
			{ provider: CUSTOM_PROVIDER.id, maxTokens: 4096 },
		);
		const chat = createConfiguredChat("Test: custom provider length stop");

		assert.equal((await turn(engine, chat.id, { type: "text", text: "plan" })).status, 200);
		const last = chatStore.getChat(chat.id)!.messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.equal(last.stopReason, "error");
		assert.match(last.errorMessage ?? "", /4096/);
		assert.match(last.errorMessage ?? "", /Custom endpoint/i);
		assert.equal(endsInFailedTurn(chatStore.getChat(chat.id)!.messages), true);
	});

	it("preserves partial visible text when stopReason is length", async () => {
		const { engine } = scripted([
			() =>
				fauxAssistantMessage(
					[fauxThinking("Outline..."), fauxText("Here is the partial explanation already shown.")],
					{ stopReason: "length" },
				),
		]);
		const chat = createConfiguredChat("Test: partial text length stop");

		assert.equal((await turn(engine, chat.id, { type: "text", text: "explain" })).status, 200);
		const messages = chatStore.getChat(chat.id)!.messages;
		const last = messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.equal(last.stopReason, "length");
		assert.equal(last.errorMessage, undefined);
		assert.ok(
			last.content.some((block) => block.type === "text" && block.text.includes("partial explanation already shown")),
		);
		assert.equal(endsInFailedTurn(messages), false);
		assert.equal(new SessionModel({ chatId: chat.id, initialMessages: messages }).getState().error, null);
	});

	it("preserves truncated tool-call recovery when stopReason is length with a toolCall", async () => {
		let executions = 0;
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "trunc-call" })], { stopReason: "length" }),
			() => fauxAssistantMessage("Recovered cleanly after truncated tool call."),
		]);
		const tools: AgentBuildOptions["tools"] = {
			save_note: {
				name: "save_note",
				label: "save_note",
				description: "Record one fixture side effect.",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "Saved" }], details: {} };
				},
			},
		};
		const chat = createConfiguredChat("Test: length stop with truncated tool call");

		assert.equal(
			(
				await turn(engine, chat.id, { type: "text", text: "save note" }, (opts) =>
					createTeacherAgent(undefined, { ...opts, engine, tools }),
				)
			).status,
			200,
		);
		assert.equal(executions, 0, "truncated tool call must never execute");
		const messages = chatStore.getChat(chat.id)!.messages;
		assert.equal(endsInFailedTurn(messages), false);
		assert.match(JSON.stringify(messages.at(-1)), /Recovered cleanly/);
	});

	it("leaves normal stopReason === 'stop' responses untouched", async () => {
		const { engine } = scripted([() => fauxAssistantMessage("All good.", { stopReason: "stop" })]);
		const chat = createConfiguredChat("Test: normal stop");

		assert.equal((await turn(engine, chat.id, { type: "text", text: "hi" })).status, 200);
		const messages = chatStore.getChat(chat.id)!.messages;
		const last = messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.equal(last.stopReason, "stop");
		assert.equal(last.errorMessage, undefined);
		assert.equal(endsInFailedTurn(messages), false);
		assert.equal(new SessionModel({ chatId: chat.id, initialMessages: messages }).getState().error, null);
	});

	it("protects prober and practice foreground agents identically", async () => {
		const probeEngine = scripted([
			() => fauxAssistantMessage([fauxThinking("Prober ran out of output tokens.")], { stopReason: "length" }),
		]).engine;
		const probeChat = createConfiguredChat("Test: prober length stop");
		assert.equal(
			(
				await turn(probeEngine, probeChat.id, { type: "text", text: "start" }, (opts) =>
					createProberAgent(
						{ chatId: probeChat.id, chatStore, deliver: () => {}, jobStore, spawn: () => {} },
						{ ...opts, engine: probeEngine },
					),
				)
			).status,
			200,
		);
		assert.equal(endsInFailedTurn(chatStore.getChat(probeChat.id)!.messages), true);

		const practiceEngine = scripted([
			() => fauxAssistantMessage([fauxThinking("Practice ran out of output tokens.")], { stopReason: "length" }),
		]).engine;
		const practiceChat = createConfiguredChat("Test: practice length stop", "practice");
		assert.equal(
			(
				await turn(practiceEngine, practiceChat.id, { type: "text", text: "practice" }, (opts) =>
					createPracticeAgent({ chatId: practiceChat.id, chatStore }, { ...opts, engine: practiceEngine }),
				)
			).status,
			200,
		);
		assert.equal(endsInFailedTurn(chatStore.getChat(practiceChat.id)!.messages), true);
	});

	it("retries an empty length stop after a completed tool without re-executing the tool", async () => {
		let executions = 0;
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("save_note", {}, { id: "note-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxThinking("Hit cap after reading tool result.")], { stopReason: "length" }),
			() => fauxAssistantMessage("Finished after retry."),
		]);
		const tools: AgentBuildOptions["tools"] = {
			save_note: {
				name: "save_note",
				label: "save_note",
				description: "Record one fixture side effect.",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "Note saved" }], details: { saved: true } };
				},
			},
		};
		const factory: AgentFactory = (opts) => createTeacherAgent(undefined, { ...opts, engine, tools });
		const chat = createConfiguredChat("Test: length stop after completed tool");

		await turn(engine, chat.id, { type: "text", text: "save and summarize" }, factory);
		assert.equal(executions, 1);
		assert.equal(endsInFailedTurn(chatStore.getChat(chat.id)!.messages), true);

		assert.equal((await turn(engine, chat.id, { type: "retry" }, factory)).status, 200);
		assert.equal(executions, 1, "completed tool must not re-execute on retry");
		assert.deepEqual(contexts.at(-1), ["user", "assistant", "toolResult"]);
		assert.equal(endsInFailedTurn(chatStore.getChat(chat.id)!.messages), false);
		assert.match(JSON.stringify(chatStore.getChat(chat.id)!.messages.at(-1)), /Finished after retry/);
	});
});
