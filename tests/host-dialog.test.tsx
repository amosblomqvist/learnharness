import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayer, useInteractionLayers, useOptionalInteractionLayers, type InteractionLayersController, type OpeningLease } from "../components/interaction-layers.tsx";

it("closed dialogs and provider SSR do not access browser globals", () => {
	assert.equal(renderToString(<HostDialog open={false} onClose={() => "closed"}>closed</HostDialog>), "");
	assert.equal(renderToString(<InteractionLayersProvider><span>server</span></InteractionLayersProvider>), "<span>server</span>");
	function OptionalProbe() { return <span>{useOptionalInteractionLayers() === null ? "absent" : "present"}</span>; }
	assert.equal(renderToString(<OptionalProbe />), "<span>absent</span>");
	assert.equal(renderToString(<InteractionLayersProvider><OptionalProbe /></InteractionLayersProvider>), "<span>present</span>");
	function RequiredProbe() { useInteractionLayers(); return null; }
	assert.throws(() => renderToString(<RequiredProbe />), /require InteractionLayersProvider/);
});

let root: Root | null = null;
let cleanupGlobals: (() => void) | null = null;
function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div><button id='launcher'>launch</button></body></html>");
	let active: Element = dom.document.querySelector("#launcher")!;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	const prototype = dom.window.HTMLElement.prototype;
	const originalFocus = prototype.focus;
	const originalSetAttribute = prototype.setAttribute;
	const legacyInputDescriptors = new Map(["attachEvent", "detachEvent"].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
	// ReactDOM was imported for SSR before a browser existed; its legacy
	// input-event branch needs these stubs in linkedom (not in Chromium).
	Object.assign(prototype, { attachEvent() {}, detachEvent() {} });
	// linkedom preserves camel-cased HTML attributes, unlike Chromium.
	prototype.setAttribute = function (name: string, value: string) { originalSetAttribute.call(this, name.toLowerCase(), value); };
	let focusCalls = 0;
	prototype.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		if (++focusCalls > 100) throw new Error("fixture focus recursion");
		active = this;
		this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
	};
	const style = (element: HTMLElement) => ({
		display: element.style.display || "block", visibility: element.style.visibility || "visible",
		position: element.style.position || "static", overflow: element.style.overflow || "visible",
		paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
	});
	const globals = {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement,
		MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		getComputedStyle: style, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	Object.assign(dom.window, { getComputedStyle: style, innerWidth: 1200 });
	cleanupGlobals = () => {
		prototype.focus = originalFocus;
		prototype.setAttribute = originalSetAttribute;
		for (const [key, descriptor] of legacyInputDescriptors) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	root = createRoot(dom.document.querySelector("#root")!);
	let controller!: InteractionLayersController;
	function Probe() { controller = useInteractionLayers(); return null; }
	async function render(children: React.ReactNode) {
		await act(async () => { root!.render(<InteractionLayersProvider><Probe />{children}</InteractionLayersProvider>); });
	}
	return { dom, render, controller: () => controller };
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	// Flush only our and FocusScope's documented delayed cleanup, before
	// removing this fixture's DOM. No browser, app server or user data involved.
	await new Promise(resolve => setTimeout(resolve, 5));
	cleanupGlobals?.();
	cleanupGlobals = null;
});

