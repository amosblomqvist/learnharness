import React, { act, useEffect, useRef, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { HostDialog } from "../components/host-dialog.tsx";
import { MenuShell } from "../components/menu-shell.tsx";
import { usePopoverDismiss } from "../components/popover-dismiss.ts";
import { createPortal } from "react-dom";
import { installModalDom } from "./modal-dom.ts";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { usePluginMenuDismiss } from "../components/plugin-model-picker.tsx";

async function withDom(run: (controller: () => InteractionLayersController, render: (node: React.ReactNode) => Promise<void>) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const values = { React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
		getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }) };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const restore = installModalDom(dom);
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const { createRoot } = await import("react-dom/client");
	let controller!: InteractionLayersController;
	function Probe({ children }: { children: React.ReactNode }) { controller = useInteractionLayers(); return children; }
	const root = createRoot(document.querySelector("#root")!);
	try {
		await run(() => controller, async node => {
			await act(async () => { root.render(<InteractionLayersProvider><Probe>{node}</Probe></InteractionLayersProvider>); });
		});
	} finally {
		await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 5)); });
		restore();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}
const click = async (selector: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(selector)!.click(); }); };
async function key(controller: InteractionLayersController, target: Element, value: string, shiftKey = false) {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: value, shiftKey });
	await act(async () => {
		// linkedom does not implement the browser's window capture route.
		controller.captureKeyDown(event as KeyboardEvent);
		target.dispatchEvent(event);
	});
	return event;
}

function ModalMenu({ blocked = false, searchable = false }: { blocked?: boolean; searchable?: boolean }) {
	const [open, setOpen] = useState(true), [menu, setMenu] = useState(false), [edited, setEdited] = useState(true);
	const trigger = useRef<HTMLButtonElement>(null);
	const controller = useInteractionLayers();
	return <HostDialog open={open} onClose={() => { setOpen(false); return "closed"; }} aria-label="Parent" frame={<div data-testid="parent" />}>
		<h2>Parent</h2><button ref={trigger} data-testid="trigger" onClick={() => setMenu(true)}>Menu</button>
		{menu && <MenuShell anchorRef={trigger} testid="test-menu" preferredSide="down" menuClass="fixture-menu"
			onClose={() => { if (blocked) return "blocked"; setMenu(false); return "closed"; }}>
			{searchable && <input data-testid="search" onKeyDown={event => {
				if (event.key === "Escape" && edited) { controller.claimEscape(event); event.stopPropagation(); setEdited(false); }
			}} data-edited={edited} />}
			<button data-testid="first">First</button><button disabled>Disabled</button><button data-testid="last">Last</button>
		</MenuShell>}
	</HostDialog>;
}

test("popup is portaled into its modal host; focused leaf Escape precedes menu then parent", async () => withDom(async (controller, render) => {
	await render(<ModalMenu searchable />);
	await click('[data-testid="trigger"]');
	const menu = document.querySelector<HTMLElement>('[data-testid="test-menu"]')!;
	assert(menu.parentElement?.hasAttribute("data-interaction-popup-host"));
	assert(document.querySelector('[role="dialog"]')!.contains(menu));
	const search = document.querySelector<HTMLInputElement>('[data-testid="search"]')!;
	assert.equal(document.activeElement, search, "existing search autofocus survives owned portal placement");
	await key(controller(), search, "Escape");
	assert.equal(search.dataset.edited, "false");
	assert(document.querySelector('[data-testid="test-menu"]'));
	await key(controller(), search, "Escape");
	assert.equal(document.querySelector('[data-testid="test-menu"]'), null);
	assert(document.querySelector('[data-testid="parent"]'), "one physical Escape cannot dismiss the newly exposed modal");
	await key(controller(), document.querySelector('[data-testid="parent"]')!, "Escape");
	assert.equal(document.querySelector('[data-testid="parent"]'), null);
}));

