import React, { act, useEffect, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { InteractionLayersProvider, useInteractionLayer, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { SurfaceRegion, usePageSurfaceBoundary, useSurfaceChromeStyle } from "../components/plugin-surfaces.tsx";
import { findCurrentSurfaceBoundary, findSurfaceBoundary } from "../components/plugin-surface-targets.ts";
import { isInteractionScopeEligible } from "../components/plugin-input-focus.ts";
import { HostDialog } from "../components/host-dialog.tsx";
import { SideThreadPopover } from "../components/side-thread.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { PluginSurfaceProps, PluginSurfaceTarget, PluginUi, PluginUiContent, PluginWidgetHandle } from "../src/core/plugin-ui.ts";

// Popper/Presence choose their browser layout effect at import time.
const bootstrap = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(bootstrap.document, "compatMode", { value: "CSS1Compat" });
const bootstrapGlobals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.document });
const { createPluginUiStore, PluginUiHost } = await import("../components/plugin-ui-host.tsx");
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import("../components/ui/tooltip.tsx");
for (const [key, descriptor] of bootstrapGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }

type Handle = PluginWidgetHandle<PluginSurfaceProps>;
interface ViewOptions { active?: boolean; viewKey?: string; nativeView?: boolean; settings?: boolean; retainedHidden?: boolean; helper?: boolean; tooltipContainer?: HTMLElement }
interface Fixture {
	ui: PluginUi;
	store: ReturnType<typeof createPluginUiStore>;
	lifetime: AbortController;
	controller: InteractionLayersController;
	target(): PluginSurfaceTarget;
	render(options: ViewOptions): Promise<void>;
	open(title: string, content?: PluginUiContent, ui?: PluginUi): Promise<Handle>;
	openCurrent(title: string, content?: PluginUiContent, ui?: PluginUi): Promise<Handle>;
	escape(target?: HTMLElement): Promise<void>;
	readonly helperCloses: number;
}
function NativeFocus() {
	const root = useRef<HTMLDivElement>(null);
	const layer = useInteractionLayer({ kind: "view", enabled: true, rootRef: root, onClose: () => "blocked" });
	return <div ref={root} data-native-view="" className="pointer-events-auto absolute inset-0" style={{ zIndex: 100 + layer.order }}><h2 tabIndex={-1}>Native focus</h2><input aria-label="Native focus field" /></div>;
}
function DirectViewMount({ ui, mount }: { ui: PluginUi; mount(ui: PluginUi): void }) {
	useEffect(() => { mount(ui); }, [ui, mount]);
	return <div data-direct-view-mount="" />;
}
async function withFixture(run: (fixture: Fixture) => Promise<void>, onMount?: (ui: PluginUi) => void, strict = false) {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	const globals = { window: dom.window, self: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement, SVGElement: dom.window.SVGElement, ShadowRoot: dom.window.ShadowRoot,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	const store = createPluginUiStore(), lifetime = new AbortController();
	const ui = store.createUi({ signal: lifetime.signal });
	const root = createRoot(document.querySelector("#root")!);
	let token: PluginSurfaceTarget | undefined;
	let controller!: InteractionLayersController;
	let helperCloses = 0;
	let state: Required<Omit<ViewOptions, "tooltipContainer">> & Pick<ViewOptions, "tooltipContainer"> = { active: true, viewKey: "session-a", nativeView: false, settings: false, retainedHidden: false, helper: false };
	function Boundary() {
		controller = useInteractionLayers();
		const body = useRef<HTMLDivElement>(null);
		token = usePageSurfaceBoundary({ active: state.active, viewKey: state.viewKey, bodyRef: body });
		const chromeStyle = useSurfaceChromeStyle(token);
		return <><button data-chrome="">Top bar</button><aside>Sidebar</aside>
			<main data-host-main="" style={{ isolation: "isolate" }}><div ref={body} data-session-body="" className="relative flex min-h-0 flex-1">
				<div data-native-body=""><h2 tabIndex={-1}>Session</h2><input data-native-input="" /><button>Native Submit</button></div>
				{onMount && <DirectViewMount ui={ui} mount={onMount} />}
				{state.helper && <SideThreadPopover state={{ threadId: "helper", segmentId: "segment", messages: [], answering: false, streamText: "", mode: "popover", anchor: { kind: "element", element: document.body } }} chatId="fixture"
					composer={() => document.querySelector("[data-native-input]")} draft="Retained helper draft"
					onAsk={async () => true} onStop={() => {}} onExpand={() => {}} onFloat={() => {}} onClose={() => { helperCloses++; }} />}
				<SurfaceRegion target={token}>{state.nativeView && <NativeFocus />}</SurfaceRegion>
			</div><div data-floating-chrome="" style={chromeStyle}>Floating page chrome</div></main>
			{state.tooltipContainer && createPortal(<TooltipProvider><Tooltip open><TooltipTrigger>Owned hint trigger</TooltipTrigger><TooltipContent>Owned passive hint</TooltipContent></Tooltip></TooltipProvider>, state.tooltipContainer)}
			<HostDialog open={state.settings} onClose={() => "blocked"} aria-label="Global Settings"><h2>Settings</h2><input data-settings-input="" /></HostDialog>
		</>;
	}
	const fixture: Fixture = {
		ui, store, lifetime, get controller() { return controller; }, get helperCloses() { return helperCloses; },
		target() { assert.ok(token); return token; },
		async render(options) {
			state = { ...state, ...options };
			const Mode = strict ? React.StrictMode : React.Fragment;
			await act(async () => root.render(<Mode><InteractionLayersProvider><React.Activity mode={state.retainedHidden ? "hidden" : "visible"}><Boundary /></React.Activity><PluginUiHost store={store} /></InteractionLayersProvider></Mode>));
		},
		async open(title, content = document.createElement("div"), owner = ui) {
			let handle!: Handle;
			await act(async () => { handle = owner.openSurface(fixture.target(), { title, content }, { signal: new AbortController().signal }); });
			return handle;
		},
		async openCurrent(title, content = document.createElement("div"), owner = ui) {
			let handle!: Handle;
			await act(async () => { handle = owner.openSurface({ title, content }, { signal: new AbortController().signal }); });
			return handle;
		},
		async escape(target) {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as KeyboardEvent); (target ?? document).dispatchEvent(event); });
		},
	};
	try { await fixture.render({}); await run(fixture); }
	finally {
		await act(async () => { lifetime.abort(); root.unmount(); });
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}
it("an already-open floating helper is native session content: covered and inactive, then restored without losing its draft", async () => withFixture(async f => {
	await f.render({ helper: true });
	const boundary = findSurfaceBoundary(f.target())!;
	const helper = document.querySelector<HTMLElement>("[data-testid='side-thread-popover']")!;
	const input = helper.querySelector<HTMLTextAreaElement>("textarea")!;
	assert.equal(helper.parentElement === boundary.body, true, "fixed geometry does not escape native-body coverage via a body portal");
	assert.equal(f.controller.getSnapshot().length, 0, "the companion is not a popup that blocks its main composer");
	assert.equal(isInteractionScopeEligible(input, f.controller), true);
	assert.equal(isInteractionScopeEligible(document.querySelector("[data-native-input]"), f.controller), true);
	const handle = await f.open("Cover the native session", inputContent("Plugin input"));
	assert.equal(helper.hasAttribute("inert"), true);
	assert.equal(helper.getAttribute("aria-hidden"), "true");
	assert.equal(isInteractionScopeEligible(input, f.controller), false);
	assert.equal(input.value, "Retained helper draft");
	await f.escape(input);
	assert.equal(f.helperCloses, 0, "even a queued key targeting the covered field cannot close the helper");
	assert.equal(helper.hasAttribute("inert"), false);
	assert.equal(helper.hasAttribute("aria-hidden"), false);
	assert.equal(isInteractionScopeEligible(input, f.controller), true);
	assert.equal(document.querySelector("[data-testid='side-thread-popover']") === helper, true);
	assert.equal(input.value, "Retained helper draft");
	handle.dispose();
}));

