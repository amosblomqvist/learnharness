import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimPreparingTurn } from "../src/server/turn-preparation.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { abortTurn, registerTurn, rememberTurnFailure, runningTurn, settledTurnResponse, unregisterTurn } from "../src/server/turn-runs.ts";
import type { PiTurnHandle } from "../src/server/pi/ui-stream.ts";
import { subscribe } from "../src/core/events.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const terminal = 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n';
let serial = 0;
const chatId = () => `preparation-${++serial}`;

/** A replaying teacher seam: only the teacher owns bytes/history. */
function teacher() {
	const replay = ['data: {"type":"agent_start"}\n\n', 'data: {"type":"message_update","message":"before attach"}\n\n'];
	const views = new Set<ReadableStreamDefaultController<Uint8Array>>();
	let aborted = 0;
	let subscriptions = 0;
	let cancellations = 0;
	const handle: PiTurnHandle = {
		subscribe() {
			subscriptions++;
			let view!: ReadableStreamDefaultController<Uint8Array>;
			return new ReadableStream({
				start(controller) { view = controller; views.add(view); for (const text of replay) controller.enqueue(encode(text)); },
				cancel() { cancellations++; views.delete(view); },
			});
		},
		abort() { aborted++; },
	};
	return {
		handle,
		get aborted() { return aborted; },
		get subscriptions() { return subscriptions; },
		get cancellations() { return cancellations; },
		send(text: string) { replay.push(text); for (const view of views) view.enqueue(encode(text)); },
		settle() { for (const view of views) view.close(); views.clear(); },
		replayText() { return replay.join(""); },
	};
}

