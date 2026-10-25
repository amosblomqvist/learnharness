import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar, formatContextMeasurement } from "../components/stats-bar.tsx";
import { sessionCost } from "../src/server/pricing.ts";
import { catalogLimits } from "../components/model-picker.tsx";
import type { ModelCatalogEntry, ModelCatalogResponse } from "../src/core/contracts.ts";
import { prettyModel } from "../components/usage-format.ts";
import type { ChatSettings, TurnUsage } from "../src/core/contracts.ts";

// The stats bar: folds only (no cost math in the component), the "—"
// doctrine for absent data, honest cost (never a fake $0), and the model +
// thinking control (components/model-picker.tsx — pi-ai catalog backed).

function step(inputTokens: number, outputTokens: number, over: Record<string, number | undefined> = {}) {
	return { inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, ...over };
}

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
	return {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [step(10_000, 1_000)],
		...over,
	};
}

describe("stats bar", () => {
	it("renders NOTHING on the left when there are no turns yet (owner, wave 7 sweep)", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[]} />,
		);
		assert.match(html, /data-testid="stats-bar"/);
		// pre-chat: no summary button, no "—" theater (the knowledge-context
		// slider died with the injection — the left side is simply empty)
		assert.ok(!html.includes('data-testid="stats-summary"'), "no summary button pre-chat");
		assert.ok(!html.includes('data-testid="stats-context"'), "no context figure pre-chat");
		assert.ok(!html.includes('data-testid="stats-cost"'), "no cost figure pre-chat");
		// no turns, no settings, catalog not loaded → both control labels
		// "—" (the thinking button shows just the level, like the model
		// button shows just the model name — no prefix, no dot separator)
		assert.match(html, /data-testid="stats-model"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.match(html, /data-testid="stats-thinking"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.ok(!html.includes("aria-hidden>·"), "no dot between the controls");
		// the control reads as a button: pill border + dropdown chevron
		assert.match(html, /data-testid="stats-model"[^>]*rounded-full[^>]*>/);
		assert.match(html, /▾/);
	});

	it("folds context + cost from the turns log (core/prices, no local math)", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[turn(), turn()]} contextTokens={11_000} pricing={sessionCost({ turns: [turn(), turn()] })} />,
		);
		// last turn's last call: 10k in + 1k out = 11k. The LIMIT is the
		// live catalog's — and the bar doesn't hold the index yet (the
		// catalog join lands with the UI chunk), so the meter renders
		// USAGE-ONLY (owner amendment: never a fallback window).
		assert.match(html, /data-testid="stats-context">11k</);
		// pi catalog price 0.15/0.5 per 1M (drifted in pi-ai 0.87.1):
		// each turn 10k×0.15 + 1k×0.5 = $0.002 → two = $0.0040
		assert.match(html, /data-testid="stats-cost">\$0\.0040</);
		// model button label: SSR (record fetch not run yet) reads "—" —
		// the strong slot arrives client-side via GET /api/settings; the
		// turn log below still folds the ACTUAL models billed
		assert.match(html, /data-testid="stats-model"[^>]*>\s*<span[^>]*>—<\/span>/);
	});

	it("shows — for cost when every turn is unpriceable, never a fake $0", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[turn({ model: "nope/unknown" })]} contextTokens={11_000} pricing={sessionCost({ turns: [turn({ model: "nope/unknown" })] })} />,
		);
		assert.match(html, /data-testid="stats-cost">—</);
		// unknown model: no catalog limit exists, but the footprint is
		// still an honest reading — usage-only (never "—" theater over
		// real data, never a fake window)
		assert.match(html, /data-testid="stats-context">11k</);
	});

	it("unknown context is explicit; changing the selected limit preserves the measurement", () => {
		assert.equal(formatContextMeasurement(null, 100_000), "? / 100k");
		assert.equal(formatContextMeasurement(83_000, 100_000), "83k / 100k");
		assert.equal(formatContextMeasurement(83_000, 200_000), "83k / 200k");
		assert.equal(formatContextMeasurement(83_000, null), "83k");
		const html = renderToStaticMarkup(<StatsBar chatId="fixture" turns={[turn()]} contextTokens={null} />);
		assert.match(html, /data-testid="stats-context">\?</);
		const empty = renderToStaticMarkup(<StatsBar chatId="fixture" turns={[]} />);
		assert.match(empty, /data-testid="stats-context">\?</);
	});

	it("prettyModel strips vendor + date suffix, keeps dashes", () => {
		assert.equal(prettyModel("z-ai/glm-5.3-flash"), "glm-5.3-flash"); // dashes kept (owner round 5)
		assert.equal(prettyModel("qwen/qwen3.8-max-0902"), "qwen3.8-max");
	});

	it("provider-qualified stamps (usage contract, model-slots wave)", () => {
		// qualified: the provider rides as a quiet suffix — federation makes
		// the same model via two providers different bookkeeping
		assert.equal(prettyModel("openrouter:z-ai/glm-5.3-flash", true), "glm-5.3-flash · openrouter");
		assert.equal(prettyModel("openai:gpt-5.2", true), "gpt-5.2 · openai");
		// unqualified on a qualified stamp: provider silently dropped (old shape)
		assert.equal(prettyModel("openrouter:z-ai/glm-5.3-flash"), "glm-5.3-flash");
		// qualified on a bare id: no suffix invented
		assert.equal(prettyModel("z-ai/glm-5.3-flash", true), "glm-5.3-flash");
	});
});

describe("catalogLimits (the stats-bar live-limits join, pure)", () => {
	// The client-side twin of the server's catalogContextLimits join:
	// provider:id → contextWindow straight from the cached /api/models
	// payload. A static render holds no catalog (the fetch is a live
	// concern — Playwright verifies the wiring), so the pure index shape
	// is pinned here: one entry per model, the exact key contextWindow()
	// looks up, missing models absent (→ limit null → usage-only).
	const entry = (over: Pick<ModelCatalogEntry, "id" | "provider" | "contextWindow">): ModelCatalogEntry => ({
		name: over.id,
		reasoning: false,
		input: ["text"],
		supportedLevels: [],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 32_768,
		...over,
	});
	const catalog: Pick<ModelCatalogResponse, "models"> = {
		models: [
			entry({ id: "z-ai/glm-5.3-flash", provider: "openrouter", contextWindow: 1_048_576 }),
			entry({ id: "gpt-x", provider: "openai", contextWindow: 400_000 }),
		],
	};

	it("builds provider:id → contextWindow over every catalog model", () => {
		const limits = catalogLimits(catalog);
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("openai:gpt-x"), 400_000);
		assert.equal(limits.size, 2);
	});

	it("a model missing from the index is absent — limit null, usage-only (never a fallback)", () => {
		const limits = catalogLimits(catalog);
		assert.equal(limits.has("nope/unknown"), false);
	});

	it("same provider+model on different providers keys apart", () => {
		const twin: Pick<ModelCatalogResponse, "models"> = {
			models: [...catalog.models, entry({ id: "z-ai/glm-5.3-flash", provider: "zai", contextWindow: 200_000 })],
		};
		const limits = catalogLimits(twin);
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("zai:z-ai/glm-5.3-flash"), 200_000);
	});
});
