import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import { SIDE_CONTEXT_BUDGET_ERROR, sideContextWindow } from "../src/server/side-context-budget.ts";

const selected = { provider: "claude-code", id: "opus" };
const stamp = { provider: "claude-code", api: "claude-code-cli", model: "opus" };
const report: LhMessage = { ...fauxAssistantMessage("Explanation"), ...stamp, id: "reported", cliContextWindow: 1_000_000 };
const local: LhMessage = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: SIDE_CONTEXT_BUDGET_ERROR }), ...stamp, id: "local" };
const marker = newCompactionMarker("Summary", { firstKeptMessageId: report.id, tokensBefore: 60_000, at: "2026-11-10T00:00:00Z" });
const resolve = (messages: LhMessage[], retry = true) => sideContextWindow(messages, selected, undefined, retry);

describe("side admission's genuine CLI window", () => {
	it("uses matching session metadata, never the CLI catalog placeholder", () => {
		assert.equal(resolve([report]), 1_000_000);
		assert.equal(sideContextWindow([], selected, 1_000_000, false), undefined);
		assert.equal(sideContextWindow([report], { provider: "openai", id: "opus" }, 128_000, false), 128_000);
	});
	it("recovers repeated historical local refusals only on Retry, without mutating them", () => {
		const messages = [report, local, { ...local, id: "local-again" }];
		const before = structuredClone(messages);
		assert.equal(resolve(messages), 1_000_000);
		assert.equal(resolve(messages, false), undefined);
		assert.deepEqual(messages, before);
	});
	it("does not borrow another identity or a report before compaction", () => {
		assert.equal(sideContextWindow([report], { ...selected, id: "sonnet" }, undefined, true), undefined);
		assert.equal(resolve([report, marker, local]), undefined);
		assert.equal(resolve([report, marker, { ...report, id: "fresh-after-compaction" }, local]), 1_000_000);
	});
	it("stops at a fresh response with absent/invalid/different metadata, including one before local refusals", () => {
		for (const patch of [{ cliContextWindow: undefined }, { cliContextWindow: 0 }, { cliContextWindow: -1 }, { cliContextWindow: 1.5 },
			{ model: "sonnet" }, { provider: "another-provider" }]) {
			const fresh = { ...report, id: "fresh", ...patch } as LhMessage;
			assert.equal(resolve([report, fresh, local]), undefined);
		}
	});
	for (const [label, patch] of Object.entries({
		"other error": { errorMessage: "Transport failed" }, "normal stop": { stopReason: "stop" }, "abort": { stopReason: "aborted" },
		"other provider": { provider: "another-provider" }, "other model": { model: "sonnet" }, "other API": { api: "anthropic-messages" },
		"nonempty output": { content: [{ type: "text", text: "Partial provider output" }] }, "thinking output": { content: [{ type: "thinking", thinking: "" }] },
		"response ID": { responseId: "provider-response" }, "window field": { cliContextWindow: 0 }, "missing usage": { usage: undefined },
		...Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "cacheWrite1h"].map(key => [`nonzero ${key}`, { usage: { ...local.usage, [key]: 1 } }])),
		"nonzero cost": { usage: { ...local.usage, cost: { ...local.usage.cost, total: 1 } } },
	})) {
		it(`never classifies ${label} as a recognized zero-dispatch local refusal`, () => {
			assert.equal(resolve([report, { ...local, ...patch } as LhMessage]), undefined);
		});
	}
});