const inputContent = (label: string): PluginUiContent => container => {
	const input = document.createElement("input"); input.setAttribute("aria-label", label); container.append(input);
};
const surface = (title: string) => [...document.querySelectorAll<HTMLElement>("[data-plugin-session-surface]")].find(root => root.getAttribute("aria-label") === title)!;
const frame = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-plugin-session-surface-frame]")!;

it("a plugin view's immediate mount callback can capture its current page synchronously", async () => {
	let failure: unknown, calls = 0;
	await withFixture(async f => {
		assert.equal(calls, 1, "mount is not deferred or implicitly retried");
		assert.equal(failure, undefined);
		assert.ok(surface("Immediate page surface"));
		assert.equal(findCurrentSurfaceBoundary(document)?.target, f.target());
	}, ui => {
		calls++;
		try { ui.openSurface({ title: "Immediate page surface", content: document.createElement("div") }, { signal: new AbortController().signal }); }
		catch (error) { failure = error; }
	});
});

it("targetless calls capture the page rather than a surface opener, and coexist with the legacy explicit overload", async () => withFixture(async f => {
	const boundary = findCurrentSurfaceBoundary(document)!;
	assert.equal(boundary.target, f.target());
	const lower = await f.openCurrent("Direct lower", inputContent("Lower draft"));
	const first = surface("Direct lower"), firstLayer = f.controller.getTopLayer()!;
	assert.ok(boundary.stack!.contains(first));
	first.querySelector<HTMLElement>("input")!.focus();
	await f.openCurrent("Direct sibling", inputContent("Sibling draft"));
	assert.equal(f.controller.getTopLayer()!.ownerId, f.controller.ownerOf(boundary.body)?.id ?? null, "a surface is owned by its page, not the currently focused surface");
	assert.notEqual(f.controller.getTopLayer()!.ownerId, firstLayer.id);
	assert.equal(findCurrentSurfaceBoundary(document), boundary);
	const explicit = await f.open("Legacy explicit"); assert.ok(boundary.stack!.contains(surface("Legacy explicit")));
	await act(async () => { lower.dispose(); explicit.dispose(); });
	assert.ok(surface("Direct sibling"), "disposing siblings does not close an independent targetless surface");
}));

it("targetless calls fail synchronously without a current page and abort takes precedence over capture and background validation", async () => withFixture(async f => {
	await f.render({ active: false });
	assert.equal(findCurrentSurfaceBoundary(document), undefined);
	const props = { title: "No page", content: document.createElement("div"), background: "invalid" } as unknown as PluginSurfaceProps;
	const live = new AbortController(), aborted = new AbortController(); aborted.abort();
	assert.throws(() => f.ui.openSurface(props, { signal: live.signal }), /^Error: Surface target is no longer active$/);
	const inert = f.ui.openSurface(props, { signal: aborted.signal }); inert.update({ background: "still invalid" } as unknown as Partial<PluginSurfaceProps>); inert.dispose();
	assert.equal(f.store.getSnapshot().length, 0);
	await act(async () => f.lifetime.abort());
	f.ui.openSurface(props, { signal: live.signal }).dispose();
	assert.equal(f.store.getSnapshot().length, 0);
}));

