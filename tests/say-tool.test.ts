import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import { SAY_TOOL } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { teacherProseBlocks } from "../src/core/coverage.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import { bareQuestionTools, makeQuestionStopper } from "../src/agent/teacher-agent.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";

/**
 * Claude Opus 5.5 returns prose written between tool calls as a summarized
 * thinking block, so a lesson written as plain text before a quiz call
 * never reaches the learner. The `say` tool carries learner-facing prose in
 * its input, which the API returns verbatim; every prose reader must treat
 * a say call exactly like a text block.
 */

const LESSON = "## Stopping distance\n\nTripling speed gives $9\\times$ the distance.";

function sayThenQuiz(): LhMessage[] {
	const assistant = {
		id: "m1",
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
			{ type: "toolCall", id: "c-say", name: SAY_TOOL, arguments: { markdown: LESSON } },
			{ type: "toolCall", id: "c-quiz", name: "quiz", arguments: { question: "How far?", options: [] } },
		],
	} as unknown as LhMessage;
	const sayResult = {
		id: "m2",
		role: "toolResult",
		toolCallId: "c-say",
		toolName: SAY_TOOL,
		content: [{ type: "text", text: "Shown to the learner." }],
		details: { ok: true },
		isError: false,
		timestamp: 0,
	} as unknown as ToolResultMessage & LhMessage;
	return [assistant, sayResult];
}

describe("say tool", () => {
	it("renders as teacher text in the chat view, above the question, with no tool card", () => {
		const [view] = projectView(sayThenQuiz());
		const kinds = view!.parts.map((p) => p.type);
		assert.ok(!kinds.includes(`tool-${SAY_TOOL}`), "no say tool card");
		const text = view!.parts.find((p) => p.type === "text") as { text: string } | undefined;
		assert.equal(text?.text, LESSON);
		assert.ok(kinds.indexOf("text") < kinds.indexOf("tool-quiz"), "lesson renders before the quiz");
	});

	it("streams partial markdown while the call is still arriving", () => {
		const streaming = {
			id: "m1",
			role: "assistant",
			content: [{ type: "toolCall", id: "c-say", name: SAY_TOOL, arguments: { markdown: "## Stop" } }],
		} as unknown as LhMessage;
		const [view] = projectView([streaming], { executions: new Map(), inFlight: true, streamingIds: new Set(["m1"]) });
		const text = view!.parts.find((p) => p.type === "text") as { text: string } | undefined;
		assert.equal(text?.text, "## Stop");
	});

	it("feeds knowledge extraction like any teacher prose", () => {
		assert.deepEqual(teacherProseBlocks(sayThenQuiz()), [LESSON]);
	});

	it("exports as a Teacher block, with no tool note for the ack", () => {
		const md = sessionMarkdown(sayThenQuiz(), { anchors: false });
		assert.ok(md.includes(`### Teacher\n\n${LESSON}`), md);
		assert.ok(!md.includes("say result delivered"), md);
	});

	it("is in every agent's registry", () => {
		const ctx = {} as never;
		assert.ok(SAY_TOOL in createTeacherTools(ctx));
		assert.ok(SAY_TOOL in createProberTools(ctx));
		assert.ok(SAY_TOOL in bareQuestionTools());
		assert.ok(SAY_TOOL in practiceTools({ chatId: "c", chatStore: { getChat: () => null } } as never));
	});

	it("never ends a turn alone, but a cleanly posed question or problem beside it does", () => {
		const stops = makeQuestionStopper();
		const turn = (names: string[], errored: string[] = []) => ({
			message: { content: names.map((name) => ({ type: "toolCall", id: `c-${name}`, name })) },
			toolResults: names.map((name) => ({ toolCallId: `c-${name}`, isError: errored.includes(name) })),
		});
		assert.equal(stops(turn([SAY_TOOL])), false, "say alone continues the turn");
		assert.equal(stops(turn([SAY_TOOL, "quiz"])), true, "say + quiz stops");
		assert.equal(stops(turn([SAY_TOOL, "problem"])), true, "say + problem stops");
		assert.equal(stops(turn([SAY_TOOL, "problem"], ["problem"])), false, "a refused problem lets the agent retry");
	});
});
