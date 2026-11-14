import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createInteractionLayers, type CloseOutcome, type InteractionLayer } from "../components/interaction-layers.tsx";

function fixture() {
	const { document, window } = parseHTML("<html><body><main><button id='invoker'>open</button></main></body></html>");
	const store = createInteractionLayers();
	function add(id: string, kind: InteractionLayer["kind"], ownerId?: string, onClose?: InteractionLayer["onClose"]) {
		const root = document.createElement("div");
		const portal = document.createElement("div");
		root.appendChild(portal);
		document.body.appendChild(root);
		const unregister = store.register({ id, kind, ownerId, rootRef: { current: root }, portalRef: { current: portal }, onClose });
		return { root, portal, unregister };
	}
	function key(name: string) {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: name });
		return event as unknown as KeyboardEvent;
	}
	return { store, document, add, key };
}

describe("interaction layer ordering and close ownership", () => {
	it("snapshots Escape without preventing it; one event never reaches an exposed parent", () => {
		const { store, add, key } = fixture();
		const calls: string[] = [];
		add("parent", "modal", undefined, () => { calls.push("parent"); return "closed"; });
		const child = add("menu", "popup", "parent", () => { calls.push("menu"); child.unregister(); return "closed"; });
		const event = key("Escape");
		store.captureKeyDown(event);
		assert.equal(event.defaultPrevented, false);
		assert.equal(store.getEventOwner(event)?.id, "menu");
		assert.equal(store.dispatchEscape(event), "closed");
		assert.equal(event.defaultPrevented, true);
		assert.equal(store.isEscapeOwned(event), true);
		assert.equal(store.getEventOwner(event)?.id, "menu");
		store.dispatchEscape(event);
		assert.deepEqual(calls, ["menu"]);
		store.dispatchEscape(key("Escape"));
		assert.deepEqual(calls, ["menu", "parent"]);
	});

	it("leaf claims and ordinary preventDefault win before shared dismissal", () => {
		const { store, add, key } = fixture();
		let closes = 0;
		add("modal", "modal", undefined, () => { closes++; return "closed"; });
		const ordinary = key("Escape");
		store.captureKeyDown(ordinary);
		ordinary.preventDefault();
		store.dispatchEscape(ordinary);
		const claimed = key("Escape");
		store.captureKeyDown(claimed);
		store.claimEscape({ nativeEvent: claimed });
		store.dispatchEscape(claimed);
		assert.equal(closes, 0);
		assert.equal(store.isEscapeOwned(claimed), true);
	});

	it("a refusing owner consumes Escape instead of dismissing or falling through", () => {
		for (const outcome of ["blocked", "pending", "handled-without-close"] as CloseOutcome[]) {
			const { store, add, key } = fixture();
			const calls: string[] = [];
			add("parent", "modal", undefined, () => { calls.push("parent"); return "closed"; });
			add("busy", "modal", "parent", () => { calls.push("busy"); return outcome; });
			const event = key("Escape");
			store.captureKeyDown(event);
			assert.equal(store.dispatchEscape(event), outcome);
			assert.equal(event.defaultPrevented, true);
			assert.equal(store.isEscapeOwned(event), true);
			assert.deepEqual(calls, ["busy"]);
		}
	});

	it("closing the event owner in a leaf cannot promote the parent for the same event", () => {
		const { store, add, key } = fixture();
		let parentCloses = 0;
		add("parent", "modal", undefined, () => { parentCloses++; return "closed"; });
		const child = add("child", "popup", "parent");
		const event = key("Escape");
		store.captureKeyDown(event);
		child.unregister();
		assert.equal(store.dispatchEscape(event), "closed");
		assert.equal(parentCloses, 0);
	});

	it("prevents native Tab without stopping target propagation", () => {
		const { store, document, key } = fixture();
		const target = document.getElementById("invoker")!;
		let reachedLeaf = false;
		target.addEventListener("keydown", () => { reachedLeaf = true; });
		const event = key("Tab");
		store.captureKeyDown(event);
		target.dispatchEvent(event);
		assert.equal(event.defaultPrevented, true);
		assert.equal(reachedLeaf, true);
	});

	it("popTo walks top-down once, stops on any non-closed result and never queues", () => {
		for (const outcome of ["blocked", "pending", "handled-without-close", "closed"] as CloseOutcome[]) {
			const { store, add } = fixture();
			const calls: string[] = [];
			add("settings", "modal");
			add("middle", "modal", "settings", () => { calls.push("middle"); return outcome; });
			add("top", "popup", "middle", () => { calls.push("top"); return "closed"; });
			assert.equal(store.popTo("settings"), outcome);
			assert.deepEqual(calls, ["top", "middle"]);
			assert.equal(store.getSnapshot().length, 3, "controller does not forcibly remove controlled layers");
		}
	});

	it("popTo does not invoke anything below a blocked top and treats void conservatively", () => {
		const { store, add } = fixture();
		let lowerCalls = 0;
		add("settings", "modal");
		add("lower", "modal", "settings", () => { lowerCalls++; return "closed"; });
		add("top", "popup", "lower", () => {});
		assert.equal(store.popTo("settings"), "handled-without-close");
		assert.equal(lowerCalls, 0);
	});

	it("supports child-first React layout registration without paint/owner inversion", () => {
		const { store, add } = fixture();
		add("menu", "popup", "dialog");
		add("dialog", "modal");
		assert.deepEqual(store.getSnapshot().map(layer => layer.id), ["dialog", "menu"]);
		assert.ok(store.getLayer("dialog")!.order < store.getLayer("menu")!.order);
		assert.ok(store.getSnapshot().every(layer => Number.isInteger(layer.order)), "paint ranks must be valid integer CSS z-index values");
		assert.equal(store.getTopLayer()?.id, "menu");
	});

	it("visual ancestry is not lifetime ownership: removing a plugin does not destroy Settings", () => {
		const { store, add } = fixture();
		const plugin = add("plugin", "modal");
		add("settings", "modal", "plugin");
		plugin.unregister();
		assert.equal(store.getActiveModal()?.id, "settings");
		assert.equal(store.isLayerEligible("settings"), true);
	});
});

