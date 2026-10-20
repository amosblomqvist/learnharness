/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * Import Notes renders ALWAYS — the one action that works on an empty
 * graph, the entry point itself; search + settings render only when the
 * snapshot has nodes (dead controls are lies — the honesty principle).
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphChromeRow, GraphCostControl } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	importing: false,
	searchInputRef: ref,
	fileInputRef: ref,
	onImportFiles: () => {},
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
	onOpenChains: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: Import Notes renders (the entry point), search + settings absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Import notes…"));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(!html.includes('data-testid="open-chain-table"'), "chains is a lie on an empty graph");
		assert.ok(!html.includes("graph-chrome-fade-in"), "nothing gated = nothing fading in");
	});

	it("POPULATED graph: all four render, the gated trio carries the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		assert.ok(html.includes('data-testid="open-chain-table"'), "the chains entry renders");
		// the appear-once fade rides exactly the three gated controls, never Import Notes
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 3, "three fade carriers: search + chains + settings");
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});
/**
 * The graph cost pill (issue 8): every figure is an ESTIMATED model cost. A
 * priced subtotal wears "(partial)" so a known number never reads as the
 * whole bill, and a graph where nothing could be priced shows "—", never $0.
 */
describe("GraphCostControl — estimated model cost, honest coverage", () => {
	const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	const stage = (
		dollars: number | null,
		coverage: "complete" | "partial" | "unknown",
		unpricedRuns = 0,
	) => ({ dollars, coverage, pricedRuns: dollars === null ? 0 : 1, unpricedRuns, missingUsageRuns: 0, runs: 1, tokens });
	const summary = (
		extraction: ReturnType<typeof stage>,
		audit: ReturnType<typeof stage>,
		runCoverage: "complete" | "partial" | "unknown",
	) => ({
		totalDollars: null,
		coverage: runCoverage,
		pricedRuns: 0,
		unpricedRuns: 0,
		partialRuns: 0,
		missingUsageRuns: 0,
		stages: { extraction, audit },
		runs: [
			{ startedAt: Date.parse("2026-09-09T12:00:00Z"), at: "2026-09-09T12:00:00Z", durationMs: 1000, kind: "extraction" as const, title: "run", dollars: null, coverage: runCoverage, tokens },
		],
	});

	it("shows the priced subtotal and flags it partial", () => {
		const html = renderToStaticMarkup(
			createElement(GraphCostControl, { costs: summary(stage(1.25, "partial", 1), stage(0.75, "complete"), "partial") }),
		);
		assert.match(html, /data-testid="graph-cost-pill"/);
		assert.match(html, /graph-cost-pill[^>]*>\$2\.00<span[^>]*> \(partial\)</);
		assert.ok(html.includes("Estimated model cost"), "the hint names the figure");
	});

	it("keeps an explicitly reported zero as $0.00, never unknown", () => {
		const html = renderToStaticMarkup(
			createElement(GraphCostControl, { costs: summary(stage(0, "complete"), stage(0, "complete"), "complete") }),
		);
		assert.match(html, /graph-cost-pill[^>]*>\$0\.00</);
		assert.ok(!html.includes("(partial)"), "a reported zero is complete, not partial");
	});

	it("one unpriced stage makes a priced total partial", () => {
		const html = renderToStaticMarkup(
			createElement(GraphCostControl, { costs: summary(stage(1.25, "complete"), stage(null, "unknown", 1), "partial") }),
		);
		assert.match(html, /graph-cost-pill[^>]*>\$1\.25<span[^>]*> \(partial\)</);
	});

	it("nothing priced: —, never $0", () => {
		const html = renderToStaticMarkup(
			createElement(GraphCostControl, { costs: summary(stage(null, "unknown", 1), stage(null, "unknown", 1), "unknown") }),
		);
		assert.match(html, /graph-cost-pill[^>]*>—</);
		assert.ok(!html.includes("$0.00"), "an unpriced graph never renders a zero-dollar bill");
	});
});
