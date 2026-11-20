import React, { act, useCallback, useRef } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { parseHTML } from "linkedom";
import {
	InteractionLayersProvider, useInteractionLayers, type InteractionLayersController,
} from "../components/interaction-layers.tsx";
import {
	claimPluginInputFocus, dispatchFocusedPluginShortcut,
	isInteractionScopeEligible, isInputShortcutScopeEligible,
} from "../components/plugin-input-focus.ts";
import { useFieldCycle } from "../components/field-cycle.ts";
import { useEnterSubmits } from "../components/enter-submits.ts";
import { useChainNavigation, chainRow } from "../components/chain-navigation.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { SessionFind } from "../components/session-find.tsx";

let root: Root | undefined;
let cleanup: (() => void) | undefined;
function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	let focused: HTMLElement = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
	const proto = dom.window.HTMLElement.prototype;
	const originalFocus = proto.focus, originalBlur = proto.blur, originalScroll = proto.scrollIntoView;
	proto.focus = function () { focused = this; };
	proto.blur = function () { focused = dom.document.body; };
	proto.scrollIntoView = () => {};
	const style = (element: HTMLElement) => ({
		display: element.style.display || "block", visibility: element.style.visibility || "visible", opacity: element.style.opacity || "1",
		position: element.style.position || "static", overflow: element.style.overflow || "visible",
		paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
	});
	const globals = {
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 }, getComputedStyle: style,
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	Object.assign(dom.window, { getComputedStyle: style, innerWidth: 1200 });
	cleanup = () => {
		proto.focus = originalFocus; proto.blur = originalBlur; proto.scrollIntoView = originalScroll;
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	root = createRoot(document.querySelector("#root")!);
	let controller!: InteractionLayersController;
	function Probe() { controller = useInteractionLayers(); return null; }
	async function render(children: React.ReactNode, provided = true) {
		await act(async () => root!.render(provided ? <InteractionLayersProvider><Probe />{children}</InteractionLayersProvider> : children));
	}
	async function key(target: HTMLElement, key: string, extra: Record<string, unknown> = {}) {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key, ...extra });
		await act(async () => {
			// linkedom lacks window capture: invoke the provider's exact step.
			controller?.captureKeyDown(event as unknown as KeyboardEvent);
			target.dispatchEvent(event);
		});
		return event;
	}
	function addLayer(id: string, kind: "modal" | "popup" | "view", element: HTMLElement, anchor?: HTMLElement, ownerId?: string) {
		return controller.register({ id, kind, rootRef: { current: element }, anchorRef: { current: anchor ?? null }, ownerId, onClose: () => "blocked" });
	}
	return { dom, render, key, addLayer, controller: () => controller, focus: () => focused };
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; cleanup?.(); cleanup = undefined; });
const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
function Shortcuts() {
	const router = { bfcacheId: "keyboard-fixture", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
	return <AppRouterContext.Provider value={router}><KeyboardShortcuts /></AppRouterContext.Provider>;
}

it("one Escape closes only the cheat sheet's original owner and cannot reach abort fallback until the next event", async () => {
	const f = fixture(); let aborts = 0;
	await f.render(<Shortcuts />);
	const onAbort = () => { aborts++; }; window.addEventListener("lh:kbd-abort-turn", onAbort);
	try {
		await f.key(document.body, "?", { code: "Slash" });
		assert.ok(get("cheat-sheet"));
		const heading = document.querySelector<HTMLElement>("[role='heading']")!;
		assert.ok(heading); assert.equal(document.querySelector("[role='dialog']")?.getAttribute("aria-labelledby"), heading.id);
		await f.key(heading, "Escape");
		assert.equal(document.querySelector("[data-testid='cheat-sheet']"), null);
		assert.equal(aborts, 0, "closing the top layer never aborts the turn underneath");
		await f.key(document.body, "Escape"); assert.equal(aborts, 1);
	} finally { window.removeEventListener("lh:kbd-abort-turn", onAbort); }
});

it("Shift+Tab resolves a portaled plugin origin, while rebinding still receives and claims prevented Tab", async () => {
	const f = fixture(); let thinking = 0, candidates = 0, fields = 0;
	await f.render(<><Shortcuts /><div data-testid="plugin"><button data-testid="anchor" /></div><div data-testid="popup"><input data-testid="search" onKeyDown={event => {
		if (event.key === "Tab" && !event.shiftKey) { candidates++; event.stopPropagation(); }
	}} /></div></>);
	const off = claimPluginInputFocus(get("plugin"), { cycleThinking: () => { thinking++; } });
	const remove = f.addLayer("popup", "popup", get("popup"), get("anchor"));
	const onFields = () => { fields++; }; window.addEventListener("lh:kbd-cycle-fields", onFields);
	try {
		get("search").focus();
		const shiftTab = await f.key(get("search"), "Tab", { shiftKey: true });
		assert.equal(shiftTab.defaultPrevented, true); assert.equal(thinking, 1); assert.equal(f.focus(), get("search"));
		const tab = await f.key(get("search"), "Tab");
		assert.equal(tab.defaultPrevented, true); assert.equal(candidates, 1); assert.equal(fields, 0);
	} finally { window.removeEventListener("lh:kbd-cycle-fields", onFields); off(); remove(); }
});

it("field cycling skips hidden, disabled and modal/popup/view-covered fields, while eligible explicit cycling wraps", async () => {
	const f = fixture();
	function Fields() {
		useFieldCycle(useCallback(() => [...document.querySelectorAll<HTMLElement>("[data-cycle]")], []));
		return <><input data-cycle data-testid="first" /><input data-cycle hidden /><input data-cycle disabled />
			<div style={{ display: "none" }}><input data-cycle /></div><input data-cycle data-testid="last" />
			<div data-testid="surface"><input data-cycle data-testid="foreground" /></div></>;
	}
	await f.render(<Fields />);
	const cycle = async () => act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-cycle-fields")); });
	await cycle(); assert.equal(f.focus(), get("first"));
	await cycle(); assert.equal(f.focus(), get("last"));
	for (const kind of ["modal", "popup", "view"] as const) {
		const remove = f.addLayer(kind, kind, get("surface"));
		get("first").focus(); await cycle(); assert.equal(f.focus(), get("foreground"), `${kind} owns the field cycle`);
		await cycle(); assert.equal(f.focus(), get("foreground"), "never wraps into covered fields"); remove();
	}
});

it("global Enter submits only its eligible owner and never repeats an already-handled Enter", async () => {
	const f = fixture(); let background = 0, foreground = 0;
	function Submits() {
		const back = useRef<HTMLDivElement>(null), front = useRef<HTMLDivElement>(null);
		useEnterSubmits(() => { background++; }, back); useEnterSubmits(() => { foreground++; }, front);
		return <><div ref={back} data-testid="back" /><div ref={front} data-testid="front" /></>;
	}
	await f.render(<Submits />);
	const remove = f.addLayer("modal", "modal", get("front"));
	await f.key(document.body, "Enter"); assert.equal(background, 0); assert.equal(foreground, 1);
	const event = new f.dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: "Enter" }); event.preventDefault();
	await act(async () => { document.body.dispatchEvent(event); }); assert.equal(foreground, 1);
	remove();
});

