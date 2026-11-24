import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newAnswerResult, newPlanBlockMessage, newUserMessage } from "../src/core/native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import {
	batchRuns,
	batchTag,
	coverageOf,
	coverageSlots,
	messageFingerprint,
	messageViewLines,
	teacherProseBlocks,
} from "../src/core/coverage.ts";
import type { CoverageEntry } from "../src/core/contracts/graph.ts";

/**
 * Extraction coverage — the pure core under the TEACHER-PROSE ruling
 * (owner, 2026-09-28): the extractor sees only the teacher's text
 * blocks; fingerprints, slots, tokens, and batching all derive from that
 * one selection. Everything else is invisible — it neither opens nor
 * joins a run.
 */

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as LhMessage;
}

/** An assistant message calling `calls` (each {id,name}) — the bond anchor. */
function assistantWithCalls(
	id: string,
	calls: Array<{ id: string; name: string; args?: unknown }>,
): LhMessage {
	return {
		id,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
	} as unknown as LhMessage;
}

function result(id: string, callId: string, name: string, details: unknown): LhMessage {
	return { ...newAnswerResult(callId, name, details), id } as LhMessage;
}

function slot(messages: ReadonlyArray<LhMessage>, id: string) {
	const found = coverageSlots(messages).find((s) => s.message.id === id);
	assert.ok(found, `slot ${id}`);
	return found;
}

describe("messageFingerprint — what changes it, what never does", () => {
	it("a text edit changes the fingerprint; role participates", () => {
		const a = messageFingerprint(teacher("m1", "hello world"));
		const b = messageFingerprint(teacher("m1", "hello worlds"));
		const same = messageFingerprint(teacher("m1", "hello world"));
		assert.notEqual(a, b);
		assert.equal(a, same);
		// Role is hashed too — the same words from a LEARNER have no view
		// lines at all (teacher prose only), so the fingerprints differ.
		assert.notEqual(a, messageFingerprint(user("m1", "hello world")));
	});

	it("the message id is the provenance tag — part of exactly what the extractor saw", () => {
		// The view lines carry the [id] tag, so identical content under a
		// different id is a DIFFERENT fingerprint: coverage matches the
		// extraction view byte-for-byte. (Ids are stable in practice — the
		// write-ahead persist owns them.)
		assert.notEqual(messageFingerprint(teacher("m1", "same")), messageFingerprint(teacher("m2", "same")));
		// The same id + content re-fingerprints equal.
		assert.equal(messageFingerprint(teacher("m1", "same")), messageFingerprint(teacher("m1", "same")));
	});

	it("marker messages are invisible — a plan-block attach never re-opens anything", () => {
		// Wave D: the marker is its OWN message (not a part on another one);
		// its view is empty, so it neither re-opens others nor itself
		// carries any learning evidence.
		const marker = newPlanBlockMessage("call_p1", {
			kind: "full",
			at: "2026-09-26T00:00:00.000Z",
			current: null,
			nodes: [],
			edges: [],
		}) as LhMessage;
		assert.deepEqual(messageViewLines(marker, marker.id), []);
		// And the message it rides beside keeps its fingerprint untouched:
		const before = messageFingerprint(teacher("t1", "the chain rule"));
		const withMarker = [teacher("t1", "the chain rule"), marker];
		assert.equal(
			messageFingerprint(withMarker[0]!),
			before,
			"the neighbour's fingerprint is unchanged by the attach",
		);
	});

	it("quiz Q&A is INVISIBLE under the teacher-prose ruling (owner, 2026-09-28)", () => {
		// Neither the asking message nor the graded answer produces view
		// lines — a quiz exchange can never open or join an extraction run.
		const asking = assistantWithCalls("a1", [{ id: "q1", name: "quiz", args: { question: "Q?" } }]);
		const answer = result("r1", "q1", "quiz", { questionText: "Q?", correct: true });
		assert.deepEqual(messageViewLines(asking, "a1"), []);
		assert.deepEqual(messageViewLines(answer, "r1"), []);
		assert.equal(slot([asking, answer], "a1").tokens, 0);
		assert.equal(slot([asking, answer], "r1").tokens, 0);
	});

	it("learner messages and ALL tool results are invisible — clean or failed", () => {
		assert.deepEqual(messageViewLines(user("u1", "teach me"), "u1"), []);
		const demo = result("r1", "j1", "demo", { title: "T" });
		assert.deepEqual(messageViewLines(demo, "r1"), []);
		const failed = {
			...newAnswerResult("j2", "visual", { oops: true }),
			isError: true,
		} as LhMessage;
		assert.deepEqual(messageViewLines(failed, "r9"), []);
	});

	it("teacherProseBlocks — the prompt material: teacher text blocks only, plain, in order", () => {
		const blocks = teacherProseBlocks([
			user("u1", "learner asks"),
			teacher("t1", " first insight "),
			assistantWithCalls("a1", [{ id: "q1", name: "quiz" }]),
			teacher("t2", "second insight"),
		]);
		assert.deepEqual(blocks, ["first insight", "second insight"]);
	});
});

