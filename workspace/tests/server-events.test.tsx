/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture S3,
 * 2026-10-02): one EventSource per window fanned out through the hub.
 * The provider's ENTIRE effect body is wireSource(source, hub) — a plain
 * function — so these pins drive the real wiring with a fake source, no
 * React and no server: typed dispatch, resync-on-open, error isolation,
 * and close-stops-dispatch. The React glue around it (hooks/context) is
 * an adapter seam like lh:turn-state (untested by precedent).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNotifyHub, wireSource, type NotifySource } from "../components/server-events.tsx";

/** A source the test drives by hand — recordable, closable, honest. */
function fakeSource() {
	const events = new Map<string, Set<(data: string) => void>>();
	const opens = new Set<() => void>();
	const src: NotifySource & {
		push(name: string, payload: unknown): void;
		open(): void;
		closed: boolean;
	} = {
		closed: false,
		close() {
			this.closed = true;
		},
		onOpen(cb) {
			opens.add(cb);
		},
		onEvent(name, cb) {
			const set = events.get(name) ?? new Set();
			events.set(name, set);
			set.add(cb);
		},
		push(name, payload) {
			for (const cb of events.get(name) ?? []) cb(JSON.stringify(payload));
		},
		open() {
			for (const cb of opens) cb();
		},
	};
	return src;
}

describe("notify hub + wireSource (the client channel wiring)", () => {
	it("a named frame dispatches to the right subscriber with the parsed payload", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		const got: string[] = [];
		hub.subscribe("turn-started", (p) => got.push(p.chatId));
		hub.subscribe("turn-settled", (p) => got.push(`settled:${p.chatId}`));
		src.push("turn-started", { chatId: "chat_wire" });
		src.push("turn-settled", { chatId: "chat_wire" });
		src.push("jobs-changed", { chatId: "chat_wire" }); // no subscriber — no-op
		assert.deepEqual(got, ["chat_wire", "settled:chat_wire"]);
	});

	it("open fires resync (initial AND reconnect — EventSource's own retry exploited)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let resyncs = 0;
		hub.onResync(() => resyncs++);
		src.open();
		src.open(); // the reconnect case: same callback, fired again
		assert.equal(resyncs, 2);
	});

	it("a throwing handler never breaks its neighbors (the bus's isolation law)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		hub.subscribe("chats-changed", () => {
			throw new Error("handler bug");
		});
		const got: number[] = [];
		hub.subscribe("chats-changed", () => got.push(1));
		src.push("chats-changed", {});
		assert.deepEqual(got, [1]);
	});

	it("an unparseable frame is dropped loudly, never half-fired", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let calls = 0;
		hub.subscribe("activity-changed", () => calls++);
		// dispatch is the seam's own parser — feed it garbage directly
		hub.dispatch("activity-changed", "{not json");
		assert.equal(calls, 0);
	});

	it("unsubscribe stops delivery; close() (the disconnect) is wired through", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		const disconnect = wireSource(src, hub);
		let calls = 0;
		const off = hub.subscribe("chats-changed", () => calls++);
		src.push("chats-changed", {});
		off();
		src.push("chats-changed", {});
		assert.equal(calls, 1);
		assert.equal(src.closed, false, "connected until the provider unmounts");
		disconnect();
		assert.equal(src.closed, true, "the effect's cleanup closes the source");
	});
});
