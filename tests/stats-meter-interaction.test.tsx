import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

test("meter keeps its measured numerator across selected-model/catalog changes, and renders post-compaction unknown", async () => {
	const originalFetch = globalThis.fetch;
	let selected = "a";
	const catalog: ModelCatalogResponse = {
		models: ["a", "b"].map((id, i) => ({ id, provider: "fixture", name: id, input: ["text"], reasoning: false, supportedLevels: ["off"], maxTokens: 1000, contextWindow: 100_000 * (i + 1), cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })),
		providers: [], defaults: null, slots: { strong: null, cheap: null, vision: null }, rolePins: {} as ModelCatalogResponse["rolePins"],
	};
	globalThis.fetch = async (input) => {
		if (input === "/api/models") return Response.json(catalog);
		if (input === "/api/settings") return Response.json({ settings: { models: {} } });
		if (input === "/api/chats/fixture") return Response.json({ settings: { model: { provider: "fixture", id: selected }, thinkingLevel: "off" } });
		throw new Error(`unexpected fixture request ${String(input)}`);
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const turn: TurnUsage = { id: "summary", messageId: "marker", at: "fixture", model: "fixture:a", steps: [{ inputTokens: 4300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] };
	const pricing = { cost: 0.003, unpriced: 0, turnCosts: { summary: 0.003 } };
	try {
		await act(async () => root.render(<StatsBar chatId="fixture" turns={[turn]} contextTokens={83_000} pricing={pricing} />));
		const context = () => host.querySelector('[data-testid="stats-context"]')?.textContent;
		assert.equal(context(), "83k / 100k", "summarizer's 4.3k money log is not the meter source");
		selected = "b";
		await act(async () => notifySettingsSaved("models"));
		assert.equal(context(), "83k / 200k", "only denominator changes");
		await act(async () => root.render(<StatsBar chatId="fixture" turns={[turn]} contextTokens={null} pricing={pricing} />));
		assert.equal(context(), "? / 200k");
		assert.equal(host.querySelector('[data-testid="stats-cost"]')?.textContent, "$0.0030", "summary spending is still visible");
		await act(async () => root.render(<StatsBar chatId="fixture" turns={[turn]} contextTokens={72_000} pricing={pricing} />));
		assert.equal(context(), "72k / 200k");
	} finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
	}
});
