import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";

import { InteractionLayersProvider, useOptionalInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { CommitInput } from "../components/settings/controls.tsx";
import { installModalDom } from "./modal-dom.ts";

// These established browser primitives choose their isomorphic effect at
// import time. Load them as a browser would, then remove the bootstrap DOM
// before the explicit SSR proof and install an isolated DOM for each test.
const bootstrap = parseHTML("<html><body></body></html>");
const bootstrapGlobals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.document });
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, TOOLTIP_DELAY_MS } = await import("../components/ui/tooltip.tsx");
const { HostDialog } = await import("../components/host-dialog.tsx");
const { MenuShell } = await import("../components/menu-shell.tsx");
for (const [key, descriptor] of bootstrapGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }

it("SSRs without browser globals and keeps the trigger's unwrapped markup", () => {
	assert.equal(TOOLTIP_DELAY_MS, 500);
	const html = renderToString(<TooltipProvider><Tooltip defaultOpen><TooltipTrigger asChild><button className="original" data-testid="ssr">Control</button></TooltipTrigger><TooltipContent forceMount>Hint</TooltipContent></Tooltip></TooltipProvider>);
	assert.match(html, /^<button/); assert.ok(html.includes('class="original"'));
	assert.ok(!html.includes("tooltip-content"));
});

let root: Root | null = null;
let disposeGlobals: (() => void) | null = null;
function fixture(interactions = true) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
		SVGElement: dom.window.SVGElement, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	const originalError = console.error;
	const errors: string[] = [];
	console.error = (...args) => { errors.push(args.map(String).join(" ")); };
	const proto = dom.window.HTMLElement.prototype;
	const changed = new Map<string, PropertyDescriptor | undefined>();
	const define = (key: string, descriptor: PropertyDescriptor) => { changed.set(key, Object.getOwnPropertyDescriptor(proto, key)); Object.defineProperty(proto, key, { configurable: true, ...("value" in descriptor ? { writable: true } : {}), ...descriptor }); };
	define("getBoundingClientRect", { value(this: HTMLElement) {
		const width = this.tagName === "HTML" || this.tagName === "BODY" ? 1280 : 80;
		const height = this.tagName === "HTML" || this.tagName === "BODY" ? 800 : 24;
		const left = width === 1280 ? 0 : 100, top = width === 1280 ? 0 : 100;
		return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} };
	} });
	for (const key of ["offsetWidth", "clientWidth"]) define(key, { get(this: HTMLElement) { return this.tagName === "HTML" || this.tagName === "BODY" ? 1280 : 80; } });
	for (const key of ["offsetHeight", "clientHeight"]) define(key, { get(this: HTMLElement) { return this.tagName === "HTML" || this.tagName === "BODY" ? 800 : 24; } });
	define("blur", { value(this: HTMLElement) { this.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); dom.document.body.focus(); } });
	const style = (element: HTMLElement) => ({
		display: element.style.display || "block", visibility: element.style.visibility || "visible", position: element.style.position || "static",
		overflow: "visible", overflowX: "visible", overflowY: "visible", transform: element.style.transform || "none", perspective: "none", filter: "none", backdropFilter: "none",
		contain: "none", willChange: "auto", direction: "ltr", width: "80px", height: "24px", boxSizing: "border-box", animationName: "none",
		paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
		zIndex: element.style.zIndex || (element.classList.contains("z-50") ? "50" : "auto"), getPropertyValue: (key: string) => element.style.getPropertyValue(key),
	});
	const extra = {
		getComputedStyle: style, getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }), requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	};
	const savedExtra = new Map(Object.keys(extra).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, extra); Object.assign(dom.window, { getComputedStyle: style, getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }) });
	mock.timers.enable({ apis: ["setTimeout"] });
	root = createRoot(document.querySelector("#root")!);
	let controller: InteractionLayersController | null = null;
	function Probe() { controller = useOptionalInteractionLayers(); return null; }
	async function render(children: React.ReactNode) {
		await act(async () => { root!.render(interactions ? <InteractionLayersProvider><Probe />{children}</InteractionLayersProvider> : <><Probe />{children}</>); });
	}
	async function event(target: Element, type: string, detail: Record<string, unknown> = {}) {
		await act(async () => {
			const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { pointerType: "mouse", button: 0, isPrimary: true, clientX: 140, clientY: 112, ...detail });
			if (type === "keydown") controller?.captureKeyDown(event as unknown as KeyboardEvent);
			target.dispatchEvent(event);
		});
	}
	async function advance(ms: number) { await act(async () => { mock.timers.tick(ms); }); }
	async function focus(target: HTMLElement) { await act(async () => { target.focus(); }); }
	disposeGlobals = () => {
		mock.timers.reset();
		for (const [key, descriptor] of changed) { if (descriptor) Object.defineProperty(proto, key, descriptor); else Reflect.deleteProperty(proto, key); }
		for (const [key, descriptor] of savedExtra) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
		restoreModal();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
		console.error = originalError;
		assert.deepEqual(errors, [], "tooltip lifecycle has no console errors or stale updates");
	};
	return { dom, render, event, advance, focus, controller: () => controller! };
}
function element(selector: string): HTMLElement { const node = document.querySelector<HTMLElement>(selector); assert.ok(node, selector); return node; }
function hint(name = "one", props: React.ComponentProps<typeof Tooltip> = {}) {
	return <Tooltip {...props}><TooltipTrigger data-testid={`trigger-${name}`}>{name}</TooltipTrigger><TooltipContent data-testid={`content-${name}`}>{name} hint</TooltipContent></Tooltip>;
}
function content(name = "one") { return document.querySelector<HTMLElement>(`[data-testid='content-${name}']`); }
afterEach(async () => {
	await act(async () => { root?.unmount(); }); root = null;
	if (disposeGlobals) { await act(async () => { mock.timers.tick(0); }); disposeGlobals(); disposeGlobals = null; }
});

