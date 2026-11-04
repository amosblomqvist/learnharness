/**
 * The client study tracker (docs/designs/study-time.md): the React-free
 * components/study-tracker.ts with injected clock, focus and send — the
 * SessionModel testing pattern.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudyInput } from "../src/core";
import { createStudyTracker, type StudySendResult } from "../components/study-tracker.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(opts: { focused?: boolean } = {}) {
	const sent: { input: StudyInput; bypassQueue: boolean }[] = [];
	const pending: Array<() => void> = [];
	const state = { focused: opts.focused ?? true, hold: false, reply: (() => ({ ok: true })) as (input: StudyInput) => StudySendResult };
	let tickFn: (() => void) | null = null;
	let ids = 0;
	const timeouts: Array<() => void> = [];
	const tracker = createStudyTracker({
		setInterval: (fn) => {
			tickFn = fn;
			return "interval";
		},
		clearInterval: () => {
			tickFn = null;
		},
		setTimeout: (fn) => {
			timeouts.push(fn);
			return "timeout";
		},
		hasFocus: () => state.focused,
		randomId: () => `win${++ids}`,
		send: (input, { bypassQueue }) => {
			sent.push({ input, bypassQueue });
			if (!state.hold) return Promise.resolve(state.reply(input));
			return new Promise<StudySendResult>((resolve) => pending.push(() => resolve(state.reply(input))));
		},
	});
	return {
		tracker,
		sent,
		state,
		pending,
		types: () => sent.map((s) => `${s.input.type}${"chatId" in s.input ? `:${s.input.chatId}` : ""}`),
		tick: () => tickFn?.(),
		runTimeouts: () => timeouts.splice(0).forEach((fn) => fn()),
	};
}

describe("study tracker: start and stop", () => {
	it("sends active when a started chat is shown in a focused window", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		assert.deepEqual(h.types(), ["active:c1"]);
	});

	it("does nothing for an unstarted chat, or when the window is not focused", async () => {
		const h = harness();
		h.tracker.setChat("c1", false);
		h.state.focused = false;
		h.tracker.setChat("c2", true);
		await flush();
		assert.deepEqual(h.types(), []);
	});

	it("started going false → true sends active", async () => {
		const h = harness();
		h.tracker.setChat("c1", false);
		h.tracker.setChat("c1", true);
		await flush();
		assert.deepEqual(h.types(), ["active:c1"]);
		h.tracker.setChat("c1", true);
		await flush();
		assert.deepEqual(h.types(), ["active:c1"], "an unchanged setChat is a no-op");
	});

	it("a chat change stops the previous chat before activating the next", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		h.tracker.setChat("c2", true);
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1", "active:c2"]);
		h.tracker.setChat(null, false);
		await flush();
		assert.deepEqual(h.types().slice(-1), ["stop:c2"]);
	});

	it("focus() sends active for a started chat", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		h.tracker.focus();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "active:c1"]);
	});

	it("keeps one windowId for every request, across chat switches", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		h.tracker.setChat("c2", true);
		await flush();
		const ids = new Set(h.sent.map((s) => (s.input.type === "closeAll" ? "" : s.input.windowId)));
		assert.deepEqual([...ids], [h.tracker.windowId]);
	});
});

describe("study tracker: blur, visibility, unload", () => {
	it("blur sends stop after the deferred check when the document lost focus", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.state.focused = false;
		h.tracker.blur();
		assert.deepEqual(h.types(), ["active:c1"], "the check is deferred");
		h.runTimeouts();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1"]);
	});

	it("blur sends nothing when focus moved into a demo iframe (document.hasFocus stays true)", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.tracker.blur();
		h.runTimeouts();
		await flush();
		assert.deepEqual(h.types(), ["active:c1"]);
	});

	it("the tick runs checkFocus as a fallback for a lost demo-blur", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.state.focused = false;
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1"]);
	});

	it("visibility(true) stops; visibility(false) restarts when focused", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		h.tracker.visibility(true);
		h.tracker.visibility(false);
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1", "active:c1"]);
		h.tracker.visibility(true);
		h.state.focused = false;
		h.tracker.visibility(false);
		await flush();
		assert.deepEqual(h.types().slice(-1), ["stop:c1"], "not focused: no active");
	});

	it("unload() sends stop immediately, bypassing the queue", async () => {
		const h = harness();
		h.state.hold = true;
		h.tracker.setChat("c1", true); // active is in flight, never settles
		await flush();
		h.tracker.unload();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1"]);
		assert.deepEqual(h.sent.map((s) => s.bypassQueue), [false, true]);
	});

	it("a second stop is not sent for an already stopped chat", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		h.tracker.visibility(true);
		h.tracker.unload();
		h.tracker.dispose();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1"]);
	});
});

describe("study tracker: pings and input", () => {
	it("pings on a tick only when input was noted since the previous tick", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1"], "no input, no ping");
		h.tracker.input({ type: "keydown" });
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "active:c1"]);
		h.tick();
		await flush();
		assert.deepEqual(h.types().length, 2, "the flag was cleared by the ping");
	});

	it("scroll and a still pointer are not input; a moved pointer is", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.tracker.input({ type: "scroll" });
		h.tracker.input({ type: "pointermove", screenX: 1, screenY: 1 }); // first move counts
		h.tick();
		await flush();
		assert.equal(h.sent.length, 2);
		h.tracker.input({ type: "pointermove", screenX: 1, screenY: 1 });
		h.tick();
		await flush();
		assert.equal(h.sent.length, 2, "same position: not input");
		h.tracker.input({ type: "pointermove", screenX: 2, screenY: 1 });
		h.tick();
		await flush();
		assert.equal(h.sent.length, 3);
	});

	it("noteInput() (dictation, demos) counts as input", async () => {
		const h = harness();
		h.tracker.setChat("c1", true);
		await flush();
		h.tracker.noteInput();
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "active:c1"]);
	});

	it("the tick does nothing without a started chat, or without focus", async () => {
		const h = harness();
		h.tracker.noteInput();
		h.tick();
		h.tracker.setChat("c1", false);
		h.tracker.noteInput();
		h.tick();
		await flush();
		assert.deepEqual(h.types(), []);
	});

	it("requests are sent one at a time, in order", async () => {
		const h = harness();
		h.state.hold = true;
		h.tracker.setChat("c1", true);
		h.tracker.setChat("c2", true);
		await flush();
		assert.deepEqual(h.types(), ["active:c1"], "the next waits for the previous to settle");
		h.pending.shift()?.();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1"]);
		h.pending.shift()?.();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "stop:c1", "active:c2"]);
	});
});

describe("study tracker: refusals", () => {
	it("chat_not_started is retried on every tick while focused, until it succeeds", async () => {
		const h = harness();
		let refuse = true;
		h.state.reply = () => (refuse ? { ok: false, error: "chat_not_started" } : { ok: true });
		h.tracker.setChat("c1", true);
		await flush();
		h.tick();
		await flush();
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1", "active:c1", "active:c1"]);
		refuse = false;
		h.tick();
		await flush();
		assert.equal(h.sent.length, 4);
		h.tick();
		await flush();
		assert.equal(h.sent.length, 4, "success ends the retries");
	});

	it("chat_not_found silences the chat until the chat id changes", async () => {
		const h = harness();
		h.state.reply = (input) => (input.type === "active" && input.chatId === "gone" ? { ok: false, error: "chat_not_found" } : { ok: true });
		h.tracker.setChat("gone", true);
		await flush();
		h.tracker.noteInput();
		h.tick();
		h.tracker.focus();
		await flush();
		assert.deepEqual(h.types(), ["active:gone"]);
		h.tracker.setChat("c2", true);
		await flush();
		assert.deepEqual(h.types().slice(-2), ["stop:gone", "active:c2"]);
	});

	it("other failures are ignored (no retry storm)", async () => {
		const h = harness();
		h.state.reply = () => ({ ok: false });
		h.tracker.setChat("c1", true);
		await flush();
		h.tick();
		await flush();
		assert.deepEqual(h.types(), ["active:c1"]);
	});

	it("a send that rejects does not break the queue", async () => {
		const h = harness();
		let first = true;
		h.state.reply = () => {
			if (first) {
				first = false;
				throw new Error("boom");
			}
			return { ok: true };
		};
		h.state.hold = false;
		h.tracker.setChat("c1", true);
		h.tracker.setChat("c2", true);
		await flush();
		assert.ok(h.types().includes("active:c2"));
	});
});
