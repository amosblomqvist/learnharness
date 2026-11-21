import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, SystemMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { toAntigravityPromptBlocks } from "../src/agent/antigravity/transcript.ts";

function system(content: string): SystemMessage {
	return { role: "system", content, timestamp: 0 };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "antigravity-acp",
		provider: "antigravity",
		model: "gemini-3.1-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(toolName: string, content: ToolResultMessage["content"], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: `${toolName}-1`, toolName, content, isError, timestamp: 0 };
}

test("toAntigravityPromptBlocks skips system messages and passes single user message unlabelled", () => {
	assert.deepEqual(toAntigravityPromptBlocks([system("You are a tutor."), user("What is a derivative?")]), [
		{ type: "text", text: "What is a derivative?" },
	]);
});

test("toAntigravityPromptBlocks preserves mixed text and images in a single unlabelled user turn", () => {
	const blocks = toAntigravityPromptBlocks([
		system("System prompt"),
		user([
			{ type: "text", text: "Check this graph" },
			{ type: "image", data: "PNGDATA", mimeType: "image/png" },
		]),
	]);
	assert.deepEqual(blocks, [
		{ type: "text", text: "Check this graph" },
		{ type: "image", data: "PNGDATA", mimeType: "image/png" },
	]);
});

test("toAntigravityPromptBlocks formats user, assistant, toolCall, and toolResult history in order", () => {
	const messages: Message[] = [
		system("System prompt"),
		user([{ type: "text", text: "Quiz me on limits" }]),
		assistant([
			{ type: "text", text: "Let's check your intuition first." },
			{ type: "toolCall", id: "call-1", name: "ask_user_question", arguments: { question: "What is lim x->0 sin(x)/x?" } },
		]),
		toolResult("ask_user_question", [{ type: "text", text: "1" }]),
		assistant([{ type: "text", text: "Correct!" }]),
		user("Give me a harder one"),
	];

	assert.deepEqual(toAntigravityPromptBlocks(messages), [
		{
			type: "text",
			text: [
				"[user]\nQuiz me on limits",
				"[assistant]\nLet's check your intuition first.",
				'[tool call ask_user_question] {"question":"What is lim x->0 sin(x)/x?"}',
				"[tool result ask_user_question]\n1",
				"[assistant]\nCorrect!",
				"[user]\nGive me a harder one",
			].join("\n\n"),
		},
	]);
});

test("toAntigravityPromptBlocks marks error tool results and omits thinking blocks", () => {
	const messages: Message[] = [
		user("Check file"),
		assistant([
			{ type: "thinking", thinking: "internal reasoning should not be replayed" },
			{ type: "text", text: "Checking now." },
			{ type: "toolCall", id: "call-2", name: "probe_check", arguments: { path: "missing.ts" } },
		]),
		toolResult("probe_check", [{ type: "text", text: "ENOENT" }], true),
	];

	assert.deepEqual(toAntigravityPromptBlocks(messages), [
		{
			type: "text",
			text: [
				"[user]\nCheck file",
				"[assistant]\nChecking now.",
				'[tool call probe_check] {"path":"missing.ts"}',
				"[tool result probe_check error]\nENOENT",
			].join("\n\n"),
		},
	]);
});

test("toAntigravityPromptBlocks preserves images in user and toolResult history as ACP image blocks", () => {
	const messages: Message[] = [
		user([
			{ type: "text", text: "Diagram A" },
			{ type: "image", data: "IMG_A", mimeType: "image/png" },
		]),
		assistant([{ type: "toolCall", id: "call-3", name: "ask_user_question", arguments: { prompt: "Upload diagram B" } }]),
		toolResult("ask_user_question", [
			{ type: "text", text: "Here is Diagram B" },
			{ type: "image", data: "IMG_B", mimeType: "image/jpeg" },
		]),
		user("Compare A and B"),
	];

	assert.deepEqual(toAntigravityPromptBlocks(messages), [
		{ type: "text", text: "[user]\nDiagram A" },
		{ type: "image", data: "IMG_A", mimeType: "image/png" },
		{ type: "text", text: '[tool call ask_user_question] {"prompt":"Upload diagram B"}\n\n[tool result ask_user_question]\nHere is Diagram B' },
		{ type: "image", data: "IMG_B", mimeType: "image/jpeg" },
		{ type: "text", text: "[user]\nCompare A and B" },
	]);
});