it("waits a cold 500ms, opens focus immediately, and never creates an interaction owner", async () => {
	const f = fixture();
	await f.render(<TooltipProvider>{hint()}</TooltipProvider>);
	const trigger = element("[data-testid='trigger-one']");
	await f.event(trigger, "pointermove"); await f.advance(499); assert.equal(content(), null);
	await f.advance(1); assert.equal(content()?.dataset.state, "delayed-open");
	assert.equal(f.controller().getSnapshot().length, 0);
	await f.event(trigger, "pointerout", { relatedTarget: document.body }); assert.equal(content(), null);
	await f.focus(trigger); assert.equal(content()?.dataset.state, "instant-open");
	await f.event(trigger, "keydown", { key: "Tab" });
	assert.ok(document.activeElement === trigger, "native Tab remains disabled by the application, not by a tooltip scope");
	assert.equal(content()?.dataset.state, "instant-open");
});

it("shares the 300ms warm window and returns to cold delay after scroll and outside close", async () => {
	const f = fixture();
	await f.render(<TooltipProvider>{hint("one")}{hint("two")}</TooltipProvider>);
	const one = element("[data-testid='trigger-one']"), two = element("[data-testid='trigger-two']");
	await f.focus(one); await f.event(one, "pointerout", { relatedTarget: document.body });
	await f.advance(299); await f.event(two, "pointermove"); assert.ok(content("two"));
	assert.equal(content("one"), null, "only one tooltip is visible");
	await f.event(two, "pointerout", { relatedTarget: document.body }); await f.advance(300);
	await f.event(one, "pointermove"); await f.advance(499); assert.equal(content("one"), null); await f.advance(1); assert.ok(content("one"));
	await f.event(document.body, "scroll"); assert.equal(content("one"), null);
	await f.event(one, "pointerout", { relatedTarget: document.body }); await f.advance(300);
	await f.event(one, "pointermove"); await f.advance(499); assert.equal(content(), null); await f.advance(1); assert.ok(content());
	await f.advance(0); await f.event(document.body, "pointerdown"); assert.equal(content(), null);
	await f.event(one, "pointerout", { relatedTarget: document.body }); await f.advance(300);
	await f.event(one, "pointermove"); await f.advance(499); assert.equal(content(), null); await f.advance(1); assert.ok(content());
});

it("preserves controlled/defaultOpen callbacks, prop updates and single-tooltip coordination", async () => {
	const f = fixture(false);
	const calls: string[] = [];
	const tree = (open: boolean, label: string) => <TooltipProvider>{hint("one", { open, onOpenChange: value => calls.push(`${label}:${value}`) })}{hint("two")}</TooltipProvider>;
	await f.render(tree(false, "old")); await f.focus(element("[data-testid='trigger-one']"));
	assert.equal(content(), null); assert.deepEqual(calls, ["old:true"]);
	await f.render(tree(true, "new")); assert.ok(content()); assert.deepEqual(calls, ["old:true"]);
	await f.event(document.body, "scroll"); assert.deepEqual(calls, ["old:true", "new:false"]); assert.ok(content(), "controlled refusal remains visible");
	await f.render(tree(false, "new")); assert.equal(content(), null);
	// Remount the uncontrolled root rather than switching control mode.
	await f.render(null); await f.render(<TooltipProvider>{hint("one", { defaultOpen: true, onOpenChange: value => calls.push(`default:${value}`) })}{hint("two")}</TooltipProvider>);
	assert.ok(content()); const before = calls.length;
	await f.focus(element("[data-testid='trigger-two']")); assert.equal(content(), null); assert.ok(content("two"));
	assert.deepEqual(calls.slice(before), ["default:false"]);
});

