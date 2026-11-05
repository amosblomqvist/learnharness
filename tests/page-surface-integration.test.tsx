import React, { act, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Home } from "../components/home.tsx";
import { DraftShell, NewSession } from "../components/new-session.tsx";
import { PluginViewScreen } from "../components/plugin-view.tsx";
import { PluginWidgets } from "../components/plugins.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { findCurrentSurfaceBoundary, findSurfaceBoundary } from "../components/plugin-surface-targets.ts";
import type { PluginUi, PluginWidgetHandle, PluginSurfaceProps } from "../src/core/plugin-ui.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";
import { renderWithInteractionLayers } from "./interaction-layer-render.tsx";
import { parseHTML } from "linkedom";

const draft = <DraftShell busy={false} text="Preserved draft" onChange={() => {}} onSend={() => {}} />;
type Page = { name: string; path: string; node: ReactNode; floating: boolean; content: string };
const pages: Page[] = [
	{ name: "Home graph", path: "/", node: <Home initialConfigured rendering />, floating: true, content: '[data-testid="home-mode-switch"]' },
	{ name: "Home chains", path: "/", node: <Home initialConfigured rendering={false} />, floating: true, content: '[data-testid="open-chain-table"]' },
	{ name: "New draft", path: "/chat/new", node: draft, floating: true, content: '[data-testid="composer"]' },
	{ name: "Plugin view", path: "/plugins/fixture/overview", node: <PluginViewScreen pluginId="fixture" viewId="overview" />, floating: false, content: '[data-page-plugin-input]' },
	{ name: "Unavailable plugin view", path: "/plugins/fixture/missing", node: <PluginViewScreen pluginId="fixture" viewId="missing" />, floating: false, content: 'a[href="/"]' },
];

/** Real page components and real surface host; only browser geometry/fetch are
 * synthetic. No application directory, model, audio or graph IO is performed. */
async function withPage(page: Page, run: (f: {
	document: Document;
	controller: InteractionLayersController;
	ui: PluginUi;
	activationSignal: AbortSignal;
	viewCleanups: number;
	registerView(): Promise<void>;
	unregisterView(): Promise<void>;
	render(path?: string, hidden?: boolean): Promise<void>;
	open(): Promise<PluginWidgetHandle<PluginSurfaceProps>>;
}) => Promise<void>) {
	let ui!: PluginUi;
	let controller!: InteractionLayersController;
	let activationSignal!: AbortSignal;
	let registerView!: () => void;
	let unregisterView!: () => void;
	let viewCleanups = 0;
	function Capture() { controller = useInteractionLayers(); return null; }
	const wrap = (path = page.path, hidden = false) => <PathnameContext.Provider value={path}><SettingsDialogProvider>
		<Capture /><aside data-page-sidebar=""><button>Fixture sidebar</button></aside>
		<main data-page-main="" className="relative isolate"><React.Activity mode={hidden ? "hidden" : "visible"}>{page.node}</React.Activity></main>
		<PluginWidgets />
	</SettingsDialogProvider></PathnameContext.Provider>;
	const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class {
		observe() {} unobserve() {} disconnect() {}
	} });
	try {
	const f = await mountPluginChrome({ activate(ctx) {
		ui = ctx.ui;
		activationSignal = ctx.signal;
		registerView = () => {
			unregisterView = ctx.registerView({ id: "overview", name: "Fixture overview", mount(container) {
				const input = container.ownerDocument.createElement("input"); input.dataset.pagePluginInput = ""; input.value = "Uncontrolled page draft"; container.append(input);
				input.focus();
				return () => { viewCleanups++; };
			} });
		};
		registerView();
	} }, wrap());
	try {
		await run({ document: f.document as unknown as Document, get controller() { return controller; }, get ui() { return ui; },
			get activationSignal() { return activationSignal; }, get viewCleanups() { return viewCleanups; },
			registerView: async () => { await act(async () => { registerView(); }); },
			unregisterView: async () => { await act(async () => { unregisterView(); }); },
			render: async (path, hidden) => { await f.render(wrap(path, hidden)); },
			open: async () => {
				const boundary = findCurrentSurfaceBoundary(document); assert.ok(boundary?.stack);
				let handle!: PluginWidgetHandle<PluginSurfaceProps>;
				await act(async () => { handle = ui.openSurface({ title: "Page overlay", content(container) {
					const input = container.ownerDocument.createElement("input"); input.setAttribute("aria-label", "Overlay draft"); container.append(input);
				} }, { signal: new AbortController().signal }); });
				return handle;
			},
		});
	} finally { await f.close(); }
	} finally {
		if (observerDescriptor) Object.defineProperty(globalThis, "ResizeObserver", observerDescriptor);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
}

