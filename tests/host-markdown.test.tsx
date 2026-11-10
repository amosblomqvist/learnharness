import React, { act, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import mermaid from "mermaid";
import { code, type HighlightResult } from "@streamdown/code";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { HostMarkdown } from "../components/host-markdown.tsx";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { MermaidError } from "../components/mermaid-error.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginsProvider, createPluginWindowOwner } from "../components/plugins.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { SessionMermaidContext } from "../components/session-overlay.tsx";
import type { PluginFrontendModule, PluginInfo } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

const source = "## Heading **ink**\n\nFirst line\nsecond line with `inline` and *emphasis*.\n\n> [!IMPORTANT]\n> Preserve this idea.\n\n| A | B |\n| --- | --- |\n| one | two |\n\n$x^2$ and \\(y^2\\).\n\n$$\n\\int_0^1 x^2\\,dx = \\tfrac13\n$$\n\n```js startLine=4\nconst answer = 42;\n```\n\n![Alt text](https://example.invalid/image.png \"Image title\")\n\n[Ordinary link](https://example.invalid/page)";
const noControls = (container: ParentNode) => {
	assert.equal(container.querySelector("button, details, summary, input, select, textarea, [role='button'], [data-streamdown='link-safety-modal']"), null, "display-only means controls never mount, not CSS-hidden controls");
	assert.equal(container.querySelector("[data-testid='md-copy'], [data-testid='md-mermaid-expand'], [data-plugin-renderer], [data-streamdown='code-block-actions']"), null);
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function highlighted(content: string): HighlightResult {
	return { tokens: [[{ content, offset: 0, color: "#aabbcc" }]], fg: "#eeeeee", bg: "#111111" };
}
const plugin: PluginInfo = { id: "static-markdown-proof", origin: "community", enabled: true, status: "active", revision: "fixture-1", manifest: {
	apiVersion: 1, id: "static-markdown-proof", name: "Static Markdown proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
} };

async function fixture(frontend?: PluginFrontendModule) {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	const globals = {
		window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
		HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	const errors: string[] = [], originalError = console.error;
	console.error = (...args) => { errors.push(args.map(String).join(" ")); };
	const root = createRoot(document.querySelector("#root")!);
	const owner = frontend ? createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [plugin], directory: "/fixture/plugins" }),
		importModule: async () => frontend, pathname: () => "/", navigate() {},
	}) : null;
	if (owner) window.__lhPluginWindow = owner;
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = (): NotifySource => ({ close() {}, onOpen() {}, onEvent() {} });
	return {
		async render(children: ReactNode) {
			await act(async () => root.render(<InteractionLayersProvider>{owner
				? <AppRouterContext.Provider value={router}><PathnameContext.Provider value="/"><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></PathnameContext.Provider></AppRouterContext.Provider>
				: children}</InteractionLayersProvider>));
		},
		async close() {
			try { await act(async () => root.unmount()); await owner?.manager.dispose(); }
			finally {
				restoreModal();
				for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
				console.error = originalError;
				assert.deepEqual(errors, [], "render/update/dispose causes no console errors or stale updates");
			}
		},
	};
}

