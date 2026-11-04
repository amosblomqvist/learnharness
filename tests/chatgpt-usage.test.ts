import { test } from "node:test";
import assert from "node:assert/strict";
import { callCost, sessionCost, turnCost, jobCost } from "../src/server/pricing.ts";
import { graphCostSummary as foldGraphCostSummary, type CostSummaryInput } from "../src/core/cost-summary.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, callCost);
import type { TurnUsage } from "../src/core/contracts.ts";
import { planCostLabel } from "../components/usage-format.ts";
const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
const turn = (model: string, steps = [step]): TurnUsage => ({ id: "scratch-turn", messageId: "scratch-message", at: "2026-10-19T00:00:00Z", model, steps });

test("subscription usage is neither API dollars nor an unpriced-model mistake, including empty/partial usage", () => {
	const plan = turn("chatgpt:gpt-5");
	assert.equal(callCost(step, plan.model), null);
	assert.equal(turnCost(turn(plan.model, [])), null);
	assert.equal(jobCost({ usage: { model: plan.model, ...step, steps: 1 } }), null);
	assert.deepEqual(sessionCost({ turns: [plan, turn(plan.model, [])] }), { cost: 0, unpriced: 0, subscription: 2, subscriptionProviders: ["ChatGPT"], turnCosts: { "scratch-turn": null } });
	const api = turn("openai:gpt-5");
	const mixed = sessionCost({ turns: [plan, api, turn("unknown:missing")] });
	assert.equal(mixed.cost, turnCost(api)); assert.equal(mixed.unpriced, 1); assert.equal(mixed.subscription, 1);
	assert.equal(planCostLabel(null, true), "ChatGPT");
	assert.match(planCostLabel(mixed.cost, true), /\$[\d.]+ \+ ChatGPT$/);
});

test("graph extraction and audit preserve subscription identity separately from priced and unknown stages", () => {
	const base = { startedAt: 1, at: "2026-10-19T00:00:00Z", durationMs: 1, stages: { extractor: { model: "chatgpt:gpt-5", steps: [step] }, auditor: { model: "chatgpt:gpt-5", steps: [] } } };
	const plan = graphCostSummary({ chats: [{ title: "Scratch", extractions: [base] }], sources: [] });
	assert.equal(plan.unpricedRuns, 0); assert.equal(plan.subscriptionRuns, 2);
	assert.equal(plan.stages.extraction.unpricedRuns, 0); assert.equal(plan.stages.audit.unpricedRuns, 0);
	assert.equal(plan.runs[0]!.dollars, null);
	const mixed = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ ...base, stages: { ...base.stages, auditor: { model: "openai:gpt-5", steps: [step] } } }] }], sources: [] });
	assert.equal(mixed.subscriptionRuns, 1);
	assert.equal(mixed.totalDollars, callCost(step, "openai:gpt-5"));
	assert.equal(mixed.runs[0]!.subscriptionRuns, 1);
	assert.equal(mixed.unpricedRuns, 0);
	for (const reverse of [false, true]) {
		const stages = [{ model: "chatgpt:gpt-5", steps: [step] }, { model: "unknown:not-priced", steps: [step] }];
		if (reverse) stages.reverse();
		const unknown = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ ...base, stages: { extractor: stages[0]!, auditor: stages[1]! } }] }], sources: [] });
		assert.equal(unknown.unpricedRuns, 1); assert.equal(unknown.runs[0]!.dollars, null); assert.equal(unknown.subscriptionRuns, 1);
		assert.equal(unknown.stages.extraction.unpricedRuns + unknown.stages.audit.unpricedRuns, 1);
	}
	const zero = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ ...base, stages: { ...base.stages, auditor: { model: "openai:gpt-5", steps: [{ ...step, inputTokens: 0, outputTokens: 0 }] } } }] }], sources: [] });
	assert.equal(zero.runs[0]!.dollars, 0); assert.equal(zero.unpricedRuns, 0); assert.equal(zero.subscriptionRuns, 1);
	const capped = graphCostSummary({ recentCap: 0, chats: [{ title: "Scratch", extractions: [{ ...base, stages: { ...base.stages, auditor: { model: "unknown:model", steps: [step] } } }] }], sources: [] });
	assert.equal(capped.runs.length, 0); assert.equal(capped.unpricedRuns, 1);
});
