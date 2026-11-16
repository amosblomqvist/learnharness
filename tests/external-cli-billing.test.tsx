import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { contextLimitForModel, StatsBar } from "../components/stats-bar.tsx";
import { cliContextWindowOf, type LhMessage, type ModelCatalogEntry, type ModelCatalogResponse, type TurnUsage } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

function assistantMessage(provider: string, model: string, cliContextWindow: number): LhMessage {
	return {
		id: `msg-${provider}`,
		role: "assistant",
		api: "external-cli",
		provider,
		model,
		content: [],
		timestamp: 0,
		stopReason: "stop",
		cliContextWindow,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function catalogEntry(provider: string, id: string, name: string): ModelCatalogEntry {
	return {
		id,
		name,
		provider,
		reasoning: true,
		input: ["text"],
		supportedLevels: ["low", "medium", "high"],
		cost: null,
		contextWindow: null,
		maxTokens: null,
	};
}

test("cliContextWindowOf accepts codex and gemini-cli reports and rejects non-CLI providers", () => {
	assert.deepEqual(cliContextWindowOf([assistantMessage("codex", "gpt-5", 128000)]), {
		model: "codex:gpt-5",
		tokens: 128000,
	});
	assert.deepEqual(cliContextWindowOf([assistantMessage("gemini-cli", "pro", 1000000)]), {
		model: "gemini-cli:pro",
		tokens: 1000000,
	});
	assert.equal(cliContextWindowOf([assistantMessage("openai", "gpt-4o", 128000)]), null);
});

test("StatsBar renders CLI billing and CLI context rules for codex turns including ids with colons", async () => {
	const models: ModelCatalogEntry[] = [
		catalogEntry("codex", "gpt-5:v1:0", "GPT-5"),
		catalogEntry("gemini-cli", "pro", "Gemini Pro"),
	];
	const catalog: ModelCatalogResponse = {
		models,
		providers: [],
		slots: { strong: null, cheap: null, vision: null },
		defaults: null,
		rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
	};
	globalThis.fetch = (async (url) => {
		if (url === "/api/models") return Response.json(catalog);
		if (url === "/api/settings") return Response.json({ settings: { models: {} } });
		if (url === "/api/chats/codex-session") return Response.json({ settings: { model: { provider: "codex", id: "gpt-5:v1:0" } } });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	const limits = new Map([["codex:gpt-5:v1:0", 999999], ["openai:gpt-4o", 128000]]);
	assert.equal(contextLimitForModel("codex:gpt-5:v1:0", limits, null), null);
	assert.equal(contextLimitForModel("codex:gpt-5:v1:0", limits, { model: "codex:gpt-5:v1:0", tokens: 200000 }), 200000);
	assert.equal(contextLimitForModel("gemini-cli:pro", limits, { model: "gemini-cli:pro", tokens: 500000 }), 500000);

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const turn: TurnUsage = {
		id: "codex-turn",
		messageId: "codex-message",
		model: "codex:gpt-5:v1:0",
		at: "2026-11-13T00:00:00Z",
		steps: [{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: undefined }],
	};
	const pricing = { cost: 0, unpriced: 1, turnCosts: { "codex-turn": null } };

	await act(async () => {
		root!.render(<StatsBar chatId="codex-session" turns={[turn]} pricing={pricing} />);
	});

	assert.equal(document.querySelector('[data-testid="stats-cost"]')?.textContent, "CLI");
	assert(!document.body.textContent?.includes("$0"));

	const summary = document.querySelector<HTMLButtonElement>('[data-testid="stats-summary"]')!;
	await act(async () => summary.click());
	assert.equal(document.querySelector('[data-testid="stats-detail"] li > span:last-child > span:last-child')?.textContent, "CLI");
});

test("ModelMenuList renders CLI billing and provider-labeled tooltip for codex, gemini-cli, and claude-code", async () => {
	const models: ModelCatalogEntry[] = [
		catalogEntry("codex", "gpt-5", "Codex GPT-5"),
		catalogEntry("gemini-cli", "pro", "Gemini CLI Pro"),
		catalogEntry("claude-code", "sonnet", "Claude Sonnet"),
	];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);

	await act(async () => {
		root!.render(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} />);
	});

	const codexBilling = document.querySelector<HTMLElement>('[data-testid="model-option-gpt-5"] span[title]');
	assert.equal(codexBilling?.textContent, "CLI billing");
	assert.match(codexBilling?.getAttribute("title") ?? "", /Codex/);
	assert.equal(
		codexBilling?.getAttribute("title"),
		"Billing is determined by your Codex configuration; LearnHarness does not estimate it.",
	);

	const geminiBilling = document.querySelector<HTMLElement>('[data-testid="model-option-pro"] span[title]');
	assert.equal(geminiBilling?.textContent, "CLI billing");
	assert.equal(
		geminiBilling?.getAttribute("title"),
		"Billing is determined by your Gemini CLI configuration; LearnHarness does not estimate it.",
	);

	const claudeBilling = document.querySelector<HTMLElement>('[data-testid="model-option-sonnet"] span[title]');
	assert.equal(claudeBilling?.textContent, "CLI billing");
	assert.equal(
		claudeBilling?.getAttribute("title"),
		"Billing is determined by your Claude Code configuration; LearnHarness does not estimate it.",
	);
});
