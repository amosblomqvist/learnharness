import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createInteractionLayers, type CloseOutcome, type InteractionLayer, type OpeningLease } from "../components/interaction-layers.tsx";

function fixture() {
	const { document } = parseHTML("<html><body><button id='a'>A</button><button id='b'>B</button></body></html>");
	const store = createInteractionLayers();
	function register(id: string, openingLease?: OpeningLease, onClose: InteractionLayer["onClose"] = () => "closed", ownerId?: string) {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const unregister = store.register({ id, kind: "modal", rootRef: { current: root }, openingLease, onClose, ownerId });
		return { root, unregister };
	}
	return { store, document, register };
}

describe("exclusive generic opening leases", () => {
	it("revokes a superseded pending read immediately, before its late response", async () => {
		const { store } = fixture();
		const request = new AbortController();
		let revokes = 0;
		const first = store.reserveOpening("exclusive", { onRevoke() { revokes++; request.abort(); } })!;
		let finishRead!: () => void;
		const lateRead = new Promise<void>(resolve => { finishRead = resolve; }).then(() => first.activate());
		const second = store.reserveOpening("exclusive", { onRevoke() {} })!;
		assert.equal(request.signal.aborted, true);
		assert.equal(revokes, 1);
		assert.equal(first.owns(), false);
		assert.equal(second.owns(), true);
		first.release();
		assert.equal(second.owns(), true, "stale cleanup never releases the newer slot");
		finishRead();
		assert.equal(await lateRead, false);
		assert.equal(revokes, 1);
	});

	it("cached replacement waits for actual old unregister; accepted close is not removal", () => {
		const { store, document, register } = fixture();
		let closes = 0;
		let oldRevokes = 0;
		const old = store.reserveOpening("exclusive", { opener: document.getElementById("a"), onRevoke() { oldRevokes++; } })!;
		assert.equal(old.activate(), true);
		const active = register("same-id", old, reason => { assert.equal(reason, "dismiss"); closes++; return "closed"; });
		const replacement = store.reserveOpening("exclusive", { opener: document.getElementById("b"), onRevoke() {} })!;
		assert.equal(closes, 1);
		assert.equal(oldRevokes, 1);
		assert.equal(old.owns(), false);
		assert.equal(replacement.owns(), true);
		assert.equal(replacement.ready(), false);
		assert.equal(replacement.activate(), false, "cached data cannot bypass the retiring DOM boundary");
		assert.doesNotThrow(() => register("same-id", old), "stale lease is rejected before duplicate-ID validation");
		const before = store.getSnapshot();
		active.unregister();
		assert.notEqual(store.getSnapshot(), before, "retirement notifies external-store subscribers");
		assert.equal(replacement.ready(), true);
		assert.equal(replacement.activate(), true);
		register("same-id", replacement);
		assert.equal(store.getLayer("same-id")?.openingLease, replacement);
		old.release();
		assert.equal(replacement.owns(), true);
	});

	it("notifies once after retiring DOM isolation cleanup without advancing or excusing a generation", async () => {
		const { store, document, register } = fixture();
		const a = store.reserveOpening("exclusive", { onRevoke() {} })!;
		a.activate();
		const old = register("old", a);
		const opener = document.getElementById("b")!;
		opener.setAttribute("aria-hidden", "true");
		const b = store.reserveOpening("exclusive", { opener, onRevoke() {} })!;
		const readiness: boolean[] = [];
		const unsubscribe = store.subscribe(() => { readiness.push(b.ready()); });
		old.unregister();
		const generation = store.getGeneration();
		assert.deepEqual(readiness, [false], "registration cleanup runs before aria-hidden cleanup");
		opener.removeAttribute("aria-hidden");
		await Promise.resolve();
		assert.deepEqual(readiness, [false, true], "one post-cleanup reconciliation permits cached activation");
		assert.equal(store.getGeneration(), generation);
		unsubscribe();
	});

	it("post-cleanup notifications never revive a request revoked by unrelated UI", async () => {
		const { store, register } = fixture();
		const a = store.reserveOpening("exclusive", { onRevoke() {} })!;
		a.activate();
		const old = register("old", a);
		let revokes = 0;
		const b = store.reserveOpening("exclusive", { onRevoke() { revokes++; } })!;
		old.unregister();
		register("settings");
		const generation = store.getGeneration();
		await Promise.resolve();
		assert.equal(b.ready(), false);
		assert.equal(b.activate(), false);
		assert.equal(revokes, 1);
		assert.equal(store.getGeneration(), generation);
	});

	it("rapid A→B→A transfers only the original retirement and rejects every stale same-ID render", () => {
		const { store, register } = fixture();
		let closes = 0;
		const a1 = store.reserveOpening("exclusive", { onRevoke() {} })!;
		a1.activate();
		const first = register("shared", a1, () => { closes++; return "closed"; });
		const bRequest = new AbortController();
		const b = store.reserveOpening("exclusive", { onRevoke: () => bRequest.abort() })!;
		const a2 = store.reserveOpening("exclusive", { onRevoke() {} })!;
		assert.equal(bRequest.signal.aborted, true);
		assert.equal(closes, 1, "do not ask the already-accepted retiring layer to close twice");
		assert.equal(a2.activate(), false);
		assert.equal(b.activate(), false);
		assert.doesNotThrow(() => register("shared", b));
		first.unregister();
		assert.equal(a2.activate(), true);
		const second = register("shared", a2);
		assert.doesNotThrow(() => register("shared", a1));
		assert.doesNotThrow(() => register("shared", b));
		assert.equal(store.getLayer("shared")?.rootRef.current === second.root, true);
		first.unregister();
		a1.release(); b.release();
		assert.equal(a2.owns(), true);
	});

	it("claimed-but-not-mounted leases are revoked atomically before competing React registrations", () => {
		const { store, register } = fixture();
		let revokes = 0;
		const a = store.reserveOpening("exclusive", { onRevoke() { revokes++; } })!;
		assert.equal(a.activate(), true);
		const b = store.reserveOpening("exclusive", { onRevoke() {} })!;
		assert.equal(b.activate(), true);
		register("shared", b);
		assert.doesNotThrow(() => register("shared", a));
		assert.equal(revokes, 1);
		assert.equal(store.getLayer("shared")?.openingLease, b);
		assert.equal(store.getSnapshot().length, 1);
	});

	it("unrelated registrations, removals and explicit retargets invalidate pending leases", () => {
		for (const change of ["register", "unregister", "retarget"] as const) {
			const { store, register } = fixture();
			const existing = register("existing");
			let revokes = 0;
			const pending = store.reserveOpening("exclusive", { onRevoke() { revokes++; } })!;
			if (change === "register") register("settings");
			if (change === "unregister") existing.unregister();
			if (change === "retarget") store.invalidateOpening();
			assert.equal(pending.owns(), false);
			assert.equal(pending.activate(), false);
			assert.equal(revokes, 1);
			store.invalidateOpening();
			assert.equal(revokes, 1);
		}
	});

	it("only the exact retiring registration is exempt, never its visual descendants", () => {
		const { store, register } = fixture();
		const a = store.reserveOpening("exclusive", { onRevoke() {} })!;
		a.activate();
		const old = register("old", a);
		const independent = register("global-settings", undefined, () => "closed", "old");
		let revokes = 0;
		const next = store.reserveOpening("exclusive", { onRevoke() { revokes++; } })!;
		independent.unregister();
		assert.equal(next.owns(), false, "ownerId is not a lifetime/retirement exemption");
		old.unregister();
		assert.equal(next.activate(), false, "later expected cleanup cannot revive an invalidated read");
		assert.equal(revokes, 1);
	});

	it("blocked, handled and pending normal closes return null with no deferred activation", () => {
		for (const outcome of ["blocked", "handled-without-close", "pending"] as CloseOutcome[]) {
			const { store, register } = fixture();
			let closes = 0;
			let revokes = 0;
			const old = store.reserveOpening("exclusive", { onRevoke() { revokes++; } })!;
			old.activate();
			const layer = register("old", old, () => { closes++; return outcome; });
			let attemptedRevokes = 0;
			assert.equal(store.reserveOpening("exclusive", { onRevoke() { attemptedRevokes++; } }), null);
			assert.equal(old.owns(), true);
			assert.equal(closes, 1);
			assert.equal(revokes, 0);
			layer.unregister();
			assert.equal(store.getSnapshot().length, 0);
			assert.equal(attemptedRevokes, 0, "a rejected reserve never queues an opening callback");
		}
	});

	it("mounted ownership survives child UI and retarget, while all pending slots are invalidated", () => {
		const { store, register } = fixture();
		let activeRevokes = 0;
		const active = store.reserveOpening("active", { onRevoke() { activeRevokes++; } })!;
		active.activate(); register("active-modal", active);
		let pendingRevokes = 0;
		const pending1 = store.reserveOpening("pending-1", { onRevoke() { pendingRevokes++; } })!;
		const pending2 = store.reserveOpening("pending-2", { onRevoke() { pendingRevokes++; } })!;
		pending2.activate();
		store.invalidateOpening();
		assert.equal(pending1.owns(), false);
		assert.equal(pending2.owns(), false);
		assert.equal(pendingRevokes, 2);
		const child = register("child", undefined, () => "closed", "active-modal");
		assert.equal(active.owns(), true);
		child.unregister();
		assert.equal(active.owns(), true);
		assert.equal(activeRevokes, 0);
	});

	it("observes synchronous accepted closure but does not excuse unrelated UI opened by the callback", () => {
		for (const unrelated of [false, true]) {
			const { store, register } = fixture();
			const a = store.reserveOpening("exclusive", { onRevoke() {} })!;
			a.activate();
			const old = register("old", a, () => {
				old.unregister();
				if (unrelated) register("settings");
				return "closed";
			});
			let revokes = 0;
			const b = store.reserveOpening("exclusive", { onRevoke() { revokes++; } });
			assert.equal(b !== null, !unrelated);
			assert.equal(revokes, 0, "a null proposal has no returned lease/work to revoke before reserve returns");
			if (b) assert.equal(b.activate(), true);
		}
	});

	it("normal release retains the retiring registration barrier without notifying or re-closing it", () => {
		const { store, register } = fixture();
		let closes = 0;
		const a = store.reserveOpening("exclusive", { onRevoke() {} })!;
		a.activate();
		const old = register("old", a, () => { closes++; return "closed"; });
		a.release();
		const b = store.reserveOpening("exclusive", { onRevoke() {} })!;
		assert.equal(closes, 0, "released/closing old content is not asked to close again");
		assert.equal(b.ready(), false);
		b.release();
		const c = store.reserveOpening("exclusive", { onRevoke() {} })!;
		assert.equal(c.activate(), false);
		old.unregister();
		assert.equal(c.activate(), true);
	});

	it("superseding opening authority revokes old focus callbacks, including after pending cancellation", () => {
		const { store, document } = fixture();
		const opener = document.getElementById("a")!;
		let focuses = 0;
		opener.focus = () => { focuses++; };
		const a = store.reserveOpening("exclusive", { opener, onRevoke() {} })!;
		a.activate();
		a.release();
		const generation = store.getGeneration();
		const focusRevision = store.getFocusRevision();
		assert.equal(store.restoreFocus(opener, generation, focusRevision, a), true, "ordinary release retains return authority");
		const b = store.reserveOpening("exclusive", { onRevoke() {} })!;
		b.release();
		assert.equal(store.restoreFocus(opener, generation, focusRevision, a), false, "cancelled newer intent does not revive old focus authority");
		assert.equal(focuses, 1);
	});
});
