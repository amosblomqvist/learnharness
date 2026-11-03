import React, { act, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { parseHTML } from "linkedom";
import { PluginsProvider, createPluginWindowOwner } from "../components/plugins.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { PluginCodeBlock, ToolPartRenderer, reservedToolRendererNames } from "../components/plugin-renderers.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { PluginWorkerCard } from "../components/artifacts/plugin-worker-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { ActivitySection, type ActivityFeed } from "../components/activity-dock.tsx";
import type { PluginBackgroundResult } from "../src/core/index.ts";
import { SessionModel } from "../components/session-core.ts";
import { buildSubagentSteer, projectView, type LhMessage, type LhViewPart, type PluginCleanup, type PluginCodeBlockProps, type PluginFrontendContext, type PluginFrontendModule, type PluginInfo, type PluginToolRenderProps } from "../src/core/index.ts";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}
const packageInfo: PluginInfo = { id: "render-proof", enabled: true, status: "active", revision: "fixture-1", manifest: {
	apiVersion: 1, id: "render-proof", name: "Renderer proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
} };

/** Real provider + React effects, but no network, user files, or provider calls. */
async function harness(frontend: PluginFrontendModule, { reserved = true } = {}) {
	const dom = parseHTML("<html><head></head><body><div id='test-root'></div></body></html>");
	const keys = ["window", "self", "document", "HTMLElement", "Element", "Node", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, {
		window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
		Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	window.__lhPluginWindow = createPluginWindowOwner({
		reservedCodeBlockLanguages: reserved ? ["mermaid"] : [], reservedToolNames: reserved ? reservedToolRendererNames() : [],
		fetch: async () => Response.json({ plugins: [packageInfo], directory: "/fixture/plugins" }),
		importModule: async () => frontend, pathname: () => "/", navigate() {},
	});
	const owner = window.__lhPluginWindow;
	const root = createRoot(document.querySelector("#test-root")!);
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	return {
		dom, manager: owner.manager,
		async render(children: ReactNode) {
			await act(async () => { root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/"><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></PathnameContext.Provider></AppRouterContext.Provider>); });
		},
		async close() {
			try {
				await act(async () => { root.unmount(); });
				await owner.manager.dispose();
			} finally {
				for (const key of keys) {
					const descriptor = saved.get(key);
					if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
				}
			}
		},
	};
}
function nativePart(overrides: Partial<LhViewPart> = {}): LhViewPart {
	return { type: "tool-custom_tool", toolCallId: "call-1", state: "output-available", input: { subject: "fixture" }, ...overrides };
}

describe("shared Markdown renderer dispatch", () => {
	it("MessageResponse fences pass source/meta/incomplete, and updates get fresh aborted mount signals", async () => {
		const props: PluginCodeBlockProps[] = [];
		let cleaned = 0;
		const h = await harness({ activate(ctx) { ctx.registerCodeBlock({ language: "lesson", mount(container, block) {
			props.push(block); container.textContent = `Plugin lesson: ${block.source}`;
			return () => { cleaned++; };
		} }); } });
		try {
			await h.render(<MessageResponse>{"```lesson title=proof\nfirst source\n```"}</MessageResponse>);
			assert.equal(props.length, 1); assert.equal(props[0]!.language, "lesson");
			assert.equal(props[0]!.source.trim(), "first source"); assert.match(props[0]!.meta, /title=proof/);
			assert.equal(props[0]!.incomplete, false); assert.equal(props[0]!.signal.aborted, false);
			assert.ok(document.body.textContent?.includes("Plugin lesson: first source"));
			await h.render(<MessageResponse isAnimating>{"```lesson title=updated\nstreaming source"}</MessageResponse>);
			assert.equal(props.length, 2); assert.equal(props[0]!.signal.aborted, true); assert.equal(cleaned, 1);
			assert.equal(props[1]!.source.trim(), "streaming source"); assert.match(props[1]!.meta, /title=updated/);
			assert.equal(props[1]!.incomplete, true); assert.equal(props[1]!.signal.aborted, false);
			await h.render(<div>Another surface</div>);
			assert.equal(props[1]!.signal.aborted, true); assert.equal(cleaned, 2);
		} finally { await h.close(); }
	});

	it("unknown/uninstalled fences retain ordinary code and inline code is never intercepted", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"Inline `lesson`\n\n```not_installed\nreadable raw source\n```"}</MessageResponse>);
		assert.ok(html.includes('data-streamdown="inline-code"'));
		assert.ok(html.includes('data-testid="md-code"')); assert.ok(html.includes("readable raw source"));
	});

	it("failed async code mounts expose their error and readable raw fallback", async () => {
		const h = await harness({ activate(ctx) { ctx.registerCodeBlock({ language: "broken", async mount() { throw new Error("code renderer exploded"); } }); } });
		try {
			await h.render(<MessageResponse>{"```broken\nraw recovery source\n```"}</MessageResponse>);
			assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("code renderer exploded"));
			assert.ok(document.querySelector('[data-testid="md-code"]')?.textContent?.includes("raw recovery source"));
			assert.match(h.manager.getSnapshot().plugins[0]!.error!, /code renderer exploded/);
		} finally { await h.close(); }
	});

	it("update/disable abort old mounts, and late async cleanup only touches its private DOM", async () => {
		const finishOldMount = deferred<PluginCleanup>(), finishCleanup = deferred<void>();
		const blocks: PluginCodeBlockProps[] = [];
		let cleaned = 0;
		let oldContainer!: HTMLElement;
		const h = await harness({ activate(ctx) { ctx.registerCodeBlock({ language: "lesson", mount(container, block) {
			blocks.push(block); container.textContent = `rendered ${block.source}`;
			if (block.source === "old") oldContainer = container;
			if (block.source === "old") return finishOldMount.promise;
			return () => { cleaned++; };
		} }); } });
		const render = (source: string) => h.render(<PluginCodeBlock language="lesson" source={source} meta="" incomplete={false} fallback={<pre>raw {source}</pre>} />);
		try {
			await render("old"); await render("new");
			assert.equal(blocks[0]!.signal.aborted, true); assert.equal(blocks[1]!.signal.aborted, false);
			await act(async () => { finishOldMount.resolve(async () => { await finishCleanup.promise; oldContainer.replaceChildren(); }); });
			assert.ok(document.body.textContent?.includes("rendered new"));
			await act(async () => { finishCleanup.resolve(); });
			assert.ok(document.body.textContent?.includes("rendered new"), "a late orphan cleanup cannot clear the replacement's DOM");
			await act(async () => { h.manager.reconcile([{ ...packageInfo, enabled: false, status: "disabled" }]); });
			assert.equal(blocks[1]!.signal.aborted, true); assert.equal(cleaned, 1);
			assert.equal(document.querySelector("[data-plugin-renderer]"), null); assert.ok(document.body.textContent?.includes("raw new"));
			finishCleanup.resolve();
		} finally { finishOldMount.resolve(() => {}); finishCleanup.resolve(); await h.close(); }
	});

	it("unregistering a fence renderer aborts its current mount and immediately restores fallback", async () => {
		let unregister!: () => void, signal!: AbortSignal;
		const h = await harness({ activate(ctx) { unregister = ctx.registerCodeBlock({ language: "lesson", mount(container, props) { signal = props.signal; container.textContent = "custom"; } }); } });
		try {
			await h.render(<PluginCodeBlock language="lesson" source="raw" meta="" incomplete={false} fallback={<pre>raw fallback</pre>} />);
			await act(async () => { unregister(); assert.equal(signal.aborted, true); });
			assert.ok(document.body.textContent?.includes("raw fallback"));
		} finally { await h.close(); }
	});
});