test("popup keeps arrow wrapping and consumes blocked Escape without native Tab loops", async () => withDom(async (controller, render) => {
	await render(<ModalMenu blocked />);
	await click('[data-testid="trigger"]');
	const menu = document.querySelector<HTMLElement>('[data-testid="test-menu"]')!;
	assert.equal(document.activeElement, menu);
	await key(controller(), menu, "ArrowDown");
	assert.equal(document.activeElement, document.querySelector('[data-testid="first"]'));
	await key(controller(), document.activeElement!, "ArrowDown");
	assert.equal(document.activeElement, document.querySelector('[data-testid="last"]'));
	await key(controller(), document.activeElement!, "ArrowDown");
	assert.equal(document.activeElement, document.querySelector('[data-testid="first"]'));
	for (const shift of [false, true]) {
		const focused: Element | null = document.activeElement;
		const event = await key(controller(), focused!, "Tab", shift);
		assert.equal(event.defaultPrevented, true);
		assert.equal(document.activeElement, focused);
	}
	const escape = await key(controller(), menu, "Escape");
	assert.equal(escape.defaultPrevented, true);
	assert(document.querySelector('[data-testid="test-menu"]'));
	assert(document.querySelector('[data-testid="parent"]'));
}));

function NestedMenus() {
	const [outer, setOuter] = useState(false), [inner, setInner] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null), childTrigger = useRef<HTMLButtonElement>(null);
	return <HostDialog open onClose={() => "blocked"} aria-label="Nested menu parent">
		<h2>Nested menu parent</h2><button ref={trigger} data-testid="outer-trigger" onClick={() => setOuter(true)}>Outer</button>
		{outer && <MenuShell anchorRef={trigger} preferredSide="down" testid="outer-menu" menuClass="fixture"
			onClose={() => { setOuter(false); return "closed"; }}>
			<button ref={childTrigger} data-testid="inner-trigger" onClick={() => setInner(true)}>Inner</button>
			<button data-testid="outer-last">Outer last</button>
			{inner && <MenuShell anchorRef={childTrigger} preferredSide="down" testid="inner-menu" menuClass="fixture"
				onClose={() => { setInner(false); return "closed"; }}><button data-testid="inner-first">Inner first</button><button>Inner last</button></MenuShell>}
		</MenuShell>}
	</HostDialog>;
}

test("nested popups share the unclipped modal host, integer paint order, and one keyboard owner", async () => withDom(async (controller, render) => {
	await render(<NestedMenus />);
	await click('[data-testid="outer-trigger"]');
	await click('[data-testid="inner-trigger"]');
	const outer = document.querySelector<HTMLElement>('[data-testid="outer-menu"]')!;
	const inner = document.querySelector<HTMLElement>('[data-testid="inner-menu"]')!;
	assert.equal(inner.parentElement, outer.parentElement);
	assert(Number.isInteger(Number(inner.style.zIndex)));
	assert(Number(inner.style.zIndex) > Number(outer.style.zIndex));
	const modal = document.querySelector('[role="dialog"]')!;
	assert.equal(modal.getAttribute("aria-hidden"), null, "an owned popup never hides its modal parent");
	assert.equal(modal.hasAttribute("inert"), false);
	assert.equal(controller().isElementEligible(outer), false);
	await key(controller(), inner, "ArrowDown");
	assert.equal(document.activeElement, document.querySelector('[data-testid="inner-first"]'), "portaled React bubbling cannot also run the parent arrow machine");
	await key(controller(), inner, "Escape");
	assert.equal(document.querySelector('[data-testid="inner-menu"]'), null);
	assert(document.querySelector('[data-testid="outer-menu"]'));
	await key(controller(), outer, "Escape");
	assert.equal(document.querySelector('[data-testid="outer-menu"]'), null);
	assert(document.querySelector('[role="dialog"]'));
}));

function RepeatedPicker({ id }: { id: string }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	// Like the real controls, open after the anchor exists. An initially open
	// child cannot measure a parent host ref before React attaches that ref.
	useEffect(() => { setOpen(true); }, []);
	const close = () => setOpen(false);
	usePluginMenuDismiss(open, root, close);
	return <div ref={root}><button>{id}</button>{open && <MenuShell anchorRef={root} testid="plugin-model-menu"
		preferredSide="up" menuClass="fixture" onClose={() => { close(); return "closed"; }}><button>{id} option</button></MenuShell>}</div>;
}

