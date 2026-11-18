import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { MermaidOverlay } from "../components/session-overlay.tsx";
import { PlanPopup } from "../components/plan-block.tsx";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { installModalDom } from "./modal-dom.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const restoreDom = installModalDom(dom);
after(restoreDom);
dom.window.HTMLInputElement.prototype.select = function () {};
const nativeClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
let controller: InteractionLayersController;
function Probe() { controller = useInteractionLayers(); return null; }
const directory = { organization: { version: 1, folders: [], placements: {} },
	sources: [{ id: "note", kind: "notes", label: "A note", createdAt: "now" }] };
async function mount(children: React.ReactNode) {
	document.body.focus();
	globalThis.fetch = async () => Response.json(directory);
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => { root!.render(<InteractionLayersProvider><Probe />
		<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
			<button data-testid="sidebar">Sidebar</button>{children}
		</ServerEventsProvider>
	</InteractionLayersProvider>); });
}
afterEach(async () => {
	await act(async () => { root?.unmount(); }); root = undefined;
	// Flush FocusScope's delayed unmount event while fixture CustomEvent is installed.
	await new Promise(resolve => setTimeout(resolve, 5));
	host?.remove(); globalThis.fetch = originalFetch;
});
async function escape(target: Element = document.body) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: "Escape" });
	await act(async () => { target.dispatchEvent(event); }); return event;
}
async function click(id: string) {
	const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(target, id);
	await act(async () => { target.click(); });
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"></svg>';
for (const kind of ["chains", "diagram", "plan"] as const) {
	it(`${kind} retains content-area bounds, sidebar eligibility and its existing focus policy`, async () => {
		let closes = 0;
		const close = () => { closes++; };
		await mount(kind === "chains" ? <ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={close} />
			: kind === "diagram" ? <MermaidOverlay svg={svg} onClose={close} /> : <PlanPopup messages={[]} onClose={close} />);
		const layer = controller.getTopLayer()!;
		assert.equal(layer.kind, "view"); assert.equal(controller.getActiveModal(), null);
		const frame = layer.rootRef.current!;
		assert.match(frame.className, /absolute inset-0 z-40/);
		assert.match(frame.className, /bg-background\/80/); assert.match(frame.className, /backdrop-blur-sm/);
		assert.equal(frame.hasAttribute("aria-modal"), false);
		assert.equal(frame.getAttribute("role"), kind === "chains" ? null : "region");
		const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
		assert.equal(controller.isElementEligible(sidebar), true);
		assert.equal(sidebar.closest("[inert], [aria-hidden='true']"), null);
		if (kind !== "chains") assert.equal(document.activeElement, document.body, "views introduce no modal initial-focus default");
		sidebar.focus(); assert.equal(document.activeElement, sidebar, "no focus containment");
		const event = await escape(sidebar);
		assert.equal(event.defaultPrevented, true); assert.equal(closes, 1);
	});
}

it("a child popup owns one Escape; a refusing child consumes it without closing the content view", async () => {
	let closes = 0, popupCloses = 0;
	await mount(<PlanPopup messages={[]} onClose={() => { closes++; }} />);
	const view = controller.getTopLayer()!;
	const popup = document.createElement("div"); document.body.append(popup);
	let unregister = () => {};
	try {
		await act(async () => { unregister = controller.register({ id: "child", kind: "popup", ownerId: view.id,
			rootRef: { current: popup }, onClose: () => { popupCloses++; unregister(); return "closed"; } }); });
		await escape(popup);
		assert.equal(popupCloses, 1); assert.equal(closes, 0);
		await escape(); assert.equal(closes, 1);
		await act(async () => { unregister = controller.register({ id: "busy-child", kind: "popup", ownerId: view.id,
			rootRef: { current: popup }, onClose: () => "blocked" }); });
		assert.equal((await escape()).defaultPrevented, true); assert.equal(closes, 1);
	} finally { await act(async () => { unregister(); }); popup.remove(); }
});

it("a target's claimed Escape remains leaf-owned, and explicit view close controls keep their action", async () => {
	let closes = 0;
	await mount(<MermaidOverlay svg={svg} onClose={() => { closes++; }} />);
	const frame = controller.getTopLayer()!.rootRef.current!;
	const editor = document.createElement("input"); frame.append(editor);
	editor.addEventListener("keydown", event => controller.claimEscape(event));
	assert.equal((await escape(editor)).defaultPrevented, true); assert.equal(closes, 0);
	await click("mermaid-overlay-close"); assert.equal(closes, 1);
});

it("Chains source deletion is a logically owned child and busy Escape never closes either surface", async () => {
	let closes = 0, finishDelete: (() => void) | undefined;
	await mount(<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => { closes++; }} />);
	const viewId = controller.getTopLayer()!.id;
	await click("cluster-checkbox-note"); await click("chain-delete");
	assert.equal(controller.getTopLayer()!.kind, "modal");
	assert.equal(controller.getTopLayer()!.ownerId, viewId, "body-portaled child retains view lifetime ownership");
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "DELETE") await new Promise<void>(resolve => { finishDelete = resolve; });
		return Response.json(directory);
	};
	await click("source-delete-confirm");
	assert.ok(finishDelete);
	assert.equal((await escape()).defaultPrevented, true);
	assert.ok(document.querySelector('[data-testid="delete-source-dialog"]')); assert.equal(closes, 0);
	await act(async () => { finishDelete!(); });
	assert.equal(document.querySelector('[data-testid="delete-source-dialog"]'), null); assert.equal(closes, 0);
	await escape(); assert.equal(closes, 1);
});

it("the full-window picker opts out of duplicate view ownership and inherits the modal owner", async () => {
	let closes = 0;
	function Picker() {
		const [open, setOpen] = useState(true);
		const headingRef = useRef<HTMLHeadingElement>(null);
		return <HostDialog open={open} headingRef={headingRef} onClose={() => { closes++; setOpen(false); return "closed"; }}>
			<h2 ref={headingRef}>Picker</h2>
			<ChainTableOverlay open registerInteraction={false} nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => { closes++; setOpen(false); }} />
		</HostDialog>;
	}
	await mount(<Picker />);
	assert.equal(controller.getSnapshot().length, 1, "one surface, one registration");
	assert.equal(controller.getTopLayer()!.kind, "modal");
	const modalId = controller.getTopLayer()!.id;
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-find")); });
	const search = document.querySelector<HTMLElement>('[data-testid="chain-table-search"]')!;
	assert.equal(document.activeElement === search, true, "picker-owned Find is not blocked by its own dialog");
	const down = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(down, "key", { value: "ArrowDown" });
	await act(async () => { search.dispatchEvent(down); });
	assert.equal(down.defaultPrevented, true);
	assert.ok(document.querySelector("[data-chain-nav-active]"), "picker-owned arrow navigation remains active");
	await click("cluster-checkbox-note"); await click("chain-delete");
	assert.equal(controller.getTopLayer()!.ownerId, modalId, "no phantom view owner between picker and confirmation");
	await escape(); assert.equal(closes, 0);
	await escape(); assert.equal(closes, 1); assert.equal(controller.getSnapshot().length, 0);
});