it("preserves the visual frame and selects first editable text rather than a button", async () => {
	const f = fixture();
	const visualRef = React.createRef<HTMLDivElement>();
	await f.render(<HostDialog open onClose={() => "blocked"} layerId="dialog" frame={<div ref={visualRef} className="existing-frame" data-testid="frame" style={{ transform: "translateY(2px)", overflowY: "auto" }} />} backdropProps={{ className: "existing-scrim", "data-testid": "backdrop" }} aria-label="Fixture">
		<button>Action</button><input disabled /><input readOnly /><input type="hidden" /><input style={{ display: "none" }} /><div hidden><input /></div><input data-testid="editable" /><h2>Heading</h2>
	</HostDialog>);
	const frame = document.querySelector<HTMLElement>("[data-testid='frame']")!;
	const boundary = document.querySelector<HTMLElement>("[role='dialog']")!;
	assert.equal(frame.className, "existing-frame");
	assert.equal(frame.style.transform, "translateY(2px)");
	assert.equal(frame.style.overflowY, "auto");
	assert.ok(visualRef.current === frame, "original visual ref retained");
	assert.equal(boundary.getAttribute("aria-label"), "Fixture");
	assert.ok(document.activeElement === frame.querySelector("[data-testid='editable']"), `expected editable focus; got ${document.activeElement?.outerHTML}`);
	const popupHost = f.controller().getPortalContainer(frame);
	assert.ok(popupHost);
	assert.equal(boundary.contains(popupHost), true);
	assert.equal(frame.contains(popupHost), false);
	assert.equal(popupHost.style.transform || "", "");
	assert.equal(popupHost.style.isolation, "isolate", "owned popup stack is independent of caller frame/backdrop z-index");
	assert.equal(boundary.firstElementChild?.getAttribute("style"), "isolation:isolate");
	assert.equal(document.querySelector("#launcher")?.getAttribute("aria-hidden"), "true");
});

it("includes editable number inputs in default focus without changing native types or steppers", async () => {
	const f = fixture();
	await f.render(<HostDialog open onClose={() => "closed"}>
		<h2>Agent settings</h2><input type="number" disabled /><input type="number" readOnly />
		<input type="number" style={{ display: "none" }} /><input type="number" data-testid="first-number" min={1} max={16} step={1} defaultValue={4} />
		<input type="text" data-testid="later-text" />
	</HostDialog>);
	const number = document.querySelector<HTMLInputElement>("[data-testid='first-number']")!;
	assert.ok(document.activeElement === number, `expected first editable number focus; got ${document.activeElement?.outerHTML}`);
	assert.equal(number.getAttribute("type"), "number");
	assert.equal(number.getAttribute("min"), "1");
	assert.equal(number.getAttribute("max"), "16");
	assert.equal(number.getAttribute("step"), "1");
	assert.equal(number.value, "4");
});

it("uses explicit initial focus, otherwise a programmatically focusable heading", async () => {
	const f = fixture();
	const explicit = React.createRef<HTMLButtonElement>();
	await f.render(<HostDialog open onClose={() => "closed"} initialFocusRef={explicit}><h2>Heading</h2><input /><button ref={explicit}>Explicit</button></HostDialog>);
	assert.ok(document.activeElement === explicit.current, `expected explicit focus; got ${document.activeElement?.outerHTML}`);
	await f.render(null);
	await f.render(<HostDialog open onClose={() => "closed"}><button>Not default focus</button><input readOnly /><h2 data-testid="heading">Heading</h2></HostDialog>);
	assert.ok(document.activeElement === document.querySelector("[data-testid='heading']"), `expected heading focus; got ${document.activeElement?.outerHTML}`);
	assert.equal(document.activeElement?.getAttribute("tabindex"), "-1");
});

it("resolves an app-root widget popup's modal ownership from its DOM anchor", async () => {
	const f = fixture();
	const anchorRef = React.createRef<HTMLButtonElement>();
	function WidgetPopup() {
		const controller = useInteractionLayers();
		const rootRef = React.useRef<HTMLDivElement>(null);
		useInteractionLayer({ id: "widget-popup", kind: "popup", enabled: true, rootRef, anchorRef, onClose: () => "closed" });
		const host = controller.getPortalContainer(anchorRef.current);
		return host && createPortal(<div ref={rootRef} data-testid="widget-popup"><button>Widget action</button></div>, host);
	}
	function contents(popup: boolean) {
		return <><HostDialog open onClose={() => "closed"} layerId="widget-modal" frame={<div className="animated-overflow-frame" style={{ transform: "translateY(1px)", overflowY: "auto" }} />}>
			<h2>Widget modal</h2><button ref={anchorRef}>Open menu</button>
		</HostDialog>{popup && <WidgetPopup />}</>;
	}
	await f.render(contents(false));
	await f.render(contents(true));
	const popup = document.querySelector<HTMLElement>("[data-testid='widget-popup']")!;
	assert.equal(f.controller().getLayer("widget-popup")?.ownerId, "widget-modal");
	assert.equal(f.controller().ownerOf(popup)?.id, "widget-popup");
	assert.equal(f.controller().isElementEligible(popup), true);
	assert.equal(f.controller().isPopupOrigin(anchorRef.current), true);
	assert.equal(popup.closest("[role='dialog']")?.getAttribute("data-interaction-layer"), "widget-modal");
	assert.equal(popup.closest(".animated-overflow-frame"), null);
});