describe("native tool renderer dispatch", () => {
	it("passes all four native states, call identity/input/details/error/result, and cancels on every update", async () => {
		const seen: PluginToolRenderProps[] = [];
		const h = await harness({ activate(ctx) { ctx.registerToolRenderer({ toolName: "custom_tool", mount(container, props) { seen.push(props); container.textContent = `custom ${props.state}`; } }); } });
		const input = { subject: "native" }, output = { answer: 42 };
		const content = [{ type: "text" as const, text: "native result text" }];
		try {
			for (const state of ["input-streaming", "input-available", "output-available", "output-error"] as const) {
				await h.render(<ToolPartRenderer part={nativePart({ input, state, ...(state.startsWith("output-") ? { output, result: { content, details: output, isError: state === "output-error" } } : {}), ...(state === "output-error" ? { errorText: "native failure" } : {}) })} />);
				const props = seen.at(-1)!;
				assert.equal(props.toolName, "custom_tool"); assert.equal(props.toolCallId, "call-1"); assert.equal(props.input, input);
				assert.equal(props.state, state); assert.equal(props.signal.aborted, false);
				if (state.startsWith("output-")) { assert.equal(props.output, output); assert.equal(props.result?.content, content); assert.equal(props.result?.details, output); }
				else assert.equal(props.result, undefined);
			}
			assert.equal(seen.length, 4); assert.equal(seen[3]!.errorText, "native failure"); assert.equal(seen[3]!.result?.isError, true);
			assert.equal(seen.slice(0, 3).every(props => props.signal.aborted), true);
			await h.render(<div />); assert.equal(seen[3]!.signal.aborted, true);
		} finally { await h.close(); }
	});

	it("unknown tools retain the existing expandable card and native text/images when details are absent", () => {
		const html = renderToStaticMarkup(<ToolPartRenderer part={nativePart({ result: { content: [{ type: "text", text: "native answer without details" }, { type: "image", data: "NEVER_RENDER_IMAGE_BYTES", mimeType: "image/png" }], details: undefined, isError: false } })} />);
		assert.ok(html.includes('data-testid="tool-call-card"')); assert.ok(html.includes("custom_tool"));
		assert.ok(html.includes("native answer without details")); assert.ok(html.includes("Image attached to the model: image/png"));
		assert.ok(!html.includes("NEVER_RENDER_IMAGE_BYTES"));
		const details = renderToStaticMarkup(<ToolPartRenderer part={nativePart({ output: { structured: "details remain readable" } })} />);
		assert.ok(details.includes("details remain readable"));
	});

	it("tool renderer failures never hide the native result, and disable restores that fallback", async () => {
		let ctx!: PluginFrontendContext;
		const h = await harness({ activate(context) { ctx = context; ctx.registerToolRenderer({ toolName: "custom_tool", mount() { throw new Error("tool renderer exploded"); } }); } });
		try {
			await h.render(<ToolPartRenderer part={nativePart({ result: { content: [{ type: "text", text: "readable native fallback" }], details: undefined, isError: false } })} />);
			assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("tool renderer exploded"));
			assert.ok(document.querySelector('[data-testid="tool-call-card"]')?.textContent?.includes("readable native fallback"));
			await act(async () => { h.manager.reconcile([{ ...packageInfo, enabled: false, status: "disabled" }]); });
			assert.equal(ctx.signal.aborted, true); assert.ok(document.body.textContent?.includes("readable native fallback"));
		} finally { await h.close(); }
	});

	it("reserves only real built-in presentation and keeps those cards/hidden plans authoritative", async () => {
		const names = reservedToolRendererNames();
		for (const name of ["read", "research", "quiz", "probe", "problem", "conclude", "plan_init"]) assert.ok(names.includes(name), name);
		for (const name of ["web_search", "web_fetch", "pdf_info", "pdf_extract", "write_svg"]) assert.ok(!names.includes(name), name);
		let pluginMounts = 0;
		const h = await harness({ activate(ctx) {
			ctx.registerCodeBlock({ language: "mermaid", mount() { pluginMounts++; } });
			ctx.registerToolRenderer({ toolName: "read", mount() { pluginMounts++; } });
		} }, { reserved: false });
		try {
			await h.render(<><MessageResponse isAnimating>{"```mermaid\ngraph TD\nA-->B"}</MessageResponse><ToolPartRenderer part={{ type: "tool-read", toolCallId: "read-1", state: "output-available", input: { path: "fixture.txt" }, output: "builtin output" }} /><ToolPartRenderer part={{ type: "tool-plan_init", toolCallId: "plan-1", state: "output-available", output: { ok: true } }} /></>);
			assert.equal(pluginMounts, 0); assert.ok(document.querySelector('[data-testid="md-mermaid"]'));
			assert.ok(document.querySelector('[data-testid="tool-call-card"][data-tool="read"]'));
			assert.equal(document.querySelector('[data-tool="plan_init"]'), null);
		} finally { await h.close(); }
	});

	it("ordinary host tools without dedicated presentation can acquire plugin renderers", async () => {
		let mounted = false;
		const h = await harness({ activate(ctx) { ctx.registerToolRenderer({ toolName: "web_search", mount(container) { mounted = true; container.textContent = "custom search display"; } }); } });
		try {
			await h.render(<ToolPartRenderer part={nativePart({ type: "tool-web_search" })} />);
			assert.equal(mounted, true); assert.ok(document.body.textContent?.includes("custom search display"));
		} finally { await h.close(); }
	});
});

