/**
 * Provider labels in the model menu and model tooltips. Rows read
 * "<provider label> · <model id>" (subscriptions add "(subscription)"),
 * so ids shared across catalogs (opencode vs opencode-go) stay
 * distinguishable.
 *
 * The DOM globals are installed BEFORE any component module loads: Radix
 * picks its layout-effect hook at import time from `globalThis.document`,
 * and without one the tooltip portal never mounts. Components are
 * therefore imported dynamically below. `document.oninput` lets react-dom
 * detect native input events (as in dictation-picker.test.tsx), so the
 * search field's onChange fires.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { ModelCatalogEntry, ModelCatalogResponse, ModelsSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: () => null, setItem() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
Object.assign(dom.document, { oninput: null });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const core = await import("../src/core/index.ts");
const { createRoot } = await import("react-dom/client");
const { ModelMenuList } = await import("../components/settings/model-menu.tsx");
const { ModelControl } = await import("../components/model-picker.tsx");
const { SetupDialog } = await import("../components/setup-dialog.tsx");
const { AgentSection } = await import("../components/settings/agent-section.tsx");
const { useModelCatalog } = await import("../components/model-catalog.ts");
const { hintText } = await import("../components/ui/hint.tsx");

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function entry(provider: string, id: string): ModelCatalogEntry {
	return { id, provider, name: `Model ${id}`, input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 };
}
const zen = entry("opencode", "kimi-k2");
const go = entry("opencode-go", "kimi-k2");
const catalog: ModelCatalogResponse = {
	models: [zen, go], defaults: null,
	rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
	slots: { strong: { model: { provider: go.provider, id: go.id }, thinkingLevel: "off" }, cheap: { model: { provider: go.provider, id: go.id }, thinkingLevel: "off" }, vision: { model: { provider: go.provider, id: go.id }, thinkingLevel: "off" } },
	providers: [{ id: "opencode", envVar: "OPENCODE_API_KEY", keyPresent: true }, { id: "opencode-go", envVar: "OPENCODE_API_KEY", keyPresent: true }],
};
const strongGo: ModelsSettings = { strong: { model: { provider: go.provider, id: go.id }, thinkingLevel: "off" } };

function installFetch() {
	globalThis.fetch = async (input) => {
		const path = String(input);
		if (path === "/api/models") return Response.json(catalog);
		if (path === "/api/settings") return Response.json({ settings: { models: strongGo } });
		if (path === "/api/keys") return Response.json({ providers: [], keys: [] });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [] });
		if (path === "/api/search") return Response.json({ available: false, engine: null, reason: "fixture" });
		throw new Error(`Unexpected request ${path}`);
	};
}
async function render(children: React.ReactNode) {
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(children));
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function element(testid: string) { const e = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`); assert.ok(e, testid); return e; }
function rows() { return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="model-list"] button')].map((b) => b.textContent ?? ""); }
async function search(value: string) {
	const input = element("model-search") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
/** Focus opens the Radix tooltip immediately; returns its text. */
async function tooltipFor(testid: string) {
	await act(async () => { element(testid).dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); });
	return document.querySelector('[data-slot="tooltip-content"]')?.textContent;
}
function Reader() { useModelCatalog(); return null; }

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