it("targetless capture cannot move to a replacement page before its portal commits", async () => withFixture(async f => {
	const captured = findCurrentSurfaceBoundary(document)!;
	let mounts = 0, handle!: Handle;
	await act(async () => {
		handle = f.ui.openSurface({ title: "Captured only once", content() { mounts++; } }, { signal: new AbortController().signal });
		assert.ok(captured.stack!.contains(f.store.getSnapshot()[0]!.target), "destination is chosen synchronously");
		await f.render({ viewKey: "replacement-page" });
	});
	assert.equal(captured.signal.aborted, true); assert.equal(findSurfaceBoundary(captured.target), undefined);
	assert.notEqual(findCurrentSurfaceBoundary(document)?.target, captured.target);
	assert.equal(mounts, 0); assert.equal(f.store.getSnapshot().length, 0);
	await act(async () => handle.update({ title: "Must not revive", content() { mounts++; } }));
	assert.equal(mounts, 0); assert.equal(f.store.getSnapshot().length, 0);
	await f.openCurrent("New call on new page"); assert.ok(surface("New call on new page"));
}));

it("late targetless content completion is cleaned once without remapping to or taking focus from the new page", async () => withFixture(async f => {
	let complete!: () => void, cleaned = 0, signal!: AbortSignal;
	const handle = await f.openCurrent("Old asynchronous content", async (_container, mountedSignal) => {
		signal = mountedSignal; await new Promise<void>(resolve => { complete = resolve; }); return () => { cleaned++; };
	});
	await f.render({ viewKey: "different-page" });
	assert.equal(signal.aborted, true); assert.equal(f.store.getSnapshot().length, 0);
	await f.openCurrent("Fresh page content", inputContent("Fresh input"));
	const focus = document.activeElement;
	await act(async () => { complete(); handle.update({ title: "Late stale update" }); });
	assert.equal(cleaned, 1); assert.equal(document.activeElement, focus);
	assert.equal(surface("Late stale update"), undefined); assert.ok(surface("Fresh page content"));
	await act(async () => handle.dispose()); assert.equal(cleaned, 1);
}));

for (const timing of ["before", "after"] as const) {
	it(`a global modal opened ${timing} a targetless surface stays authoritative, then closing reveals the still-live page-owned surface`, async () => withFixture(async f => {
		if (timing === "before") await f.render({ settings: true });
		let signal!: AbortSignal;
		const before = document.activeElement;
		await f.openCurrent("Page-owned beneath Settings", (container, mountedSignal) => {
			signal = mountedSignal; const input = document.createElement("input"); input.dataset.behindModal = ""; container.append(input);
		});
		if (timing === "after") await f.render({ settings: true });
		else assert.equal(document.activeElement, before, "opening a late page surface cannot steal modal focus");
		const modal = f.controller.getActiveModal()!;
		const root = surface("Page-owned beneath Settings"), input = root.querySelector<HTMLElement>("input")!;
		const layer = f.controller.getSnapshot().find(candidate => candidate.rootRef.current === root)!;
		assert.equal(f.controller.getTopLayer(), modal); assert.equal(f.controller.isElementEligible(input), false);
		assert.notEqual(layer.ownerId, modal.id, "a modal opener does not confer modal ownership on the page surface");
		assert.equal(signal.aborted, false);
		await f.render({ settings: false });
		assert.equal(f.controller.getActiveModal(), null); assert.equal(f.controller.getTopLayer()?.id, layer.id);
		assert.equal(f.controller.isElementEligible(input), true); assert.equal(signal.aborted, false); assert.equal(root.isConnected, true);
	}));
}

it("targetless caller abort disposes content once without onClose and Activity hide expires the captured page", async () => withFixture(async f => {
	const caller = new AbortController(); let handle!: Handle, cleaned = 0, closed = 0, signal!: AbortSignal;
	await act(async () => { handle = f.ui.openSurface({ title: "Direct caller", onClose() { closed++; }, content(_container, mountedSignal) {
		signal = mountedSignal; return () => { cleaned++; };
	} }, { signal: caller.signal }); });
	await act(async () => { caller.abort(); handle.dispose(); handle.update({ title: "Ignored" }); });
	assert.equal(signal.aborted, true); assert.equal(cleaned, 1); assert.equal(closed, 0);
	const old = f.target(), native = document.querySelector("[data-native-body]");
	await f.openCurrent("Direct Activity");
	await f.render({ retainedHidden: true });
	assert.equal(document.querySelector("[data-native-body]"), native);
	assert.equal(findCurrentSurfaceBoundary(document), undefined); assert.equal(findSurfaceBoundary(old), undefined);
	assert.equal(f.store.getSnapshot().length, 0);
	assert.throws(() => f.ui.openSurface({ title: "Hidden page", content: document.createElement("div") }, { signal: new AbortController().signal }), /Surface target is no longer active/);
	await f.render({ retainedHidden: false }); assert.notEqual(f.target(), old);
	assert.throws(() => f.ui.openSurface(old, { title: "Explicit old page", content: document.createElement("div") }, { signal: new AbortController().signal }), /Surface target is no longer active/);
	await f.openCurrent("Direct re-entry"); assert.ok(surface("Direct re-entry"));
}));

it("floating chrome uses only the maximum own-plugin-surface rank, not native views, newer pane pickers or other regions", async () => withFixture(async f => {
	const chrome = document.querySelector<HTMLElement>("[data-floating-chrome]")!;
	assert.equal(chrome.style.zIndex || "", "");
	await f.render({ nativeView: true }); assert.equal(chrome.style.zIndex || "", "", "a native view alone adds no chrome override");
	const first = await f.openCurrent("Own lower");
	assert.equal(Number(chrome.style.zIndex), Number(frame(surface("Own lower")).style.zIndex));
	const pane = document.createElement("div"), foreign = document.createElement("div"); foreign.dataset.pluginSessionSurface = "";
	document.querySelector("[data-host-main]")!.append(pane, foreign);
	let removePane!: () => void, removeForeign!: () => void;
	try {
		await act(async () => {
			removePane = f.controller.register({ id: "later-pane-picker", kind: "view", rootRef: { current: pane } });
			removeForeign = f.controller.register({ id: "another-page-plugin", kind: "view", rootRef: { current: foreign } });
		});
		assert.ok(100 + f.controller.getLayer("later-pane-picker")!.order > Number(chrome.style.zIndex));
		assert.equal(Number(chrome.style.zIndex), Number(frame(surface("Own lower")).style.zIndex));
		const upper = await f.openCurrent("Own upper");
		assert.equal(Number(chrome.style.zIndex), Number(frame(surface("Own upper")).style.zIndex));
		await act(async () => upper.dispose());
		assert.equal(Number(chrome.style.zIndex), Number(frame(surface("Own lower")).style.zIndex));
		await act(async () => first.dispose()); assert.equal(chrome.style.zIndex || "", "");
	} finally { await act(async () => { removePane?.(); removeForeign?.(); pane.remove(); foreign.remove(); }); }
}));