describe("plugin background result rendering", () => {
	const result: PluginBackgroundResult = { pluginId: "worker-plugin", toolName: "custom_tool", input: { subject: "accepted input" }, text: "Persisted fallback text", outcome: { id: "task-1", status: "succeeded", result: { raw: "persisted raw outcome" } } };

	it("uses an independent presentation plugin for both phases, forwarding producer metadata/falsy data without changing the ack", async () => {
		const seen: PluginToolRenderProps[] = [];
		const h = await harness({ activate(ctx) { ctx.registerToolRenderer({ toolName: "custom_tool", mount(container, props) { seen.push(props); container.textContent = "custom task result"; } }); } });
		const ack = nativePart({ input: result.input, output: "accepted; continue teaching", result: { content: [{ type: "text", text: "accepted; continue teaching" }], isError: false } });
		try {
			await h.render(<ToolPartRenderer part={ack} />);
			assert.equal(seen[0]!.background, undefined); assert.ok(seen[0]!.result);
			for (const data of [null, false, 0, ""]) {
				const marker = buildSubagentSteer({ id: "plugin-job", kind: "plugin", toolCallId: "original-call" }, { ...result, data });
				await h.render(<SubagentSteerCard message={projectView([marker])[0]!} />);
				const props = seen.at(-1)!;
				assert.equal(props.output, data); assert.equal(props.state, "output-available");
				assert.equal(props.input, result.input); assert.equal(props.toolCallId, "original-call");
				assert.deepEqual(props.background, { pluginId: result.pluginId, taskId: "task-1", status: "succeeded" });
				assert.equal(Object.hasOwn(props, "result"), false);
			}
			for (const status of ["failed", "cancelled", "interrupted"] as const) {
				const outcome = { id: "task-1", status, error: { code: "run_error" as const, message: "worker did not finish" } };
				await h.render(<PluginWorkerCard result={{ ...result, outcome }} toolCallId="original-call" />);
				const props = seen.at(-1)!;
				assert.equal(props.state, "output-error"); assert.equal(props.output, outcome);
				assert.equal(props.errorText, outcome.error.message); assert.equal(props.background?.status, status);
				assert.equal(Object.hasOwn(props, "result"), false);
			}
			assert.equal(ack.output, "accepted; continue teaching"); assert.equal(ack.result?.content[0]?.type, "text");
			assert.ok(seen.slice(0, -1).every(props => props.signal.aborted));
		} finally { await h.close(); }
	});

	it("keeps host header/format errors outside custom presentation and restores persisted fallback on failure/disable", async () => {
		let mounts = 0;
		const h = await harness({ activate(ctx) { ctx.registerToolRenderer({ toolName: "custom_tool", mount(container, props) {
			mounts++;
			if ((props.input as { broken?: boolean }).broken) throw new Error("background renderer failed");
			container.textContent = "custom task result";
		} }); } });
		try {
			await h.render(<PluginWorkerCard result={{ ...result, formatError: "formatter unavailable" }} toolCallId="original-call" />);
			assert.match(document.querySelector('[data-testid="plugin-worker-header"]')!.textContent!, /custom_tool succeeded/);
			assert.match(document.querySelector('[role="alert"]')!.textContent!, /formatter unavailable/);
			assert.ok(document.body.textContent?.includes("custom task result"));
			assert.equal(document.querySelector('[data-testid="plugin-worker-fallback"]'), null);
			assert.ok(!document.body.textContent?.includes("Persisted fallback text"));
			assert.ok(!document.body.textContent?.includes("persisted raw outcome"));
			await h.render(<PluginWorkerCard result={{ ...result, input: { broken: true } }} toolCallId="original-call" />);
			assert.ok(document.body.textContent?.includes("background renderer failed"));
			assert.ok(document.querySelector('[data-testid="plugin-worker-fallback"]')?.textContent?.includes("persisted raw outcome"));
			await h.render(<PluginWorkerCard result={{ ...result, pluginId: "uninstalled-plugin" }} toolCallId="original-call" />);
			assert.equal(mounts, 3, "the global tool-name renderer remains usable even when its producer is uninstalled");
			assert.ok(document.body.textContent?.includes("custom task result"));
			assert.equal(document.querySelector('[data-testid="plugin-worker-fallback"]'), null);
			await act(async () => { h.manager.reconcile([{ ...packageInfo, enabled: false, status: "disabled" }]); });
			await h.render(<PluginWorkerCard result={result} toolCallId="original-call" />);
			assert.ok(document.body.textContent?.includes("Persisted fallback text"));
			assert.ok(document.body.textContent?.includes("persisted raw outcome"));
		} finally { await h.close(); }
	});

	it("plugin worker END uses the existing generic job abort endpoint", async () => {
		const h = await harness({ activate() {} });
		const savedFetch = globalThis.fetch;
		const calls: { url: string; body: unknown }[] = [];
		globalThis.fetch = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(String(options?.body)) }); return new Response(null, { status: 204 }); };
		const feed: ActivityFeed = { jobs: [{ id: "plugin-job", kind: "plugin", chatId: "session-1", toolCallId: "original-call", status: "running", activity: "reading", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), title: "Session title", contextLimit: null, plugin: { pluginId: packageInfo.id, toolName: "custom_tool", workerId: "worker-1", requestId: "request-1", label: "Source checker" } }], extractions: [] };
		try {
			await h.render(<ActivitySection feed={feed} />);
			assert.ok(document.body.textContent?.includes("Source checker"));
			const button = document.querySelector('[data-testid="activity-abort"]')!;
			assert.equal(button.getAttribute("aria-label"), "End Plugin worker in Source checker");
			await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
			assert.deepEqual(calls, [{ url: "/api/activity/abort", body: { kind: "job", id: "plugin-job" } }]);
		} finally { globalThis.fetch = savedFetch; await h.close(); }
	});
});

describe("native session result retention", () => {
	it("both live executions and restored history carry native content/details/isError to renderer parts", async () => {
		const assistant = { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "custom_tool", arguments: { subject: "native" } }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage;
		const content = [{ type: "text" as const, text: "content survives without details" }];
		for (const isError of [false, true]) {
			const model = new SessionModel({ chatId: "fixture", initialMessages: [assistant] });
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
			const consume = model.consumeStream(new Response(stream));
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "custom_tool", result: { content }, isError })}\n\n`));
			await tick();
			const live = model.getState().messages.flatMap(message => message.parts).find(part => part.toolCallId === "call-1")!;
			assert.deepEqual(live.result, { content, details: undefined, isError });
			assert.equal(live.state, isError ? "output-error" : "output-available");
			controller.close(); await consume;
			const restored = projectView([assistant, { id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "custom_tool", content, isError, timestamp: 2 } as LhMessage]).flatMap(message => message.parts).find(part => part.toolCallId === "call-1")!;
			assert.deepEqual(restored.result, live.result);
		}
	});
});
