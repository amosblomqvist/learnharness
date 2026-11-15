/**
 * Host hold wiring at the work entry points: turns (preparation + liveness),
 * the side-chat service, plugin workers/agents commits, and the desktop
 * lifecycle IPC routing (electron/lifecycle.cjs).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { acquireHold, isHostIdle, resetHostHoldForTests, runningWork } from "../src/core/host-hold.ts";
import type { TurnInput } from "../src/core/input-events.ts";

afterEach(() => resetHostHoldForTests());

test("a turn is refused with 503 and the hold's message while a hold is active", async () => {
	acquireHold({ owner: "github-sync", reason: "GitHub Sync is syncing" });
	const res = await handleChatInput("no-such-chat", { type: "text", text: "hi" } as unknown as TurnInput);
	assert.equal(res.status, 503);
	const body = await res.json() as { error: string; hold: { owner: string } };
	assert.match(body.error, /GitHub Sync is syncing/);
	assert.equal(body.hold.owner, "github-sync");
	assert.equal(isHostIdle(), true);
});

test("turn preparation ends its work lease on every return path", async () => {
	const res = await handleChatInput("no-such-chat", { type: "text", text: "hi" } as unknown as TurnInput);
	assert.equal(res.status, 404);
	assert.equal(isHostIdle(), true);
});

test("a live turn is registered work from beginTurn until endTurn", () => {
	assert.equal(beginTurn("hold-chat"), true);
	assert.deepEqual(runningWork().map((w) => [w.kind, w.label]), [["turn", "hold-chat"]]);
	assert.equal(acquireHold({ owner: "p", reason: "r" }), null);
	endTurn("hold-chat");
	assert.equal(isTurnRunning("hold-chat"), false);
	assert.equal(isHostIdle(), true);
	acquireHold({ owner: "p", reason: "r" });
	assert.throws(() => beginTurn("hold-chat"), /Changes are paused/);
	assert.equal(isTurnRunning("hold-chat"), false);
});

test("lifecycle IPC routes only well-formed lh:lifecycle messages and sends ops", () => {
	const { attachLifecycleChild, statusPage } = createRequire(import.meta.url)("../electron/lifecycle.cjs");
	const child = Object.assign(new EventEmitter(), { connected: true, sent: [] as unknown[], send(message: unknown, cb: () => void) { this.sent.push(message); cb(); } });
	const seen: unknown[] = [];
	const channel = attachLifecycleChild(child, {
		beforeLoad: (state: string, plugins: string[]) => seen.push(["load", state, plugins]),
		hooks: (beforeQuit: boolean) => seen.push(["hooks", beforeQuit]),
		restart: () => seen.push(["restart"]),
		beforeQuitDone: () => seen.push(["quit-done"]),
	});
	child.emit("message", { channel: "lh:lifecycle", op: "before-load", state: "start", plugins: ["GitHub Sync", 3] });
	child.emit("message", { channel: "lh:lifecycle", op: "before-load", state: "bogus" });
	child.emit("message", { channel: "lh:other", op: "restart" });
	child.emit("message", { channel: "lh:lifecycle", op: "hooks", beforeQuit: true });
	child.emit("message", { channel: "lh:lifecycle", op: "hooks", beforeQuit: "yes" });
	child.emit("message", { channel: "lh:lifecycle", op: "restart" });
	child.emit("message", { channel: "lh:lifecycle", op: "before-quit", state: "done" });
	child.emit("message", null);
	assert.deepEqual(seen, [["load", "start", ["GitHub Sync"]], ["hooks", true], ["restart"], ["quit-done"]]);
	assert.equal(channel.send("skip"), true);
	assert.deepEqual(child.sent, [{ channel: "lh:lifecycle", op: "skip" }]);
	channel.dispose();
	child.emit("message", { channel: "lh:lifecycle", op: "restart" });
	assert.equal(seen.length, 4);
	assert.equal(channel.send("skip"), false);
	const page = statusPage({ title: "Syncing <data>", detail: "", action: "skip", actionLabel: "Skip", colors: { color: "#000", symbolColor: "#fff" } });
	assert.match(page, /Syncing &lt;data&gt;/);
	assert.match(page, /href="lh-lifecycle:\/\/skip"/);
	assert.match(page, /default-src 'none'/);
});
