/**
 * Retry (owner, 2026-10-24): the "Try again" button under the learner's
 * last prompt. Pure cut rules + the handler flow with a scripted model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { parseChatInput, retryBase, retryPromptIndex } from "../src/core/input-events.ts";
import { newAnswerResult, newNextMessage, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const assistant = (text: string): LhMessage =>
	({ ...fauxAssistantMessage([fauxText(text)]), id: `a_${text}` }) as unknown as LhMessage;

describe("retry cut rules (pure)", () => {
	it("parses the retry input", () => {
		assert.deepEqual(parseChatInput({ type: "retry" }), { type: "retry" });
	});

	it("keeps everything up to the last text prompt", () => {
		const u1 = newUserMessage("first");
		const a1 = assistant("one");
		const u2 = newUserMessage("second");
		const a2 = assistant("two");
		const msgs = [u1, a1, u2, a2];
		assert.equal(retryPromptIndex(msgs), 2);
		assert.deepEqual(retryBase(msgs), [u1, a1, u2]);
	});

	it("refuses when there is no prompt", () => {
		assert.equal(retryBase([]), null);
		assert.equal(retryBase([assistant("hi")]), null);
	});

	it("targets a quiz answer as the last learner input and keeps it", () => {
		const u = newUserMessage("go");
		const a = assistant("q");
		const answer = newAnswerResult("c1", "quiz", { values: ["a"] });
		const reply = assistant("reaction");
		assert.equal(retryPromptIndex([u, a, answer, reply]), 2);
		assert.deepEqual(retryBase([u, a, answer, reply]), [u, a, answer]);
	});

	it("targets a practice marker", () => {
		const u = newUserMessage("go");
		const next = newNextMessage();
		assert.equal(retryPromptIndex([u, assistant("p"), next, assistant("x")]), 2);
	});

	it("refuses across compaction or sub-agent markers", () => {
		const u = newUserMessage("go");
		const marker = { ...newNextMessage(), customType: "compaction" } as unknown as LhMessage;
		assert.equal(retryBase([u, assistant("x"), marker]), null);
	});
});

describe("retry through the handler", () => {
	const created: string[] = [];
	after(() => {
		for (const id of created) {
			try {
				fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
			} catch {
				/* gone */
			}
		}
	});

	function scripted(steps: FauxResponseStep[]): PiEngine {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}

	async function turn(chatId: string, input: unknown, engine: PiEngine): Promise<Response> {
		const res = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input }),
			}),
			(opts) => createTeacherAgent(undefined, { engine, messages: opts.messages }),
		);
		if (res.status === 200) {
			const handle = runningTurn(chatId);
			if (handle) await new Response(handle.subscribe()).text();
		}
		return res;
	}

	it("replaces the previous response without duplicating the prompt", async () => {
		const chat = chatStore.createChat("Test: retry");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		created.push(chat.id);
		const seen: string[][] = [];
		const engine = scripted([
			() => fauxAssistantMessage([fauxText("first answer")]),
			(ctx) => {
				seen.push(ctx.messages.map((m) => (m as { role: string }).role));
				return fauxAssistantMessage([fauxText("second answer")]);
			},
		]);

		await turn(chat.id, { type: "text", text: "explain gravity" }, engine);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 2);

		const res = await turn(chat.id, { type: "retry" }, engine);
		assert.equal(res.status, 200);
		const after = chatStore.getChat(chat.id)!.messages;
		assert.equal(after.length, 2, "prompt + ONE response — nothing duplicated");
		assert.equal(after[0]!.role, "user");
		const text = JSON.stringify((after[1] as { content: unknown }).content);
		assert.ok(text.includes("second answer") && !text.includes("first answer"));
		assert.deepEqual(seen[0]!.filter((r) => r !== "system"), ["user"], "the model saw the prompt once, no stale response");
	});

	it("400s when there is nothing to retry and leaves the record alone", async () => {
		const chat = chatStore.createChat("Test: retry empty");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		created.push(chat.id);
		const res = await turn(chat.id, { type: "retry" }, scripted([]));
		assert.equal(res.status, 400);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 0);
	});
});
