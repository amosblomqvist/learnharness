import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { createInteractionLayers, type InteractionLayer } from "../components/interaction-layers.tsx";

function fixture() {
	const { document } = parseHTML("<html><body><button>Opener</button><div id='picker'></div></body></html>");
	const store = createInteractionLayers(); let revokes = 0;
	const lease = store.reserveOpening("picker", { opener: document.querySelector("button"), onRevoke() { revokes++; } })!;
	assert.equal(lease.activate(), true);
	const effectOwner = {};
	const input: Omit<InteractionLayer, "order"> = { id: "picker", kind: "view", ownerId: null,
		rootRef: { current: document.querySelector<HTMLElement>("#picker")! }, openingLease: lease, onClose: () => "closed" };
	const detach = store.register(input, effectOwner);
	return { document, store, lease, input, effectOwner, detach, get revokes() { return revokes; } };
}

it("a hook can detach/reconnect its same logical lease without duplicate registration or stale-cleanup authority", () => {
	const f = fixture(); const first = f.store.getLayer("picker")!;
	f.detach();
	assert.equal(f.store.getLayer("picker"), undefined); assert.equal(f.lease.owns(), true); assert.equal(f.revokes, 0);
	f.store.register(f.input, {}); // Another hook cannot claim this still-owned lease.
	f.store.register(f.input); // Neither can an unqualified imperative registration.
	assert.equal(f.store.getLayer("picker"), undefined); assert.equal(f.lease.owns(), true);
	const detachAgain = f.store.register(f.input, f.effectOwner);
	const second = f.store.getLayer("picker")!;
	assert.ok(second); assert.notEqual(second, first); assert.equal(second.openingLease, f.lease);
	f.detach(); assert.equal(f.store.getLayer("picker"), second, "old cleanup cannot remove its successor registration");
	f.store.register(f.input, f.effectOwner);
	assert.equal(f.store.getSnapshot().length, 1, "setup without a detach cannot register a lease twice");
	assert.throws(() => f.store.register({ ...f.input, openingLease: undefined }), /already registered/);
	f.lease.release(); detachAgain(); assert.equal(f.lease.owns(), false); assert.equal(f.store.getSnapshot().length, 0);
});

it("ordinary imperative registration cleanup still revokes its mounted lease", () => {
	const { document } = parseHTML("<html><body><div></div></body></html>");
	const store = createInteractionLayers(); const lease = store.reserveOpening("raw", { onRevoke() {} })!;
	lease.activate();
	const unregister = store.register({ id: "raw", kind: "view", rootRef: { current: document.querySelector("div") }, openingLease: lease });
	unregister(); assert.equal(lease.owns(), false); assert.equal(lease.activate(), false);
});

for (const mutation of ["id", "kind", "owner", "ref", "element", "null", "disconnected"] as const) {
	it(`the same hook cannot migrate a detached lease to a different ${mutation}`, () => {
		const f = fixture(); f.detach(); const next = { ...f.input };
		if (mutation === "id") next.id = "different";
		if (mutation === "kind") next.kind = "modal";
		if (mutation === "owner") next.ownerId = "different-owner";
		if (mutation === "ref") next.rootRef = { current: f.input.rootRef.current };
		if (mutation === "element") { const replacement = f.document.createElement("div"); f.document.body.append(replacement); next.rootRef.current = replacement; }
		if (mutation === "null") next.rootRef.current = null;
		if (mutation === "disconnected") next.rootRef.current!.remove();
		f.store.register(next, f.effectOwner);
		assert.equal(f.store.getSnapshot().length, 0); assert.equal(f.lease.owns(), false); assert.equal(f.revokes, 1);
		f.store.register(f.input, f.effectOwner); assert.equal(f.store.getSnapshot().length, 0, "rejected migration cannot revive the lease later");
	});
}

for (const timing of ["before detach", "after detach"] as const) it(`logical release ${timing} is irreversible for the same effect owner`, () => {
	const f = fixture();
	if (timing === "before detach") f.lease.release();
	f.detach();
	if (timing === "after detach") f.lease.release();
	f.store.register(f.input, f.effectOwner);
	assert.equal(f.lease.owns(), false); assert.equal(f.store.getSnapshot().length, 0); assert.equal(f.revokes, 0);
});

for (const change of ["registration", "removal", "retarget", "intent", "reservation", "focus"] as const) {
	it(`intervening ${change} cannot be excused as same-owner replay`, () => {
		const f = fixture();
		const otherInput: Omit<InteractionLayer, "order"> = { id: "other", kind: "view", rootRef: { current: f.document.querySelector("button") } };
		const removeOther = change === "removal" ? f.store.register(otherInput) : undefined;
		f.detach();
		if (change === "registration") f.store.register(otherInput);
		if (change === "removal") removeOther!();
		if (change === "retarget") f.store.invalidateOpening();
		if (change === "intent") f.store.beginOpening();
		if (change === "reservation") f.store.reserveOpening("another-slot", { onRevoke() {} });
		if (change === "focus") f.store.observeFocus();
		f.store.register(f.input, f.effectOwner);
		assert.equal(f.store.getLayer("picker"), undefined); assert.equal(f.lease.owns(), false); assert.equal(f.revokes, 1);
	});
}

it("a superseding opening cannot be displaced by old reconnect attempts or old unregister callbacks", () => {
	const f = fixture(); f.detach();
	const next = f.store.reserveOpening("picker", { onRevoke() {} })!; assert.equal(next.activate(), true);
	const second = f.document.createElement("div"); f.document.body.append(second);
	const unregister = f.store.register({ ...f.input, rootRef: { current: second }, openingLease: next }, {});
	f.store.register(f.input, f.effectOwner); f.detach(); f.lease.release();
	assert.equal(f.lease.owns(), false); assert.equal(next.owns(), true); assert.equal(f.revokes, 1);
	assert.equal(f.store.getLayer("picker")?.rootRef.current, second);
	next.release(); unregister();
});

it("hook cleanup still satisfies only its exact accepted predecessor retirement barrier", () => {
	const f = fixture();
	const next = f.store.reserveOpening("picker", { onRevoke() {} })!;
	assert.equal(next.ready(), false); assert.equal(next.activate(), false);
	f.store.register(f.input, f.effectOwner); assert.equal(f.store.getSnapshot().length, 1, "a stale setup cannot register another same-ID layer");
	f.detach(); assert.equal(f.lease.owns(), false); assert.equal(next.ready(), true); assert.equal(next.activate(), true);
	const root = f.document.createElement("div"); f.document.body.append(root);
	const unregister = f.store.register({ ...f.input, rootRef: { current: root }, openingLease: next }, {});
	f.detach(); assert.equal(f.store.getLayer("picker")?.openingLease, next);
	next.release(); unregister();
});

it("reconnection invalidates the old cleanup's focus return generation rather than extending its authority", () => {
	const f = fixture(); const opener = f.document.querySelector<HTMLElement>("button")!; let focuses = 0;
	opener.focus = () => { focuses++; };
	f.detach(); const oldGeneration = f.store.getGeneration(), oldFocus = f.store.getFocusRevision();
	const unregister = f.store.register(f.input, f.effectOwner);
	assert.equal(f.store.restoreFocus(opener, oldGeneration, oldFocus, f.lease), false); assert.equal(focuses, 0);
	f.lease.release(); unregister();
	assert.equal(f.store.restoreFocus(opener, f.store.getGeneration(), f.store.getFocusRevision(), f.lease), true);
	assert.equal(focuses, 1, "ordinary logical close retains its own current focus-return authority");
});
