/**
 * SCHEDULED PRACTICE — the review log on disk and its sync seam, under an
 * isolated LH_DATA_DIR (set before the first config-loading import, so
 * every app-module import is dynamic — the birth-stamp discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { REVIEW_FILES } = await import("../config.ts");
const { reviewStore } = await import("../src/store/review.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { backfillReviews, reviewSummary, syncChatReviews } = await import("../src/server/review.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { FACTORY_SETTINGS } = await import("../src/core/settings.ts");
const { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL } = await import("../src/core/native-messages.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.dirname(REVIEW_FILES.reviews), { recursive: true, force: true });
});

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

function call(callId: string, name: string, args: JsonObject, at: number): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: at,
		...STAMPS,
	};
	const result: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details: null,
		isError: false,
		timestamp: at + 1,
	};
	return [assistant, result];
}

function practiceChat(targets: string[], outcome = "solved"): string {
	const chat = chatStore.createChat("practice", "practice");
	chatStore.saveMessages(chat.id, [
		...call("p1", PRACTICE_PROBLEM_TOOL, { statement: "s", mode: "recall", modelSolution: "m", target: targets }, 1_000),
		...call("c1", PRACTICE_CONCLUDE_TOOL, { outcome, verdict: "v", rung: null, missClass: null, retest: false }, 2_000),
	]);
	return chat.id;
}

describe("the review log", () => {
	it("a sync appends once — re-syncing is idempotent", () => {
		const id = practiceChat(["n_a"]);
		assert.equal(syncChatReviews(id), 1);
		assert.equal(syncChatReviews(id), 0);
		const logged = reviewStore.readReviews();
		assert.equal(logged.length, 1);
		assert.equal(logged[0]!.id, `${id}:p1`);
		assert.deepEqual(JSON.parse(fs.readFileSync(REVIEW_FILES.format, "utf-8")), { version: 1 });
	});

	it("a teach chat or an empty sync creates no files", () => {
		const teach = chatStore.createChat("teach");
		assert.equal(syncChatReviews(teach.id), 0);
		assert.equal(syncChatReviews("missing"), 0);
		assert.equal(fs.existsSync(path.dirname(REVIEW_FILES.reviews)), false);
	});

	it("backfill folds every practice chat, and never twice", () => {
		const before = reviewStore.readReviews().length;
		practiceChat(["n_b"]);
		const added = backfillReviews();
		assert.ok(added >= 1);
		assert.equal(reviewStore.readReviews().length, before + added);
		assert.equal(backfillReviews(), 0);
	});

	it("corrupt and shape-invalid lines are skipped", () => {
		const id = practiceChat(["n_c"]);
		syncChatReviews(id);
		fs.appendFileSync(REVIEW_FILES.reviews, "{torn\n" + JSON.stringify({ id: "x", targets: [] }) + "\n");
		assert.equal(reviewStore.readReviews().length, 1);
	});

	it("lines with and without the brief's facts both read; a mistyped fact skips the line", () => {
		const base = { chatId: "c", problemCallId: "p", at: "2026-11-01T12:00:00.000Z", targets: ["n_a"], outcome: "solved", rung: null };
		reviewStore.appendReviews([
			{ ...base, id: "c:old" } as never,
			{ ...base, id: "c:new", mode: "recall", missClass: null, surface: "a ladder" } as never,
		]);
		fs.appendFileSync(REVIEW_FILES.reviews, JSON.stringify({ ...base, id: "c:bad", surface: 7 }) + "\n");
		assert.deepEqual(
			reviewStore.readReviews().map((r) => [r.id, r.mode, r.surface]),
			[["c:old", undefined, undefined], ["c:new", "recall", "a ladder"]],
		);
	});

	it("a newer format stamp is refused honestly", () => {
		fs.mkdirSync(path.dirname(REVIEW_FILES.format), { recursive: true });
		fs.writeFileSync(REVIEW_FILES.format, JSON.stringify({ version: 99 }));
		assert.throws(() => reviewStore.readReviews(), /format version 99/);
	});

	it("deleting a practice chat keeps its reviews (unsynced ones are folded in first)", async () => {
		const id = practiceChat(["n_d"], "surrendered");
		const outcome = await deleteChatSession(id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(chatStore.getChat(id), null);
		assert.deepEqual(
			reviewStore.readReviews().map((r) => [r.id, r.outcome]),
			[[`${id}:p1`, "surrendered"]],
		);
	});
});

describe("reviewSummary", () => {
	it("resolves picks to the live graph's name and statement", () => {
		const graphStore = {
			readNodes: () => [
				{ id: "n_a", name: "A", statement: "A holds.", aliases: [], provenance: [], createdAt: "2026-11-01T12:00:00.000Z" },
				{ id: "n_b", name: "B", statement: "B holds.", aliases: [], provenance: [], createdAt: "2026-11-01T13:00:00.000Z" },
			],
			readChains: () => [],
		};
		const reviews = {
			readReviews: () => [
				{ id: "c:p1", chatId: "c", problemCallId: "p1", at: "2026-10-01T12:00:00.000Z", targets: ["n_b"], outcome: "solved" as const, rung: null },
			],
			appendReviews: () => {},
		};
		const summary = reviewSummary(new Date("2026-11-02T12:00:00.000Z"), { graphStore, reviewStore: reviews }, FACTORY_SETTINGS.review);
		assert.deepEqual(summary, {
			dueCount: 1,
			newCount: 1,
			picks: [
				{ id: "n_b", name: "B", statement: "B holds." },
				{ id: "n_a", name: "A", statement: "A holds." },
			],
		});
	});
});