it("portaled plugin popup retains only its own model/thinking input profile, never background fields or dictation", async () => {
	const f = fixture();
	await f.render(<><div data-testid="core" tabIndex={-1} /><div data-testid="plugin"><button data-testid="anchor" /></div><div data-testid="popup"><input data-testid="search" /></div></>);
	let core = 0, plugin = 0, dictation = 0;
	const offCore = claimPluginInputFocus(get("core"), { cycleThinking: () => { core++; } });
	const offPlugin = claimPluginInputFocus(get("plugin"), { cycleThinking: () => { plugin++; }, cycleModel: () => { plugin++; }, toggleDictation: () => { dictation++; } });
	const remove = f.addLayer("popup", "popup", get("popup"), get("anchor"));
	try {
		get("search").focus();
		assert.equal(isInteractionScopeEligible(get("plugin"), f.controller()), false);
		assert.equal(isInputShortcutScopeEligible(get("plugin"), f.controller()), true);
		assert.equal(isInputShortcutScopeEligible(get("core"), f.controller()), false);
		assert.equal(dispatchFocusedPluginShortcut("cycle-thinking", f.controller()), true);
		assert.equal(dispatchFocusedPluginShortcut("open-model-picker", f.controller()), true);
		assert.equal(dispatchFocusedPluginShortcut("toggle-dictation", f.controller()), false);
		assert.deepEqual([core, plugin, dictation], [0, 2, 0]);
		get("core").focus(); assert.equal(dispatchFocusedPluginShortcut("cycle-thinking", f.controller()), true);
		assert.deepEqual([core, plugin], [0, 3], "covered DOM focus cannot select a background profile");
	} finally { offCore(); offPlugin(); remove(); }
});