describe("DOM ownership, focus and opening authority", () => {
	it("resolves DOM anchors across unrelated React ancestry and keeps popup hosts outside visual clipping", () => {
		const { store, add, document } = fixture();
		const modal = add("modal", "modal");
		const visual = document.createElement("section");
		visual.style.transform = "translateY(1px)";
		visual.style.overflow = "auto";
		const anchor = document.createElement("button");
		visual.appendChild(anchor);
		modal.root.appendChild(visual);
		assert.equal(store.ownerOf(anchor)?.id, "modal");
		assert.equal(store.getPortalContainer(anchor), modal.portal);
		assert.equal(visual.contains(modal.portal), false);
		assert.equal(store.getPortalContainer(null, "modal"), modal.portal);
	});

	it("excludes covered controls while permitting a nonmodal view's sidebar", () => {
		const { store, add, document } = fixture();
		const sidebar = document.getElementById("invoker")!;
		add("graph", "view");
		assert.equal(store.isElementEligible(sidebar), true);
		const modal = add("settings", "modal");
		const field = document.createElement("input");
		modal.root.appendChild(field);
		assert.equal(store.isElementEligible(sidebar), false);
		assert.equal(store.isElementEligible(field), true);
		const menu = add("menu", "popup", "settings");
		modal.portal.appendChild(menu.root);
		assert.equal(store.isElementEligible(field), false);
		assert.equal(store.isElementEligible(menu.root), true);
		assert.equal(store.isLayerEligible("settings"), true, "the owning modal retains containment while its menu is active");
	});

	it("only the top popup's own origin can opt into its thinking shortcut", () => {
		const { store, add, document } = fixture();
		const modal = add("settings", "modal");
		const ownControl = document.createElement("div");
		const ownAnchor = document.createElement("button");
		ownControl.appendChild(ownAnchor);
		const otherControl = document.createElement("div");
		modal.root.append(ownControl, otherControl);
		const popup = add("models", "popup", "settings");
		modal.portal.appendChild(popup.root);
		store.update("models", { anchorRef: { current: ownAnchor } });
		assert.equal(store.isElementEligible(ownControl), false, "normal covered-field commands remain blocked");
		assert.equal(store.isPopupOrigin(ownControl), true);
		assert.equal(store.isPopupOrigin(ownAnchor), true);
		assert.equal(store.isPopupOrigin(otherControl), false);
		const child = add("child", "modal", "settings");
		assert.equal(store.isPopupOrigin(ownControl), false, "a later modal revokes popup origin shortcuts");
		child.unregister();
		ownAnchor.remove();
		assert.equal(store.isPopupOrigin(ownControl), false);
	});

	it("late opening reads are invalidated by intervening surfaces, newer intents, or disposed requests", () => {
		const { store, add, document } = fixture();
		const opener = document.getElementById("invoker")!;
		const first = store.beginOpening(opener);
		assert.equal(store.isOpeningCurrent(first), true);
		const second = store.beginOpening(opener);
		assert.equal(store.isOpeningCurrent(first), false);
		assert.equal(store.isOpeningCurrent(second), true);
		const modal = add("intervening", "modal");
		modal.unregister();
		assert.equal(store.isOpeningCurrent(second), false, "even an intervening surface already closed revokes the read");
		const third = store.beginOpening(opener);
		store.invalidateOpening();
		assert.equal(store.isOpeningCurrent(third), false);
	});

	it("a newer explicit focus choice revokes an old return ticket without needing a new surface", () => {
		const { store, document } = fixture();
		const opener = document.getElementById("invoker")!;
		let focusCount = 0;
		opener.focus = () => { focusCount++; };
		const generation = store.getGeneration();
		const focusRevision = store.getFocusRevision();
		store.observeFocus();
		assert.equal(store.restoreFocus(opener, generation, focusRevision), false);
		assert.equal(focusCount, 0);
	});

	it("return tickets cannot focus detached, disabled, hidden, covered, or superseded openers", () => {
		const { store, add, document } = fixture();
		const opener = document.getElementById("invoker")!;
		let focusCount = 0;
		opener.focus = () => { focusCount++; };
		const generation = store.getGeneration();
		assert.equal(store.restoreFocus(opener, generation), true);
		assert.equal(focusCount, 1);
		opener.setAttribute("disabled", "");
		assert.equal(store.restoreFocus(opener, generation), false);
		opener.removeAttribute("disabled");
		opener.hidden = true;
		assert.equal(store.restoreFocus(opener, generation), false);
		opener.hidden = false;
		add("new", "modal");
		assert.equal(store.restoreFocus(opener, generation), false);
		opener.remove();
		assert.equal(store.isElementEligible(opener), false);
		assert.equal(focusCount, 1);
	});
});