it("surfaces share the exact session body/local paint stratum, leaving chrome and empty native input eligible", async () => withFixture(async f => {
	const native = document.querySelector<HTMLElement>("[data-native-input]")!;
	const region = document.querySelector<HTMLElement>("[data-session-surface-region]")!;
	assert.equal(region.parentElement?.hasAttribute("data-session-body"), true);
	assert.match(region.className, /absolute inset-0/);
	assert.doesNotMatch(region.className, /\bz-40\b/, "session geometry must not isolate its ranks from main-pane picker siblings");
	assert.match(region.className, /pointer-events-none/);
	assert.equal(f.controller.isElementEligible(native), true);
	await f.open("Drawing", inputContent("Canvas note"));
	const root = surface("Drawing");
	assert.ok(region.contains(root));
	assert.equal(document.querySelector('[aria-modal="true"]'), null);
	assert.equal(f.controller.getTopLayer()?.kind, "view");
	assert.equal(Number(frame(root).style.zIndex), 100 + f.controller.getTopLayer()!.order);
	assert.equal(f.controller.isElementEligible(native), false);
	assert.equal(isInteractionScopeEligible(native, f.controller), false, "covered Enter/Tab/dictation scope is ineligible");
	assert.equal(f.controller.isElementEligible(document.querySelector("[data-chrome]")), true);
	assert.equal(document.querySelector("aside")?.closest("[inert]"), null);
	assert.equal(root.getAttribute("aria-label"), "Drawing");
	assert.equal(root.querySelector("h2"), null, "the accessible title creates no host heading or row");
	assert.doesNotMatch(frame(root).className, /\bp-4\b/);
	const scroller = root.querySelector("input")!.parentElement!.parentElement!;
	assert.match(scroller.className, /overflow-y-auto/);
	const close = root.querySelector('button[aria-label="Close"]')!;
	assert.equal(close.parentElement, frame(root), "floating X is outside the content scroller");
	assert.match(close.className, /absolute right-2 top-2/);
	assert.equal(root.querySelector("[data-plugin-ui-widget]"), null);
	assert.match(root.querySelector("input")!.parentElement!.className, /h-full w-full/);
}));

it("surface background defaults to dimmed and controlled presets preserve content, focus, and lifetime", async () => withFixture(async f => {
	let mounts = 0;
	let signal!: AbortSignal;
	const handle = await f.open("Background", (container, mountedSignal) => {
		mounts++; signal = mountedSignal;
		container.append(document.createElement("input"));
	});
	const root = surface("Background"), painted = frame(root), focus = document.activeElement;
	assert.match(painted.className, /bg-background\/80 backdrop-blur-sm/);
	await act(async () => handle.update({ background: "opaque" }));
	assert.equal(frame(surface("Background")), painted);
	assert.match(painted.className, /\bbg-background\b/);
	assert.doesNotMatch(painted.className, /bg-background\/80|backdrop-blur/);
	assert.equal(document.activeElement, focus); assert.equal(mounts, 1); assert.equal(signal.aborted, false);
	await act(async () => handle.update({ background: "dimmed" }));
	assert.match(painted.className, /bg-background\/80 backdrop-blur-sm/);
	await act(async () => handle.update({ background: undefined }));
	assert.match(painted.className, /bg-background\/80 backdrop-blur-sm/);
	assert.equal(mounts, 1); assert.equal(signal.aborted, false);
}));

it("surface background rejects unsupported open/update values without publishing or mutating accepted props", async () => withFixture(async f => {
	const options = { signal: new AbortController().signal };
	for (const background of ["transparent", "", null, 0]) {
		assert.throws(() => f.ui.openSurface(f.target(), { title: "Invalid", content: document.createElement("div"), background } as unknown as PluginSurfaceProps, options), /Surface background must be/);
		assert.equal(f.store.getSnapshot().length, 0);
	}
	let handle!: Handle;
	await act(async () => { handle = f.ui.openSurface(f.target(), { title: "Opaque", content: document.createElement("div"), background: "opaque" }, options); });
	const snapshot = f.store.getSnapshot();
	assert.doesNotMatch(frame(surface("Opaque")).className, /backdrop-blur/);
	assert.throws(() => handle.update({ background: "invalid" } as unknown as Partial<PluginSurfaceProps>), /Surface background must be/);
	assert.equal(f.store.getSnapshot(), snapshot);
	await act(async () => handle.update({ title: "Still opaque" }));
	assert.doesNotMatch(frame(surface("Still opaque")).className, /backdrop-blur/);
	await act(async () => handle.dispose());
	handle.update({ background: "ignored" } as unknown as Partial<PluginSurfaceProps>);
	const aborted = new AbortController(); aborted.abort();
	f.ui.openSurface(f.target(), { title: "Ignored", content: document.createElement("div"), background: "ignored" } as unknown as PluginSurfaceProps, { signal: aborted.signal }).dispose();
}));

