import React, { act, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { InteractionLayersProvider, useInteractionLayer, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { SessionSurfaceRegion, useSessionSurfaceBoundary } from "../components/plugin-session-surfaces.tsx";
import { isInteractionScopeEligible } from "../components/plugin-input-focus.ts";
import { HostDialog } from "../components/host-dialog.tsx";
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
interface ViewOptions { active?: boolean; viewKey?: string; nativeView?: boolean; settings?: boolean; retainedHidden?: boolean; tooltipContainer?: HTMLElement }
interface Fixture {
	ui: PluginUi;
	store: ReturnType<typeof createPluginUiStore>;
	lifetime: AbortController;
	controller: InteractionLayersController;
	target(): PluginSurfaceTarget;
	render(options: ViewOptions): Promise<void>;
	open(title: string, content?: PluginUiContent, ui?: PluginUi): Promise<Handle>;
	escape(): Promise<void>;
}
function NativeFocus() {
	const root = useRef<HTMLDivElement>(null);
	const layer = useInteractionLayer({ kind: "view", enabled: true, rootRef: root, onClose: () => "blocked" });
	return <div ref={root} data-native-view="" className="pointer-events-auto absolute inset-0" style={{ zIndex: 100 + layer.order }}><h2 tabIndex={-1}>Native focus</h2><input aria-label="Native focus field" /></div>;
}
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
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
	let state: Required<Omit<ViewOptions, "tooltipContainer">> & Pick<ViewOptions, "tooltipContainer"> = { active: true, viewKey: "session-a", nativeView: false, settings: false, retainedHidden: false };
	function Boundary() {
		controller = useInteractionLayers();
		const body = useRef<HTMLDivElement>(null);
		token = useSessionSurfaceBoundary({ active: state.active, viewKey: state.viewKey, bodyRef: body });
		return <><button data-chrome="">Top bar</button><aside>Sidebar</aside>
			<div ref={body} data-session-body="" className="relative flex min-h-0 flex-1">
				<div data-native-body=""><h2 tabIndex={-1}>Session</h2><input data-native-input="" /><button>Native Submit</button></div>
				<SessionSurfaceRegion target={token}>{state.nativeView && <NativeFocus />}</SessionSurfaceRegion>
			</div>
			{state.tooltipContainer && createPortal(<TooltipProvider><Tooltip open><TooltipTrigger>Owned hint trigger</TooltipTrigger><TooltipContent>Owned passive hint</TooltipContent></Tooltip></TooltipProvider>, state.tooltipContainer)}
			<HostDialog open={state.settings} onClose={() => "blocked"} aria-label="Global Settings"><h2>Settings</h2><input data-settings-input="" /></HostDialog>
		</>;
	}
	const fixture: Fixture = {
		ui, store, lifetime, get controller() { return controller; },
		target() { assert.ok(token); return token; },
		async render(options) {
			state = { ...state, ...options };
			await act(async () => root.render(<InteractionLayersProvider><React.Activity mode={state.retainedHidden ? "hidden" : "visible"}><Boundary /></React.Activity><PluginUiHost store={store} /></InteractionLayersProvider>));
		},
		async open(title, content = document.createElement("div"), owner = ui) {
			let handle!: Handle;
			await act(async () => { handle = owner.openSurface(fixture.target(), { title, content }, { signal: new AbortController().signal }); });
			return handle;
		},
		async escape() {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as KeyboardEvent); document.dispatchEvent(event); });
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
const inputContent = (label: string): PluginUiContent => container => {
	const input = document.createElement("input"); input.setAttribute("aria-label", label); container.append(input);
};
const surface = (title: string) => [...document.querySelectorAll<HTMLElement>("[data-plugin-session-surface]")].find(root => root.querySelector("h2")?.textContent === title)!;
const frame = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-plugin-session-surface-frame]")!;

it("surfaces share the exact session body/local paint stratum, leaving chrome and empty native input eligible", async () => withFixture(async f => {
	const native = document.querySelector<HTMLElement>("[data-native-input]")!;
	const region = document.querySelector<HTMLElement>("[data-session-surface-region]")!;
	assert.equal(region.parentElement?.hasAttribute("data-session-body"), true);
	assert.match(region.className, /absolute inset-0 z-40/);
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
	assert.match(root.querySelector("h2")!.textContent!, /Drawing/);
	assert.equal(root.querySelector("[data-plugin-ui-widget]"), null);
	assert.match(root.querySelector("input")!.parentElement!.className, /h-full w-full/);
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

it("entry honors explicit eligible focus, otherwise first editable field, otherwise the supplied title", async () => withFixture(async f => {
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
	await f.open("Heading only");
	assert.equal(document.activeElement, surface("Heading only").querySelector("h2"));
	assert.equal(document.activeElement?.getAttribute("tabindex"), "-1");
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
	assert.match(region.className, /z-40/);
	assert.ok(Number(modal.rootRef.current!.style.zIndex) > 40, "global modal stratum remains above local view stratum");
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
