import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeCompactionOf,
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
	buildCompactionPrompt,
	compactionCutIndex,
	estimateTokens,
	keptIndexFor,
	newCompactionMarker,
	newUserMessage,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	COMPACTED_HISTORY_HEADER,
	type LhMessage,
	type LhMarkerMessage,
} from "../src/core/index.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { projectView } from "../src/core/view.ts";

/**
 * COMPACTION (owner round 14, 2026-10-05) — the pure core: the cut walk,
 * the marker, and the ONE model-facing projection (toLlmMessages) that
 * swaps [summary] + [kept tail] for the dropped span.
 *
 * The laws pinned here:
 * - the cut NEVER separates a tool result from its call;
 * - a pending question call (pose→answer window) always survives — the
 *   walk cannot cross the transcript end;
 * - the active marker is the NEWEST one (chained compactions rule last);
 * - the marker renders ONCE (head), never twice;
 * - a corrupt cut degrades honestly (everything renders — never throw).
 */

const assistantWithCall = (id: string, callId: string, text = "Let me quiz you."): LhMessage =>
	({
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Q?" } },
		],
		timestamp: 1,
	}) as never;

const assistantText = (id: string, text: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as never;

const resultFor = (callId: string, text: string): LhMessage & ToolResultMessage =>
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	}) as never;

const big = (id: string, kb = 8): LhMessage => newUserMessage(`${id}: ${"x".repeat(kb * 1024)}`);

// ─── the anchored estimator (pi's law — 2026-10-05 incident fix) ─────────────

describe("estimateContextTokens (usage-anchored, pi's law)", () => {
	const usageAssistant = (id: string, total: number, trailing = false): LhMessage =>
		({
			id,
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: trailing ? "aborted" : "toolUse",
			timestamp: 1,
		}) as never;

	it("anchors on the last assistant's provider-reported usage and chars/4-estimates ONLY the tail", () => {
		const msgs = [
			newUserMessage(`${"x".repeat(400_000)}`), // 100k chars of DROPPED-span text
			usageAssistant("a1", 30_000),
			newUserMessage("y".repeat(4_000)), // 1k estimated tokens AFTER the anchor
		] as LhMessage[];
		// ^ newUserMessage signature: (text, ts?) — second arg timestamp
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex !== null, true);
		assert.equal(est.usageTokens, 30_000);
		assert.equal(est.trailingTokens, 1_000);
		assert.equal(est.tokens, 31_000); // the 100k chars before the anchor are NOT re-estimated
	});

	it("skips aborted and all-zero-usage assistants when hunting the anchor", () => {
		const msgs = [
			usageAssistant("a1", 30_000),
			usageAssistant("a2", 99_999, true), // aborted after the real one
			{ ...usageAssistant("a3", 0), stopReason: "toolUse" }, // zero usage
		] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, 0);
		assert.equal(est.tokens, 30_000 + estimateMessageTokens(msgs[1]!) + estimateMessageTokens(msgs[2]!));
	});

	it("refuses anchors older than the newest compaction marker (pre-cut usage is not truth)", () => {
		const marker = newCompactionMarker("summary text", {
			firstKeptMessageId: "m1",
			tokensBefore: 500_000,
			at: "2026-10-05T00:00:00.000Z",
		});
		const msgs = [usageAssistant("a1", 500_000), marker as LhMessage, newUserMessage("kept tail")] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, null, "the marker invalidates every anchor behind it");
	});

	it("unanchored (no usage at all): the plain heuristic over everything", () => {
		const msgs = [big("m1", 4), big("m2", 4)] as LhMessage[]; // 2 × 4,116ish chars
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, null);
		assert.equal(est.tokens, estimateTokens(msgs));
	});
});

describe("estimateMessageTokens (wire text only — the 3x-inflation fix)", () => {
	it("assistant: text + thinking + toolCall name/args — scaffolding never counted", () => {
		const m = {
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "x".repeat(400) },
				{ type: "thinking", thinking: "y".repeat(800), thinkingSignature: "sig" },
				{ type: "toolCall", id: "c1", name: "quiz", arguments: { q: "z".repeat(200) } },
			],
			usage: { input: 9_999_999, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			responseId: "r".repeat(300),
			timestamp: 1,
		} as never as LhMessage;
		const expected = Math.ceil((400 + 800 + ("quiz".length + JSON.stringify({ q: "z".repeat(200) }).length)) / 4);
		assert.equal(estimateMessageTokens(m), expected); // usage/responseId/signature inflate nothing
	});

	it("calculateContextTokens: totalTokens wins, else the field sum", () => {
		assert.equal(calculateContextTokens({ totalTokens: 42, input: 1, output: 2 }), 42);
		assert.equal(calculateContextTokens({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }), 20);
		assert.equal(calculateContextTokens({}), 0);
	});
});