describe("coverageOf — uncovered is DERIVED, never dual-tracked", () => {
	it("diffs fingerprints: covered stays, uncovered counts, tokens split", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb"), teacher("m3", "cccc")];
		const fp1 = slot(messages, "m1").fp;
		const fp2 = slot(messages, "m2").fp;
		const entries: CoverageEntry[] = [
			{ chatId: "c1", fp: fp1, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			{ chatId: "c1", fp: fp2, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			// Another chat's entries are irrelevant to c1's coverage.
			{ chatId: "c2", fp: slot(messages, "m3").fp, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
		];
		const cov = coverageOf(messages, entries, "c1");
		// `uncovered` is INDEXES (the batcher needs positions for bonding):
		assert.deepEqual(cov.uncovered, [2]);
		assert.deepEqual(cov.slots[cov.uncovered[0]!]!.message.id, "m3");
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.uncoveredTokens, slot(messages, "m3").tokens);
		assert.equal(cov.coveredTokens, slot(messages, "m1").tokens + slot(messages, "m2").tokens);
	});

	it("a mutated covered message re-opens itself, and only itself", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb")];
		const entries: CoverageEntry[] = coverageSlots(messages).map((s) => ({
			chatId: "c1",
			fp: s.fp,
			tokens: s.tokens,
			foldedAt: "2026-09-15T00:00:00.000Z",
		}));
		assert.equal(coverageOf(messages, entries, "c1").uncoveredCount, 0);
		const mutated = [teacher("m1", "aaaa!"), messages[1]!];
		const cov = coverageOf(mutated, entries, "c1");
		assert.deepEqual(cov.uncovered, [0]);
		assert.equal(cov.slots[0]!.message.id, "m1");
	});
});

describe("batchRuns — token-budgeted, consecutive, never splits a message", () => {
	it("greedy oldest-first fill; the overflowing message starts the next run", () => {
		// Each message's view line is ~14 tok (chars/4) → budget 45 fits
		// three, the fourth overflows: [m1,m2,m3] + [m4].
		const slots = coverageSlots([
			teacher("m1", "a".repeat(40)),
			teacher("m2", "b".repeat(40)),
			teacher("m3", "c".repeat(40)),
			teacher("m4", "d".repeat(40)),
		]);
		const runs = batchRuns(slots, [0, 1, 2, 3], 45);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["m1", "m2", "m3"], ["m4"]],
		);
	});

	it("a single message larger than the budget becomes its own over-budget run", () => {
		const slots = coverageSlots([teacher("m1", "x".repeat(400)), teacher("m2", "y".repeat(20))]);
		assert.deepEqual(
			batchRuns(slots, [0, 1], 10).map((r) => r.map((s) => s.message.id)),
			[["m1"], ["m2"]],
		);
	});

	it("an empty or non-positive budget never drops messages into a void", () => {
		assert.deepEqual(batchRuns(coverageSlots([teacher("m1", "hi")]), [0], 0), []);
		assert.deepEqual(batchRuns([], [], 4096), []);
	});

	it("learner messages and tool results never join a batch — teacher prose only (owner, 2026-09-28)", () => {
		// The inseparability bond died with the ruling: tool results are
		// invisible, so nothing needs keeping together. Batches are pure
		// greedy runs over the TEACHER slots alone.
		const messages = [
			user("u1", "learner asks"),
			teacher("t1", "x".repeat(40)),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true }),
			teacher("t2", "y".repeat(40)),
		];
		const cov = coverageOf(messages, [], "c1");
		assert.deepEqual(cov.uncovered, [1, 3], "only the teacher-prose slots are uncovered");
		const runs = batchRuns(cov.slots, cov.uncovered, 15);
		assert.deepEqual(
			runs.map((r) => r.map((sl) => sl.message.id)),
			[["t1"], ["t2"]],
			"each run is teacher prose alone — the learner message and the quiz result ride nowhere",
		);
	});
});

describe("batchTag — deterministic, ref-stable, mutation-sensitive", () => {
	it("the same members in the same order → the same 12-hex tag; a different order is a different batch", () => {
		const slots = coverageSlots([teacher("m1", "aaaa"), teacher("m2", "bbbb")]);
		assert.equal(batchTag(slots), batchTag(coverageSlots([teacher("m1", "aaaa"), teacher("m2", "bbbb")])));
		assert.notEqual(batchTag(slots), batchTag([...slots].reverse()), "batches are ordered runs");
		assert.match(batchTag(slots), /^[0-9a-f]{12}$/);
	});

	it("a re-opened member changes the tag — its observations land as new events", () => {
		const slots = coverageSlots([teacher("m1", "aaaa"), teacher("m2", "bbbb")]);
		const mutated = coverageSlots([teacher("m1", "aaaa!"), teacher("m2", "bbbb")]);
		assert.notEqual(batchTag(slots), batchTag(mutated));
	});
});

describe("the all-sessions coverage GET is dead (extraction-UX close-out, 2026-09-24)", () => {
	it("the route file is gone — the only coverage endpoint is the Extract POST", () => {
		// UI confirmation (ff1ec7a): nothing client-side consumes the
		// all-sessions list anymore — the sidebar block and the ring both
		// read GET /api/chats/[id]'s coverage block. This pin guards against
		// a merge resurrecting the dead surface.
		assert.equal(fs.existsSync("app/api/graph/coverage/route.ts"), false, "the all-sessions GET route is deleted");
		// stays by design: the manual-extract front door (sidebar block's
		// Extract affordance) lives on.
		assert.equal(fs.existsSync("app/api/graph/coverage/extract/route.ts"), true, "the Extract POST survives");
	});
});
