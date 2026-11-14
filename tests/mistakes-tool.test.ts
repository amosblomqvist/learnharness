/**
 * The `mistakes` tool — read-only access to the learner's mistake history.
 *
 * Pins the three actions (list/summary/get), the filters, the compact text
 * shape, the token-budget truncation notice, the empty states, and the
 * privacy rule: no path separator and no store filename reaches the model.
 * The reader is injected, mirroring the composition root.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mistakeTools, MISTAKES_TOOL } from "../src/agent/tools/mistakes.ts";
import type { ErrorType, MistakeAnalysis, MistakeRecord } from "../src/core/mistakes.ts";

let current: readonly MistakeRecord[] = [];
const tool = mistakeTools({ read: () => current })[MISTAKES_TOOL]!;

const analysis = (errorType: ErrorType, topic: string): MistakeAnalysis => ({
	errorType,
	topic,
	whatYouDid: "Used kinetic friction before checking whether the block moves.",
	correct: "Static friction balances the pull while the block is at rest.",
	rule: "Check whether the object moves before choosing a friction model.",
});

const record = (over: Partial<MistakeRecord> & Pick<MistakeRecord, "id" | "chatId">): MistakeRecord => ({
	kind: "missed",
	origin: "quiz",
	question: "What is the friction force?",
	yourAnswer: "69 N",
	correctAnswer: "50 N",
	sessionTitle: "Session",
	sessionKind: "teach",
	sources: [],
	answeredAt: "2026-10-27T10:00:00.000Z",
	createdAt: "2026-10-27T10:01:00.000Z",
	status: "ready",
	...over,
});

const FIXTURES: MistakeRecord[] = [
	record({
		id: "chat-a:q1",
		chatId: "chat-a",
		question: "What is static friction on the ramp?",
		sessionTitle: "Ramps",
		analysis: analysis("confusable-pair", "Static friction"),
	}),
	record({
		id: "chat-b:q2",
		chatId: "chat-b",
		kind: "unanswered",
		question: "What is the normal force on the block?",
		yourAnswer: "I don't know",
		correctAnswer: "98 N",
		sessionTitle: "Forces",
		createdAt: "2026-10-28T10:01:00.000Z",
		analysis: analysis("knowledge-gap", "Normal force"),
	}),
	record({
		id: "chat-a:p1",
		chatId: "chat-a",
		kind: "problem",
		question: "Prove the sum is even.",
		yourAnswer: "Gave up",
		correctAnswer: "Pair them.",
		sessionTitle: "Ramps",
		createdAt: "2026-10-29T10:01:00.000Z",
		status: "pending",
	}),
	record({
		id: "chat-c:q3",
		chatId: "chat-c",
		question: "Which graph is a function?",
		sessionTitle: "Functions",
		createdAt: "2026-10-30T10:01:00.000Z",
		status: "failed",
	}),
	record({
		id: "chat-b:q5",
		chatId: "chat-b",
		question: "Which force pair is easily confused?",
		sessionTitle: "Forces",
		createdAt: "2026-10-31T10:01:00.000Z",
		analysis: analysis("confusable-pair", "Static friction"),
	}),
];

function writeRecords(records: readonly MistakeRecord[]): void {
	current = [...records];
}

async function run(args: Record<string, unknown>): Promise<string> {
	const result = await tool.execute!("test", args as never);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("mistakes tool", () => {
	it("has the native name and a read-only description with no path", () => {
		assert.equal(tool.name, "mistakes");
		assert.doesNotMatch(tool.description, /mistakes\.json|[\\/]/);
		assert.doesNotMatch(JSON.stringify(tool.parameters), /mistakes\.json|[\\/]/);
	});

	it("returns useful sentences for an empty store", async () => {
		writeRecords([]);
		assert.match(await run({ action: "list" }), /No mistakes have been recorded yet\./);
		assert.match(await run({ action: "summary" }), /No mistakes have been recorded yet\./);
		assert.match(await run({ action: "get", id: "missing" }), /No mistake with id "missing"/);
	});

	it("filters by session title, chat id, error type, status and topic", async () => {
		writeRecords(FIXTURES);
		const bySession = await run({ action: "list", session: "ramps" });
		assert.match(bySession, /^2 mistakes found/);
		assert.match(bySession, /chat-a:q1/);
		assert.match(bySession, /chat-a:p1/);
		assert.doesNotMatch(bySession, /chat-b:q2/);

		const byChat = await run({ action: "list", chatId: "chat-b" });
		assert.match(byChat, /^2 mistakes found/);
		assert.match(byChat, /chat-b:q2/);
		assert.match(byChat, /chat-b:q5/);

		const byType = await run({ action: "list", errorType: "confusable-pair" });
		assert.match(byType, /^2 mistakes found/);
		assert.match(byType, /Confusable pair/);
		assert.doesNotMatch(byType, /Knowledge gap/);

		const byStatus = await run({ action: "list", status: "pending" });
		assert.match(byStatus, /^1 mistake found/);
		assert.match(byStatus, /chat-a:p1/);

		const byTopic = await run({ action: "list", topic: "normal force" });
		assert.match(byTopic, /^1 mistake found/);
		assert.match(byTopic, /chat-b:q2/);

		assert.match(await run({ action: "list", topic: "no such topic" }), /No mistakes match those filters\./);
	});

	it("summarizes counts, statuses and recurring patterns", async () => {
		writeRecords(FIXTURES);
		const text = await run({ action: "summary" });
		assert.match(text, /Mistakes: 5 total — 3 missed, 1 unanswered, 1 problem\./);
		assert.match(text, /Analysis: 3 ready, 1 failed, 1 pending\./);
		assert.match(text, /Confusable pair: 2/);
		assert.match(text, /Knowledge gap: 1/);
		assert.match(text, /2 of 3: Confusable pair/);
		assert.match(text, /2 of 3: Static friction/);
	});

	it("shows one record by id and says when it is missing", async () => {
		writeRecords(FIXTURES);
		const text = await run({ action: "get", id: "chat-a:q1" });
		assert.match(text, /Mistake chat-a:q1/);
		assert.match(text, /What went wrong:/);
		assert.match(text, /Correct reasoning:/);
		assert.match(text, /Rule for next time:/);
		assert.match(text, /Confusable pair/);
		assert.match(await run({ action: "get", id: "chat-c:q3" }), /Analysis: failed/);
		assert.match(await run({ action: "get", id: "nope" }), /No mistake with id "nope"/);
	});

	it("renders a malformed record with missing strings instead of throwing", async () => {
		const malformed = {
			id: "chat-m:q1",
			chatId: "chat-m",
			kind: "missed",
			origin: "quiz",
			sessionTitle: "Malformed",
			sessionKind: "teach",
			sources: [],
			status: "ready",
			analysis: { errorType: "confusable-pair" },
		} as unknown as MistakeRecord;
		writeRecords([malformed]);
		assert.match(await run({ action: "list" }), /chat-m:q1/);
		const detail = await run({ action: "get", id: "chat-m:q1" });
		assert.match(detail, /Mistake chat-m:q1/);
		assert.doesNotMatch(detail, /undefined/);
	});

	it("renders an unknown error type as its own string, never undefined", async () => {
		const unknown = {
			...record({ id: "chat-u:q1", chatId: "chat-u", question: "Which type is this?", sessionTitle: "Unknowns" }),
			analysis: {
				errorType: "renamed-type",
				topic: "Future topic",
				whatYouDid: "Used an older name.",
				correct: "Use the current name.",
				rule: "Read the current taxonomy.",
			},
		} as unknown as MistakeRecord;
		writeRecords([unknown]);
		const output = [
			await run({ action: "list" }),
			await run({ action: "get", id: "chat-u:q1" }),
			await run({ action: "summary" }),
		].join("\n");
		assert.match(output, /renamed-type/);
		assert.doesNotMatch(output, /undefined/);
	});

	it("caps the list and prints the truncation notice", async () => {
		writeRecords(FIXTURES);
		const text = await run({ action: "list", limit: 1 });
		assert.match(text, /^5 mistakes found \(showing 1\):/);
		assert.match(text, /4 more not shown; narrow the filters or raise limit \(max 40\)\./);
		assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 1);
	});

	it("never leaks a path separator or the store filename", async () => {
		writeRecords(FIXTURES);
		const outputs = [
			tool.description,
			JSON.stringify(tool.parameters),
			await run({ action: "list" }),
			await run({ action: "summary" }),
			await run({ action: "get", id: "chat-a:q1" }),
		];
		for (const output of outputs) assert.doesNotMatch(output, /mistakes\.json|[\\/]/);
	});
});
