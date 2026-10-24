/**
 * THE TERMINAL IS LAST IN FACT, NOT JUST IN NAME (the silent-turn fix).
 *
 * Issue #23: a prompt is accepted, nothing comes back, and nothing is said.
 * One of the ways a turn dies that way is the SETTLE SEAM — the record write,
 * the usage append, endTurn. pi awaits its listeners in an unguarded loop
 * (agent.js), so a throw from onFinish rejects agent.continue() and lands in
 * runPiTurn's loop-level catch; with [DONE] already queued by closeAll, every
 * view had been told the turn ended cleanly, `settled` swallowed the error, and
 * the console line was skipped by the same early return.
 *
 * These tests pin the contract directly against runPiTurn — no engine, no
 * store, no network: a fake agent, a scripted settle, and the frames the
 * subscriber actually receives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";

type Listener = (event: unknown) => unknown | Promise<unknown>;

/** The smallest object runPiTurn touches: subscribe · continue · state ·
 *  abort. `events` is what the loop dispatches; `throwWith` is a loop-level
 *  failure (agent.continue rejecting), which is a different terminal. */
function fakeAgent(opts: { events?: unknown[]; throwWith?: unknown; messages?: unknown[] } = {}) {
	const listeners = new Set<Listener>();
	return {
		state: { messages: opts.messages ?? [] },
		subscribe(listener: Listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async continue() {
			for (const event of opts.events ?? []) for (const listener of listeners) await listener(event);
			if (opts.throwWith !== undefined) throw opts.throwWith;
		},
		abort() {},
	};
}

const AGENT_END = { type: "agent_end", messages: [] };

/** Drain a subscriber stream into its wire frames ("data: X\n\n" → "X"). */
async function frames(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const text = await new Response(stream).text();
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((frame) => frame.replace(/^data: /, ""));
}

const errorFrames = (all: string[]) => all.filter((f) => f.includes('"type":"error"'));

describe("runPiTurn — a settle failure can never be a clean end", () => {
	it("emits the settle error BEFORE [DONE]", async () => {
		const handle = runPiTurn({
			agent: fakeAgent({ events: [AGENT_END] }) as never,
			onFinish: () => {
				throw new Error("disk full");
			},
			onSettleError: () => "The reply could not be saved.",
		});
		const all = await frames(handle.subscribe());
		const errors = errorFrames(all);
		assert.equal(errors.length, 1, "the failure went on the wire");
		assert.equal(JSON.parse(errors[0]!).errorText, "The reply could not be saved.");
		// The whole point: [DONE] closes the view to new events, so an error
		// queued after it can never be seen. Order is the fix.
		assert.ok(
			all.indexOf(errors[0]!) < all.indexOf("[DONE]"),
			"the error precedes the terminal",
		);
		assert.equal(all.at(-1), "[DONE]", "the terminal is last");
	});

	it("clears the caller's liveness before the views are told (a dead turn must not look in flight)", async () => {
		const order: string[] = [];
		const handle = runPiTurn({
			agent: fakeAgent({ events: [AGENT_END] }) as never,
			onFinish: () => {
				order.push("settle");
				throw new Error("boom");
			},
			onSettleFailure: () => void order.push("cleanup"),
			onSettleError: () => "failed",
		});
		const errors = errorFrames(await frames(handle.subscribe()));
		assert.deepEqual(order, ["settle", "cleanup"], "the settle threw, then its cleanup ran");
		assert.equal(errors.length, 1, "…and only then did the failure reach the views");
	});

	it("a cleanup that itself throws does not swallow the report", async () => {
		const handle = runPiTurn({
			agent: fakeAgent({ events: [AGENT_END] }) as never,
			onFinish: () => {
				throw new Error("boom");
			},
			onSettleFailure: () => {
				throw new Error("cleanup also broke");
			},
			onSettleError: () => "The reply could not be saved.",
		});
		const errors = errorFrames(await frames(handle.subscribe()));
		assert.equal(errors.length, 1, "the learner is still told");
	});

	it("a healthy settle emits no error and still ends in [DONE] (the regression)", async () => {
		let settled = 0;
		const handle = runPiTurn({
			agent: fakeAgent({ events: [AGENT_END] }) as never,
			onFinish: () => void (settled += 1),
		});
		const all = await frames(handle.subscribe());
		assert.equal(settled, 1, "the seam ran once");
		assert.equal(errorFrames(all).length, 0, "a good turn stays quiet");
		assert.equal(all.at(-1), "[DONE]");
	});

	it("a loop-level failure followed by a failing settle reports ONE error, and it is the loop's", async () => {
		const handle = runPiTurn({
			agent: fakeAgent({ throwWith: new Error("provider exploded") }) as never,
			onError: () => "An error occurred.",
			onFinish: () => {
				throw new Error("and the save failed too");
			},
			onSettleError: () => "The reply could not be saved.",
		});
		const errors = errorFrames(await frames(handle.subscribe()));
		assert.equal(errors.length, 1, "no contradictory second failure on the same turn");
		assert.equal(JSON.parse(errors[0]!).errorText, "An error occurred.");
		assert.equal((await frames(handle.subscribe())).at(-1), "[DONE]", "a late subscriber still gets the terminal");
	});
});
