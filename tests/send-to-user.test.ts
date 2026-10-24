/**
 * send_to_user — Anthropic's documented fix for verbatim mid-turn content: newer Claude models return text written right before a tool call only as a summary, so explanations travel as tool input instead.
 * Pinned here: the tool's shape and acknowledgement, the view rendering its message as ordinary teacher prose (settled and mid-stream), and extraction plus the markdown export reading it as prose.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendToUserTool } from "../src/agent/tools/send-to-user.ts";
import { messageViewLines, teacherProseBlocks } from "../src/core/coverage.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { projectView } from "../src/core/view.ts";

const EXPLANATION = "The union $S\\cup B$ is everyone in at least one circle.";

const teachingTurn = (message: string = EXPLANATION): LhMessage[] =>
	[
		{ id: "u1", role: "user", content: "teach me", timestamp: 0 },
		{
			id: "a1",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "explain the union, then check it" },
				{ type: "toolCall", id: "call-s1", name: "send_to_user", arguments: { message } },
				{ type: "toolCall", id: "call-q1", name: "quiz", arguments: { question: "Q?", options: ["a", "b"], correctAnswer: "a" } },
			],
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			id: "r1",
			role: "toolResult",
			toolCallId: "call-s1",
			toolName: "send_to_user",
			content: [{ type: "text", text: "Shown to the learner." }],
			isError: false,
			timestamp: 0,
		},
	] as unknown as LhMessage[];

describe("the send_to_user tool", () => {
	it("takes one message and acknowledges it", async () => {
		assert.equal(sendToUserTool.name, "send_to_user");
		assert.deepEqual(Object.keys(sendToUserTool.parameters.properties), ["message"]);
		const result = await sendToUserTool.execute!("c", { message: EXPLANATION });
		assert.deepEqual(result.content, [{ type: "text", text: "Shown to the learner." }]);
	});
});

describe("the view renders the message as teacher prose", () => {
	it("in place, before the question it introduces; the acknowledgement renders nothing", () => {
		const parts = projectView(teachingTurn()).flatMap((m) => m.parts);
		const textIndex = parts.findIndex((p) => p.type === "text" && p.text === EXPLANATION);
		const quizIndex = parts.findIndex((p) => p.type === "tool-quiz");
		assert.ok(textIndex >= 0, "the message projects as a text part");
		assert.ok(textIndex < quizIndex, "it reads before the quiz");
		assert.equal(parts[textIndex]!.id, "a1-t0", "same id scheme as text blocks, so navigation and find work");
		assert.ok(!parts.some((p) => p.type === "tool-send_to_user"), "never a tool card");
	});

	it("streams in as the model writes it", () => {
		const live = { executions: new Map(), inFlight: true, streamingIds: new Set(["a1"]) };
		const parts = projectView(teachingTurn("The union $S"), live).flatMap((m) => m.parts);
		assert.ok(parts.some((p) => p.type === "text" && p.text === "The union $S"));
	});
});

describe("extraction and the markdown export read it as prose", () => {
	it("coverage lines and the extractor's prose blocks include the message", () => {
		const messages = teachingTurn();
		assert.deepEqual(messageViewLines(messages[1]!, "a1"), [`TEACHER [a1] ${EXPLANATION}`]);
		assert.deepEqual(teacherProseBlocks(messages), [EXPLANATION]);
	});

	it("exports as a Teacher block, with no tool-result line for the acknowledgement", () => {
		const markdown = sessionMarkdown(teachingTurn());
		assert.ok(markdown.includes(`### Teacher · a1\n\n${EXPLANATION}`));
		assert.ok(!markdown.includes("send_to_user result delivered"));
	});
});
