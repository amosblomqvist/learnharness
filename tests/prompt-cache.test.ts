import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildCacheView,
	cacheSavingsUsd,
	cacheUsageStats,
	diffCacheViews,
	fingerprint,
	messageWireText,
	stableJson,
} from "../src/core/prompt-cache.ts";
import { toLlmMessages } from "../src/core/native-messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function system(content = "You are a tutor.", tools = true): SystemMessage {
	return {
		role: "system",
		content,
		...(tools
			? {
					toolsAdded: [
						{
							name: "quiz",
							description: "Ask a question.",
							parameters: { type: "object", properties: { q: { type: "string" } } },
						},
					],
			  }
			: {}),
		timestamp: 0,
	};
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string, model = "deepseek-v4-pro"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	};
}

function result(toolCallId: string, text = "ok"): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "quiz", content: [{ type: "text", text }], isError: false, timestamp: 3 };
}

test("stableJson ignores object key order and undefined members", () => {
	assert.equal(stableJson({ b: 1, a: [{ y: 2, x: 1 }] }), stableJson({ a: [{ x: 1, y: 2 }], b: 1 }));
	assert.equal(stableJson({ a: 1, b: undefined }), '{"a":1}');
	assert.equal(stableJson([1, "two", null]), '[1,"two",null]');
});

test("fingerprint is deterministic and content-sensitive", () => {
	assert.equal(fingerprint("same bytes"), fingerprint("same bytes"));
	assert.notEqual(fingerprint("same bytes"), fingerprint("same byteS"));
	assert.match(fingerprint("x"), /^[0-9a-f]{16}$/);
});

test("messageWireText ignores timestamps but includes provider identity for assistants", () => {
	const a = assistant("hello");
	assert.equal(messageWireText(a), messageWireText({ ...a, timestamp: 999 }));
	assert.notEqual(messageWireText(a), messageWireText(assistant("hello", "another-model")));
});

test("diffCacheViews: first request shares nothing", () => {
	const view = buildCacheView([system(), user("hi"), assistant("hello")]);
	const audit = diffCacheViews(null, view);
	assert.equal(audit.kind, "first");
	assert.equal(audit.sharedBlocks, 0);
	assert.equal(audit.prefixShare, 0);
	assert.ok(audit.totalTokens > 0);
});

test("diffCacheViews: append keeps every earlier block (the DSH rule)", () => {
	const base = [system(), user("hi"), assistant("hello")];
	const previous = buildCacheView(base);
	const next = buildCacheView([...base, result("call_1"), user("next?")]);
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "append");
	assert.equal(audit.sharedBlocks, base.length);
	assert.equal(audit.sharedTokens, previous.totalTokens);
	assert.ok(audit.prefixShare > 0.9);
});

test("diffCacheViews: a system prompt change resets the prefix at token 0", () => {
	const previous = buildCacheView([system("You are a tutor."), user("hi")]);
	const next = buildCacheView([system("You are a stricter tutor."), user("hi")]);
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "system");
	assert.equal(audit.sharedBlocks, 0);
	assert.equal(audit.sharedTokens, 0);
	assert.equal(audit.prefixShare, 0);
});

test("diffCacheViews: a tool declaration change resets the prefix at token 0", () => {
	const previous = buildCacheView([system("You are a tutor.", false), user("hi")]);
	const withTool = system("You are a tutor.");
	const next = buildCacheView([{ ...withTool, toolsAdded: [{ ...withTool.toolsAdded![0]!, description: "Ask a graded question." }] }, user("hi")]);
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "tools");
	assert.equal(audit.sharedBlocks, 0);
	assert.equal(audit.prefixShare, 0);
});

test("diffCacheViews: a mid-history rewrite keeps only the blocks before it", () => {
	const base = [system(), user("first"), assistant("answer one"), user("second")];
	const previous = buildCacheView(base);
	const next = buildCacheView([base[0]!, base[1]!, assistant("answer one, edited"), base[3]!]);
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "rewrite");
	assert.equal(audit.sharedBlocks, 2);
	assert.equal(audit.divergedAt, 2);
	assert.ok(audit.prefixShare > 0 && audit.prefixShare < 1);
});

test("buildCacheView over toLlmMessages: a normal turn extends the prefix", () => {
	// The real seam: the record (native messages) → model view → projection.
	const turnOne: AgentMessage[] = [
		{ id: "m1", role: "user", content: "What is a derivative?", timestamp: 1 } as AgentMessage,
		{ ...assistant("The slope of a curve."), id: "m2" } as AgentMessage,
		{ id: "m3", role: "user", content: "So a limit of slopes?", timestamp: 2 } as AgentMessage,
	];
	const previous = buildCacheView(toLlmMessages(turnOne));
	const next = buildCacheView(toLlmMessages([...turnOne, { ...assistant("Yes — the limit of the difference quotient."), id: "m4" } as AgentMessage]));
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "append");
	assert.equal(audit.sharedBlocks, previous.blocks.length);
});

test("buildCacheView over toLlmMessages: a compaction marker is a head rewrite", () => {
	const head = system() as unknown as AgentMessage;
	const base: AgentMessage[] = [
		head,
		{ id: "m1", role: "user", content: "old question", timestamp: 1 } as AgentMessage,
		{ ...assistant("old answer"), id: "m2" } as AgentMessage,
		{ id: "m3", role: "user", content: "recent question", timestamp: 2 } as AgentMessage,
	];
	const previous = buildCacheView(toLlmMessages(base));
	const marker = {
		id: "c1",
		role: "custom",
		customType: "compaction",
		content: "SUMMARY",
		display: true,
		details: { firstKeptMessageId: "m3" },
		timestamp: 3,
	} as unknown as AgentMessage;
	const next = buildCacheView(toLlmMessages([...base, marker]));
	const audit = diffCacheViews(previous, next);
	assert.equal(audit.kind, "rewrite");
	assert.equal(audit.divergedAt, 1);
	assert.ok(audit.sharedBlocks === 1);
	assert.ok(audit.prefixShare < 1);
});

test("cacheUsageStats: disjoint buckets and an honest unknown", () => {
	const known = cacheUsageStats({ input: 100, cacheRead: 900, cacheWrite: 0 });
	assert.deepEqual(known, {
		freshInputTokens: 100,
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
		promptTokens: 1000,
		hitRate: 0.9,
	});
	const unknown = cacheUsageStats({ input: 100 });
	assert.equal(unknown.hitRate, null);
	assert.equal(unknown.promptTokens, 100);
});

test("cacheSavingsUsd: DeepSeek cache reads are ~98% cheaper than fresh input", () => {
	// deepseek-v4-pro: input $1.32/M, cache read $0.044/M.
	const saved = cacheSavingsUsd({
		input: 1_000_000,
		cacheRead: 1_000_000,
		cost: { input: 1.32, cacheRead: 0.044 },
	});
	assert.ok(Math.abs(saved - 1.276) < 1e-9);
	// Unreported cost blocks never invent savings.
	assert.equal(cacheSavingsUsd({ input: 1_000_000, cacheRead: 1_000_000 }), 0);
});