describe("providerLabel / modelLabel", () => {
	it("key providers read their AUTH_PROVIDER_KEYS label, so the OpenCode plans differ", () => {
		assert.equal(core.providerLabel("opencode"), "OpenCode Zen");
		assert.equal(core.providerLabel("opencode-go"), "OpenCode Go");
		assert.equal(core.providerLabel("moonshotai-cn"), "Moonshot AI CN");
		assert.equal(core.providerLabel("openrouter"), "OpenRouter");
		assert.equal(core.providerLabel("xai"), "xAI", "the API-key xai provider is not the Grok subscription");
	});
	it("Claude Code, the custom endpoint and subscriptions use their own labels", () => {
		assert.equal(core.providerLabel(core.CLAUDE_CODE_PROVIDER), "Claude Code");
		assert.equal(core.providerLabel(core.CUSTOM_PROVIDER.id), "Custom endpoint");
		assert.equal(core.providerLabel("chatgpt"), "ChatGPT");
		assert.equal(core.providerLabel("github-copilot-subscription"), "GitHub Copilot");
		assert.equal(core.providerLabel("xai-subscription"), "Grok");
	});
	it("an unknown provider falls back to its raw id", () => {
		assert.equal(core.providerLabel("newprovider"), "newprovider");
		assert.equal(core.modelLabel("newprovider", "m1"), "newprovider · m1");
	});
	it("modelLabel adds (subscription) only for subscription models", () => {
		assert.equal(core.modelLabel("opencode-go", "kimi-k2"), "OpenCode Go · kimi-k2");
		assert.equal(core.modelLabel(core.CLAUDE_CODE_PROVIDER, "opus"), "Claude Code · opus");
		assert.equal(core.modelLabel("chatgpt", "gpt-5"), "ChatGPT (subscription) · gpt-5");
		assert.equal(core.modelLabel("xai-subscription", "grok-4"), "Grok (subscription) · grok-4");
	});
	it("key refusals name the provider label, including non-key providers", () => {
		const tail = "key is set — add one in Settings → Keys";
		assert.equal(core.providerKeyMissing("opencode-go", ["strong"]).error, `No OpenCode Go ${tail}`);
		assert.equal(core.providerKeyMissing(core.CUSTOM_PROVIDER.id, ["strong"]).error, `No Custom endpoint ${tail}`);
		assert.equal(core.providerKeyMissing("chatgpt", ["cheap"]).error, `No ChatGPT ${tail}`);
		assert.equal(core.providerKeyMissing("github-copilot-subscription", ["cheap"]).error, `No GitHub Copilot ${tail}`);
		assert.equal(core.providerKeyMissing("weird", ["cheap"]).error, `No weird ${tail}`);
	});
});

describe("model menu rows", () => {
	before(installFetch);
	it("the second line reads the provider label, not the raw id", async () => {
		await render(<ModelMenuList models={[zen, go, entry(core.CLAUDE_CODE_PROVIDER, "opus"), entry(core.CUSTOM_PROVIDER.id, "local")]} effectiveId={undefined} onPick={() => {}} />);
		const text = rows().join("\n");
		assert.match(text, /OpenCode Zen · kimi-k2/);
		assert.match(text, /OpenCode Go · kimi-k2/);
		assert.match(text, /Claude Code · opus/);
		assert.match(text, /Custom endpoint · local/);
		assert.doesNotMatch(text, /opencode-go ·|opencode ·/);
	});
	it("search matches the provider label as well as the id", async () => {
		await render(<ModelMenuList models={[zen, go, entry("openrouter", "other")]} effectiveId={undefined} onPick={() => {}} />);
		await search("zen");
		assert.equal(rows().length, 1); assert.match(rows()[0]!, /OpenCode Zen · kimi-k2/);
		await search("OpenCode Go");
		assert.match(rows()[0]!, /OpenCode Go · kimi-k2/);
		await search("opencode-go");
		assert.match(rows()[0]!, /OpenCode Go · kimi-k2/);
	});
});

describe("model tooltips", () => {
	it("the chat model pill", async () => {
		installFetch();
		await render(<ModelControl />);
		// The pill appends its live shortcut, which differs per platform.
		assert.equal(await tooltipFor("stats-model"), hintText("OpenCode Go · kimi-k2", "open-model-picker"));
	});
	it("the setup dialog slot trigger", async () => {
		installFetch();
		await render(<><Reader /><SetupDialog open onClose={() => {}} onDone={() => {}} /></>);
		assert.equal(await tooltipFor("setup-trigger-strong"), "OpenCode Go · kimi-k2");
	});
	it("the agent settings slot trigger", async () => {
		installFetch();
		await render(<><Reader /><AgentSection agent={undefined} models={strongGo} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} /></>);
		assert.equal(await tooltipFor("slot-model-strong"), "OpenCode Go · kimi-k2");
	});
});