it("SSRs the real host message pipeline with prose, math, code, callouts, tables and blocked Markdown images, without controls", () => {
	assert.equal(typeof window, "undefined"); assert.equal(typeof document, "undefined");
	const html = renderToStaticMarkup(<HostMarkdown text={source} />);
	const { document: doc } = parseHTML(`<html><body>${html}</body></html>`);
	assert.ok(doc.querySelector(".lh-prose")); assert.equal(doc.querySelector("h2 strong")?.textContent, "ink");
	assert.equal(doc.querySelector("em")?.textContent, "emphasis"); assert.ok(doc.querySelector("br"));
	assert.equal(doc.querySelector("[data-streamdown='inline-code']")?.textContent, "inline");
	assert.equal(doc.querySelector("[data-testid='md-callout']")?.getAttribute("data-alert-kind"), "important");
	assert.ok(!doc.body.textContent?.includes("[!IMPORTANT]")); assert.equal(doc.querySelectorAll("table td").length, 2);
	assert.equal(doc.querySelectorAll(".katex").length, 3); assert.ok(doc.querySelector(".katex-display")); assert.equal(doc.querySelector(".katex-error"), null);
	const block = doc.querySelector("[data-streamdown='code-block-body']")!;
	assert.ok(block.textContent?.includes("const answer = 42;")); assert.match(block.innerHTML, /counter-reset:line 3/);
	assert.equal(doc.querySelector("img, link[rel='preload'][as='image']"), null);
	assert.ok(doc.body.textContent?.includes("[Image blocked: Alt text]"));
	assert.ok(!html.includes("https://example.invalid/image.png"));
	const link = doc.querySelector("a")!; assert.equal(link.getAttribute("href"), "https://example.invalid/page");
	assert.equal(link.getAttribute("target"), "_blank"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
	noControls(doc);
});

it("shares raw-HTML sanitization and URL hardening with MessageResponse, rather than using a second parser", () => {
	const text = '<div>Safe <strong>HTML</strong>.</div>\n\n<script>alert("bad")</script>\n<iframe src="https://example.invalid"></iframe>\n<img src="javascript:bad()" onerror="bad()">\n\n[Unsafe](javascript:bad())';
	const render = (node: ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
	const host = render(<HostMarkdown text={text} />), transcript = render(<MessageResponse mode="static" controls={false} linkSafety={{ enabled: false }}>{text}</MessageResponse>);
	for (const doc of [host, transcript]) {
		assert.equal(doc.querySelector("script, iframe, [onerror], [onclick]"), null);
		assert.equal(doc.querySelector("[src^='javascript:'], [href^='javascript:']"), null);
		assert.ok(doc.body.textContent?.includes("Safe HTML."));
	}
	assert.equal(host.body.textContent, transcript.body.textContent);
	assert.deepEqual([...host.querySelectorAll("a")].map(a => a.getAttribute("href")), [...transcript.querySelectorAll("a")].map(a => a.getAttribute("href")));
	noControls(host);
});

it("does not make ordinary transcript/static MessageResponse controls display-only", () => {
	const html = renderToStaticMarkup(<><section id="host"><HostMarkdown text={source} /></section><section id="chat"><MessageResponse mode="static">{source}</MessageResponse></section></>);
	const doc = parseHTML(`<html><body>${html}</body></html>`).document;
	noControls(doc.querySelector("#host")!);
	for (const label of ["Copy code", "Copy table", "Copy equation source"]) assert.ok(doc.querySelector(`#chat button[aria-label='${label}']`));
});

it("keeps invalid Mermaid heading/message and source visible with no disclosure or retry", () => {
	const html = renderToStaticMarkup(<MermaidError displayOnly chart={"invalid <chart>\nA --> B"} error="Parse error on line 1" retry={() => assert.fail("static errors never retry")} />);
	const doc = parseHTML(`<html><body>${html}</body></html>`).document;
	assert.ok(doc.body.textContent?.includes("Diagram failed to render")); assert.ok(doc.body.textContent?.includes("Parse error on line 1"));
	assert.equal(doc.querySelector("pre")?.textContent, "invalid <chart>\nA --> B"); assert.equal(doc.querySelector("chart"), null);
	noControls(doc);
	const interactive = renderToStaticMarkup(<MermaidError chart="broken" error="bad" retry={() => {}} />);
	assert.match(interactive, /<details/); assert.match(interactive, /Show diagram source/); assert.match(interactive, />Retry</);
});

it("blocks remote, same-origin and relative Markdown images before mounting any image or preload", async () => {
	const f = await fixture();
	try {
		for (const url of ["https://example.invalid/one.png", "http://localhost/image.png", "/image.png", "./image.png", "//example.invalid/image.png"]) {
			await f.render(<HostMarkdown text={`![Markdown](${url})\n\n<img src="${url}" alt="Dimensioned" width="80" height="60">`} />);
			assert.equal(document.querySelector("img, link[rel='preload'][as='image']"), null, url);
			assert.ok(document.body.textContent?.includes("[Image blocked: Markdown]"), url);
			assert.ok(document.body.textContent?.includes("[Image blocked: Dimensioned]"), url);
			assert.equal(document.querySelector("[data-streamdown='image-fallback']"), null);
			noControls(document);
		}
	} finally { await f.close(); }
});

it("ordinary links keep native click behavior without mounting confirmation UI", async () => {
	const f = await fixture();
	try {
		await f.render(<HostMarkdown text="[Ordinary destination](https://example.invalid/page)" />);
		const link = document.querySelector("a")!;
		const click = new window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => link.dispatchEvent(click));
		assert.equal(click.defaultPrevented, false, "the static renderer does not take over link navigation");
		assert.equal(document.querySelector("[role='dialog'], [data-streamdown='link-safety-modal']"), null);
		noControls(document);
	} finally { await f.close(); }
});

it("static and interactive instances isolate registered code renderers, controls, updates and plugin cleanup", async () => {
	let mounted = 0, cleaned = 0;
	const f = await fixture({ activate(ctx) { ctx.registerCodeBlock({ language: "lesson", mount(container) { mounted++; container.textContent = "Interactive custom lesson"; return () => { cleaned++; }; } }); } });
	const tree = (text: string) => <><section id="host"><HostMarkdown text={text} /></section><section id="chat"><MessageResponse mode="static">{"```lesson\nchat source\n```"}</MessageResponse></section></>;
	try {
		await f.render(tree("```lesson\nhost raw source\n```"));
		assert.equal(mounted, 1); assert.ok(document.querySelector("#chat [data-plugin-renderer]"));
		assert.ok(document.querySelector("#host [data-streamdown='code-block-body']")?.textContent?.includes("host raw source")); noControls(document.querySelector("#host")!);
		await f.render(tree("```lesson\nreplacement raw source\n```"));
		assert.equal(mounted, 1); assert.equal(cleaned, 0, "a static snapshot update does not remount or revoke its interactive sibling");
		assert.ok(document.querySelector("#host")?.textContent?.includes("replacement raw source")); noControls(document.querySelector("#host")!);
		await f.render(<MessageResponse mode="static">{"```js\nordinary transcript code\n```"}</MessageResponse>);
		assert.equal(cleaned, 1); assert.ok(document.querySelector("button[aria-label='Copy code']"));
	} finally { await f.close(); }
});

it("static Mermaid uses the shared renderer, suppresses overlay/copy controls and shows invalid source without retry", async t => {
	t.mock.method(mermaid, "initialize", () => {});
	t.mock.method(mermaid, "render", async (_id: string, chart: string) => {
		if (chart.includes("invalid")) throw new Error("Parse error: invalid source");
		return { svg: '<svg viewBox="0 0 160 80"><text>Shared chart</text></svg>', diagramType: "flowchart-v2" };
	});
	const f = await fixture(); const expanded: string[] = [];
	const tree = (text: string) => <SessionMermaidContext.Provider value={{ openMermaid: chart => { expanded.push(chart); }, openFigure() {} }}><section id="host"><HostMarkdown text={text} /></section><section id="chat"><MessageResponse mode="static">{"```mermaid\ngraph TD\nA --> B\n```"}</MessageResponse></section></SessionMermaidContext.Provider>;
	try {
		await f.render(tree("```mermaid\ngraph TD\nA --> B\n```"));
		assert.equal(document.querySelector("#host svg text")?.textContent, "Shared chart"); noControls(document.querySelector("#host")!);
		assert.ok(document.querySelector("#chat [data-testid='md-mermaid-expand']")); assert.ok(document.querySelector("#chat [aria-label='Copy diagram source']"));
		assert.deepEqual(expanded, []);
		await f.render(tree("```mermaid\ninvalid <diagram>\n```"));
		const host = document.querySelector("#host")!;
		assert.ok(host.querySelector("[data-streamdown='mermaid-error']")); assert.ok(host.textContent?.includes("Parse error: invalid source"));
		assert.equal(host.querySelector("pre")?.textContent, "invalid <diagram>\n"); noControls(host);
	} finally { await f.close(); }
});

it("late diagram results cannot promote after a complete-text update or disposal", async t => {
	t.mock.method(mermaid, "initialize", () => {});
	type Result = Awaited<ReturnType<typeof mermaid.render>>;
	const old = deferred<Result>(), disposed = deferred<Result>();
	t.mock.method(mermaid, "render", async (_id: string, chart: string) => chart.includes("old") ? old.promise : chart.includes("disposed") ? disposed.promise : { svg: '<svg viewBox="0 0 160 80"><text>Current chart</text></svg>', diagramType: "flowchart-v2" });
	const f = await fixture();
	try {
		await f.render(<HostMarkdown text={"```mermaid\ngraph TD\nold --> result\n```"} />);
		assert.ok(document.querySelector("[aria-busy='true']"));
		await f.render(<HostMarkdown text={"```mermaid\ngraph TD\ncurrent --> result\n```"} />);
		assert.equal(document.querySelector("svg text")?.textContent, "Current chart");
		await act(async () => old.resolve({ svg: '<svg><text>Stale chart</text></svg>', diagramType: "flowchart-v2" }));
		assert.equal(document.querySelector("svg text")?.textContent, "Current chart"); assert.ok(!document.body.textContent?.includes("Stale chart"));
		await f.render(<HostMarkdown text={"```mermaid\ngraph TD\ndisposed --> result\n```"} />);
		await f.render(<p>Unmounted</p>);
		await act(async () => disposed.resolve({ svg: '<svg><text>Disposed chart</text></svg>', diagramType: "flowchart-v2" }));
		assert.equal(document.querySelector("#root")?.textContent, "Unmounted"); noControls(document);
	} finally { old.resolve({ svg: "", diagramType: "flowchart-v2" }); disposed.resolve({ svg: "", diagramType: "flowchart-v2" }); await f.close(); }
});

it("shared asynchronous highlighting paints current tokens, never callbacks from retired snapshots", async t => {
	const callbacks = new Map<string, (result: HighlightResult) => void>();
	t.mock.method(code, "highlight", (options: Parameters<typeof code.highlight>[0], callback?: (result: HighlightResult) => void) => { if (callback) callbacks.set(options.code, callback); return null; });
	const f = await fixture();
	try {
		await f.render(<HostMarkdown text={"```js\nold_code\n```"} />);
		assert.ok(callbacks.has("old_code"), "the actual CodeBlock loads the shared code plugin");
		await f.render(<HostMarkdown text={"```js\nnew_code\n```"} />);
		assert.ok(callbacks.has("new_code"));
		await act(async () => callbacks.get("new_code")!(highlighted("Highlighted current source")));
		assert.ok(document.querySelector("[data-streamdown='code-block-body']")?.textContent?.includes("Highlighted current source"));
		await act(async () => callbacks.get("old_code")!(highlighted("Stale highlighted source")));
		assert.ok(!document.body.textContent?.includes("Stale highlighted source"));
		await f.render(<p>Disposed</p>);
		await act(async () => callbacks.get("new_code")!(highlighted("Late disposed source")));
		assert.equal(document.querySelector("#root")?.textContent, "Disposed"); noControls(document);
	} finally { await f.close(); }
});