describe("private turn preparation ownership", () => {
	it("claims synchronously, registers one stable handle, and excludes all competing begins", () => {
		const id = chatId();
		const prep = claimPreparingTurn(id)!;
		try {
			assert.ok(prep);
			assert.equal(prep.isCurrent(), true);
			assert.ok(runningTurn(id), "handle exists before the first await");
			assert.equal(isTurnRunning(id), true);
			assert.equal(claimPreparingTurn(id), null);
			assert.equal(beginTurn(id), false);
		} finally { prep.finish(); }
		assert.equal(prep.isCurrent(), false);
		assert.equal(runningTurn(id), undefined);
		assert.equal(isTurnRunning(id), false);
	});

	it("preparation emits no bytes; cancellation before handoff detaches only that view", async () => {
		const id = chatId();
		const prep = claimPreparingTurn(id)!;
		const outer = runningTurn(id)!;
		const cancelled = outer.subscribe().getReader();
		let readCompleted = false;
		const pending = cancelled.read().then((result) => { readCompleted = true; return result; });
		await Promise.resolve();
		assert.equal(readCompleted, false, "no synthetic agent_start/terminal while grading");
		await cancelled.cancel();
		assert.equal((await pending).done, true);
		assert.equal(prep.signal.aborted, false);
		assert.equal(prep.isCurrent(), true);
		const real = teacher();
		const text = new Response(outer.subscribe()).text();
		prep.handoff(real.handle);
		assert.equal(real.subscriptions, 1, "cancelled waiting subscriber never attaches to teacher");
		assert.equal(runningTurn(id), outer);
		real.send("data: [DONE]\n\n"); real.settle(); prep.finish();
		assert.equal(await text, real.replayText());
	});

	it("waiting and late views forward the teacher's own replay and live bytes, without a second log", async () => {
		const id = chatId();
		const prep = claimPreparingTurn(id)!;
		const outer = runningTurn(id)!;
		const first = new Response(outer.subscribe()).text();
		const real = teacher();
		prep.handoff(real.handle);
		real.send('data: {"type":"message_end"}\n\n');
		const late = new Response(outer.subscribe()).text();
		real.send("data: [DONE]\n\n"); real.settle(); prep.finish();
		assert.equal(await first, real.replayText());
		assert.equal(await late, real.replayText());
		assert.equal(real.subscriptions, 2);
	});

	it("after handoff a cancelled view cancels only its teacher subscription, and abort delegates", async () => {
		const id = chatId();
		const prep = claimPreparingTurn(id)!;
		const outer = runningTurn(id)!;
		const real = teacher();
		prep.handoff(real.handle);
		const view = outer.subscribe();
		await view.cancel();
		assert.equal(real.cancellations, 1);
		assert.equal(real.aborted, 0);
		assert.equal(prep.signal.aborted, false);
		assert.deepEqual(abortTurn(id), { ok: true });
		assert.equal(real.aborted, 1);
		real.settle(); prep.finish();
	});

	for (const outcome of ["sibling save", "refusal", "save failure", "startup failure", "abort settlement"]) {
		it(`finish terminates every waiting subscriber on ${outcome}, only after explicit settlement`, async () => {
			const id = chatId();
			const prep = claimPreparingTurn(id)!;
			const outer = runningTurn(id)!;
			const texts = [new Response(outer.subscribe()).text(), new Response(outer.subscribe()).text()];
			if (outcome === "abort settlement") {
				assert.deepEqual(abortTurn(id), { ok: true });
				assert.equal(prep.signal.aborted, true);
				assert.equal(beginTurn(id), false, "abort must not release an executing grader");
				assert.equal(runningTurn(id), outer);
			}
			if (outcome.includes("failure")) rememberTurnFailure(id, "Save/start failed");
			prep.finish(); prep.finish();
			const expected = await settledTurnResponse(id).text();
			for (const text of texts) assert.equal(await text, expected);
			assert.equal(await new Response(outer.subscribe()).text(), expected, "late retained handle also terminates");
			assert.equal(runningTurn(id), undefined);
			assert.equal(isTurnRunning(id), false);
			if (!outcome.includes("failure")) assert.equal(expected, terminal);
		});
	}

	it("preparation cannot expire at 30 minutes, even when aborted; teacher handoff resets its TTL", () => {
		const id = chatId();
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const prep = claimPreparingTurn(id)!;
		try {
			now += 31 * 60_000;
			assert.equal(isTurnRunning(id), true);
			assert.equal(prep.isCurrent(), true);
			assert.equal(beginTurn(id), false);
			const real = teacher();
			prep.handoff(real.handle);
			assert.equal(isTurnRunning(id), true, "teacher gets a fresh start timestamp");
			now += 29 * 60_000;
			assert.equal(isTurnRunning(id), true);
			now += 2 * 60_000;
			assert.equal(isTurnRunning(id), false, "existing teacher TTL resumes after transfer");
		} finally { prep.finish(); Date.now = originalNow; }

		const aborted = claimPreparingTurn(id)!;
		try {
			Date.now = () => originalNow() + 60 * 60_000;
			abortTurn(id);
			assert.equal(aborted.signal.aborted, true);
			assert.equal(aborted.isCurrent(), true);
			assert.equal(beginTurn(id), false);
		} finally { aborted.finish(); Date.now = originalNow; }
	});

	it("finish is owner-fenced and idempotent, including an expired teacher's late cleanup", () => {
		const id = chatId();
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const prep = claimPreparingTurn(id)!;
		const real = teacher();
		prep.handoff(real.handle);
		now += 31 * 60_000;
		const successor = claimPreparingTurn(id)!;
		try {
			assert.ok(successor);
			const nextHandle = runningTurn(id);
			assert.equal(prep.isCurrent(), false);
			prep.finish(); prep.finish();
			assert.equal(runningTurn(id), nextHandle);
			assert.equal(successor.isCurrent(), true);
			assert.equal(isTurnRunning(id), true);
		} finally { prep.finish(); successor.finish(); Date.now = originalNow; }
	});

	it("settlement announces once and cannot unregister a successor admitted by a settlement listener", () => {
		const id = chatId();
		const prep = claimPreparingTurn(id)!;
		const next: { prep: ReturnType<typeof claimPreparingTurn> } = { prep: null };
		let settled = 0;
		const off = subscribe((event) => {
			if (event.type !== "turn-settled" || event.chatId !== id) return;
			settled++;
			assert.equal(isTurnRunning(id), false);
			next.prep = claimPreparingTurn(id);
		});
		try {
			prep.finish(); prep.finish();
			assert.equal(settled, 1);
			assert.ok(next.prep);
			assert.equal(next.prep.isCurrent(), true);
			assert.ok(runningTurn(id), "late unregister did not remove the successor");
		} finally { off(); prep.finish(); next.prep?.finish(); }
	});

	it("stale or aborted handoff aborts the incoming teacher and throws without changing ownership", () => {
		for (const state of ["finished", "aborted", "superseded"] as const) {
			const id = chatId();
			const prep = claimPreparingTurn(id)!;
			if (state === "finished") prep.finish();
			if (state === "aborted") abortTurn(id);
			if (state === "superseded") endTurn(id);
			const successor = state === "aborted" ? null : claimPreparingTurn(id)!;
			const nextHandle = runningTurn(id);
			const real = teacher();
			try {
				assert.throws(() => prep.handoff(real.handle), Error);
				assert.equal(real.aborted, 1);
				assert.equal(runningTurn(id), nextHandle);
				if (successor) assert.equal(successor.isCurrent(), true);
			} finally { prep.finish(); successor?.finish(); }
		}
	});

	it("fenced unregister never removes a replacement handle; default unregister stays compatible", () => {
		const id = chatId();
		const first = teacher().handle;
		const second = teacher().handle;
		registerTurn(id, first); registerTurn(id, second);
		unregisterTurn(id, first);
		assert.equal(runningTurn(id), second);
		unregisterTurn(id);
		assert.equal(runningTurn(id), undefined);
	});
});