// ─── the cut walk ────────────────────────────────────────────────────────────

describe("compactionCutIndex", () => {
	it("keeps ~the budget of recent messages: everything before is the span", () => {
		const messages = [big("m1"), big("m2"), big("m3"), big("m4"), newUserMessage("recent")];
		// ~8KB each ≈ 2k tokens; a 4.5k budget keeps the last two + recent.
		const cut = compactionCutIndex(messages, 4_500);
		// check-at-loop-top: kept = [m2, m3, m4, recent] ≈ 6.2k — the first
		// end-prefix whose estimate reaches the budget (overshoot = one message)
		assert.equal((messages[cut] as { content: string }).content.startsWith("m2"), true, "the oldest kept message sits at the cut");
	});

	it("native cut after an oversized result drops both call and result, never keeps an orphan", () => {
		const messages = [
			big("m1"),
			big("m2"),
			assistantWithCall("a1", "call_1"), // pose
			resultFor("call_1", "correct"), // answer — must ride WITH a1
			big("m3"),
			big("m4"),
		];
		// Budget lands on the result. Pi chooses the next valid cut AT OR
		// AFTER it, dropping the complete exchange rather than extending.
		const cut = compactionCutIndex(messages, estimateTokens([big("m3"), big("m4")]) + 1);
		assert.equal(cut, 4);
		const keptIds = new Set(messages.slice(cut).map((m) => m.id));
		assert.equal(keptIds.has("a1"), false);
		assert.equal(keptIds.has("r_call_1"), false);
	});

	it("a PENDING question call (no result — the pose→answer window) always survives", () => {
		const messages = [big("m1"), big("m2"), big("m3"), assistantWithCall("a_pending", "call_p")];
		const cut = compactionCutIndex(messages, 100); // tiny budget
		const kept = messages.slice(cut);
		assert.ok(kept.some((m) => m.id === "a_pending"), "the pending pose is never dropped");
	});

	it("whole history within budget keeps everything (zero cut)", () => {
		assert.equal(compactionCutIndex([newUserMessage("hi")], 100), 0);
	});
});

// ─── the marker + the active scan ───────────────────────────────────────────

