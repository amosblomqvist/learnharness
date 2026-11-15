import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

// #610: the chat dock sits inside Conversation, whose overflow clips both axes.
test("session stats render outside the stats bar and close on outside pointerdown or Escape, not inside", async () => {
	const originalFetch = globalThis.fetch;
	const catalog: ModelCatalogResponse = { models: [], providers: [], defaults: null,
		slots: { strong: null, cheap: null, vision: null }, rolePins: {} as ModelCatalogResponse["rolePins"] };
	globalThis.fetch = async (input) => {
		if (input === "/api/models") return Response.json(catalog);
		if (input === "/api/settings") return Response.json({ settings: { models: {} } });
		if (input === "/api/chats/fixture") return Response.json({ settings: {} });
		throw new Error(`unexpected fixture request ${String(input)}`);
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const turn: TurnUsage = { id: "turn", messageId: "message", at: "2026-11-15T00:00:00Z", model: "unknown:unpriced",
		steps: [{ inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] };
	const detail = () => document.querySelector('[data-testid="stats-detail"]');
	const summary = () => host.querySelector<HTMLButtonElement>('[data-testid="stats-summary"]')!;
	const pointerDown = (target: EventTarget) => act(async () => {
		target.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
	});
	try {
		await act(async () => root.render(<InteractionLayersProvider><StatsBar chatId="fixture" turns={[turn]} contextTokens={42_000} /></InteractionLayersProvider>));
		await act(async () => summary().click());
		assert(detail(), "the summary opens the popover");
		assert(!host.contains(detail()), "the popover is outside the stats bar and its clipping ancestors");

		await pointerDown(detail()!.firstElementChild!);
		assert(detail(), "a pointerdown inside the popover keeps it open");

		await pointerDown(document.body);
		assert.equal(detail(), null, "a pointerdown outside closes it");

		await act(async () => summary().click());
		const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escape, { key: "Escape" });
		await act(async () => { detail()!.dispatchEvent(escape); });
		assert.equal(detail(), null, "Escape closes it");
	} finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
	}
});
