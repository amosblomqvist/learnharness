/**
 * The reverse of the /chat/new regression: a chat whose STRONG slot is an
 * ordinary API-key provider but whose OWN model override is the Codex
 * subscription (not connected) must be blocked with Subscription guidance.
 * The server resolves this chat with resolveConversationSpec(chat.settings,
 * strong), so a gate that reads only the strong pin would let it through.
 *
 * A fresh module graph keeps the model catalog cache empty: the only
 * /api/models read is this test's API-strong catalog. The shared
 * useModelAccess hook is the real consumer seam Chat uses.
 */

import assert from "node:assert/strict";
import { after, afterEach, it } from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { ModelCatalogEntry, ModelCatalogResponse } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { createRoot } = await import("react-dom/client");
const { useModelAccess } = await import("../components/setup-cta.tsx");

const CODEX_MODEL: ModelCatalogEntry = {
	id: "gpt-5-codex",
	name: "GPT-5 Codex",
	provider: "openai-codex",
	reasoning: true,
	input: ["text"],
	supportedLevels: ["low"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	authorization: "subscription",
	availability: "authorization_required",
};

const API_MODEL: ModelCatalogEntry = {
	id: "openai/gpt-4o-mini",
	name: "GPT-4o mini",
	provider: "openrouter",
	reasoning: false,
	input: ["text"],
	supportedLevels: ["low"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const API_STRONG = {
	model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
	thinkingLevel: "low" as const,
};

const CODEX_CHAT = {
	model: { provider: "openai-codex", id: "gpt-5-codex" },
	thinkingLevel: "low" as const,
};

const CATALOG: ModelCatalogResponse = {
	models: [CODEX_MODEL, API_MODEL],
	defaults: API_STRONG,
	rolePins: {
		researcher: null,
		demoBuilder: null,
		visualMaker: null,
		extractor: null,
		auditor: null,
	},
	slots: { strong: API_STRONG, cheap: API_STRONG, vision: API_STRONG },
	providers: [
		{ id: "openrouter", envVar: "OPENROUTER_API_KEY", keyPresent: true, authorization: "api_key" },
		{ id: "openai-codex", envVar: null, keyPresent: false, authorization: "subscription" },
	],
};

const originalFetch = globalThis.fetch;
const calls: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

after(() => {
	globalThis.fetch = originalFetch;
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root!.unmount();
		});
		root = null;
	}
	if (host) {
		host.remove();
		host = null;
	}
});

async function settle(ms = 0): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await settle(25);
	}
	assert.fail("condition was not met before the timeout");
}

function AccessProbe({ settings }: { settings: typeof CODEX_CHAT }) {
	const access = (
		useModelAccess as unknown as (options?: {
			conversationSettings?: { model?: { provider: string; id: string } };
		}) => { blocked: string | null }
	)({ conversationSettings: settings });
	return <span data-testid="access-blocked">{access.blocked ?? "none"}</span>;
}

it("a chat override on the disconnected subscription is blocked even when strong is a keyed API provider", async () => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const path = new URL(String(input), "http://localhost").pathname;
		calls.push(path);
		if (path === "/api/keys") return Response.json({ keys: [], providers: [] });
		if (path === "/api/models") return Response.json(CATALOG);
		if (path === "/api/subscription") return Response.json({ state: "disconnected" });
		throw new Error(`unexpected fixture request: ${path}`);
	}) as typeof fetch;

	const el = document.createElement("div");
	document.body.appendChild(el);
	host = el;
	root = createRoot(el);
	await act(async () => {
		root!.render(<AccessProbe settings={CODEX_CHAT} />);
	});
	await waitFor(() => calls.includes("/api/models") && calls.includes("/api/subscription"));
	await settle(50);

	assert.equal(
		el.querySelector('[data-testid="access-blocked"]')?.textContent,
		"subscription",
		"the chat's own subscription override must be intercepted, not the strong API pin",
	);
});