describe("the compaction marker", () => {
	it("content is the header + summary; details carry the cut", () => {
		const marker = newCompactionMarker("The learner knows X.", {
			firstKeptMessageId: "m9",
			tokensBefore: 180_000,
			model: "openai:gpt-5.2",
			at: "2026-10-05T12:00:00.000Z",
		});
		assert.equal(marker.customType, "compaction");
		assert.ok(marker.content.startsWith(COMPACTED_HISTORY_HEADER));
		assert.ok(marker.content.endsWith("The learner knows X."));
		assert.equal((marker.details as { firstKeptMessageId: string }).firstKeptMessageId, "m9");
	});

	it("activeCompactionOf: the NEWEST marker rules (chained compactions)", () => {
		const old = newCompactionMarker("old", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" });
		const fresh = newCompactionMarker("fresh", { firstKeptMessageId: "m5", tokensBefore: 2, at: "t" });
		const active = activeCompactionOf([old as never, newUserMessage("x"), fresh as never]);
		assert.equal(active!.content.endsWith("fresh"), true);
	});

	it("a marker with malformed details is not an active compaction (defensive)", () => {
		const broken = { ...newCompactionMarker("s", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" }), details: {} };
		assert.equal(activeCompactionOf([broken as never]), null);
	});

	it("keptIndexFor: found by id; missing → -1 (the honest-fallback signal)", () => {
		const marker = newCompactionMarker("s", { firstKeptMessageId: "m2", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		const messages = [newUserMessage("a"), newUserMessage("b"), newUserMessage("c")];
		messages[0]!.id = "m1";
		messages[1]!.id = "m2";
		assert.equal(keptIndexFor(messages as never, marker as never), 1);
		const gone = newCompactionMarker("s", { firstKeptMessageId: "zzz", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		assert.equal(keptIndexFor(messages as never, gone as never), -1);
	});
});

// ─── the ONE model-facing projection ────────────────────────────────────────

describe("toLlmMessages honors the cut", () => {
	it("the active marker renders ONCE as the head; the span before the cut is gone; the kept tail rides verbatim", () => {
		const span = [big("m1"), assistantText("a0", "early lecture")];
		const kept = [newUserMessage("m2"), assistantText("a1", "recent")];
		const marker = newCompactionMarker("SUMMARY TEXT", {
			firstKeptMessageId: kept[0]!.id,
			tokensBefore: 200_000,
			at: "t",
		});
		const out = toLlmMessages([...span, ...kept, marker] as never);
		assert.equal(out.length, 3, "head + two kept messages");
		assert.equal((out[0] as { role: string }).role, "user");
		assert.ok(((out[0] as { content: Array<{ type: string; text: string }> }).content[0]!.text).includes("SUMMARY TEXT"));
		assert.ok(((out[0] as never as { content: Array<{ text: string }> }).content[0]!.text).includes(COMPACTED_HISTORY_HEADER));
		assert.equal((out[1] as never as { content: string }).content, "m2", "kept user message rides verbatim");
		// The dropped span is nowhere.
		const flat = JSON.stringify(out);
		assert.ok(!flat.includes("early lecture"), "the pre-cut span never reaches the wire");
	});

	it("the marker NEVER renders twice (its own ride position is skipped in place)", () => {
		const kept = [newUserMessage("m2")];
		const marker = newCompactionMarker("S", { firstKeptMessageId: kept[0]!.id, tokensBefore: 1, at: "t" });
		const after = [newUserMessage("later")];
		const out = toLlmMessages([...kept, marker, ...after] as never);
		assert.equal(out.length, 3, "head + kept + later — the marker's own position skipped");
		assert.equal(JSON.stringify(out).indexOf("COMPACTED]"), JSON.stringify(out).lastIndexOf("COMPACTED]"), "header appears exactly once");
	});

	it("a pending (dangling) question call in the KEPT tail still gets the interrupted synthesis", () => {
		const kept = [assistantWithCall("a1", "call_1")];
		const marker = newCompactionMarker("S", { firstKeptMessageId: "a1", tokensBefore: 1, at: "t" });
		const out = toLlmMessages([big("m0"), ...kept, marker] as never);
		const synthesis = out.find((m) => (m as never as { toolCallId?: string }).toolCallId === "call_1");
		assert.ok(synthesis, "the dangling kept call is synthesized, not stranded");
	});

	it("a corrupt cut (missing kept id) degrades honestly: everything renders, marker text included once", () => {
		const marker = newCompactionMarker("S", { firstKeptMessageId: "zzz", tokensBefore: 1, at: "t" });
		const out = toLlmMessages([newUserMessage("a"), marker, newUserMessage("b")] as never);
		assert.equal(out.length, 3, "no head swap — all three render (marker as its user text)");
	});

	it("chained compaction: the newest marker's cut wins; the older marker falls in the dropped span", () => {
		const oldMarker = newCompactionMarker("OLD", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" });
		const m1 = newUserMessage("x");
		m1.id = "m1";
		const freshKept = newUserMessage("y");
		const freshMarker = newCompactionMarker("FRESH", { firstKeptMessageId: freshKept.id, tokensBefore: 2, at: "t" });
		const out = toLlmMessages([oldMarker, m1, freshKept, freshMarker] as never);
		const flat = JSON.stringify(out);
		assert.ok(flat.includes("FRESH"));
		assert.ok(!flat.includes("OLD"), "the superseded marker dropped with its span");
	});
});

// ─── the summarizer input ────────────────────────────────────────────────────

describe("serializeForSummary + buildCompactionPrompt", () => {
	it("labels roles; truncates long tool results; skips plan blocks", () => {
		const long = "y".repeat(5_000);
		const messages: LhMessage[] = [
			newUserMessage("hello"),
			assistantText("a1", "lecture"),
			resultFor("c1", long),
			{ id: "pb", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 1 } as never,
		];
		const text = serializeForSummary(messages);
		assert.ok(text.includes("[LEARNER] hello"));
		assert.ok(text.includes("[TUTOR] lecture"));
		assert.ok(text.includes("[RESULT for quiz]"));
		assert.ok(text.includes("…[truncated]"));
		assert.ok(!text.includes("yyyyy".repeat(1000)), "truncation bounded the result");
		assert.ok(!text.toLowerCase().includes("plan-block"), "UI-only markers never serialize");
	});

	it("the prompt demands the four sections in order and carries the plan tree verbatim", () => {
		const prompt = buildCompactionPrompt({ spanText: "TRANSCRIPT", planTreeText: "- [done] A (a1)\n- A → B", kind: "teach" });
		const order = ["The learner's understanding", "The teaching arc", "The plan dependency tree", "The current moment"].map(
			(s) => prompt.indexOf(s),
		);
		assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections appear in the ruled order");
		assert.ok(prompt.includes("TRANSCRIPT"));
		assert.ok(prompt.includes("- [done] A (a1)"));
	});

	it("planTreeToText: statuses derive from the transcript; edges render; empty tree → null", () => {
		assert.equal(planTreeToText(undefined, []), null);
		const tree = {
			nodes: [
				{ id: "a", title: "Alpha", summary: "first" },
				{ id: "b", title: "Beta" },
			],
			edges: [{ from: "a", to: "b" }],
			version: 1,
		};
		const text = planTreeToText(tree as never, [])!;
		assert.ok(text.includes("Alpha (a) — first"));
		assert.ok(text.includes("Alpha → Beta"));
	});
});

// ---------------------------------------------------------------------------
// THE VIEW FOLD (owner round 14): two dividers from one marker —
// the minimal moment divider where the user is, the longer cut divider
// at the kept boundary. Both carry the full summary payload.
// ---------------------------------------------------------------------------
describe("projectView compaction dividers", () => {
	const record = (): LhMessage[] => [
		{ id: "old1", role: "user", content: "earliest", timestamp: 1 },
		{ id: "kept", role: "user", content: "recent", timestamp: 2 },
		newCompactionMarker("SUMMARY TEXT", {
			firstKeptMessageId: "kept",
			tokensBefore: 12345,
			at: new Date(0).toISOString(),
		}) as unknown as LhMessage,
	];

	it("emits the cut divider BEFORE the first kept message", () => {
		const view = projectView(record());
		const idx = view.findIndex((m) => m.parts.some((p) => p.type === "data-compaction-cut"));
		const keptIdx = view.findIndex((m) => m.parts.some((p) => p.type === "text" && p.text === "recent"));
		assert.ok(idx !== -1, "the cut divider exists");
		assert.ok(keptIdx !== -1);
		assert.equal(idx, keptIdx - 1, "immediately before the kept message");
		const part = view[idx]!.parts.find((p) => p.type === "data-compaction-cut")!;
		assert.equal((part.data as { content: string }).content.includes("SUMMARY TEXT"), true);
	});

	it("emits the moment divider at the marker (the transcript tail)", () => {
		const view = projectView(record());
		const moment = view.find((m) => m.parts.some((p) => p.type === "data-compaction"));
		assert.ok(moment, "the moment divider exists");
		const part = moment!.parts.find((p) => p.type === "data-compaction")!;
		assert.equal((part.data as { details: { tokensBefore: number } }).details.tokensBefore, 12345);
		// and it renders AFTER the kept message (the compaction moment is
		// the tail — where the user is when it happens)
		const keptIdx = view.findIndex((m) => m.parts.some((p) => p.type === "text" && p.text === "recent"));
		assert.ok(view.indexOf(moment!) > keptIdx);
	});
});

// ---------------------------------------------------------------------------
// THE CHROME LAW (the OpenRouter no-tools incident, owner 2026-10-05):
// pi-agent-core seeds a leading SystemMessage (prompt + tool
// declarations) at state.messages[0]; the record never persists it. The
// cut slices the RECORD's history — the chrome carries through ahead of
// the compaction head, exactly as pi's prepareRequest re-applies
// context.systemPrompt + context.tools around its projection.
// ---------------------------------------------------------------------------
describe("toLlmMessages carries the leading system message (request chrome)", () => {
	const chrome = {
		id: "sys",
		role: "system",
		content: "SYSTEM PROMPT + tool declarations",
		toolsAdded: [{ name: "quiz" }, { name: "plan_init" }],
		timestamp: 0,
	};
	const record = (): LhMessage[] => [
		{ id: "old", role: "user", content: "dropped history", timestamp: 1 },
		{ id: "kept", role: "user", content: "kept tail", timestamp: 2 },
		newCompactionMarker("SUMMARY", {
			firstKeptMessageId: "kept",
			tokensBefore: 99,
			at: new Date(0).toISOString(),
		}) as unknown as LhMessage,
	];

	it("chrome FIRST, then the compaction head, then the kept tail — never dropped by the cut", () => {
		const out = toLlmMessages([chrome, ...record()] as never);
		assert.equal(out[0]!.role, "system");
		assert.equal((out[0] as { toolsAdded?: unknown[] }).toolsAdded?.length, 2);
		assert.equal(out[1]!.role, "user");
		assert.ok((out[1]!.content as { text: string }[])[0]!.text.includes("SUMMARY"));
		const textOf = (m: (typeof out)[number]): string =>
			typeof m.content === "string"
				? m.content
				: ((m.content as { text?: string }[])[0]?.text ?? "");
		assert.ok(out.slice(2).some((m) => m.role === "user" && textOf(m) === "kept tail"));
		assert.ok(!out.some((m) => m.role === "user" && textOf(m) === "dropped history"));
	});

	it("without a cut the chrome renders EXACTLY ONCE (no duplicate)", () => {
		const plain = [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 },
		] as unknown as LhMessage[];
		const out = toLlmMessages([chrome, ...plain] as never);
		assert.equal(out.filter((m) => m.role === "system").length, 1);
		assert.equal(out[0]!.role, "system");
	});

	it("record-path callers (no chrome in the record) are unchanged: head first", () => {
		const out = toLlmMessages(record());
		assert.notEqual(out[0]!.role, "system");
		const headText =
			typeof out[0]!.content === "string"
				? out[0]!.content
				: ((out[0]!.content as { text?: string }[])[0]?.text ?? "");
		assert.ok(headText.includes("SUMMARY"));
	});
});
