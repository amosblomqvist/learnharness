/**
 * Turn liveness registry unit tests (src/server/turn-liveness.ts): one turn
 * per chat, ever — begin/end round trip, double-begin rejection, restart
 * after end, and a turn that runs past 30 minutes still owns its chat (no
 * clock ever frees it). The lifecycle-emitter pins ride the same seams:
 * turn-started on the accepted begin only, turn-settled on the live end
 * only, and the registry already consistent when the listener runs.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { runningWorkBlocker } from "../src/server/chats.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { subscribe, type ServerEvent } from "../src/core/events.ts";
import { rememberTurnFailure, settledTurnResponse } from "../src/server/turn-runs.ts";

describe("turn liveness registry", () => {
	it("retains a late-attach failure notice until the next accepted begin", async () => {
		const id = "chat_failure_notice_unit";
		rememberTurnFailure(id, "The reply could not be saved.");
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./);
		assert.match(await settledTurnResponse(id).text(), /The reply could not be saved\./, "reading does not consume the notice");
		assert.equal(beginTurn(id), true);
		assert.doesNotMatch(await settledTurnResponse(id).text(), /"type":"error"/);
		endTurn(id);
	});

	it("begin/end round trip; a second begin is rejected until the turn ends", () => {
		const id = "chat_liveness_unit";
		assert.equal(isTurnRunning(id), false, "initially idle");
		assert.equal(beginTurn(id), true, "first turn accepted");
		assert.equal(isTurnRunning(id), true, "in flight");
		assert.equal(beginTurn(id), false, "no two turns for one chat");
		endTurn(id);
		assert.equal(isTurnRunning(id), false, "cleared at finish");
		assert.equal(beginTurn(id), true, "a new turn may start after the last ended");
		endTurn(id);
	});

	it("a turn running past 30 minutes still owns its chat: no second turn, no delete", () => {
		mock.timers.enable({ apis: ["Date"] });
		const id = "chat_liveness_long_turn";
		try {
			assert.equal(beginTurn(id), true);
			mock.timers.tick(31 * 60_000);
			assert.equal(isTurnRunning(id), true, "still in flight after 31 minutes");
			assert.equal(beginTurn(id), false, "a second turn is still rejected");
			assert.equal(runningWorkBlocker(id)?.code, "turn_in_flight", "the chat cannot be deleted");
			endTurn(id);
			assert.equal(runningWorkBlocker(id), null, "deletable once the turn ends");
			assert.equal(beginTurn(id), true, "a new turn may start after the long one ended");
		} finally {
			endTurn(id);
			mock.timers.reset();
		}
	});
});

describe("turn lifecycle events", () => {
	it("beginTurn emits turn-started on success only — the 409 double-begin stays silent", () => {
		const id = "chat_events_begin";
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		assert.equal(beginTurn(id), true, "fresh chat accepts the turn");
		assert.equal(beginTurn(id), false, "the rejected double-begin");
		assert.deepEqual(got, [{ type: "turn-started", chatId: id }], "exactly one event");
		endTurn(id); // cleanup (its settle is asserted in the next case's terms)
		off();
	});

	it("endTurn emits turn-settled only when a live entry was present", () => {
		const id = "chat_events_end";
		const got: ServerEvent[] = [];
		let runningAtSettle: boolean | undefined;
		const off = subscribe((e) => {
			got.push(e);
			// The settle must be observable as already-idle: the registry
			// write happens BEFORE the emit, so a listener that fetches truth
			// (the whole point of notify → fetch) reads consistent state.
			if (e.type === "turn-settled") runningAtSettle = isTurnRunning(id);
		});
		beginTurn(id);
		got.length = 0; // focus on the settle path
		endTurn(id); // live entry → settle
		endTurn(id); // absent entry → defensive no-op, must stay silent
		assert.deepEqual(got, [{ type: "turn-settled", chatId: id }]);
		assert.equal(runningAtSettle, false, "listener sees the registry already cleared");
		off();
	});
});