test("repeated plugin picker instances dismiss only the actual top panel on outside pointerdown", async () => withDom(async (_controller, render) => {
	await render(<><RepeatedPicker id="first" /><RepeatedPicker id="second" /></>);
	assert.equal(document.querySelectorAll('[data-testid="plugin-model-menu"]').length, 2);
	await act(async () => { document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
	const remaining = document.querySelectorAll('[data-testid="plugin-model-menu"]');
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]?.textContent, "first option", "do not use the first matching testid as the ownership proxy");
}));

function LegacyMetadata() {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
	const controller = useInteractionLayers();
	usePopoverDismiss(root, open, () => setOpen(false), { layerRootRef: panel });
	return <div ref={root}><button data-testid="metadata-trigger" onClick={() => setOpen(true)}>Metadata</button>
		{open && createPortal(<div ref={panel} data-testid="metadata-panel">Existing panel</div>, controller.getPortalContainer(root.current)!)}
	</div>;
}

test("separate popup registration ref preserves legacy metadata outside-pointer policy", async () => withDom(async (_controller, render) => {
	await render(<LegacyMetadata />);
	await click('[data-testid="metadata-trigger"]');
	assert(document.querySelector('[data-testid="metadata-panel"]'));
	await act(async () => { document.querySelector('[data-testid="metadata-panel"]')!.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
	assert.equal(document.querySelector('[data-testid="metadata-panel"]'), null, "do not silently fix the separately deferred metadata containment behavior");
}));

function KeysSettings() {
	const [open, setOpen] = useState(true);
	return <HostDialog open={open} onClose={() => { setOpen(false); return "closed"; }} aria-label="Settings"><KeysSection /></HostDialog>;
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function type(id: string, value: string) {
	await act(async () => {
		const input = byTest(id) as HTMLInputElement;
		input.focus();
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function chooseProvider(id: string) {
	await click('[data-testid="add-provider"]');
	await click(`[data-testid="provider-option-${id}"]`);
}
function mockKeys() {
	const original = globalThis.fetch;
	const writes: { path: string; body: unknown }[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		if (init?.method && init.method !== "GET") {
			writes.push({ path, body: JSON.parse(String(init.body)) });
			return Response.json({ ok: true });
		}
		if (path.startsWith("/api/custom-provider")) return Response.json({ baseUrl: "http://fixture.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [] }, { headers: { etag: '"fixture"' } });
		return Response.json({ keys: [], providers: [
			{ id: "alpha", envVar: "ALPHA_API_KEY", label: "Alpha" }, { id: "beta", envVar: "BETA_API_KEY", label: "Beta" },
		] });
	};
	return { writes, restore: () => { globalThis.fetch = original; } };
}

test("Keys popup precedes editor Escape; per-provider drafts last until Settings closes, with explicit Save/Cancel unchanged", async () => withDom(async (controller, render) => {
	const mock = mockKeys();
	try {
		await render(<KeysSettings />);
		assert.equal(byTest("group-provider-keys").parentElement?.className, "contents", "ownership metadata must not remove SettingsSection's existing flex gaps between groups");
		await chooseProvider("alpha");
		await type("key-alpha-input", "draft-alpha");
		const alpha = byTest("key-alpha-input") as HTMLInputElement;
		await click('[data-testid="add-provider"]');
		await key(controller(), byTest("provider-search"), "Escape");
		assert.equal(document.querySelector('[data-testid="add-provider-menu"]'), null);
		assert.equal(byTest("key-alpha-editor").hidden, false, "child popup closes before the editor folds");
		await key(controller(), alpha, "Escape");
		assert.equal(byTest("key-alpha-editor").hidden, true);
		assert.equal(controller().isElementEligible(alpha), false);
		assert(document.querySelector('[role="dialog"]'));
		await chooseProvider("beta");
		const beta = byTest("key-beta-input") as HTMLInputElement;
		assert.equal(beta.value, "", "provider A's typing never leaks to B");
		assert.equal(document.activeElement, beta);
		await type("key-beta-input", "draft-beta");
		await chooseProvider("alpha");
		assert.equal(byTest("key-alpha-input"), alpha, "same cached editor/input instance");
		assert.equal(alpha.value, "draft-alpha");
		assert.equal(beta.value, "draft-beta");
		assert.equal(byTest("key-beta-editor").hidden, true);
		assert.equal(document.activeElement, alpha, "only the explicitly reopened editor regains typing focus");
		assert.equal(mock.writes.length, 0, "Escape, provider switches and reopening cannot save credentials");
		await click('[data-testid="key-alpha-cancel"]');
		assert.equal(document.querySelector('[data-testid="key-alpha-input"]'), null, "Add-provider Cancel keeps its old discard behavior");
		await chooseProvider("alpha");
		assert.equal((byTest("key-alpha-input") as HTMLInputElement).value, "");
		await type("key-alpha-input", "saved-alpha");
		await click('[data-testid="key-alpha-save"]');
		assert.deepEqual(mock.writes, [{ path: "/api/keys/ALPHA_API_KEY", body: { value: "saved-alpha" } }]);
		assert.equal(document.querySelector('[data-testid="key-alpha-input"]'), null);
		await chooseProvider("beta");
		assert.equal((byTest("key-beta-input") as HTMLInputElement).value, "draft-beta");
		await key(controller(), byTest("key-beta-input"), "Escape");
		await key(controller(), document.body, "Escape");
		assert.equal(document.querySelector('[role="dialog"]'), null);
		await render(<KeysSettings key="fresh-settings" />);
		await chooseProvider("beta");
		assert.equal((byTest("key-beta-input") as HTMLInputElement).value, "", "Settings unmount destroys the draft cache");
	} finally { mock.restore(); }
}));

test("Keys custom and ordinary row drafts survive editor-first Escape even with focus elsewhere", async () => withDom(async (controller, render) => {
	const mock = mockKeys();
	try {
		await render(<KeysSettings />);
		await click('[data-testid="custom-endpoint-row-btn"]');
		await type("custom-baseurl-input", "http://draft.invalid/v1");
		await type("custom-models-input", "draft-model");
		await act(async () => {
			const select = byTest("custom-auth-mode");
			Object.defineProperty(select, "value", { configurable: true, value: "apiKey" });
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await type("custom-key-input", "unsaved-custom-key");
		const customInput = byTest("custom-baseurl-input");
		await key(controller(), document.querySelector('[data-testid="group-search"]')!, "Escape");
		assert(customInput.closest("[hidden][inert]"));
		assert(document.querySelector('[role="dialog"]'), "an open editor owns Escape even when focus is elsewhere in Settings");
		await chooseProvider("beta");
		assert.equal(controller().isElementEligible(customInput), false);
		await key(controller(), byTest("key-beta-input"), "Escape");
		await click('[data-testid="custom-endpoint-row-btn"]');
		assert.equal(byTest("custom-baseurl-input"), customInput);
		assert.equal((customInput as HTMLInputElement).value, "http://draft.invalid/v1");
		assert.equal((byTest("custom-models-input") as HTMLInputElement).value, "draft-model");
		assert.equal((byTest("custom-key-input") as HTMLInputElement).value, "unsaved-custom-key");
		assert.equal(document.activeElement, customInput);
		assert.equal(mock.writes.length, 0);
		await click('[data-testid="custom-cancel"]');
		assert.equal(document.querySelector('[data-testid="custom-endpoint-editor"]'), null);
		await click('[data-testid="custom-endpoint-row-btn"]');
		assert.equal((byTest("custom-baseurl-input") as HTMLInputElement).value, "http://fixture.invalid/v1");
		assert.equal((byTest("custom-models-input") as HTMLInputElement).value, "");
		await key(controller(), byTest("custom-baseurl-input"), "Escape");
		await click('[data-testid="key-deepgram_api_key-row"]');
		await type("key-deepgram_api_key-input", "ordinary-row-draft");
		await click('[data-testid="key-deepgram_api_key-cancel"]');
		await click('[data-testid="key-deepgram_api_key-row"]');
		assert.equal((byTest("key-deepgram_api_key-input") as HTMLInputElement).value, "ordinary-row-draft", "ordinary row Cancel still folds without clearing its existing local state");
		assert.equal(mock.writes.length, 0);
	} finally { mock.restore(); }
}));