for (const page of pages) it(`${page.name}: covers page content but not native chrome, preserving page geometry and shared paint stratum`, async () => withPage(page, async f => {
	const boundary = findCurrentSurfaceBoundary(f.document); assert.ok(boundary?.stack);
	const body = boundary.body;
	const content = f.document.querySelector<HTMLElement>(page.content); assert.ok(content);
	assert.ok(body.contains(content));
	const header = f.document.querySelector<HTMLElement>("header"); assert.ok(header);
	assert.equal(body.contains(header), false, "host chrome is outside inert page-content coverage");
	assert.equal(header.style.zIndex || "", "", "no-surface chrome has no invented rank");
	assert.equal(body.style.isolation || "", ""); assert.equal(body.style.transform || "", ""); assert.equal(body.style.zIndex || "", "");
	assert.doesNotMatch(body.className, /\bisolate\b|\bz-\d+\b|\btransform\b/);
	assert.doesNotMatch(boundary.stack.className, /\bisolate\b|\bz-\d+\b|\btransform\b/);
	if (page.name.startsWith("Home")) {
		assert.equal(body.className, "absolute inset-0");
		assert.ok(body.querySelector('main.absolute.inset-0'));
		assert.ok(body.querySelector('[data-testid="home-mode-switch"]'), "graph and composer share coverage");
	} else if (page.floating) assert.equal(body.className, "relative flex min-h-0 flex-1");
	else {
		assert.equal(body.className, "relative flex min-h-0 min-w-0 flex-1 flex-col");
		assert.equal(content.closest(".contents")?.parentElement, body, "stable coverage wrapper introduces no layout box");
		assert.equal(body.children.length, 2, "coverage wrapper and surface region stay direct siblings");
	}
	const originalClass = body.className;
	if (page.floating) {
		const shell = header.parentElement!;
		assert.ok(shell.firstElementChild?.classList.contains("lh-drag"), "window drag mask remains first");
		const orderedElements = [...shell.querySelectorAll("*")];
		assert.ok(orderedElements.indexOf(body) < orderedElements.indexOf(header), "floating chrome follows body and surface region in DOM order");
	}
	const handle = await f.open();
	try {
		assert.ok(content.closest("[inert]"), "all underlying page controls are covered");
		assert.equal(header.closest("[inert]"), null);
		assert.equal(f.document.querySelector("[data-page-sidebar]")?.closest("[inert]"), null);
		assert.equal(f.document.querySelector('[aria-modal="true"]'), null);
		assert.equal(body.className, originalClass, "opening changes coverage, not page layout classes");
		const layer = f.controller.getTopLayer(); assert.equal(layer?.kind, "view");
		const frame = body.querySelector<HTMLElement>("[data-plugin-session-surface-frame]"); assert.ok(frame);
		assert.equal(Number(frame.style.zIndex), 100 + layer!.order);
		if (page.floating) {
			assert.equal(Number(header.style.zIndex), Number(frame.style.zIndex));
			// A later main-pane picker retains the higher shared rank. The
			// floating chrome must not rise above unrelated foreground views.
			const picker = f.document.createElement("div"); f.document.querySelector("[data-page-main]")!.append(picker);
			let unregister!: () => void;
			await act(async () => { unregister = f.controller.register({ id: "later-pane-picker", kind: "view", rootRef: { current: picker } }); });
			assert.ok(100 + f.controller.getLayer("later-pane-picker")!.order > Number(header.style.zIndex));
			await act(async () => { unregister(); picker.remove(); });
		}
	} finally { await act(async () => handle.dispose()); }
	assert.equal(content.closest("[inert]"), null);
	assert.equal(header.style.zIndex || "", "");
}));