it("routes React leaf Escape before modal dismissal and still delivers prevented Tab", async () => {
	const f = fixture();
	let closes = 0;
	const keys: string[] = [];
	await f.render(<HostDialog open layerId="leaf-dialog" onClose={() => { closes++; return "blocked"; }}>
		<h2 data-testid="leaf-heading">Heading</h2>
		<input data-testid="leaf-input" onKeyDown={event => { keys.push(event.key); if (event.key === "Escape") event.preventDefault(); }} />
	</HostDialog>);
	const field = document.querySelector<HTMLElement>("[data-testid='leaf-input']")!;
	async function key(target: HTMLElement, name: string) {
		const event = new f.dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: name });
		await act(async () => {
			// linkedom does not implement window capture. Exercise that exact
			// provider step before the real React target/document bubble path.
			f.controller().captureKeyDown(event as unknown as KeyboardEvent);
			target.dispatchEvent(event);
		});
		return event;
	}
	await key(field, "Escape");
	assert.equal(closes, 0);
	const tab = await key(field, "Tab");
	assert.equal(tab.defaultPrevented, true);
	assert.deepEqual(keys, ["Escape", "Tab"]);
	assert.ok(document.activeElement === field, "FocusScope does not loop or move focus on Tab");
	const escape = await key(document.querySelector<HTMLElement>("[data-testid='leaf-heading']")!, "Escape");
	assert.equal(closes, 1);
	assert.equal(escape.defaultPrevented, true);
});

it("reconciles cached replacement after real modal isolation cleanup and keeps rapid batched focus authority", async () => {
	const f = fixture();
	type Presentation = { name: "a" | "b"; lease: OpeningLease };
	let show!: (name: Presentation["name"]) => void;
	let close!: () => void;
	let revokes = 0;
	let normalCloses = 0;
	function Harness() {
		const controller = useInteractionLayers();
		const aRef = React.useRef<HTMLButtonElement>(null);
		const bRef = React.useRef<HTMLButtonElement>(null);
		const pending = React.useRef<Presentation | null>(null);
		const [presentation, setPresentation] = React.useState<Presentation | null>(null);
		const promote = React.useCallback(() => {
			const next = pending.current;
			if (!next?.lease.ready()) return;
			pending.current = null;
			if (next.lease.activate()) setPresentation(next);
		}, []);
		React.useLayoutEffect(() => controller.subscribe(promote), [controller, promote]);
		show = name => {
			const lease = controller.reserveOpening("cached-fixture", {
				opener: name === "a" ? aRef.current : bRef.current,
				onRevoke() {
					revokes++;
					if (pending.current?.lease === lease) pending.current = null;
					setPresentation(current => current?.lease === lease ? null : current);
				},
			});
			if (!lease) return;
			pending.current = { name, lease };
			promote();
		};
		close = () => { presentation?.lease.release(); setPresentation(null); };
		return <><button ref={aRef} data-testid="cached-a">A</button><button ref={bRef} data-testid="cached-b">B</button>
			{presentation && <HostDialog key={presentation.name} open layerId="cached-shared" openingLease={presentation.lease}
				onClose={() => { normalCloses++; presentation.lease.release(); setPresentation(null); return "closed"; }}>
				<h2>{presentation.name}</h2><input data-testid={`cached-field-${presentation.name}`} />
			</HostDialog>}</>;
	}
	await f.render(<Harness />);
	await act(async () => { show("a"); });
	assert.equal(document.querySelector("[data-testid='cached-b']")?.closest("[aria-hidden='true']") !== null, true);
	await act(async () => { show("b"); });
	assert.equal(document.querySelectorAll("[role='dialog']").length, 1);
	assert.equal(f.controller().getSnapshot().filter(layer => layer.id === "cached-shared").length, 1);
	assert.ok(document.activeElement === document.querySelector("[data-testid='cached-field-b']"));
	await act(async () => { show("a"); show("b"); });
	assert.equal(document.querySelectorAll("[role='dialog']").length, 1, "batched cached ABA never registers duplicate IDs");
	assert.equal(normalCloses, 2, "each exact retiring mounted layer closes once");
	assert.ok(revokes >= 2);
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	assert.ok(document.activeElement === document.querySelector("[data-testid='cached-field-b']"), "old delayed callbacks never steal the latest modal focus");
	await act(async () => { close(); });
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	assert.ok(document.activeElement === document.querySelector("[data-testid='cached-b']"), "ordinary close still returns to its own eligible invoker");
});

