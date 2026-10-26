import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import type { AgentSettings } from "../src/core/index.ts";

async function mountSection(options: {
	search: { available: boolean; chatgptAvailable: boolean; engine: string | null; reason: string };
	agent?: AgentSettings;
	onSearchRequest?: () => void;
	fetchSearch?: () => Promise<Response>;
	fetchModels?: () => Promise<Response>;
}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const bodies: Record<string, unknown> = {
		"/api/search": options.search,
		"/api/keys": { keys: [{ id: "TAVILY_API_KEY", present: false }, { id: "BRAVE_API_KEY", present: false }] },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [] },
	};
	let subscriptionListener: ((data: string) => void) | undefined;
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		CustomEvent: dom.window.CustomEvent,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			assert.ok(url in bodies, `unexpected request: ${url}`);
			if (url === "/api/search") {
				options.onSearchRequest?.();
				if (options.fetchSearch) return options.fetchSearch();
			}
			if (url === "/api/models" && options.fetchModels) return options.fetchModels();
			return new Response(JSON.stringify(bodies[url]));
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	await act(async () => {
		root.render(<ServerEventsProvider connect={() => ({
			close() {},
			onOpen() {},
			onEvent(name, cb) { if (name === "subscriptions-changed") subscriptionListener = cb; },
		})}>
			<AgentSection
				agent={options.agent ?? { tools: { research: true } }}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				onSectionChange={(next) => { written = next; }}
				onModelsChange={() => {}}
				onCompactionChange={() => {}}
			/>
		</ServerEventsProvider>);
	});
	return {
		root,
		dom,
		get written() { return written; },
		publishSubscriptionChange() { subscriptionListener?.("{}"); },
		cleanup() {
			act(() => { root.unmount(); });
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete globals[key];
			}
		},
	};
}

it("keyless settings keep Research interactive while search-engine setup retains its own disabled state", async () => {
	const reason = "No search engine is configured.";
	const mounted = await mountSection({ search: { available: false, chatgptAvailable: false, engine: null, reason } });
	try {
		const row = document.querySelector<HTMLElement>('[data-testid="tool-row-research"]')!;
		const toggle = row.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
		assert.ok(toggle);
		assert.equal(toggle.hasAttribute("disabled"), false);
		assert.equal(toggle.getAttribute("aria-checked"), "true");
		assert.ok(!row.className.includes("opacity-40"));
		assert.ok(!row.textContent?.includes(reason));
		act(() => { toggle.click(); });
		assert.equal(mounted.written?.tools?.research, false);
		const engine = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(engine.className.includes("cursor-not-allowed"));
		act(() => { engine.click(); });
		assert.equal(document.querySelector('[data-testid="search-engine-menu"]'), null);
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes(reason));
	} finally { mounted.cleanup(); }
});

it("shows ChatGPT candidate readiness without a keyed provider and clears an unavailable ChatGPT pin", async () => {
	const mounted = await mountSection({
		search: { available: false, chatgptAvailable: true, engine: null, reason: "ChatGPT ready" },
		agent: { search: { engine: "chatgpt" } },
	});
	try {
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(!trigger.className.includes("cursor-not-allowed"));
		assert.ok(trigger.textContent?.includes("ChatGPT"), "stored ChatGPT pin is not displayed as Automatic");
		act(() => { trigger.click(); });
		assert.ok(document.querySelector('[data-testid="search-engine-menu"]'));
		act(() => { document.querySelector<HTMLButtonElement>('[data-testid="engine-option-auto"]')!.click(); });
		assert.equal(mounted.written?.search, undefined, "Automatic clears the unavailable explicit pin");
	} finally { mounted.cleanup(); }
});

it("waits for the existing model-catalog refresh before reading initial search readiness", async () => {
	let resolveCatalog!: (response: Response) => void;
	const catalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
	let searchRequests = 0;
	const mounted = await mountSection({
		search: { available: true, chatgptAvailable: true, engine: "chatgpt", reason: "Ready" },
		fetchModels: () => catalog,
		onSearchRequest: () => { searchRequests++; },
	});
	try {
		assert.equal(searchRequests, 0, "no stale cached-catalog status request precedes the catalog refresh");
		await act(async () => {
			resolveCatalog(new Response(JSON.stringify({ models: [], slots: { strong: null, cheap: null, vision: null } })));
			await Promise.resolve(); await Promise.resolve();
		});
		assert.equal(searchRequests, 1);
	} finally { mounted.cleanup(); }
});

it("refreshes status on subscription changes and ignores stale status responses", async () => {
	let requests = 0;
	let resolveOld!: (response: Response) => void;
	const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
	const mounted = await mountSection({
		search: { available: false, chatgptAvailable: false, engine: null, reason: "Not connected" },
		onSearchRequest: () => { requests++; },
		fetchSearch: () => requests === 1
			? oldResponse
			: Promise.resolve(new Response(JSON.stringify({ available: true, chatgptAvailable: true, engine: "chatgpt", reason: "Connected" }))),
	});
	try {
		await act(async () => { mounted.publishSubscriptionChange(); await Promise.resolve(); await Promise.resolve(); });
		assert.equal(requests, 2);
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes("Connected"));
		await act(async () => {
			resolveOld(new Response(JSON.stringify({ available: false, chatgptAvailable: false, engine: null, reason: "Old status" })));
			await Promise.resolve(); await Promise.resolve();
		});
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes("Connected"));
		assert.ok(!document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes("Old status"));
	} finally { mounted.cleanup(); }
});
