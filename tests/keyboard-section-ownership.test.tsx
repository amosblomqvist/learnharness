import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { loadOverrides } from "../src/core/keyboard.ts";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined, cleanup: (() => void) | undefined;
function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const storage = new Map<string, string>();
	const globals = {
		React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	Object.assign(dom.window, { localStorage: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => { storage.set(key, value); },
		removeItem: (key: string) => { storage.delete(key); },
	} });
	const restoreModalDom = installModalDom(dom);
	// linkedom lacks real window capture. Retain the actual capture callbacks
	// and deliver them before the real React-target/document-bubble path.
	const captures = new Set<EventListenerOrEventListenerObject>();
	const add = dom.window.addEventListener.bind(dom.window), remove = dom.window.removeEventListener.bind(dom.window);
	dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		if (type === "keydown" && (options === true || (typeof options === "object" && options.capture))) captures.add(listener);
		else add(type, listener, options);
	}) as typeof dom.window.addEventListener;
	dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
		if (type === "keydown" && (options === true || (typeof options === "object" && options.capture))) captures.delete(listener);
		else remove(type, listener, options);
	}) as typeof dom.window.removeEventListener;
	cleanup = () => {
		dom.window.addEventListener = add; dom.window.removeEventListener = remove;
		restoreModalDom();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	root = createRoot(document.querySelector("#root")!);
	return {
		async render(children: React.ReactNode) { await act(async () => root!.render(<InteractionLayersProvider>{children}</InteractionLayersProvider>)); },
		async key(key: string, shiftKey = false) {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key, code: key === "Tab" || key === "Escape" ? key : "KeyK", shiftKey });
			await act(async () => {
				for (const listener of captures) {
					if (typeof listener === "function") listener.call(dom.window, event);
					else listener.handleEvent(event);
					if (event.cancelBubble) break;
				}
				if (!event.cancelBubble) (document.activeElement ?? document).dispatchEvent(event);
			});
			return event;
		},
	};
}
const byTest = (id: string) => {
	const element = document.querySelector<HTMLElement>(`[data-testid='${id}']`);
	assert.ok(element, `missing ${id}`); return element;
};
async function arm() { await act(async () => byTest("kbd-rebind-find").click()); }
const isArmed = () => byTest("kbd-row-find").textContent!.includes("Press keys…");
afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	// Flush HostDialog/FocusScope cleanup before restoring this fixture's DOM.
	await new Promise(resolve => setTimeout(resolve, 5));
	cleanup?.(); cleanup = undefined;
});

it("a covered Settings recorder ignores child keys/Escape, and resumes recording Tab when its owner is active", async () => {
	const f = fixture(); let childCloses = 0, parentCloses = 0;
	let openChild!: () => void;
	function Harness() {
		const [child, setChild] = React.useState(false); openChild = () => setChild(true);
		return <HostDialog open layerId="settings" onClose={() => { parentCloses++; return "blocked"; }}>
			<h2>Settings</h2><KeyboardSection />
			<HostDialog open={child} layerId="plugin-dialog" onClose={() => { childCloses++; setChild(false); return "closed"; }}>
				<h2 data-testid="child-heading">Plugin dialog</h2>
			</HostDialog>
		</HostDialog>;
	}
	await f.render(<Harness />); await arm(); assert.equal(isArmed(), true);
	await act(async () => openChild());
	assert.equal(document.activeElement, byTest("child-heading"));
	// Escape is the first event after coverage: the original regression
	// consumed it during window capture and stranded the child dialog.
	const escape = await f.key("Escape");
	assert.equal(escape.defaultPrevented, true); assert.equal(childCloses, 1); assert.equal(parentCloses, 0);
	assert.equal(document.querySelector("[data-testid='child-heading']"), null);
	assert.equal(isArmed(), true, "child Escape must not cancel the covered recorder");
	await act(async () => openChild());
	await f.key("k"); assert.deepEqual(loadOverrides(), {}); assert.equal(isArmed(), true);
	const childTab = await f.key("Tab");
	assert.equal(childTab.defaultPrevented, true); assert.deepEqual(loadOverrides(), {});
	assert.equal(isArmed(), true); assert.equal(document.activeElement, byTest("child-heading"));
	await f.key("Escape"); assert.equal(childCloses, 2); assert.equal(parentCloses, 0);
	assert.equal(isArmed(), true);
	const tab = await f.key("Tab");
	assert.equal(tab.defaultPrevented, true); assert.deepEqual(loadOverrides(), { find: "tab" });
	assert.equal(isArmed(), false); assert.equal(parentCloses, 0);
});

it("an active Settings recorder consumes Escape without dismissing Settings and still records Shift+Tab", async () => {
	const f = fixture(); let closes = 0;
	await f.render(<HostDialog open onClose={() => { closes++; return "blocked"; }}><h2>Settings</h2><KeyboardSection /></HostDialog>);
	await arm(); const escape = await f.key("Escape");
	assert.equal(escape.defaultPrevented, true); assert.equal(isArmed(), false); assert.equal(closes, 0);
	assert.deepEqual(loadOverrides(), {});
	await arm(); const tab = await f.key("Tab", true);
	assert.equal(tab.defaultPrevented, true); assert.deepEqual(loadOverrides(), { find: "shift+tab" });
	assert.equal(isArmed(), false); assert.equal(closes, 0);
});