it("visual siblings stay mounted and painted; unloading a lower owner cannot close another owner's foreground", async () => withFixture(async f => {
	const ownerB = new AbortController();
	const uiB = f.store.createUi({ signal: ownerB.signal });
	let cleanedA = 0, cleanedB = 0;
	await f.open("A", container => { container.textContent = "A stays painted"; return () => { cleanedA++; }; });
	await f.open("B", container => { container.textContent = "B stays painted"; return () => { cleanedB++; }; }, uiB);
	const a = surface("A"), b = surface("B");
	assert.equal(a.isConnected, true); assert.equal(a.style.display, "contents");
	assert.equal(a.hasAttribute("inert"), true); assert.equal(b.hasAttribute("inert"), false);
	assert.equal(cleanedA, 0); assert.equal(cleanedB, 0);
	assert.ok(Number(frame(a).style.zIndex) < Number(frame(b).style.zIndex));
	const focus = document.activeElement;
	await act(async () => f.lifetime.abort());
	assert.equal(surface("A"), undefined); assert.equal(surface("B"), b);
	assert.equal(cleanedA, 1); assert.equal(cleanedB, 0);
	assert.equal(document.activeElement, focus, "covered owner unload never steals foreground focus");
	await act(async () => ownerB.abort());
	assert.equal(cleanedB, 1);
}));

it("one Escape closes only the foreground surface; close notifications use latest controlled props", async () => withFixture(async f => {
	let closes = 0;
	await f.open("Lower");
	const top = await f.open("Upper");
	await act(async () => top.update({ title: "Upper updated", onClose: () => { closes++; } }));
	await f.escape();
	assert.equal(closes, 1); assert.equal(surface("Upper updated"), undefined);
	assert.ok(surface("Lower")); assert.equal(f.store.getSnapshot().length, 1);
	await f.escape();
	assert.equal(document.querySelector("[data-plugin-session-surface]"), null);
	assert.equal(document.querySelector("[data-native-body]")?.hasAttribute("inert"), false);
}));

it("controlled title/callback updates preserve content; replacement and late asynchronous cleanup run exactly once", async () => withFixture(async f => {
	let mounts = 0, cleanups = 0, lateCleanups = 0;
	let resolve!: (cleanup: () => void) => void;
	let signal!: AbortSignal;
	const handle = await f.open("First", (container, mountedSignal) => {
		mounts++; signal = mountedSignal; container.textContent = "Original";
		return new Promise(done => { resolve = done; });
	});
	const original = surface("First");
	await act(async () => handle.update({ title: "Renamed", onClose() {} }));
	assert.equal(surface("Renamed"), original); assert.equal(mounts, 1); assert.equal(signal.aborted, false);
	await act(async () => handle.update({ content: container => { container.textContent = "Replacement"; return () => { cleanups++; }; } }));
	assert.equal(signal.aborted, true); assert.equal(mounts, 1);
	await act(async () => resolve(() => { lateCleanups++; }));
	assert.equal(lateCleanups, 1); assert.match(original.textContent!, /Replacement/);
	await act(async () => { handle.dispose(); handle.dispose(); handle.update({ title: "Late" }); });
	assert.equal(cleanups, 1); assert.equal(lateCleanups, 1);
}));

it("unknown/expired targets throw synchronously, aborted owners/callers return inert handles, hide-return never revives a token", async () => withFixture(async f => {
	const old = f.target();
	const props = { title: "Stale", content: document.createElement("div") };
	const live = new AbortController(), aborted = new AbortController(); aborted.abort();
	assert.throws(() => f.ui.openSurface({} as PluginSurfaceTarget, props, { signal: live.signal }), /Surface target is no longer active/);
	await f.open("Leaving");
	await f.render({ active: false });
	assert.equal(f.store.getSnapshot().length, 0);
	assert.throws(() => f.ui.openSurface(old, props, { signal: live.signal }), /Surface target is no longer active/);
	const inert = f.ui.openSurface(old, props, { signal: aborted.signal }); inert.update({ title: "Ignored" }); inert.dispose();
	await f.render({ active: true });
	assert.notEqual(f.target(), old);
	assert.throws(() => f.ui.openSurface(old, props, { signal: live.signal }), /Surface target is no longer active/);
	await f.open("New instance");
	await f.render({ viewKey: "session-b" });
	assert.equal(f.store.getSnapshot().length, 0);
	await act(async () => f.lifetime.abort());
	f.ui.openSurface(old, props, { signal: live.signal }).dispose();
	assert.equal(f.store.getSnapshot().length, 0);
}));

it("React Activity hide-retains native DOM but expires surfaces and never revives the old target on re-entry", async () => withFixture(async f => {
	const old = f.target();
	let cleaned = 0;
	await f.open("Activity surface", () => () => { cleaned++; });
	const native = document.querySelector("[data-native-body]");
	await f.render({ retainedHidden: true });
	assert.equal(f.store.getSnapshot().length, 0); assert.equal(cleaned, 1);
	assert.equal(document.querySelector("[data-native-body]"), native, "native view DOM is retained");
	assert.throws(() => f.ui.openSurface(old, { title: "Old", content: document.createElement("div") }, { signal: new AbortController().signal }), /Surface target is no longer active/);
	await f.render({ retainedHidden: false });
	assert.notEqual(f.target(), old);
	assert.throws(() => f.ui.openSurface(old, { title: "Still old", content: document.createElement("div") }, { signal: new AbortController().signal }), /Surface target is no longer active/);
	await f.open("Reentered"); assert.ok(surface("Reentered"));
}));

it("caller abort cancels surface content exactly once without notifying onClose", async () => withFixture(async f => {
	const caller = new AbortController();
	let signal!: AbortSignal, cleaned = 0, closed = 0;
	let handle!: Handle;
	await act(async () => { handle = f.ui.openSurface(f.target(), { title: "Caller owned", onClose() { closed++; }, content(_container, mountedSignal) { signal = mountedSignal; return () => { cleaned++; }; } }, { signal: caller.signal }); });
	assert.equal(signal.aborted, false);
	await act(async () => { caller.abort(); handle.dispose(); handle.update({ title: "Ignored" }); });
	assert.equal(signal.aborted, true); assert.equal(cleaned, 1); assert.equal(closed, 0);
	assert.equal(f.store.getSnapshot().length, 0);
}));

