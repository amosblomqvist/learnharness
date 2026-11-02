import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import type { ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; globalThis.fetch = originalFetch; });

test("compact CLI context is numeric only; effective-window explanation appears only in expanded session metadata", async () => {
	const catalog: ModelCatalogResponse = { models: CLAUDE_CODE_MODELS.map(toModelDto), providers: [],
		slots: { strong: null, cheap: null, vision: null }, defaults: null,
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null } };
	globalThis.fetch = (async (url) => {
		if (url === "/api/models") return Response.json(catalog);
		if (url === "/api/settings") return Response.json({ settings: { models: {} } });
		if (url === "/api/chats/cli-session") return Response.json({ settings: { model: { provider: "claude-code", id: "opus" } } });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	const turn: TurnUsage = { id: "cli-turn", messageId: "cli-message", model: "claude-code:opus", at: "2026-10-28T00:00:00Z", steps: [{ inputTokens: 42000, outputTokens: 1, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }] };
	const render = (window: { model: string; tokens: number } | null) => root!.render(<StatsBar chatId="cli-session" turns={[turn]} contextTokens={42000} cliContextWindow={window} />);
	await act(async () => render({ model: "claude-code:opus", tokens: 200000 }));
	assert.equal(document.querySelector('[data-testid="stats-context"]')?.textContent, "42k / 200k");
	assert(!document.body.textContent?.includes("auto-compaction"));
	assert.equal(document.querySelector('[data-testid="stats-cost"]')?.textContent, "CLI");
	const summary = document.querySelector<HTMLButtonElement>('[data-testid="stats-summary"]')!;
	assert(!summary.textContent?.includes("window")); assert(!summary.textContent?.includes("budget"));
	await act(async () => summary.click());
	assert.match(document.querySelector('[data-testid="stats-detail"]')?.textContent ?? "", /Window reported by Claude Code; may be lower for auto-compaction\./);
	assert.equal(document.querySelector('[data-testid="stats-detail"] li > span:last-child > span:last-child')?.textContent, "CLI");
	assert.equal(document.querySelector('[data-testid="stats-context"]')?.textContent, "42k / 200k");
	await act(async () => render(null));
	assert.equal(document.querySelector('[data-testid="stats-context"]')?.textContent, "42k");
	await act(async () => render({ model: "claude-code:sonnet", tokens: 1000000 }));
	assert.equal(document.querySelector('[data-testid="stats-context"]')?.textContent, "42k", "another alias cannot supply this session's denominator");
});
