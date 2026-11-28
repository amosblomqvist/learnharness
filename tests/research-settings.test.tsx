import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { AgentSettings } from "../src/core/index.ts";
import { SEARCH_ENGINES } from "../src/core/search.ts";
import { installModalDom } from "./modal-dom.ts";

const KEYED_ENGINES = SEARCH_ENGINES.flatMap((engine) => engine.envVar ? [engine] : []);

/** Mount the section over canned route bodies, with the menu DOM installed. */
async function withAgentSection(
	routes: { search: unknown; keys: { id: string; present: boolean }[] },
	agent: AgentSettings | undefined,
	run: (written: () => AgentSettings | undefined) => Promise<void>,
) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const bodies: Record<string, unknown> = {
		"/api/search": routes.search,
		"/api/keys": { keys: routes.keys },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [], practice: [] },
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		CustomEvent: dom.window.CustomEvent,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
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
	const restoreModalDom = installModalDom(dom);
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => root.render(<InteractionLayersProvider><AgentSection agent={agent} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { written = next; return true; }} onModelsChange={() => {}} onCompactionChange={() => true} /></InteractionLayersProvider>));
		await run(() => written);
	} finally {
		act(() => root.unmount());
		restoreModalDom();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
}

const engineTrigger = () => document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
const engineOptions = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="engine-option-"]')];

it("keyless settings keep Research interactive while search-engine setup retains its own disabled state", () => {
	const reason = "No search engine is configured.";
	return withAgentSection(
		{ search: { available: false, engine: null, reason, keyless: { openai: "unsupported" } }, keys: KEYED_ENGINES.map(({ envVar }) => ({ id: envVar, present: false })) },
		{ tools: { research: true } },
		async (written) => {
			const row = document.querySelector<HTMLElement>('[data-testid="tool-row-research"]')!;
			const toggle = row.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
			assert.ok(toggle);
			assert.equal(toggle.hasAttribute("disabled"), false);
			assert.equal(toggle.getAttribute("aria-checked"), "true");
			assert.ok(!row.className.includes("opacity-40"));
			assert.ok(!row.textContent?.includes(reason), "search setup hint is no longer a research-disable hint");
			act(() => { toggle.click(); });
			assert.equal(written()?.tools?.research, false, "the keyless toggle emits the same stored boolean");
			assert.ok(engineTrigger().className.includes("cursor-not-allowed"), "search engine preference retains its own key gate");
			act(() => { engineTrigger().click(); });
			assert.equal(document.querySelector('[data-testid="search-engine-menu"]'), null, "keyless engine preference does not open");
			assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes(reason));
		},
	);
});

for (const { id, label, envVar } of KEYED_ENGINES) {
it(`a ${label}-only key enables the engine menu and selecting ${label} saves the pin`, () => withAgentSection(
	{ search: { available: true, engine: id, reason: `search engine: ${id} (auto)`, keyless: { openai: "unsupported" } }, keys: [{ id: envVar, present: true }] },
	undefined,
	async (written) => {
		assert.ok(!engineTrigger().hasAttribute("disabled"));
		await act(async () => engineTrigger().click());
		assert.deepEqual(engineOptions().map((row) => row.getAttribute("data-testid")), ["engine-option-auto", ...KEYED_ENGINES.map(({ id }) => `engine-option-${id}`)]);
		const option = document.querySelector<HTMLButtonElement>(`[data-testid="engine-option-${id}"]`);
		assert.ok(option);
		assert.ok(option.textContent?.includes(label));
		assert.match(option.textContent ?? "", /key/);
		act(() => option.click());
		assert.deepEqual(written()?.search, { engine: id });
		await act(async () => engineTrigger().click());
		const auto = document.querySelector<HTMLButtonElement>('[data-testid="engine-option-auto"]')!;
		assert.ok(auto);
		act(() => auto.click());
		assert.equal(written()?.search, undefined, "Automatic clears the explicit pin");
	},
));
}

for (const { openai, mark } of [{ openai: "ready", mark: "✓ available" }, { openai: "blocked", mark: "· unavailable" }] as const) {
it(`a researcher model that can run it offers OpenAI last, marked "${mark}", with no key anywhere`, () => withAgentSection(
	{ search: { available: false, engine: null, reason: "No search engine is configured.", keyless: { openai } }, keys: [] },
	undefined,
	async (written) => {
		assert.ok(!engineTrigger().hasAttribute("disabled"));
		await act(async () => engineTrigger().click());
		const option = engineOptions().at(-1)!;
		assert.equal(option.getAttribute("data-testid"), "engine-option-openai");
		assert.equal(option.textContent, `OpenAI${mark}`);
		act(() => option.click());
		assert.deepEqual(written()?.search, { engine: "openai" });
	},
));
}

it("OpenAI stays listed while it is the saved choice, so a researcher that can no longer run it can be switched away from", () => withAgentSection(
	{ search: { available: false, engine: null, reason: "not an OpenAI model", keyless: { openai: "unsupported" } }, keys: [] },
	{ search: { engine: "openai" } },
	async (written) => {
		assert.ok(!engineTrigger().hasAttribute("disabled"));
		await act(async () => engineTrigger().click());
		assert.equal(engineOptions().at(-1)!.textContent, "OpenAI· unavailable");
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="engine-option-auto"]')!.click());
		assert.equal(written()?.search, undefined);
	},
));