it("native-view expiry before the portal commits aborts content without a late mount or focus return", async () => withFixture(async f => {
	let mounts = 0;
	await act(async () => {
		f.ui.openSurface(f.target(), { title: "Never commit", content() { mounts++; } }, { signal: new AbortController().signal });
		// Deactivate in this same batch before the new portal's layout effects.
		await f.render({ active: false });
	});
	assert.equal(mounts, 0); assert.equal(f.store.getSnapshot().length, 0);
}));

it("entry honors explicit eligible focus, otherwise first editable field, plugin heading, or painted frame", async () => withFixture(async f => {
	let explicit!: HTMLButtonElement;
	const one = await f.open("Explicit", container => {
		container.append(document.createElement("input"));
		explicit = document.createElement("button"); explicit.textContent = "Explicit focus"; container.append(explicit); explicit.focus();
	});
	assert.equal(document.activeElement, explicit);
	await act(async () => one.dispose());
	const two = await f.open("Editable", container => {
		const readonly = document.createElement("input"); readonly.setAttribute("readonly", ""); container.append(readonly);
		const disabled = document.createElement("input"); disabled.disabled = true; container.append(disabled);
		const text = document.createElement("textarea"); text.dataset.entry = ""; container.append(text);
	});
	assert.equal(document.activeElement?.hasAttribute("data-entry"), true);
	await act(async () => two.dispose());
	const three = await f.open("Heading only", container => {
		const heading = document.createElement("h2"); heading.textContent = "Plugin heading"; container.append(heading);
	});
	assert.equal(document.activeElement, surface("Heading only").querySelector("h2"));
	assert.equal(document.activeElement?.getAttribute("tabindex"), "-1");
	await act(async () => three.dispose());
	const native = document.querySelector<HTMLElement>("[data-native-input]")!;
	native.focus();
	await f.open("Accessible name only");
	const root = surface("Accessible name only"), painted = frame(root);
	assert.equal(root.style.display, "contents");
	assert.equal(root.getAttribute("aria-label"), "Accessible name only");
	assert.equal(painted.getAttribute("aria-label"), "Accessible name only");
	assert.equal(painted.getAttribute("tabindex"), "-1");
	assert.equal(document.activeElement, painted, "empty content focuses the painted frame, not the display:contents root, floating X, or covered composer");
	assert.equal(f.controller.isElementEligible(native), false);
}));

for (const strict of [false, true]) it(`surface entry prefers a real marked region before fields/headings with fresh content under StrictMode=${strict}`, async () => withFixture(async f => {
	const mounted: { region: HTMLElement; signal: AbortSignal }[] = [];
	let keys = 0;
	await f.openCurrent("Marked entry", (container, signal) => {
		const owned = document.createElement("div"), region = document.createElement("section");
		region.setAttribute("data-plugin-initial-focus", ""); region.tabIndex = -1;
		region.setAttribute("role", "group"); region.setAttribute("aria-label", "Review card"); region.textContent = "A visible question";
		const heading = document.createElement("h2"); heading.textContent = "Another heading";
		owned.append(document.createElement("input"), heading, region); container.append(owned);
		const keydown = () => { keys++; }; owned.addEventListener("keydown", keydown);
		signal.addEventListener("abort", () => { owned.removeEventListener("keydown", keydown); owned.remove(); }, { once: true });
		mounted.push({ region, signal });
	});
	assert.ok(mounted.length >= (strict ? 2 : 1), "StrictMode actually replays the content mount");
	const latest = mounted.at(-1)!;
	assert.ok(document.activeElement === latest.region, "entry must focus the latest visible marked region before the earlier field/heading"); assert.equal(latest.region.isConnected, true);
	assert.equal(latest.signal.aborted, false);
	for (const old of mounted.slice(0, -1)) { assert.equal(old.signal.aborted, true); assert.equal(old.region.isConnected, false); }
	const event = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: " ", code: "Space" });
	document.activeElement!.dispatchEvent(event); assert.equal(keys, 1, "keys reach the content's own listener, not a host ancestor");
}, undefined, strict));

it("marked entry skips hidden/inert/disabled targets and preserves already-owned eligible focus", async () => withFixture(async f => {
	let chosen!: HTMLElement;
	const first = await f.open("Eligible marker", container => {
		container.append(document.createElement("input"));
		for (const attribute of ["hidden", "inert", "aria-hidden", "disabled", "display", "visibility"]) {
			const wrapper = document.createElement("div"), invalid = document.createElement("button");
			invalid.setAttribute("data-plugin-initial-focus", "");
			if (attribute === "disabled") invalid.disabled = true;
			else if (attribute === "display") wrapper.style.display = "none";
			else if (attribute === "visibility") wrapper.style.visibility = "hidden";
			else wrapper.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
			wrapper.append(invalid); container.append(wrapper);
		}
		chosen = document.createElement("div"); chosen.tabIndex = -1; chosen.setAttribute("data-plugin-initial-focus", "");
		chosen.textContent = "Visible region"; container.append(chosen, chosen.cloneNode(true));
	});
	assert.ok(document.activeElement === chosen, "entry must skip ineligible markers and choose the first eligible marker");
	await act(async () => first.dispose());
	let explicit!: HTMLElement;
	await f.open("Preserve explicit focus", container => {
		const marker = chosen.cloneNode(true); explicit = document.createElement("button"); explicit.textContent = "Already focused";
		container.append(marker, explicit); explicit.focus();
	});
	assert.ok(document.activeElement === explicit, "a marker never overrides eligible focus already in the surface");
}));

