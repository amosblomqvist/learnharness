import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";

it("shows account-specific default, maximum and effective compaction for the selected model", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = globalThis as Record<string, unknown>;
	const common = { input: ["text", "image"], supportedLevels: ["low", "medium", "high"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000 };
	const entries = [
		{ ...common, id: "gpt-6.1-sol", name: "Sol", provider: "chatgpt", contextWindow: 500_000, defaultContextWindow: 500_000, maxContextWindow: 872_000, contextWindowKey: "chatgpt:a:gpt-6.1-sol" },
		{ ...common, id: "gpt-6-astra", name: "Astra", provider: "chatgpt", contextWindow: 872_000, defaultContextWindow: 272_000, maxContextWindow: 872_000, contextWindowKey: "chatgpt:a:gpt-6-astra" },
	];
	const bodies: Record<string, unknown> = {
		"/api/search": { available: false, engine: null, reason: "No search engine" },
		"/api/keys": { keys: [] },
		"/api/models": { models: entries, slots: { strong: { model: { provider: "chatgpt", id: "gpt-6.1-sol" } }, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [] },
	};
	for (const [key, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		fetch: async (url: string) => new Response(JSON.stringify(bodies[url])),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<AgentSection agent={undefined} models={undefined} graph={undefined}
			compaction={{ thresholdTokens: 800_000, contextWindows: { "chatgpt:a:gpt-6-astra": 872_000 } }}
			onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} />));
		const row = document.querySelector<HTMLElement>('[data-testid="context-window-row"]')!;
		assert.match(row.textContent ?? "", /Account default 500000; maximum 872000/);
		assert.equal(document.querySelector<HTMLInputElement>('[data-testid="input-context-window"]')?.placeholder, "500000");
		assert.match(document.querySelector('[data-testid="compaction-row-threshold"]')?.textContent ?? "", /483616 tok effective for Sol/);
		const select = document.querySelector<HTMLSelectElement>('[data-testid="context-model"]')!;
		await act(async () => {
			Object.defineProperty(select, "value", { configurable: true, writable: true, value: "chatgpt:a:gpt-6-astra" });
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		assert.match(row.textContent ?? "", /Account default 272000; maximum 872000/);
		assert.equal(document.querySelector<HTMLInputElement>('[data-testid="input-context-window"]')?.value, "872000");
		assert.match(document.querySelector('[data-testid="compaction-row-threshold"]')?.textContent ?? "", /800000 tok effective for Astra/);
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
