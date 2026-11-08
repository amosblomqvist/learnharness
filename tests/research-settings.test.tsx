import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import type { AgentSettings } from "../src/core/index.ts";
import { SEARCH_ENGINES } from "../src/core/search.ts";
const emptyPromptEditors = {
	editors: Object.fromEntries(["common", "prober", "teacher", "practice", "proberTeacherShared"].map((id) => [id, { text: "", defaultText: "" }])),
	history: [],
	migrationNotice: false,
};

it("keyless settings keep Research interactive while search-engine setup retains its own disabled state", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const reason = "No search engine is configured.";
	const bodies: Record<string, unknown> = {
		"/api/search": { available: false, engine: null, reason },
		"/api/keys": { keys: SEARCH_ENGINES.map(({ envVar }) => ({ id: envVar, present: false })) },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": emptyPromptEditors,
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			assert.ok(url in bodies, `unexpected request: ${url}`);
			return new Response(JSON.stringify(bodies[url]));
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => {
			root.render(<AgentSection
				agent={{ tools: { research: true } }}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				onSectionChange={(next) => { written = next; }}
				onModelsChange={() => {}}
				onCompactionChange={() => {}}
			/>);
		});
		const row = document.querySelector<HTMLElement>('[data-testid="tool-row-research"]')!;
		const toggle = row.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
		assert.ok(toggle);
		assert.equal(toggle.hasAttribute("disabled"), false);
		assert.equal(toggle.getAttribute("aria-checked"), "true");
		assert.ok(!row.className.includes("opacity-40"));
		assert.ok(!row.textContent?.includes(reason), "search setup hint is no longer a research-disable hint");
		act(() => { toggle.click(); });
		assert.equal(written?.tools?.research, false, "the keyless toggle emits the same stored boolean");
		const engine = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(engine.className.includes("cursor-not-allowed"), "search engine preference retains its own key gate");
		act(() => { engine.click(); });
		assert.equal(document.querySelector('[data-testid="search-engine-menu"]'), null, "keyless engine preference does not open");
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes(reason));
	} finally {
		act(() => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});

for (const { id, label, envVar } of SEARCH_ENGINES) {
it(`a ${label}-only key enables the engine menu and selecting ${label} saves the pin`, async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const bodies: Record<string, unknown> = {
		"/api/search": { available: true, engine: id, reason: `search engine: ${id} (auto)` },
		"/api/keys": { keys: [{ id: envVar, present: true }] },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": emptyPromptEditors,
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => new Response(JSON.stringify(bodies[url])),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => root.render(<AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { written = next; }} onModelsChange={() => {}} onCompactionChange={() => {}} />));
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(!trigger.hasAttribute("disabled"));
		await act(async () => trigger.click());
		const optionIds = [...document.querySelectorAll('[data-testid^="engine-option-"]')].map((row) => row.getAttribute("data-testid"));
		assert.deepEqual(optionIds, ["engine-option-auto", ...SEARCH_ENGINES.map(({ id }) => `engine-option-${id}`)]);
		const option = document.querySelector<HTMLButtonElement>(`[data-testid="engine-option-${id}"]`);
		assert.ok(option);
		assert.ok(option.textContent?.includes(label));
		assert.match(option.textContent ?? "", /key/);
		act(() => option.click());
		assert.deepEqual(written?.search, { engine: id });
		await act(async () => trigger.click());
		const auto = document.querySelector<HTMLButtonElement>('[data-testid="engine-option-auto"]')!;
		assert.ok(auto);
		act(() => auto.click());
		assert.equal(written?.search, undefined, "Automatic clears the explicit pin");
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
}
