/** Catalog/calculator parity replaces the old generated-table drift test. */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/models.ts";
import { callCost, jobCost } from "../src/server/pricing.ts";
import { accumulateJobUsage, piUsageToStep } from "../src/core/contracts/jobs.ts";

const models = piModels().getProviders().flatMap((p) => piModels().getModels(p.id));
const nativeUsage = (input: number): Usage => ({ input, output: 1_000, cacheRead: 10_000, cacheWrite: 2_000, cacheWrite1h: 500, totalTokens: input + 13_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const saved = (u: Usage) => ({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, cacheWrite1hTokens: u.cacheWrite1h, reasoningTokens: 500 });

test("all catalog models price through Pi, including every tier boundary; saved usage is never mutated", () => {
	assert.ok(models.length > 100);
	for (const model of models) {
		const sizes = [1_000, ...(model.cost.tiers ?? []).flatMap((t) => [Math.max(0, t.inputTokensAbove - 12_000), Math.max(0, t.inputTokensAbove - 12_000 + 1)])];
		for (const input of sizes) {
			const usage = nativeUsage(input);
			const call = Object.freeze(saved(usage));
			const before = structuredClone(call);
			const expected = calculateCost(model, usage).total;
			assert.equal(callCost(call, `${model.provider}:${model.id}`), expected, `${model.provider}:${model.id} input=${input}`);
			assert.deepEqual(call, before);
		}
	}
});

test("job capture preserves individual tier sizes and one-hour writes; old tier aggregates are unknown", () => {
	const model = models.find((m) => m.cost.tiers?.length)!;
	assert.ok(model);
	const id = `${model.provider}:${model.id}`;
	const threshold = model.cost.tiers![0]!.inputTokensAbove;
	const first = nativeUsage(Math.ceil(threshold / 2));
	const second = nativeUsage(Math.ceil(threshold / 2));
	const total = accumulateJobUsage(accumulateJobUsage(undefined, id, piUsageToStep(first)), id, piUsageToStep(second));
	assert.equal(total.calls?.length, 2);
	assert.equal(total.cacheWrite1hTokens, 1000);
	assert.equal(total.lastStep?.cacheWrite1hTokens, 500);
	assert.equal(jobCost({ usage: total }), calculateCost(model, first).total + calculateCost(model, second).total);
	assert.equal(jobCost({ usage: { ...total, calls: undefined } }), null);
	const legacyOne = { ...total, ...saved(first), calls: undefined, steps: 1 };
	assert.equal(jobCost({ usage: legacyOne }), calculateCost(model, first).total);
	const resumedLegacy = accumulateJobUsage({ ...total, calls: undefined }, id, piUsageToStep(first));
	assert.equal(resumedLegacy.calls, undefined, "never pretend the missing old calls were reconstructed");
});
