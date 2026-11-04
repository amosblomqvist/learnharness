import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { subscriptionLabel, subscriptionLabels, isSubscriptionModel, type TurnUsage } from "../src/core/index.ts";
import { sessionCost, callCost } from "../src/server/pricing.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import { planCostLabel } from "../components/usage-format.ts";
import { StatsBar } from "../components/stats-bar.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";
import { piModels } from "../src/agent/models.ts";
const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
const turn = (model: string, id: string): TurnUsage => ({ id, messageId: id, at: "2026-10-24T00:00:00Z", model, steps: [step] });

test("only explicit subscription route IDs count as subscription use; names stay compact and unique", () => {
	assert.equal(subscriptionLabel("chatgpt:gpt-5"), "ChatGPT");
	assert.equal(subscriptionLabel("github-copilot-subscription:fixture"), "GitHub Copilot");
	assert.equal(subscriptionLabel("xai-subscription:grok"), "Grok");
	for (const model of ["openai:gpt-5", "xai:grok", "github-copilot:fixture", "meta:muse", "radius:any", "kimi-coding:any"]) assert(!isSubscriptionModel(model));
	assert.deepEqual(subscriptionLabels(["chatgpt:a", "xai-subscription:b", "chatgpt:c", "github-copilot-subscription:d"]), ["ChatGPT", "Grok", "GitHub Copilot"]);
	assert.equal(planCostLabel(0.12, ["Grok"], (n) => `$${n.toFixed(2)}`), "$0.12 + Grok");
	assert.equal(planCostLabel(0.67, ["ChatGPT"], (n) => `$${n.toFixed(2)}`), "$0.67 + ChatGPT");
	assert.equal(planCostLabel(null, ["ChatGPT", "GitHub Copilot", "Grok"]), "ChatGPT + GitHub Copilot + Grok");
});
test("mixed session pricing sums only API dollars and retains all subscription providers, not unpriced errors", () => {
	const turns = [turn("github-copilot-subscription:gpt-5", "copilot"), turn("xai-subscription:grok", "grok"), turn("chatgpt:gpt-5", "chatgpt"), turn("openai:gpt-5", "api")];
	const pricing = sessionCost({ turns }); assert.equal(pricing.subscription, 3); assert.equal(pricing.unpriced, 0); assert.equal(pricing.cost, callCost(step, "openai:gpt-5"));
	assert.deepEqual(pricing.subscriptionProviders, ["GitHub Copilot", "Grok", "ChatGPT"]);
	const html = renderToStaticMarkup(<StatsBar turns={turns} pricing={pricing} />);
	assert.match(html, /\$[\d.]+ \+ GitHub Copilot \+ Grok \+ ChatGPT/); assert(!html.includes(" API +")); assert(!html.includes("ChatGPT plan"));
});
test("graph stage/recent aggregates retain distinct subscription providers without inventing dollars", () => {
	const summary = graphCostSummary({ chats: [{ title: "Fixture", extractions: [{ startedAt: 1, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: { model: "github-copilot-subscription:gpt-5", steps: [step] }, auditor: { model: "xai-subscription:grok", steps: [step] } } }] }], sources: [] }, callCost);
	assert.equal(summary.totalDollars, 0); assert.equal(summary.unpricedRuns, 0); assert.equal(summary.runs[0]!.dollars, null);
	assert.deepEqual(summary.subscriptionProviders, ["GitHub Copilot", "Grok"]); assert.deepEqual(summary.runs[0]!.subscriptionProviders, ["GitHub Copilot", "Grok"]);
});
test("model menu distinguishes subscription connection and shows provider label rather than API prices", () => {
	const native = piModels().getModels("xai")[0]!;
	const html = renderToStaticMarkup(<ModelMenuList models={[toModelDto({ ...native, provider: "xai-subscription" })]} effectiveId={undefined} onPick={() => {}} />);
	assert(html.includes("Grok (subscription)")); assert(html.includes(">Grok</span>")); assert(!html.includes("USD per 1M")); assert(!html.includes("$0"));
});