it("a marker that cannot receive focus falls back to the existing field, heading and painted-frame policies", async () => withFixture(async f => {
	for (const kind of ["field", "heading", "frame"] as const) {
		let fallback!: HTMLElement;
		const handle = await f.open(`Unfocusable ${kind}`, container => {
			const marker = document.createElement("div"); marker.setAttribute("data-plugin-initial-focus", "");
			marker.focus = () => {}; // Browser refusal to focus an un-focusable plain div.
			container.append(marker);
			if (kind !== "frame") {
				fallback = document.createElement(kind === "field" ? "input" : "h2"); fallback.textContent = "Fallback"; container.append(fallback);
			}
		});
		assert.ok(document.activeElement === (kind === "frame" ? frame(surface(`Unfocusable ${kind}`)) : fallback), `failed marker focus preserves the ${kind} fallback`);
		await act(async () => handle.dispose());
	}
}));

it("remembered surviving focus wins over its marker, and native-page return does not adopt the surface-only marker", async () => withFixture(async f => {
	const chrome = document.createElement("button"); chrome.textContent = "Temporary opener"; document.body.append(chrome); chrome.focus();
	const one = await f.open("Remembered", container => {
		const marker = document.createElement("div"); marker.tabIndex = -1; marker.setAttribute("data-plugin-initial-focus", "");
		marker.textContent = "Marked region"; container.append(marker, document.createElement("input"));
	});
	const remembered = surface("Remembered").querySelector<HTMLElement>("input")!; remembered.focus();
	chrome.focus();
	const newer = await f.open("Newer", inputContent("Newer field")); chrome.remove();
	await act(async () => newer.dispose());
	assert.ok(document.activeElement === remembered, "remembered focus takes priority over the surviving marker");
	const nativeMarker = document.createElement("div"); nativeMarker.tabIndex = -1; nativeMarker.setAttribute("data-plugin-initial-focus", "");
	nativeMarker.textContent = "Not a surface marker"; document.querySelector("[data-native-body]")!.prepend(nativeMarker);
	await act(async () => one.dispose());
	assert.ok(document.activeElement === document.querySelector("[data-native-input]"), "the marker does not change native page entry");
}));

it("a marked surface cannot steal Settings focus, and a late marker never steals newer-view focus", async () => withFixture(async f => {
	await f.render({ settings: true });
	const settingsFocus = document.activeElement;
	let marker!: HTMLElement;
	await f.open("Below Settings", container => {
		marker = document.createElement("div"); marker.tabIndex = -1; marker.setAttribute("data-plugin-initial-focus", "");
		marker.textContent = "Review card"; container.append(marker);
	});
	assert.ok(document.activeElement === settingsFocus, "the modal stays authoritative above the marked surface");
	await f.render({ settings: false });
	assert.ok(document.activeElement === marker, "the marker becomes eligible only after Settings closes");
	let complete!: () => void;
	await f.open("Late marked content", async container => {
		await new Promise<void>(resolve => { complete = resolve; });
		const late = marker.cloneNode(true); container.append(late);
	});
	await f.open("Newer foreground", inputContent("Foreground field")); const focus = document.activeElement;
	await act(async () => complete()); assert.ok(document.activeElement === focus, "late content never steals foreground focus");
}));

it("foreground close restores an uncovered chrome opener, else remembered surviving region focus; covered disposal never steals", async () => withFixture(async f => {
	const chrome = document.querySelector<HTMLElement>("[data-chrome]")!;
	chrome.focus();
	const one = await f.open("One", inputContent("One field"));
	const oneField = surface("One").querySelector<HTMLElement>("input")!;
	assert.equal(document.activeElement, oneField);
	const two = await f.open("Two", inputContent("Two field"));
	await act(async () => two.dispose());
	assert.equal(document.activeElement, oneField);
	await act(async () => one.dispose());
	assert.equal(document.activeElement, chrome);
	const native = document.querySelector<HTMLElement>("[data-native-input]")!; native.focus();
	const fallback = await f.open("Fallback");
	native.remove();
	await act(async () => fallback.dispose());
	assert.equal(document.activeElement?.textContent, "Session", "detached opener falls back to native entry policy");
}));

it("a delayed covered mount completion never steals focus from a newer view", async () => withFixture(async f => {
	let complete!: () => void;
	let cleaned = 0;
	const first = await f.open("Slow", async container => {
		await new Promise<void>(resolve => { complete = resolve; });
		container.append(document.createElement("input"));
		return () => { cleaned++; };
	});
	await f.open("Newer", inputContent("Newer field"));
	const focus = document.activeElement;
	await act(async () => complete());
	assert.equal(document.activeElement, focus);
	await act(async () => first.dispose());
	assert.equal(cleaned, 1); assert.equal(document.activeElement, focus);
}));

it("native views and surfaces share ordered local paint; an older global modal remains eligible above a late surface", async () => withFixture(async f => {
	await f.open("Surface");
	await f.render({ nativeView: true });
	const native = document.querySelector<HTMLElement>("[data-native-view]")!;
	assert.equal(native.parentElement, document.querySelector("[data-session-surface-region]"));
	assert.ok(Number(native.style.zIndex) > Number(frame(surface("Surface")).style.zIndex));
	assert.equal(surface("Surface").hasAttribute("inert"), true);
	assert.equal(native.hasAttribute("inert"), false);
	await f.render({ settings: true });
	const modal = f.controller.getActiveModal()!;
	const settings = document.querySelector<HTMLElement>("[data-settings-input]")!;
	const settingsFocus = document.activeElement;
	await f.open("Late surface");
	assert.equal(f.controller.getTopLayer(), modal);
	assert.equal(f.controller.isElementEligible(settings), true);
	assert.equal(document.activeElement, settingsFocus);
	const region = document.querySelector<HTMLElement>("[data-session-surface-region]")!;
	assert.doesNotMatch(region.className, /\bz-40\b/);
	const main = region.closest<HTMLElement>("[data-host-main]")!;
	assert.equal(main.style.isolation, "isolate");
	assert.equal(main.contains(modal.rootRef.current), false, "global dialogs escape the isolated main-pane paint stratum");
	assert.equal(modal.rootRef.current!.parentElement, document.body);
	await act(async () => f.lifetime.abort());
	assert.equal(f.controller.getActiveModal(), modal, "global Settings is not lifetime-owned by a plugin surface");
}));

