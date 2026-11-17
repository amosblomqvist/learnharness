import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { formatTranscript, ANTIGRAVITY_MODELS } from "../src/agent/providers/antigravity.ts";
import { providerKeyPresent } from "../src/server/keys.ts";
import { modelCatalog } from "../src/server/model-catalog.ts";

describe("Antigravity Provider (Zero-Key Ambient)", () => {
	it("registers all designated Antigravity models in piModels()", () => {
		const models = piModels();
		for (const def of ANTIGRAVITY_MODELS) {
			const model = models.getModel("antigravity", def.id);
			assert.ok(model, `Expected model antigravity:${def.id} to exist`);
			assert.equal(model.provider, "antigravity");
			assert.equal(model.reasoning, true);
			assert.equal(model.cost.input, 0);
			assert.equal(model.cost.output, 0);
		}
	});

	it("providerKeyPresent('antigravity') is true without requiring env keys", () => {
		assert.equal(providerKeyPresent("antigravity"), true);
	});

	it("builds a PiEngine for antigravity specs via piEngineForSpec", () => {
		const engine = piEngineForSpec({
			provider: "antigravity",
			id: "gemini-3.8-flash-medium",
			thinkingLevel: "medium",
		});
		assert.ok(engine);
		assert.equal(engine.model.id, "gemini-3.8-flash-medium");
		assert.equal(typeof engine.streamFn, "function");
	});

	it("formats conversation transcripts cleanly for agy CLI ingestion", () => {
		const formatted = formatTranscript({
			messages: [
				{
					role: "system",
					content: "You are an expert tutor.",
					timestamp: 1,
				},
				{
					role: "user",
					content: "What is an eigenvalue?",
					timestamp: 2,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "An eigenvalue is a scalar..." }],
					api: "antigravity",
					provider: "antigravity",
					model: "gemini-3.8-flash-high",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 3,
				},
			],
		} as any);

		assert.ok(formatted.includes("Instructions:\nYou are an expert tutor."));
		assert.ok(formatted.includes("User:\nWhat is an eigenvalue?"));
		assert.ok(formatted.includes("Assistant:\nAn eigenvalue is a scalar..."));
	});

	it("surfaces antigravity models in modelCatalog()", () => {
		const catalog = modelCatalog();
		const agyModels = catalog.models.filter((m) => m.provider === "antigravity");
		assert.ok(agyModels.length > 0, "Expected antigravity models in catalog");
		assert.ok(agyModels.some((m) => m.id === "gemini-3.8-flash-high"));
		assert.ok(agyModels.some((m) => m.id === "gemini-4-argon-high"));
	});

	it("adapts model id when reasoning effort changes", () => {
		const base = "gemini-3.8-flash-medium";
		const effort = "high";
		const variantId = `${base.replace(/-(low|medium|high|xhigh|max)$/, "")}-${effort}`;
		assert.equal(variantId, "gemini-3.8-flash-high");
		assert.ok(ANTIGRAVITY_MODELS.some((m) => m.id === variantId));
	});
});