it("plugin loading content is inside the same body boundary while TopBar stays outside", () => {
	const { document } = parseHTML(renderWithInteractionLayers(<PluginViewScreen pluginId="fixture" viewId="overview" />));
	const region = document.querySelector("[data-session-surface-region]"); assert.ok(region);
	const body = region.parentElement!;
	const status = body.querySelector('[role="status"]');
	assert.ok(status?.textContent?.includes("Loading plugin"));
	assert.equal(status?.parentElement?.className, "contents");
	assert.equal(body.querySelector("header"), null);
	assert.ok(document.querySelector('header [aria-label="Plugin settings"]'));
});

it("page boundary expires on exact-path mismatch without disposing preserved plugin DOM", async () => withPage(pages[3]!, async f => {
	const old = findCurrentSurfaceBoundary(f.document); assert.ok(old);
	const input = f.document.querySelector<HTMLInputElement>("[data-page-plugin-input]")!;
	input.value = "Keep the page draft";
	await f.open();
	await f.render("/plugins/fixture/elsewhere");
	assert.equal(old.signal.aborted, true); assert.equal(findSurfaceBoundary(old.target), undefined);
	assert.equal(findCurrentSurfaceBoundary(f.document), undefined);
	assert.equal(f.document.querySelector("[data-plugin-session-surface]"), null);
	assert.equal(f.document.querySelector("[data-page-plugin-input]"), input);
	assert.equal(input.value, "Keep the page draft");
	await f.render();
	const current = findCurrentSurfaceBoundary(f.document); assert.ok(current);
	assert.notEqual(current.target, old.target);
}));

it("unregistering an active plugin view keeps its replacement unavailable branch covered by the activation-owned surface", async () => withPage(pages[3]!, async f => {
	const input = f.document.querySelector<HTMLInputElement>("[data-page-plugin-input]")!;
	input.value = "Keep until actual unregistration";
	const handle = await f.open();
	const surface = f.document.querySelector<HTMLElement>("[data-plugin-session-surface]"); assert.ok(surface);
	assert.ok(f.document.querySelector("[data-page-plugin-input]") === input);
	assert.equal(input.value, "Keep until actual unregistration");
	assert.equal(f.viewCleanups, 0, "opening a surface does not remount the background view");
	await f.unregisterView();
	assert.equal(f.activationSignal.aborted, false, "supported view unregistration does not end plugin activation");
	assert.equal(f.viewCleanups, 1, "actual view unregistration cleans up its mount exactly once");
	assert.ok(f.document.querySelector("[data-plugin-session-surface]") === surface, "activation-owned overlay remains alive");
	const back = f.document.querySelector<HTMLElement>('a[href="/"]'); assert.ok(back);
	assert.ok(back.closest("[inert]"), "new unavailable branch inherits existing coverage");
	assert.equal(f.controller.isElementEligible(back), false);
	await act(async () => { handle.dispose(); });
	assert.ok(!back.closest("[inert]"), "closing the surface restores replacement content");
}));

it("registering a replacement view under an activation-owned surface retains coverage before plugin autofocus", async () => withPage(pages[3]!, async f => {
	await f.unregisterView();
	const handle = await f.open();
	const overlayInput = f.document.querySelector<HTMLInputElement>('[aria-label="Overlay draft"]'); assert.ok(overlayInput);
	await act(async () => { overlayInput.focus(); });
	await f.registerView();
	const input = f.document.querySelector<HTMLInputElement>("[data-page-plugin-input]"); assert.ok(input);
	assert.equal(f.activationSignal.aborted, false);
	assert.ok(input.closest("[inert]"), "new mount frame inherits coverage before mount/autofocus");
	assert.equal(f.controller.isElementEligible(input), false);
	assert.ok(f.document.activeElement === overlayInput, "background plugin autofocus cannot steal foreground focus");
	input.value = "Replacement draft";
	await act(async () => { handle.dispose(); });
	assert.ok(f.document.querySelector("[data-page-plugin-input]") === input);
	assert.equal(input.value, "Replacement draft");
	assert.equal(f.viewCleanups, 1, "closing the surface does not remount the replacement view");
	assert.ok(!input.closest("[inert]"));
}));

