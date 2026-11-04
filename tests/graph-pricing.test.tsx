import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphCostControl } from "../components/graph-view.tsx";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import { callCost } from "../src/server/pricing.ts";
import type { CallUsage, ExtractionRunUsage } from "../src/core/contracts.ts";

const usage = (over: Partial<CallUsage> = {}): CallUsage => ({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 20_000, reasoningTokens: 0, ...over });
const run = (steps: CallUsage[], model = "anthropic:claude-haiku-4-5", at = 1): ExtractionRunUsage => ({ startedAt: at, at: "fixture", durationMs: 1, stages: { extractor: { model, steps }, auditor: { model, steps } } });
const summary = (runs: ExtractionRunUsage[]) => graphCostSummary({ chats: [{ title: "fixture", extractions: runs }], sources: [] }, callCost);
const headline = (runs: ExtractionRunUsage[]) => renderToStaticMarkup(<GraphCostControl costs={summary(runs)} />);

test("wholly unpriced historical graph costs render unknown, not known-zero dollars", () => {
	const historical = run([usage()]); // missing long-cache split
	const costs = summary([historical]);
	assert.equal(costs.totalDollars, 0);
	assert.equal(costs.unpricedRuns, 1);
	assert.equal(costs.stages.extraction.unpricedRuns, 1);
	const html = headline([historical]);
	assert.match(html, />—<\/button>/);
	assert.doesNotMatch(html, /\$0\.00/);
});

test("known zero, mixed priced/unknown, and subscription headline semantics stay distinct", () => {
	const zero = run([usage({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 })]);
	assert.match(headline([zero]), />\$0\.00<\/button>/, "known zero is not unknown");
	const priced = run([usage({ cacheWrite1hTokens: 0 })]);
	const historical = run([usage()], undefined, 2);
	const mixed = summary([priced, historical]);
	assert.equal(mixed.unpricedRuns, 1);
	assert.ok(mixed.totalDollars > 0);
	assert.match(headline([priced, historical]), new RegExp(`>\\$${mixed.totalDollars.toFixed(2).replace(".", "\\.")}<\\/button>`));
	const plan = run([usage()], "chatgpt:fixture");
	assert.match(headline([plan]), />ChatGPT<\/button>/);
	assert.match(headline([plan, zero]), />\$0\.00 \+ ChatGPT<\/button>/);
});

test("graph stage and recent-run aggregates preserve known one-hour cache writes", () => {
	const costs = summary([run([usage({ cacheWrite1hTokens: 20_000 })]), run([usage({ cacheWrite1hTokens: 5000 })], undefined, 2)]);
	assert.equal(costs.stages.extraction.tokens.cacheWrite1hTokens, 25_000);
	assert.equal(costs.stages.audit.tokens.cacheWrite1hTokens, 25_000);
	assert.deepEqual(costs.runs.map((r) => r.tokens.cacheWrite1hTokens), [10_000, 40_000]);
});

test("unknown historical long-cache splits stay unknown regardless of merge order", () => {
	const known = run([usage({ cacheWrite1hTokens: 20_000 })]);
	const historical = run([usage()], undefined, 2);
	for (const runs of [[known, historical], [historical, known]]) {
		const costs = summary(runs);
		assert.equal(costs.stages.extraction.tokens.cacheWrite1hTokens, undefined);
		assert.equal(costs.stages.audit.tokens.cacheWrite1hTokens, undefined);
	}
	const mixedWithinRun = summary([run([usage({ cacheWrite1hTokens: 20_000 }), usage()])]);
	assert.equal(mixedWithinRun.stages.extraction.tokens.cacheWrite1hTokens, undefined);
	const absentNoWrites = run([usage({ cacheWriteTokens: 0 })], undefined, 2);
	assert.equal(summary([absentNoWrites, known]).stages.extraction.tokens.cacheWrite1hTokens, 20_000, "absence without writes must not poison known write detail");
});
