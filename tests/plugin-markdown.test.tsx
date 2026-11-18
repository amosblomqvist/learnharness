import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPluginUiStore, PluginUiHost } from "../components/plugin-ui-host.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { PluginUi } from "../src/core/plugin-ui.ts";
import { mountModelSolution } from "../plugins/coding-questions/src/solution-view.ts";
import { mountSavedQuestion } from "../plugins/coding-questions/src/question-view.ts";

async function withHost(run: (fixture: {
	ui: PluginUi;
	store: ReturnType<typeof createPluginUiStore>;
	lifetime: AbortController;
	target: HTMLElement;
}) => Promise<void>) {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div><div id='target'><span data-plugin-owned>Keep me</span></div></body></html>");
	const globals = {
		window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	const store = createPluginUiStore(), lifetime = new AbortController();
	const ui = store.createUi({ signal: lifetime.signal });
	const root = createRoot(document.querySelector("#root")!);
	try {
		await act(async () => root.render(<InteractionLayersProvider><PluginUiHost store={store} /></InteractionLayersProvider>));
		await run({ ui, store, lifetime, target: document.querySelector<HTMLElement>("#target")! });
	} finally {
		await act(async () => { lifetime.abort(); root.unmount(); });
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}

it("public Markdown mount uses host formatting, updates in place and disposes only its owned DOM", async () => withHost(async ({ ui, store, target }) => {
	const scope = new AbortController();
	let handle!: ReturnType<PluginUi["mountMarkdown"]>;
	await act(async () => { handle = ui.mountMarkdown(target, { text: "**First** and $x^2$" }, { signal: scope.signal }); });
	const widget = target.querySelector<HTMLElement>("[data-plugin-ui-widget]")!;
	assert.ok(widget.querySelector(".lh-prose"));
	assert.equal(widget.querySelector("strong")?.textContent, "First");
	assert.ok(widget.querySelector(".katex"));
	assert.equal(widget.querySelector("button"), null);
	assert.equal(widget.querySelector('[data-testid="plugin-worker-header"]'), null);
	assert.equal(target.querySelector("[data-plugin-owned]")?.textContent, "Keep me");
	await act(async () => handle.update({ text: "## Replacement\n\n[Link](https://example.invalid/)" }));
	assert.ok(target.querySelector("[data-plugin-ui-widget]") === widget, "updates preserve widget ownership");
	assert.equal(widget.querySelector("h2")?.textContent, "Replacement");
	assert.equal(widget.querySelector("strong"), null);
	assert.equal(widget.querySelector("a")?.getAttribute("href"), "https://example.invalid/");
	await act(async () => { handle.dispose(); handle.dispose(); handle.update({ text: "Too late" }); });
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(target.textContent, "Keep me");
}));

it("saved coding question immediately renders host Markdown, math and fenced code and cleans up without touching siblings", async () => withHost(async ({ ui, store, target }) => {
	const scope = new AbortController();
	const question = "Implement **square** for $x^2$.\n\n```js\nfunction square(x) {}\n```";
	let dispose!: () => void;
	await act(async () => { dispose = mountSavedQuestion(target, ui, question, scope.signal); });
	const prompt = target.querySelector(".lh-coding-prompt")!;
	assert.equal(prompt.querySelector("strong")?.textContent, "square");
	assert.ok(prompt.querySelector(".katex"));
	assert.match(prompt.querySelector("[data-streamdown='code-block-body']")!.textContent!, /function square\(x\) \{\}/);
	assert.equal(store.getSnapshot().length, 1);
	await act(async () => { scope.abort(); dispose(); dispose(); });
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(target.textContent, "Keep me");
	await act(async () => { mountSavedQuestion(target, ui, question, scope.signal)(); });
	assert.equal(store.getSnapshot().length, 0, "pre-aborted mounts never attach content");
	assert.equal(target.textContent, "Keep me");
}));

it("saved coding question removes its wrapper when the Markdown mount fails", async () => withHost(async ({ target }) => {
	assert.throws(() => mountSavedQuestion(target, { mountMarkdown() { throw new Error("fixture mount failed"); } }, "Original question", new AbortController().signal), /fixture mount failed/);
	assert.equal(target.textContent, "Keep me");
	assert.equal(target.querySelector(".lh-coding-prompt"), null);
}));

it("coding model solution lazily uses real host Markdown for fenced code and explanation, then disposes on close and abort", async () => withHost(async ({ ui, store, target }) => {
	const scope = new AbortController();
	const solution = "```js\nfunction square(x) { return x * x; }\n```\n\n**Why:** Multiply the value by itself.";
	let dispose!: () => void;
	await act(async () => { dispose = mountModelSolution(target, ui, solution, scope.signal); });
	const toggle = target.querySelector("button")!;
	assert.equal(toggle.textContent, "Model solution");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(store.getSnapshot().length, 0);
	await act(async () => { toggle.click(); });
	assert.equal(toggle.textContent, "Hide model solution");
	assert.equal(store.getSnapshot().length, 1);
	const widget = target.querySelector("[data-plugin-ui-widget]")!;
	assert.match(widget.querySelector("[data-streamdown='code-block-body']")!.textContent!, /function square\(x\) \{ return x \* x; \}/);
	assert.equal(widget.querySelector("strong")?.textContent, "Why:");
	assert.equal(widget.querySelector("[data-testid='md-copy'], [data-streamdown='code-block-actions']"), null);
	await act(async () => { toggle.click(); });
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(target.querySelector("[data-plugin-ui-widget]"), null);
	await act(async () => { toggle.click(); scope.abort(); dispose(); dispose(); });
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(target.textContent, "Keep me");
}));

for (const abort of ["mount", "lifetime"] as const) {
	it(`public Markdown ${abort} abort removes the mounted renderer and rejects later updates`, async () => withHost(async ({ ui, lifetime, store, target }) => {
		const scope = new AbortController();
		let handle!: ReturnType<PluginUi["mountMarkdown"]>;
		await act(async () => { handle = ui.mountMarkdown(target, { text: "**Present**" }, { signal: scope.signal }); });
		assert.equal(target.querySelector("strong")?.textContent, "Present");
		await act(async () => { (abort === "mount" ? scope : lifetime).abort(); handle.update({ text: "Late" }); handle.dispose(); });
		assert.equal(store.getSnapshot().length, 0);
		assert.equal(target.textContent, "Keep me");
	}));
}

it("already-aborted Markdown mounts never attach DOM or store entries", async () => withHost(async ({ ui, store, target }) => {
	const scope = new AbortController(); scope.abort();
	const handle = ui.mountMarkdown(target, { text: "Never rendered" }, { signal: scope.signal });
	handle.update({ text: "Still absent" }); handle.dispose();
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(target.textContent, "Keep me");
}));

it("independent Markdown handles can share a plugin container without disposing siblings", async () => withHost(async ({ ui, target, store }) => {
	const firstScope = new AbortController(), secondScope = new AbortController();
	await act(async () => {
		ui.mountMarkdown(target, { text: "**One**" }, { signal: firstScope.signal });
		ui.mountMarkdown(target, { text: "**Two**" }, { signal: secondScope.signal });
	});
	assert.equal(target.querySelectorAll("strong").length, 2);
	await act(async () => firstScope.abort());
	assert.equal(target.querySelector("strong")?.textContent, "Two");
	assert.equal(store.getSnapshot().length, 1);
	assert.equal(target.querySelector("[data-plugin-owned]")?.textContent, "Keep me");
	await act(async () => secondScope.abort());
	assert.equal(target.textContent, "Keep me");
}));

it("Markdown in a public dialog follows the dialog content signal, not an independent lifetime", async () => withHost(async ({ ui, store }) => {
	const scope = new AbortController();
	let mountedSignal!: AbortSignal, cleaned = 0;
	let dialog!: ReturnType<PluginUi["openDialog"]>;
	await act(async () => {
		dialog = ui.openDialog({ title: "Static content", content(container, signal) {
			mountedSignal = signal;
			const child = ui.mountMarkdown(container, { text: "**Dialog body**\n\n$$\nx^2\n$$" }, { signal });
			return () => { cleaned++; child.dispose(); };
		} }, { signal: scope.signal });
	});
	assert.equal(document.querySelector('[data-plugin-ui-dialog] strong')?.textContent, "Dialog body");
	assert.ok(document.querySelector('[data-plugin-ui-dialog] .katex-display'));
	assert.equal(document.querySelectorAll('[data-plugin-ui-dialog] .lh-prose button').length, 0);
	assert.equal(mountedSignal.aborted, false);
	await act(async () => { dialog.dispose(); dialog.dispose(); });
	assert.equal(mountedSignal.aborted, true);
	assert.equal(cleaned, 1);
	assert.equal(document.querySelector("[data-plugin-ui-dialog]"), null);
	assert.equal(store.getSnapshot().length, 0);
}));
