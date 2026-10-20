/**
 * Phase-1 reproduction for the reported block: a connected Codex
 * subscription, all three slots pinned to it, and zero provider API keys.
 * The current zero-keys truth only asks GET /api/keys, so the missing key
 * is read as "no way to run a model" and the send is intercepted into the
 * first-key setup screen instead of creating the draft session.
 *
 * The test mounts the real /chat/new entry (NewSession) and drives the
 * real composer controls: native value setter + bubbling input event for
 * typing, then the form's submit event. Fetch is wholly stubbed, so no
 * key, settings, chat, or subscription write can escape.
 *
 * linkedom has no `oninput` property; React's ChangeEventPlugin therefore
 * decides at import time that input events are unsupported and never maps
 * them to onChange. Declaring the property before react-dom loads keeps
 * the real native input path working. This is test plumbing, not a
 * production seam.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { ModelCatalogEntry, ModelCatalogResponse } from "../src/core/index.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";

(globalThis as Record<string, unknown>).React = React;

// Isolation: components may resolve data/auth paths at import time. Keep
// every path under a throwaway workspace temp dir; no real credential file
// is read.
const scratch = join(process.cwd(), ".scratch");
mkdirSync(scratch, { recursive: true });
const isolated = mkdtempSync(join(scratch, "zero-keys-subscription-"));
process.env.LH_DATA_DIR = join(isolated, "data");
process.env.LH_AUTH_FILE = join(isolated, "auth.json");
mkdirSync(process.env.LH_DATA_DIR, { recursive: true });

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	getComputedStyle: () => ({ overflowY: "visible", getPropertyValue: () => "" }),
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	IntersectionObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
// See the file header: this must happen before react-dom is imported.
(dom.window.document as unknown as { oninput: () => void }).oninput = () => {};

const { createRoot } = await import("react-dom/client");
const { NewSession } = await import("../components/new-session.tsx");
const { useModelAccess } = await import("../components/setup-cta.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");

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

const CODEX_SLOT = {
	model: { provider: "openai-codex", id: "gpt-5-codex" },
	thinkingLevel: "low" as const,
};

const OPENROUTER_MODEL: ModelCatalogEntry = {
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

const OPENROUTER_SLOT = {
	model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
	thinkingLevel: "low" as const,
};

const OPENROUTER_KEY = {
	id: "OPENROUTER_API_KEY",
	info: null,
	present: true,
	masked: "…test (9 chars)",
	source: "file",
	shadowedByEnv: false,
};

const OPENROUTER_PROVIDER = {
	id: "openrouter",
	envVar: "OPENROUTER_API_KEY",
	label: "OpenRouter",
};

const CATALOG: ModelCatalogResponse = {
	models: [CODEX_MODEL, OPENROUTER_MODEL],
	defaults: CODEX_SLOT,
	rolePins: {
		researcher: null,
		demoBuilder: null,
		visualMaker: null,
		extractor: null,
		auditor: null,
	},
	slots: { strong: CODEX_SLOT, cheap: CODEX_SLOT, vision: CODEX_SLOT },
	providers: [
		{
			id: "openai-codex",
			envVar: null,
			keyPresent: false,
			authorization: "subscription",
		},
		{
			id: "openrouter",
			envVar: "OPENROUTER_API_KEY",
			keyPresent: true,
			authorization: "api_key",
		},
	],
};

type Call = { path: string; method: string; body?: string };

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let pushed = "";
let root: Root | null = null;
let host: HTMLDivElement | null = null;

after(() => {
	globalThis.fetch = originalFetch;
	rmSync(isolated, { recursive: true, force: true });
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

function installFetch(
	subscription: { state: string; account?: unknown } = { state: "connected" },
	options: {
		subscriptionStatus?: number;
		subscriptionPending?: boolean;
		keys?: readonly unknown[];
		providers?: readonly unknown[];
	} = {},
): void {
	calls = [];
	pushed = "";
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input), "http://localhost").pathname;
		const method = init?.method ?? "GET";
		calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });

		if (path === "/api/keys") {
			return Response.json({ keys: options.keys ?? [], providers: options.providers ?? [] });
		}
		if (path === "/api/models") return Response.json(CATALOG);
		if (path === "/api/subscription") {
			if (options.subscriptionPending) return new Promise<Response>(() => {});
			return Response.json(subscription, { status: options.subscriptionStatus ?? 200 });
		}
		if (path === "/api/settings") {
			return Response.json({
				settings: { models: { strong: CODEX_SLOT, cheap: CODEX_SLOT, vision: CODEX_SLOT } },
			});
		}
		if (path === "/api/stt/token") return Response.json({ error: "dictation has no key" }, { status: 503 });
		if (path === "/api/chats" && method === "POST") return Response.json({ id: "c_new" }, { status: 201 });
		throw new Error(`unexpected fixture request: ${method} ${path}`);
	}) as typeof fetch;
}

async function mountSession(): Promise<HTMLDivElement> {
	const el = document.createElement("div");
	document.body.appendChild(el);
	host = el;
	root = createRoot(el);
	const router = {
		back() {},
		forward() {},
		refresh() {},
		hmrRefresh() {},
		push(href: string) {
			pushed = href;
		},
		replace() {},
		prefetch() {},
		experimental_gesturePush() {},
	};
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<NewSession initialConfigured={true} />
			</AppRouterContext.Provider>,
		);
	});
	return el;
}

type ConversationModelSettings = { model?: { provider: string; id: string } };

function AccessProbe({ settings }: { settings?: ConversationModelSettings }) {
	const access = (
		useModelAccess as unknown as (options?: {
			conversationSettings?: ConversationModelSettings;
		}) => { blocked: string | null }
	)({ conversationSettings: settings });
	return <span data-testid="access-blocked">{access.blocked ?? "none"}</span>;
}

async function mountAccessProbe(settings: ConversationModelSettings): Promise<HTMLDivElement> {
	const el = document.createElement("div");
	document.body.appendChild(el);
	host = el;
	root = createRoot(el);
	await act(async () => {
		root!.render(<AccessProbe settings={settings} />);
	});
	return el;
}

async function typeDraft(host: HTMLDivElement, text: string): Promise<void> {
	const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea');
	assert.ok(textarea, "the draft composer must render");
	const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
	assert.ok(setValue, "the native textarea value setter");
	await act(async () => {
		setValue.call(textarea, text);
		textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	await settle();
}

async function submitDraft(host: HTMLDivElement): Promise<void> {
	const form = host.querySelector("form");
	assert.ok(form, "the composer form must render");
	await act(async () => {
		form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle(30);
}

describe("zero provider keys with a connected subscription", () => {
	it("the configured draft submits instead of opening Add a provider key", async () => {
		installFetch();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const router = {
			back() {},
			forward() {},
			refresh() {},
			hmrRefresh() {},
			push(href: string) {
				pushed = href;
			},
			replace() {},
			prefetch() {},
			experimental_gesturePush() {},
		};

		await act(async () => {
			root!.render(
				<AppRouterContext.Provider value={router as never}>
					<NewSession initialConfigured={true} />
				</AppRouterContext.Provider>,
			);
		});

		// Wait for the real catalog + settings reads to land. The model
		// control showing the pinned id is a visible signal that both
		// reads were applied; the extra settle lets the /api/keys state
		// update flush as well.
		await waitFor(
			() =>
				calls.some((call) => call.path === "/api/keys") &&
				calls.some((call) => call.path === "/api/models") &&
				calls.some((call) => call.path === "/api/subscription") &&
				calls.some((call) => call.path === "/api/settings") &&
				Boolean(host!.querySelector('[data-testid="stats-model"]')?.textContent?.includes("gpt-5-codex")),
		);
		await settle(30);

		const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea');
		assert.ok(textarea, "the draft composer must render");
		const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
		assert.ok(setValue, "the native textarea value setter");
		await act(async () => {
			setValue.call(textarea, "teach me parity");
			textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await settle();

		const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
		assert.ok(send, "the send button must render");
		assert.equal(send.disabled, false, "typing must arm the send button");

		const form = host.querySelector("form");
		assert.ok(form, "the composer form must render");
		await act(async () => {
			form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		await settle(30);

		const posts = calls.filter((call) => call.path === "/api/chats" && call.method === "POST");
		const pill = document.querySelector('[data-testid="setup-cta-keys"]');
		const dialog = document.querySelector('[data-testid="setup-dialog"]');
		const diagnostics = [
			`posts=${posts.length}`,
			`pushed=${JSON.stringify(pushed)}`,
			`pill=${Boolean(pill)}`,
			`dialog=${Boolean(dialog)}`,
			`calls=${JSON.stringify(calls.map((call) => `${call.method} ${call.path}`))}`,
		].join(" ");

		assert.equal(posts.length, 1, `a connected subscription must create the draft session; ${diagnostics}`);
		const post = posts[0];
		assert.ok(post, "the chat create call must be recorded");
		assert.ok(post.body, "the chat create call must carry a body");
		assert.equal(JSON.parse(post.body).title, "teach me parity");
		assert.equal(pushed, "/chat/c_new?prompt=teach%20me%20parity");
		assert.equal(
			pill,
			null,
			`the zero-key CTA must not claim Add a provider key when the subscription is connected; ${diagnostics}`,
		);
		assert.equal(dialog, null, `the send must not be intercepted by the first-key setup screen; ${diagnostics}`);
	});
});

describe("the conversation's own model source", () => {
	it("a per-chat API-key override is not blocked by a disconnected strong subscription", async () => {
		installFetch(
			{ state: "disconnected" },
			{ keys: [OPENROUTER_KEY], providers: [OPENROUTER_PROVIDER] },
		);
		const el = await mountAccessProbe({ model: OPENROUTER_SLOT.model });
		await waitFor(() => calls.some((call) => call.path === "/api/subscription"));
		await settle(30);

		assert.equal(
			el.querySelector('[data-testid="access-blocked"]')?.textContent,
			"none",
			"the turn resolves the chat override, not the global strong subscription pin",
		);
	});
});

describe("subscription status is still loading", () => {
	it("does not create the draft before the first authorization read settles", async () => {
		installFetch({ state: "disconnected" }, { subscriptionPending: true });
		const el = await mountSession();
		await waitFor(
			() =>
				calls.some((call) => call.path === "/api/subscription") &&
				calls.some((call) => call.path === "/api/keys") &&
				Boolean(el.querySelector('[data-testid="stats-model"]')?.textContent?.includes("gpt-5-codex")),
		);
		await settle(30);

		await typeDraft(el, "teach me parity");
		await submitDraft(el);

		assert.equal(
			calls.filter((call) => call.path === "/api/chats" && call.method === "POST").length,
			0,
			"a pending authorization read must not create a draft it may have to abandon",
		);
		assert.equal(el.querySelector('[data-testid="setup-cta-keys"]'), null);
		assert.equal(el.querySelector('[data-testid="setup-dialog"]'), null);

		const pill = el.querySelector<HTMLButtonElement>('[data-testid="setup-cta-subscription"]');
		assert.ok(pill, "pending must render its own guidance, not disappear into a zero-key claim");
		assert.equal(pill.textContent, "Checking subscription…");
		assert.equal(pill.disabled, true, "the pending guidance is not actionable");
	});
});

describe("the selected subscription's guidance state", () => {
	it("a disconnected subscription guides to Subscription settings, not the first-key screen", async () => {
		installFetch({ state: "disconnected" });
		const el = await mountSession();
		await waitFor(
			() =>
				calls.some((call) => call.path === "/api/subscription") &&
				Boolean(document.querySelector('[data-testid="setup-cta-subscription"]')),
		);
		await settle(30);

		const pill = document.querySelector('[data-testid="setup-cta-subscription"]');
		assert.ok(pill, "a disconnected selected subscription must render subscription guidance");
		assert.equal(pill.textContent, "Connect subscription");
		assert.equal(
			document.querySelector('[data-testid="setup-cta-keys"]'),
			null,
			"a disconnected subscription is not a missing API key",
		);

		await typeDraft(el, "teach me parity");
		await submitDraft(el);

		const posts = calls.filter((call) => call.path === "/api/chats" && call.method === "POST");
		assert.equal(posts.length, 0, "a disconnected subscription must not create a draft");
		assert.equal(
			document.querySelector('[data-testid="setup-dialog"]'),
			null,
			"the send must open Subscription guidance, not the key-first dialog",
		);
		assert.equal(document.querySelector('[data-testid="setup-cta-keys"]'), null);
		assert.equal(pushed, "");
	});

	it("the subscription settings signal re-reads connect and disconnect transitions", async () => {
		const current = { state: "connected" as string };
		installFetch(current);
		const el = await mountSession();
		await waitFor(
			() =>
				calls.some((call) => call.path === "/api/subscription") &&
				Boolean(document.querySelector('[data-testid="stats-model"]')?.textContent?.includes("gpt-5-codex")),
		);
		await settle(30);
		assert.equal(
			document.querySelector('[data-testid="setup-cta-subscription"]'),
			null,
			"a connected subscription must not show guidance",
		);

		current.state = "disconnected";
		await act(async () => {
			notifySettingsSaved("subscription");
		});
		await waitFor(() => Boolean(document.querySelector('[data-testid="setup-cta-subscription"]')));
		assert.equal(
			document.querySelector('[data-testid="setup-cta-subscription"]')?.textContent,
			"Connect subscription",
		);

		current.state = "connected";
		await act(async () => {
			notifySettingsSaved("subscription");
		});
		await waitFor(() => document.querySelector('[data-testid="setup-cta-subscription"]') === null);
		assert.equal(
			document.querySelector('[data-testid="setup-cta-keys"]'),
			null,
			"a connected subscription with zero keys must not show the key pill",
		);
	});
});

describe("subscription read failures", () => {
	it("a failed read with no known status shows subscription guidance, never the first-key screen", async () => {
		installFetch({ state: "disconnected" }, { subscriptionStatus: 500 });
		const el = await mountSession();
		await waitFor(
			() =>
				calls.some((call) => call.path === "/api/subscription") &&
				Boolean(document.querySelector('[data-testid="setup-cta-subscription"]')),
		);
		await settle(30);

		assert.equal(
			document.querySelector('[data-testid="setup-cta-subscription"]')?.textContent,
			"Check subscription",
		);
		assert.equal(
			document.querySelector('[data-testid="setup-cta-keys"]'),
			null,
			"a failed subscription read must not be reported as a missing API key",
		);

		await typeDraft(el, "teach me parity");
		await submitDraft(el);

		assert.equal(calls.filter((call) => call.path === "/api/chats" && call.method === "POST").length, 0);
		assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
		assert.equal(document.querySelector('[data-testid="setup-cta-keys"]'), null);
	});
});
