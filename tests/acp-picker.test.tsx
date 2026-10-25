import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { ModelControl } from "../components/model-picker.tsx";
import type { ChatSettings, ModelCatalogEntry } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const models: ModelCatalogEntry[] = ["codex", "claude"].flatMap((agent) => ["default", `model/${agent}-beta`].map((id) => ({
	provider: `acp-${agent}`, id, name: id === "default" ? `${agent} agent default` : `${agent} beta`,
	billing: "subscription", reasoning: true, input: ["text", "image"], supportedLevels: ["medium", "max"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0,
})));
function element(testId: string) {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	assert.ok(found, `Missing ${testId}`);
	return found;
}
async function click(testId: string) {
	await act(async () => { element(testId).dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}
async function mount() {
	host = document.createElement("div"); document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<ModelControl chatId="fixture" />); });
}
async function unmount() {
	await act(async () => { root?.unmount(); });
	root = undefined; host?.remove(); host = undefined;
}
afterEach(async () => { await unmount(); globalThis.fetch = originalFetch; });

describe("existing picker with subscription models", () => {
	for (const agent of ["codex", "claude"]) {
		it(`${agent}: selects a model and reasoning, persists per-session choices, and restores native defaults`, async () => {
			const strong = { model: { provider: `acp-${agent}`, id: "default" } };
			let settings: ChatSettings = { model: strong.model };
			const writes: { path: string; settings: ChatSettings }[] = [];
			globalThis.fetch = async (input, init) => {
				const requestPath = new URL(String(input), "http://localhost").pathname;
				if (init?.method === "PUT") {
					assert.equal(requestPath, "/api/chats/fixture/settings");
					settings = JSON.parse(String(init.body)); writes.push({ path: requestPath, settings });
					return Response.json({ settings });
				}
				if (requestPath === "/api/models") return Response.json({ models, providers: [], defaults: null, slots: { strong } });
				if (requestPath === "/api/settings") return Response.json({ settings: { models: { strong } } });
				assert.equal(requestPath, "/api/chats/fixture");
				return Response.json({ settings });
			};
			await mount();
			await click("stats-model");
			await click(`model-option-model_${agent}-beta`);
			assert.equal(settings.model?.id, `model/${agent}-beta`);
			assert.equal(settings.thinkingLevel, undefined);
			assert.equal(element("stats-thinking").hasAttribute("disabled"), false);
			await click("stats-thinking");
			assert.ok(element("thinking-option-default"));
			assert.equal(document.querySelector('[data-testid="thinking-option-high"]'), null);
			await click("thinking-option-max");
			assert.equal(settings.thinkingLevel, "max");
			await unmount(); await mount();
			assert.match(element("stats-model").textContent!, new RegExp(`${agent} beta`));
			assert.match(element("stats-thinking").textContent!, /max/);
			await act(async () => { window.dispatchEvent(new dom.window.Event("lh:kbd-cycle-thinking")); });
			assert.equal(settings.thinkingLevel, "medium");
			await click("stats-thinking"); await click("thinking-option-default");
			assert.equal(settings.thinkingLevel, undefined);
			assert.match(element("stats-thinking").textContent!, /Agent default/);
			assert.equal(strong.model.id, "default", "per-session writes must not change new-session defaults");
			assert.equal(writes.length, 4);
		});
	}
});
