import type { parseHTML } from "linkedom";

/** Browser APIs used by the low-level modal primitives, absent in linkedom.
 * Focus is observable without introducing browser Tab navigation. */
export function installModalDom(dom: ReturnType<typeof parseHTML>) {
	let active: Element | null = dom.document.body;
	const activeDescriptor = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });
	const prototype = dom.window.HTMLElement.prototype;
	const originalFocus = prototype.focus, originalSetAttribute = prototype.setAttribute;
	const legacyEvents = ["attachEvent", "detachEvent"].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
	// React is imported before this synthetic DOM exists, so its legacy
	// input-event fallback is active in these Node tests only.
	Object.assign(prototype, { attachEvent() {}, detachEvent() {} });
	prototype.focus = function () {
		// Native focus refuses inert/hidden/disabled targets. In particular,
		// a covered parent's still-cleaning-up focus listener cannot steal
		// focus back from its newly mounted child in the same commit.
		if (this.closest("[inert], [hidden]") || this.matches(":disabled")) return;
		active = this;
		this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
	};
	// Chromium normalizes HTML attribute names; linkedom otherwise retains
	// React's ariaHidden casing and makes visibility checks inaccurate.
	prototype.setAttribute = function (name: string, value: string) { originalSetAttribute.call(this, name.toLowerCase(), value); };
	const style = (element: HTMLElement) => ({
		display: element.style.display || "block", visibility: element.style.visibility || "visible",
		position: element.style.position || "static", overflow: element.style.overflow || "visible",
		paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
	});
	const globals = {
		Node: dom.window.Node, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 }, getComputedStyle: style,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	Object.assign(dom.window, { getComputedStyle: style, innerWidth: 1280, innerHeight: 800 });
	return () => {
		prototype.focus = originalFocus; prototype.setAttribute = originalSetAttribute;
		for (const [key, descriptor] of legacyEvents) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		if (activeDescriptor) Object.defineProperty(dom.document, "activeElement", activeDescriptor);
		else Reflect.deleteProperty(dom.document, "activeElement");
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}
