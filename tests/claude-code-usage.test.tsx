import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { isSubscriptionModel, sumSteps, type TurnUsage } from "../src/core/index.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import { accumulateJobUsage } from "../src/core/contracts/jobs.ts";
import { callCost, jobCost, sessionCost } from "../src/server/pricing.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { StatsBar } from "../components/stats-bar.tsx";

const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: undefined };
for (const model of CLAUDE_CODE_MODELS) test(`${model.id}: token usage is retained but dollars are unpriced, not free or subscription use`, () => {
	const id = `${model.provider}:${model.id}`;
	const turn: TurnUsage = { id: "cli-turn", messageId: "cli-message", at: "2026-10-28T00:00:00Z", model: id, steps: [step] };
	assert(!isSubscriptionModel(id));
	assert.equal(callCost(step, id), null);
	const pricing = sessionCost({ turns: [turn] });
	assert.equal(pricing.unpriced, 1); assert.equal(pricing.subscription, undefined);
	assert.equal(pricing.turnCosts[turn.id], null);
	assert.deepEqual(sumSteps(turn.steps), { ...step, cacheWrite1hTokens: undefined, reasoningTokens: undefined });
	assert.equal(jobCost({ usage: accumulateJobUsage(undefined, id, step) }), null);
	const html = renderToStaticMarkup(<StatsBar turns={[turn]} pricing={pricing} />);
	assert(!html.includes("$0"));
	assert.match(html, /data-testid="stats-cost">CLI<\/span>/);
	const summary = graphCostSummary({ chats: [{ title: "CLI fixture", extractions: [{ startedAt: 1, at: turn.at, durationMs: 1,
		stages: { extractor: { model: id, steps: [step] }, auditor: { model: id, steps: [step] } },
	}] }], sources: [] }, callCost);
	assert.equal(summary.unpricedRuns, 1); assert.equal(summary.subscriptionRuns, undefined);
	assert.equal(summary.runs[0]!.dollars, null);
});

test("mixed session totals retain known API dollars and subscription labels alongside CLI billing", () => {
	const cli: TurnUsage = { id: "cli", messageId: "cli", at: "2026-10-28T00:00:00Z", model: "claude-code:sonnet", steps: [step] };
	const api = { ...cli, id: "api", messageId: "api", model: "openai:fixture" };
	const pricing = { cost: 0.12, unpriced: 1, turnCosts: { cli: null, api: 0.12 } };
	const html = renderToStaticMarkup(<StatsBar turns={[api, cli]} pricing={pricing} />);
	assert.match(html, /data-testid="stats-cost">\$0\.1200 \+ CLI<\/span>/);
	const subscription = { ...cli, id: "plan", messageId: "plan", model: "chatgpt:fixture" };
	const mixed = renderToStaticMarkup(<StatsBar turns={[api, cli, subscription]} pricing={{ ...pricing, subscription: 1, subscriptionProviders: ["ChatGPT"] }} />);
	assert.match(mixed, /data-testid="stats-cost">\$0\.1200 \+ ChatGPT \+ CLI<\/span>/);
	assert.equal(callCost(step, cli.model), null, "CLI stays unpriced in accounting");
});

test("model-catalog API and menus never advertise the CLI adapter's placeholder zero rates", () => {
	const models = CLAUDE_CODE_MODELS.map(toModelDto);
	assert(models.every((model) => model.cost === null));
	const html = renderToStaticMarkup(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} />);
	assert.equal((html.match(/>CLI billing<\/span>/g) ?? []).length, 3);
	assert.match(html, /does not estimate it/);
	assert(!html.includes("$0")); assert(!html.includes("USD per 1M")); assert(!html.includes("(subscription)"));
});