it("question's visible plain-Tab row/thinking cycle survives native Tab prevention, but does nothing behind a modal", async () => {
	const f = fixture();
	await f.render(<><QuestionDock toolName="quiz" toolCallId="q" input={{ question: "Pick", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "Yes" }} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} /><div data-testid="modal" tabIndex={-1} /></>);
	const first = await f.key(document.body, "Tab"); assert.equal(first.defaultPrevented, true);
	assert.ok(f.focus().closest("[data-kbdrow]"));
	await f.key(f.focus(), "Tab"); assert.ok(f.focus().closest("[data-testid='thinking-field']"));
	const remove = f.addLayer("modal", "modal", get("modal")); get("modal").focus();
	await f.key(get("modal"), "Tab"); assert.equal(f.focus(), get("modal"));
	remove();
});

it("ReadingThinking intentionally claims Escape even with no callback, without closing its containing modal", async () => {
	const f = fixture();
	await f.render(<div data-testid="modal"><ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} /></div>);
	let closes = 0;
	f.controller().register({ id: "modal", kind: "modal", rootRef: { current: get("modal") }, onClose: () => { closes++; return "blocked"; } });
	const field = document.querySelector<HTMLElement>("[data-file-path-input]")!;
	const event = await f.key(field, "Escape"); assert.equal(event.defaultPrevented, true); assert.equal(closes, 0);
	assert.equal(f.controller().isEscapeOwned(event as unknown as KeyboardEvent), true);
});

it("Chains Find/arrows work inside its OWN modal and are blocked by a child modal", async () => {
	const f = fixture();
	function Chains() {
		const rootRef = useRef<HTMLDivElement>(null), searchRef = useRef<HTMLInputElement>(null);
		useChainNavigation(rootRef, searchRef, true);
		return <div data-testid="modal" role="dialog"><div ref={rootRef} data-testid="chains" tabIndex={-1}><input ref={searchRef} data-testid="search" />
			<div {...chainRow(["row"], 0)} data-testid="row">Row</div></div></div>;
	}
	await f.render(<><Chains /><div data-testid="child" /></>);
	const remove = f.addLayer("modal", "modal", get("modal"));
	let selects = 0; (get("search") as HTMLInputElement).select = () => { selects++; };
	await act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-find")); });
	assert.equal(f.focus(), get("search")); assert.equal(selects, 1);
	await f.key(get("search"), "ArrowDown"); assert.equal(f.focus(), get("row"));
	const removeChild = f.addLayer("child", "modal", get("child")); get("child").focus();
	await act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-find")); });
	assert.equal(f.focus(), get("child")); assert.equal(selects, 1);
	removeChild(); remove();
});

it("Session Find cannot open behind a content view, modal or popup", async () => {
	const f = fixture();
	function Find() {
		const scope = useRef<HTMLDivElement>(null), scroll = useRef(null);
		return <><SessionFind scopeRef={scope} scrollContextRef={scroll} /><div ref={scope} data-testid="session" /><div data-testid="surface" /></>;
	}
	await f.render(<Find />);
	for (const kind of ["view", "modal", "popup"] as const) {
		const remove = f.addLayer(kind, kind, get("surface"));
		await act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-find")); });
		assert.equal(document.querySelector("[data-testid='session-find']"), null, kind); remove();
	}
});

it("legacy unprovided scopes ignore their containing dialog, but reject hidden fields and unrelated foreground layers", async () => {
	const f = fixture(); await f.render(<div role="dialog"><input data-testid="own" /></div>, false);
	assert.equal(isInteractionScopeEligible(get("own")), true);
	const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
	assert.equal(isInteractionScopeEligible(get("own")), false);
	modal.hidden = true; assert.equal(isInteractionScopeEligible(get("own")), true);
	get("own").hidden = true; assert.equal(isInteractionScopeEligible(get("own")), false);
});