it("a pending NewDraft picker becomes the interactive foreground above a later-opened surface and returns to it on close", async () => withPage({
	...pages[2]!, node: <NewSession initialConfigured mode="practice" />,
}, async f => {
	let resolveGraph!: (response: Response) => void;
	const graph = new Promise<Response>(resolve => { resolveGraph = resolve; });
	const originalFetch = globalThis.fetch;
	let graphRequests = 0;
	globalThis.fetch = async (url, options) => {
		if (url === "/api/graph") { graphRequests++; return graph; }
		if (url === "/api/graph/sources") return Response.json({ sources: [], organization: { version: 1, folders: [], placements: {} } });
		return originalFetch(url, options);
	};
	try {
		const pick = f.document.querySelector<HTMLElement>('[data-testid="practice-props-chip"]'); assert.ok(pick);
		await act(async () => { pick.dispatchEvent(new window.Event("click", { bubbles: true })); });
		assert.equal(graphRequests, 1); assert.equal(f.document.querySelector('[data-testid="chain-table-overlay"]'), null);
		const handle = await f.open();
		const surface = f.document.querySelector<HTMLElement>("[data-plugin-session-surface]"); assert.ok(surface);
		const overlayInput = surface.querySelector<HTMLInputElement>('[aria-label="Overlay draft"]'); assert.ok(overlayInput);
		await act(async () => { resolveGraph(Response.json({ propositions: [], chains: [], sessions: {}, fileSources: {} })); });
		const picker = f.document.querySelector<HTMLElement>('[data-testid="chain-table-overlay"]'); assert.ok(picker);
		const pointerOwner = picker.closest<HTMLElement>(".pointer-events-auto");
		assert.ok(pointerOwner, "native picker overrides the surface region's inherited pointer-events:none");
		assert.equal(pointerOwner.className, "contents pointer-events-auto", "pointer handoff introduces no layout box");
		assert.ok(pointerOwner.parentElement === findCurrentSurfaceBoundary(f.document)?.stack, "pointer handoff stays inside the shared surface region");
		const search = picker.querySelector<HTMLInputElement>('[aria-label="Search nodes"]'); assert.ok(search);
		assert.ok(!picker.closest("[inert]"), "late native picker is not covered as ordinary page content");
		assert.equal(f.controller.isElementEligible(search), true);
		assert.ok(f.controller.getTopLayer()?.rootRef.current === picker);
		assert.ok(surface.closest("[inert]"), "older surface becomes covered rather than claiming native picker input");
		assert.equal(f.controller.isElementEligible(overlayInput), false);
		await act(async () => { search.focus(); });
		assert.ok(f.document.activeElement === search);
		const close = picker.querySelector<HTMLElement>('[aria-label="Close chains"]'); assert.ok(close);
		await act(async () => { close.dispatchEvent(new window.Event("click", { bubbles: true })); });
		assert.equal(f.document.querySelector('[data-testid="chain-table-overlay"]'), null);
		assert.ok(f.document.querySelector("[data-plugin-session-surface]") === surface);
		assert.ok(!surface.closest("[inert]"));
		assert.equal(f.controller.isElementEligible(overlayInput), true);
		assert.ok(f.controller.getTopLayer()?.rootRef.current === surface);
		await act(async () => { handle.dispose(); });
	} finally { globalThis.fetch = originalFetch; }
}));

it("Activity hide expires the boundary and surfaces; show reconnects without replaying them or resetting native draft DOM", async () => withPage(pages[2]!, async f => {
	const old = findCurrentSurfaceBoundary(f.document); assert.ok(old);
	const input = f.document.querySelector<HTMLElement>('[data-testid="composer"] [contenteditable]'); assert.ok(input);
	const text = input.textContent;
	await f.open();
	await f.render(undefined, true);
	assert.equal(old.signal.aborted, true); assert.equal(findCurrentSurfaceBoundary(f.document), undefined);
	assert.equal(f.document.querySelector("[data-plugin-session-surface]"), null);
	assert.ok(f.document.querySelector('[data-testid="composer"] [contenteditable]') === input);
	await f.render();
	const current = findCurrentSurfaceBoundary(f.document); assert.ok(current);
	assert.notEqual(current.target, old.target);
	assert.equal(f.document.querySelector("[data-plugin-session-surface]"), null);
	assert.ok(f.document.querySelector('[data-testid="composer"] [contenteditable]') === input);
	assert.equal(input.textContent, text);
}));