it("preserves asChild/ref, explicit IDs, aria-label descriptions, forceMount and all placement/style props", async () => {
	const f = fixture(false);
	const ref = React.createRef<HTMLButtonElement>();
	const contentRef = React.createRef<HTMLDivElement>();
	let escaped = 0;
	await f.render(<TooltipProvider><Tooltip><TooltipTrigger asChild ref={ref}><button data-testid="slotted" className="original">Control</button></TooltipTrigger>
		<TooltipContent forceMount ref={contentRef} id="own-description" aria-label="Accessible hint" side="left" align="start" sideOffset={9} className="extra" style={{ color: "red" }} onEscapeKeyDown={() => { escaped++; }}><span>Visual hint</span></TooltipContent>
	</Tooltip></TooltipProvider>);
	assert.ok(ref.current === element("[data-testid='slotted']")); assert.equal(ref.current.className, "original");
	assert.equal(ref.current.getAttribute("aria-describedby"), null);
	assert.equal(contentRef.current?.dataset.state, "closed");
	await f.focus(ref.current);
	assert.equal(ref.current.getAttribute("aria-describedby"), "own-description");
	assert.equal(element("#own-description").getAttribute("role"), "tooltip"); assert.equal(element("#own-description").textContent, "Accessible hint");
	assert.equal(contentRef.current?.getAttribute("role"), null); assert.equal(contentRef.current?.style.color, "red");
	assert.ok(contentRef.current?.classList.contains("z-50")); assert.ok(contentRef.current?.classList.contains("extra"));
	assert.equal(contentRef.current?.style.getPropertyValue("--radix-tooltip-trigger-width"), "var(--radix-popper-anchor-width)");
	await f.event(ref.current, "keydown", { key: "Escape" }); assert.equal(escaped, 0); assert.equal(contentRef.current?.dataset.state, "instant-open");
	await f.render(null); assert.equal(ref.current, null); assert.equal(contentRef.current, null);
});

it("keeps outside callbacks current without a reattachment gap, respects vetoes and defers touch until click", async () => {
	const f = fixture(false); const calls: string[] = [];
	const tree = (label: string, veto: boolean) => <TooltipProvider><Tooltip defaultOpen><TooltipTrigger>Control</TooltipTrigger>
		<TooltipContent onPointerDownOutside={event => { calls.push(label); assert.ok(event.detail.originalEvent); if (veto) event.preventDefault(); }}>Hint</TooltipContent>
	</Tooltip></TooltipProvider>;
	await f.render(tree("old", true)); await f.advance(0);
	await f.render(tree("new", true));
	await f.event(document.body, "pointerdown"); assert.deepEqual(calls, ["new"]); assert.ok(document.querySelector("[data-slot='tooltip-content']"));
	await f.render(tree("accepted", false));
	await f.event(document.body, "pointerdown", { pointerType: "touch" }); assert.deepEqual(calls, ["new"]);
	await f.event(document.body, "click"); assert.deepEqual(calls, ["new", "accepted"]); assert.equal(document.querySelector("[data-slot='tooltip-content']"), null);
});

it("supports Content asChild, closes on pointerdown and cancels delayed work on leave/unmount", async () => {
	const f = fixture(false); const calls: boolean[] = [];
	await f.render(<TooltipProvider><Tooltip onOpenChange={value => calls.push(value)}><TooltipTrigger data-testid="cancel-trigger">Control</TooltipTrigger>
		<TooltipContent asChild aria-label="Description"><section data-testid="content-child" className="kept">Visible</section></TooltipContent>
	</Tooltip></TooltipProvider>);
	const trigger = element("[data-testid='cancel-trigger']");
	await f.event(trigger, "pointermove"); await f.advance(250); await f.event(trigger, "pointerout", { relatedTarget: document.body }); await f.advance(500);
	assert.equal(document.querySelector("[data-testid='content-child']"), null); assert.deepEqual(calls, []);
	await f.focus(trigger); const child = element("[data-testid='content-child']");
	assert.equal(child.tagName, "SECTION"); assert.ok(child.classList.contains("kept")); assert.ok(child.querySelector("[role='tooltip']"));
	await f.event(trigger, "pointerdown"); assert.equal(document.querySelector("[data-testid='content-child']"), null);
	await f.event(trigger, "pointerup"); await f.advance(300);
	await f.event(trigger, "pointermove"); await f.render(null); await f.advance(1000);
	assert.deepEqual(calls, [true, false], "disposed delayed work never invokes a stale callback");
});