it("retains qualified backdrop gestures rather than generic outside dismissal", async () => {
	const f = fixture();
	let closes = 0;
	await f.render(<HostDialog open onClose={reason => { assert.equal(reason, "backdrop"); closes++; return "closed"; }} backdropProps={{ "data-testid": "gesture-backdrop" }}>
		<h2 data-testid="gesture-inside">Heading</h2>
	</HostDialog>);
	const backdrop = document.querySelector<HTMLElement>("[data-testid='gesture-backdrop']")!;
	const inside = document.querySelector<HTMLElement>("[data-testid='gesture-inside']")!;
	async function event(target: HTMLElement, type: string) {
		await act(async () => {
			const event = new f.dom.window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { pointerId: 1, isPrimary: true, button: 0 });
			target.dispatchEvent(event);
		});
	}
	await event(inside, "pointerdown");
	await event(backdrop, "pointerup");
	await event(backdrop, "click");
	assert.equal(closes, 0, "a drag that began inside never dismisses");
	await event(backdrop, "click");
	assert.equal(closes, 0, "synthetic clicks without a qualified gesture never dismiss");
	await event(backdrop, "pointerdown");
	await event(backdrop, "pointerup");
	await event(backdrop, "click");
	assert.equal(closes, 1);
});

it("keeps covered parents mounted and painted while isolating the child", async () => {
	const f = fixture();
	let parentMounts = 0;
	function ParentBody() {
		React.useEffect(() => { parentMounts++; }, []);
		return <><h2>Parent</h2><input data-testid="parent-field" defaultValue="retained" /></>;
	}
	function dialogs(child: boolean) {
		return <><HostDialog open onClose={() => "closed"} layerId="parent" frame={<div data-testid="parent-frame" />}><ParentBody /></HostDialog>
			{child && <HostDialog open onClose={() => "blocked"} layerId="child" ownerId="parent"><h2>Child</h2><input data-testid="child-field" /></HostDialog>}</>;
	}
	await f.render(dialogs(false));
	const parentFrame = document.querySelector<HTMLElement>("[data-testid='parent-frame']")!;
	parentFrame.scrollTop = 43;
	const field = document.querySelector<HTMLInputElement>("[data-testid='parent-field']")!;
	field.value = "edited";
	await f.render(dialogs(true));
	assert.equal(parentMounts, 1);
	assert.equal(parentFrame.isConnected, true);
	assert.equal(parentFrame.hidden, false);
	assert.notEqual(parentFrame.style.display, "none");
	assert.equal(parentFrame.scrollTop, 43);
	assert.equal(field.value, "edited");
	assert.equal(parentFrame.closest("[data-interaction-layer]")?.hasAttribute("inert"), true);
	assert.equal(f.controller().isElementEligible(field), false);
	assert.equal(document.body.getAttribute("data-scroll-locked"), "1", "only the active modal owns scroll isolation");
	assert.ok(document.activeElement === document.querySelector("[data-testid='child-field']"), `expected child focus; got ${document.activeElement?.outerHTML}`);
	await f.render(dialogs(false));
	await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
	assert.equal(parentFrame.closest("[data-interaction-layer]")?.hasAttribute("inert"), false);
	assert.ok(document.activeElement === field, `expected resumed parent focus; got ${document.activeElement?.outerHTML}`);
});
