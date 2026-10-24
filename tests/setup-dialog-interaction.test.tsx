import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SetupDialog } from "../components/setup-dialog.tsx";
import type { ModelCatalogEntry } from "../src/core/contracts/models.ts";

// As in render-update-banner: mount real React handlers against an isolated
// DOM. Fetch is wholly stubbed; no key, settings, or session writes can escape.
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
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const originalFetch = globalThis.fetch;
const provider = { id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" };
const model: ModelCatalogEntry = {
	id: "fixture-text",
	name: "Fixture text",
	provider: provider.id,
	reasoning: false,
	input: ["text"],
	supportedLevels: ["off"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let closed = 0;
let completed = 0;

async function mount({ keyed = false, catalogFails = false } = {}) {
	closed = 0;
	completed = 0;
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "interaction tests must not write data");
		const path = new URL(String(input), "http://localhost").pathname;
		if (path === "/api/keys") return Response.json({ providers: [provider], keys: [] });
		assert.equal(path, "/api/models");
		if (catalogFails) throw new Error("fixture catalog failure");
		return Response.json({
			providers: [{ ...provider, keyPresent: keyed }],
			models: keyed ? [model] : [],
			slots: { strong: null, cheap: null, vision: null },
		});
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		const [open, setOpen] = React.useState(true);
		return <SetupDialog open={open} onClose={() => { closed++; setOpen(false); }} onDone={() => { completed++; }} />;
	}
	await act(async () => { root!.render(<Harness />); });
}

function element(selector: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(selector);
	assert.ok(node, `expected ${selector}`);
	return node;
}

async function event(target: HTMLElement, type: string) {
	await act(async () => {
		const dispatched = new dom.window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(dispatched, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, detail: 1 });
		target.dispatchEvent(dispatched);
	});
}

async function click(target: HTMLElement) {
	for (const type of ["pointerdown", "pointerup", "click"]) await event(target, type);
}

async function escape() {
	await act(async () => {
		const key = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(key, { key: "Escape" });
		document.dispatchEvent(key);
	});
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
	host = null;
	globalThis.fetch = originalFetch;
	assert.equal(completed, 0, "opening or dismissing setup must not save models");
});

describe("setup polish interactions", () => {
	it("provider dropdown closes on a click elsewhere inside the dialog without closing setup", async () => {
		await mount();
		await click(element('[data-testid="setup-key-provider"]'));
		assert.ok(document.querySelector('[data-testid="setup-key-provider-menu"]'));
		await click(element('[data-testid="setup-dialog"] h2'));
		assert.equal(document.querySelector('[data-testid="setup-key-provider-menu"]'), null);
		assert.ok(document.querySelector('[data-testid="setup-dialog"]'));
		assert.equal(closed, 0);
	});

	it("provider trigger still toggles and picking an option still opens the key field", async () => {
		await mount();
		await click(element('[data-testid="setup-key-provider"]'));
		await click(element('[data-testid="setup-key-provider"]'));
		assert.equal(document.querySelector('[data-testid="setup-key-provider-menu"]'), null);
		await click(element('[data-testid="setup-key-provider"]'));
		await click(element('[data-testid="provider-option-openrouter"]'));
		assert.equal(document.querySelector('[data-testid="setup-key-provider-menu"]'), null);
		assert.ok(document.querySelector('[data-testid="setup-key-input"]'));
		assert.equal(closed, 0);
	});

	it("Escape closes the provider dropdown first, then setup on the next press", async () => {
		await mount();
		await click(element('[data-testid="setup-key-provider"]'));
		await escape();
		assert.equal(document.querySelector('[data-testid="setup-key-provider-menu"]'), null);
		assert.ok(document.querySelector('[data-testid="setup-dialog"]'));
		assert.equal(closed, 0);
		await escape();
		assert.equal(closed, 1);
		assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
	});

	it("a genuine backdrop click closes setup and its open dropdown", async () => {
		await mount();
		await click(element('[data-testid="setup-key-provider"]'));
		await click(element('[data-testid="setup-backdrop"]'));
		assert.equal(closed, 1);
		assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
		assert.equal(document.querySelector('[data-testid="setup-key-provider-menu"]'), null);
	});

	it("inside press followed by backdrop release and ancestor click does not dismiss setup", async () => {
		await mount();
		await event(element('[data-testid="setup-dialog"] h2'), "pointerdown");
		await event(element('[data-testid="setup-backdrop"]'), "pointerup");
		await event(element('[data-testid="setup-backdrop"]'), "click");
		assert.equal(closed, 0);
		assert.ok(document.querySelector('[data-testid="setup-dialog"]'));
	});

	it("model and thinking dropdowns keep outside-click dismissal and model guidance uses two sentences", async () => {
		await mount({ keyed: true });
		assert.equal(element('[data-testid="setup-stage-pickers"] > p').textContent, "Pick the model for each tier. All three are required before chats can start.");
		await click(element('[data-testid="setup-trigger-strong"]'));
		await click(element('[data-testid="setup-dialog"] h2'));
		assert.equal(document.querySelector('[data-testid="setup-menu-strong"]'), null);
		await click(element('[data-testid="setup-trigger-strong"]'));
		await click(element('[data-testid="model-option-fixture-text"]'));
		await click(element('[data-testid="setup-thinking-strong"]'));
		assert.ok(document.querySelector('[data-testid="setup-thinking-menu-strong"]'));
		await click(element('[data-testid="setup-dialog"] h2'));
		assert.equal(document.querySelector('[data-testid="setup-thinking-menu-strong"]'), null);
		assert.equal(closed, 0);
	});

	it("the empty vision list gives the approved next action without an em dash", async () => {
		await mount({ keyed: true });
		await click(element('[data-testid="setup-trigger-vision"]'));
		assert.ok(element('[data-testid="setup-menu-vision"]').textContent?.includes("No image-capable models. Add a provider key with access to a vision model, or connect a local one."));
	});

	it("the first screen offers two model sources; the local tab is the connect form, opened without a request", async () => {
		await mount();
		assert.equal(element('[data-testid="setup-tab-keys"]').getAttribute("aria-selected"), "true");
		assert.equal(element('[data-testid="setup-tab-keys"]').textContent, "Provider API keys");
		assert.equal(element('[data-testid="setup-tab-local"]').textContent, "Local model");
		assert.ok(document.querySelector('[data-testid="setup-stage-keys"]'));
		await click(element('[data-testid="setup-tab-local"]'));
		assert.equal(document.querySelector('[data-testid="setup-stage-keys"]'), null);
		assert.ok(document.querySelector('[data-testid="setup-stage-local"]'));
		for (const field of ["address", "api", "key", "context", "vision", "connect"]) {
			assert.ok(document.querySelector(`[data-testid="setup-local-${field}"]`), field);
		}
		await click(element('[data-testid="setup-local-preset-ollama"]'));
		assert.equal((element('[data-testid="setup-local-address"]') as HTMLInputElement).value, "localhost:11434");
		await click(element('[data-testid="setup-tab-keys"]'));
		assert.ok(document.querySelector('[data-testid="setup-stage-keys"]'));
		assert.equal(closed, 0);
	});

	it("catalog failure uses the approved two-sentence error", async () => {
		await mount({ catalogFails: true });
		assert.ok(element('[data-testid="setup-dialog"]').textContent?.includes("Model catalog could not be loaded. Check the connection and retry."));
	});
});