it("surface-owned menus/dialogs have explicit interaction ownership and one-Escape behavior", async () => withFixture(async f => {
	await f.open("Owner", container => { const button = document.createElement("button"); button.dataset.anchor = ""; button.textContent = "Open"; container.append(button); });
	const anchor = document.querySelector<HTMLElement>("[data-anchor]")!; anchor.focus();
	const owner = f.controller.getTopLayer()!;
	await act(async () => f.ui.openMenu(anchor, { items: [{ key: "one", label: "One", onSelect() {} }] }, { signal: new AbortController().signal }));
	assert.equal(f.controller.getTopLayer()?.ownerId, owner.id);
	await f.escape();
	assert.equal(f.controller.getTopLayer()?.id, owner.id); assert.ok(surface("Owner"));
	anchor.focus();
	await act(async () => f.ui.openDialog({ title: "Owned dialog", content: document.createElement("div") }, { signal: new AbortController().signal }));
	assert.equal(f.controller.getActiveModal()?.ownerId, owner.id);
	await f.escape();
	assert.equal(f.controller.getActiveModal(), null); assert.ok(surface("Owner"));
}));

for (const expiry of ["dispose", "leave"] as const) {
	it(`anchored menu with independent live owner/caller expires on surface ${expiry}, without close notification or global ghost`, async () => withFixture(async f => {
		const menuOwner = new AbortController(), caller = new AbortController();
		const otherUi = f.store.createUi({ signal: menuOwner.signal });
		let closes = 0;
		const anchor = document.createElement("button"); anchor.textContent = "Owned menu";
		const parent = await f.open("Menu parent", anchor);
		await act(async () => otherUi.openMenu(anchor, { onClose() { closes++; }, items: [{ key: "one", label: "One", onSelect() {} }] }, { signal: caller.signal }));
		assert.equal(f.controller.getTopLayer()?.kind, "popup"); assert.equal(f.store.getSnapshot().length, 2);
		if (expiry === "dispose") await act(async () => parent.dispose());
		else await f.render({ active: false });
		assert.equal(menuOwner.signal.aborted, false); assert.equal(caller.signal.aborted, false);
		assert.equal(closes, 0, "parent teardown is disposal, not a fabricated user close");
		assert.equal(f.store.getSnapshot().length, 0);
		assert.equal(f.controller.getTopLayer(), null);
		assert.equal(document.querySelector("[data-testid='plugin-menu']"), null);
		assert.equal(document.querySelector("[data-lh-menu]"), null);
		// A plugin callback that ignored its old surface signal and resumes late
		// cannot create a new globally portaled popup from the detached anchor.
		await act(async () => {
			await Promise.resolve();
			const stale = otherUi.openMenu(anchor, { onClose() { closes++; }, items: [] }, { signal: caller.signal });
			stale.update({ label: "Too late" }); stale.dispose();
		});
		assert.equal(f.store.getSnapshot().length, 0); assert.equal(f.controller.getTopLayer(), null); assert.equal(closes, 0);
	}));
}

for (const newer of ["plugin", "native"] as const) {
	it(`owned popup and passive tooltip paint above their frame but below a newer ${newer} view`, async () => withFixture(async f => {
		const slot = document.createElement("div");
		await f.open("Older frame", slot);
		const older = surface("Older frame"), olderFrame = frame(older);
		await f.render({ tooltipContainer: slot });
		const hint = document.querySelector<HTMLElement>("[data-slot='tooltip-content']")!;
		assert.ok(hint, "real passive TooltipContent mounted");
		const host = older.querySelector<HTMLElement>("[data-interaction-popup-host]")!;
		assert.equal(hint.closest("[data-interaction-popup-host]"), host);
		assert.equal(olderFrame.contains(hint), false, "popup host is outside the blurred/clipping visual frame");
		assert.equal(host.parentElement, olderFrame.parentElement);
		assert.equal(older.style.display, "contents", "semantic boundary does not establish another paint context");
		assert.equal(Number(host.style.zIndex), Number(olderFrame.style.zIndex));
		assert.equal(olderFrame.nextElementSibling, host, "same integer rank, host after frame, puts even z-50 tooltips above frame");
		assert.ok(Number.isInteger(Number(host.style.zIndex)));
		assert.ok(hint.classList.contains("z-50"), "tooltip's established visual styling is unchanged");
		assert.equal(f.controller.getSnapshot().length, 1, "passive tooltip adds no Escape owner");
		const anchor = slot.querySelector<HTMLElement>("button")!;
		await act(async () => f.ui.openMenu(anchor, { items: [{ key: "one", label: "One", onSelect() {} }] }, { signal: new AbortController().signal }));
		const menu = document.querySelector<HTMLElement>("[data-testid='plugin-menu']")!;
		assert.equal(menu.closest("[data-interaction-popup-host]"), host);
		assert.equal(f.controller.getTopLayer()?.kind, "popup");
		if (newer === "plugin") await f.open("Newer frame");
		else await f.render({ nativeView: true });
		const newerFrame = newer === "plugin" ? frame(surface("Newer frame")) : document.querySelector<HTMLElement>("[data-native-view]")!;
		assert.ok(Number(newerFrame.style.zIndex) > Number(host.style.zIndex), "new view paints above the entire old owned popup/tooltip host");
		assert.ok(host.contains(menu) && host.contains(hint), "covered overlays remain mounted in their older paint context");
		assert.equal(f.controller.getTopLayer()?.kind, "view", "logical foreground matches the higher painted view");
		assert.equal(f.controller.isElementEligible(menu), false);
		assert.equal(f.controller.isElementEligible(hint), false);
	}));
}
