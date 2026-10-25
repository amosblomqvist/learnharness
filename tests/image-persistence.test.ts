import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { imageBlock } from "../src/core/images.ts";
import { estimateMessageTokens, serializeForSummary } from "../src/core/compaction.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newUserMessage, toLlmMessages, asAgentMessages, type LhMessage } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { projectView } from "../src/core/view.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// A real 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG2 = PNG; // same bytes twice: no dedupe, no reorder

const toolResult = (content: unknown, details?: unknown): LhMessage =>
	({ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", content, details, isError: false, timestamp: 3 }) as LhMessage;

describe("native image persistence and model context", () => {
	it("text-only records stay plain strings; images keep text-first, input order", () => {
		assert.equal(newUserMessage("hello").content, "hello");
		const a = imageBlock("image/png", PNG);
		const b = imageBlock("image/png", PNG2);
		const m = newUserMessage("look", [a, b]);
		assert.deepEqual(m.content, [{ type: "text", text: "look" }, a, b]);
		const only = newUserMessage("", [a]);
		assert.deepEqual(only.content, [a]);
		const input = parseChatInput({ type: "text", text: "look", images: [a, b] });
		const [appended] = inputAppends({ messages: [] }, input);
		assert.deepEqual((appended as { content: unknown }).content, [{ type: "text", text: "look" }, a, b]);
	});

	it("toLlmMessages passes image blocks through verbatim, minus the record id", () => {
		const a = imageBlock("image/png", PNG);
		const user = newUserMessage("see", [a]);
		const result = toolResult([{ type: "text", text: "shot" }, a]);
		const wire = toLlmMessages(asAgentMessages([user, result])) as unknown as Array<{ content: any[]; id?: string }>;
		assert.deepEqual(wire[0]!.content, [{ type: "text", text: "see" }, a]);
		assert.deepEqual(wire[1]!.content, [{ type: "text", text: "shot" }, a]);
		assert.equal(wire[0]!.id, undefined);
		const reloaded = JSON.parse(JSON.stringify([user, result])) as LhMessage[];
		assert.equal(JSON.stringify(toLlmMessages(asAgentMessages(reloaded))), JSON.stringify(wire));
	});

	it("the compaction image allowance is still 4800 chars", () => {
		const m = newUserMessage("", [imageBlock("image/png", PNG)]);
		assert.equal(estimateMessageTokens(m), 1200);
	});

	it("summaries carry a marker, never base64, in order", () => {
		const a = imageBlock("image/png", PNG);
		const text = serializeForSummary([
			newUserMessage("before", [a, imageBlock("image/jpeg", PNG)]),
			toolResult([{ type: "text", text: "shot" }, a]),
		]);
		assert.ok(!text.includes(PNG.slice(0, 20)), "no base64 in the summary");
		assert.match(text, /\[LEARNER\] before\n\[Image image\/png\]\n\[Image image\/jpeg\]/);
		assert.match(text, /\[RESULT for read\] shot\n\[Image image\/png\]/);
		assert.ok(!text.includes("[object Object]"));
	});

	it("markdown: describe is the base64-free default; embed (user export) keeps the images in order, even with null details", () => {
		const a = imageBlock("image/png", PNG);
		const messages = [newUserMessage("before", [a]), newUserMessage("", [a]), toolResult([{ type: "text", text: "shot" }, a], null)];
		const plain = sessionMarkdown(messages, { anchors: false });
		assert.ok(!plain.includes(PNG.slice(0, 20)), "no base64 by default");
		assert.ok(plain.includes("### Learner\n\nbefore\n\n[Image image/png]"), plain);
		assert.ok(plain.includes("### Learner\n\n[Image image/png]"), "image-only message is not dropped");
		assert.ok(plain.includes("### Tool\n\n*read result delivered*\n\n[Image image/png]"), plain);
		const md = sessionMarkdown(messages, { anchors: false, imageMode: "embed" });
		const url = `![Image 1](data:image/png;base64,${PNG})`;
		assert.ok(md.includes(`### Learner\n\nbefore\n\n${url}`), md);
		assert.ok(md.includes(`### Learner\n\n${url}`), md);
		assert.ok(md.includes(`### Tool\n\n*read result delivered*\n\n${url}`), md);
	});

	it("the view projection still renders image user messages", () => {
		const view = projectView([newUserMessage("see", [imageBlock("image/png", PNG)])]);
		assert.equal(view.length, 1);
	});
});

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch { /* gone */ }
	}
});

function post(body: BodyInit, headers: Record<string, string> = { "Content-Type": "application/json" }): Request {
	return new Request("http://test/api/chat", { method: "POST", headers, body });
}

describe("chat handler image requests (nothing is persisted on refusal)", () => {
	// Network guard: any outbound fetch fails the test instead of leaving the machine.
	const realFetch = globalThis.fetch;
	const attempted: string[] = [];
	before(() => {
		globalThis.fetch = (async (input: unknown) => {
			attempted.push(String((input as { url?: string })?.url ?? input));
			throw new Error("network blocked in image tests");
		}) as typeof fetch;
	});
	after(() => {
		globalThis.fetch = realFetch;
		assert.deepEqual(attempted, [], "no outbound fetch attempted");
	});
	const chat = chatStore.createChat("image test");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "aion-labs/aion-2.0" } });
	createdChats.push(chat.id);
	const refusedClean = () => assert.equal(chatStore.getChat(chat.id)!.messages.length, 0);

	it("400 for an invalid image payload, before any write", async () => {
		const bad = { type: "text", text: "x", images: [{ type: "image", mimeType: "image/png", data: "AAAA" + "A".repeat(40) }] };
		const res = await handleChatRequest(post(JSON.stringify({ chatId: chat.id, input: bad })));
		assert.equal(res.status, 400);
		const { error } = (await res.json()) as { error: string };
		assert.ok(!error.includes("AAAA"));
		refusedClean();
	});

	it("413 with a typed error for an oversized body, declared or streamed", async () => {
		const huge = "x".repeat(17 * 1024 * 1024);
		const streamed = await handleChatRequest(post(huge));
		assert.equal(streamed.status, 413);
		assert.equal(((await streamed.json()) as { code: string }).code, "request_too_large");
		const declared = await handleChatRequest(post("{}", { "Content-Length": String(huge.length) }));
		assert.equal(declared.status, 413);
		refusedClean();
	});

	it("normal text bodies and malformed JSON behave as before", async () => {
		assert.equal((await handleChatRequest(post("{nope"))).status, 400);
		assert.equal((await handleChatRequest(post("null"))).status, 400);
		assert.equal((await handleChatRequest(post(JSON.stringify({ input: { type: "continue" } })))).status, 404);
	});

	it("422 for a valid picture on a text-only model, before persist", async () => {
		const res = await handleChatRequest(post(JSON.stringify({ chatId: chat.id, input: { type: "text", text: "see", images: [imageBlock("image/png", PNG)] } })));
		assert.equal(res.status, 422);
		assert.equal(((await res.json()) as { code: string }).code, "model_cannot_read_images");
		refusedClean();
	});
});