it("supports hoverable-content transit, closes outside the corridor, and ignores touch hover", async () => {
	const f = fixture();
	await f.render(<TooltipProvider>{hint("one", { disableHoverableContent: false })}</TooltipProvider>);
	const trigger = element("[data-testid='trigger-one']");
	await f.event(trigger, "pointermove", { pointerType: "touch" }); await f.advance(500); assert.equal(content(), null);
	await f.focus(trigger);
	const target = content()!;
	target.getBoundingClientRect = () => ({ left: 100, top: 60, right: 180, bottom: 84, width: 80, height: 24, x: 100, y: 60, toJSON() {} });
	await f.event(trigger, "pointerout", { relatedTarget: document.body, clientX: 140, clientY: 100 }); assert.ok(content());
	await f.event(document.body, "pointermove", { clientX: 140, clientY: 92 }); assert.ok(content(), "pointer can traverse the gap");
	await f.event(target, "pointermove", { clientX: 140, clientY: 75 }); assert.ok(content());
	await f.event(target, "pointerout", { relatedTarget: document.body, clientX: 140, clientY: 84 });
	await f.event(document.body, "pointermove", { clientX: 500, clientY: 500 }); assert.equal(content(), null);
});

it("places modal tooltips in the unclipped owned host and one Escape dismisses the dialog, not a tooltip", async () => {
	const f = fixture(); let closes = 0;
	function Harness() { const [open, setOpen] = React.useState(true); return <HostDialog open={open} layerId="modal" onClose={() => { closes++; setOpen(false); return "closed"; }} frame={<div data-testid="visual" style={{ transform: "translateY(1px)", overflowY: "auto" }} />}>
		<h2>Dialog</h2><TooltipProvider>{hint()}</TooltipProvider></HostDialog>; }
	await f.render(<Harness />); await f.focus(element("[data-testid='trigger-one']"));
	assert.ok(content()?.closest("[data-interaction-popup-host='modal']")); assert.equal(content()?.closest("[data-testid='visual']"), null);
	assert.deepEqual(f.controller().getSnapshot().map(layer => layer.id), ["modal"]);
	await f.event(element("[data-testid='trigger-one']"), "keydown", { key: "Escape" });
	assert.equal(closes, 1); assert.equal(document.querySelector("[role='dialog']"), null);
});

it("a focused menu action's tooltip never intercepts the menu's first physical Escape", async () => {
	const f = fixture(); let menuCloses = 0, modalCloses = 0;
	function Harness() {
		const anchor = React.useRef<HTMLButtonElement>(null); const [menu, setMenu] = React.useState(true);
		return <HostDialog open onClose={() => { modalCloses++; return "blocked"; }} layerId="modal"><h2>Dialog</h2><button ref={anchor}>Menu</button>
			{menu && <MenuShell anchorRef={anchor} testid="menu" preferredSide="down" menuClass="menu" onClose={() => { menuCloses++; setMenu(false); return "closed"; }}><TooltipProvider>{hint()}</TooltipProvider></MenuShell>}
		</HostDialog>;
	}
	await f.render(<Harness />); await f.focus(element("[data-testid='trigger-one']")); assert.ok(content());
	assert.equal(f.controller().getSnapshot().length, 2);
	await f.event(element("[data-testid='trigger-one']"), "keydown", { key: "Escape" });
	assert.equal(menuCloses, 1); assert.equal(modalCloses, 0); assert.equal(document.querySelector("[data-testid='menu']"), null);
});

it("a visible tooltip cannot preempt CommitInput Escape's field blur/save path or close the dialog", async () => {
	const f = fixture(); const commits: string[] = []; let closes = 0;
	await f.render(<HostDialog open onClose={() => { closes++; return "blocked"; }}><h2>Settings</h2>
		<CommitInput value="before" ariaLabel="Field" testid="commit-field" onCommit={next => { commits.push(next); return true; }} />
		<TooltipProvider><Tooltip defaultOpen><TooltipTrigger>Field help</TooltipTrigger><TooltipContent>Field hint</TooltipContent></Tooltip></TooltipProvider>
	</HostDialog>);
	const field = element("[data-testid='commit-field']") as HTMLInputElement;
	await f.focus(field); assert.ok(document.querySelector("[data-slot='tooltip-content']"));
	field.value = "retained"; await f.event(field, "input"); await f.event(field, "keydown", { key: "Escape" });
	assert.deepEqual(commits, ["retained"]); assert.equal(closes, 0); assert.ok(document.querySelector("[role='dialog']"));
});
