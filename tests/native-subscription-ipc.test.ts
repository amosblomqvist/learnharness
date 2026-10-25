import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
	nativeSubscriptionConnected, nativeSubscriptionLease, nativeSubscriptionModelIds, nativeSubscriptionAbortController, nativeSubscriptionScope,
	nativeSubscriptionStatus, refreshNativeSubscriptionModels, nativeSubscriptionRequest, type NativeSubscriptionProviderId,
} from "../src/agent/native-subscription-bridge.ts";

/** Real electron/subscriptions-ipc.cjs on one end, the real bridge on the other, joined by a fake IPC pair. */
const { attachSubscriptionChild } = createRequire(import.meta.url)("../electron/subscriptions-ipc.cjs") as { attachSubscriptionChild: (child: any, map: Map<string, any>) => { send: (v: unknown) => void; dispose: () => void } };
const A: NativeSubscriptionProviderId = "subscription-anthropic", X: NativeSubscriptionProviderId = "subscription-xai";
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;

class FakeConnection {
	epoch = 1; authorityRevision = 1; revision = 1; activeId = "acct-1"; leaseCalls: { background: boolean; message: any }[] = []; leaseError: any = null;
	constructor(public label: string, public token: string) {}
	stamp() { return { epoch: this.epoch, authorityRevision: this.authorityRevision, revision: this.revision }; }
	// Extra fields mimic internal state that must never cross the boundary.
	snapshot() { return { available: true, pending: false, allowBackgroundUse: true, activeId: this.activeId, accounts: [{ id: this.activeId, label: `${this.label} account 1`, connected: true, credential: { access: "LEAK", refresh: "LEAK" } }], error: null, refreshToken: "LEAK" }; }
	async status() { return this.snapshot(); }
	async models() { return { ...this.stamp(), status: this.snapshot(), accountId: this.activeId, models: [{ id: "model-a", name: "A", secret: "LEAK" }] }; }
	async lease(background: boolean, message: any) {
		this.leaseCalls.push({ background, message });
		if (this.leaseError) throw this.leaseError;
		if (message.expectedAccountId !== this.activeId) throw Object.assign(new Error("RAW-INTERNAL stack detail"), { code: "account" });
		return { accessToken: this.token, accountId: this.activeId, ...this.stamp(), refresh: "LEAK" };
	}
}
const conns = { [A]: new FakeConnection("Claude", "sk-ant-oat01-e2e"), [X]: new FakeConnection("Grok", "grok-e2e-opaque") };
let attached: { send: (v: unknown) => void; dispose: () => void };
let wire: any[] = [];
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
/** Main-side onChange wiring: identical shape to connection.notify() in subscriptions.cjs, forwarded through child.send. */
const notify = async (provider: NativeSubscriptionProviderId, invalidate: string) => { const c = conns[provider]; c.revision++; attached.send({ channel: "lh:subscription", kind: "state", provider, stamp: c.stamp(), status: c.snapshot(), invalidate }); await new Promise((r) => setTimeout(r, 0)); };

before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	const child = new EventEmitter() as EventEmitter & { connected: boolean; send: (m: unknown, cb?: () => void) => boolean };
	child.connected = true;
	child.send = (message, cb) => { wire.push(structuredClone(message)); queueMicrotask(() => ipc(structuredClone(message))); cb?.(); return true; };
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: unknown, cb?: () => void) => { queueMicrotask(() => child.emit("message", structuredClone(message))); cb?.(); return true; } });
	attached = attachSubscriptionChild(child, new Map(Object.entries(conns)));
});
after(() => {
	attached.dispose();
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});

test("models/status/lease round trip through the real main IPC handler; nothing but whitelisted fields crosses", async () => {
	wire = [];
	await refreshNativeSubscriptionModels();
	assert.deepEqual([...nativeSubscriptionModelIds(A)], ["model-a"]); assert.deepEqual([...nativeSubscriptionModelIds(X)], ["model-a"]);
	assert.equal(nativeSubscriptionConnected(A), true);
	const scope = nativeSubscriptionScope(A, "model-a");
	const lease = await nativeSubscriptionLease(scope, true);
	assert.deepEqual(lease, { accessToken: "sk-ant-oat01-e2e", accountId: "acct-1", epoch: 1, authorityRevision: 1, revision: conns[A].revision });
	const call = conns[A].leaseCalls.at(-1)!;
	assert.equal(call.background, true);
	assert.deepEqual({ provider: call.message.provider, op: call.message.op, expectedAccountId: call.message.expectedAccountId, expectedAuthorityRevision: call.message.expectedAuthorityRevision, selectedModelId: call.message.selectedModelId }, { provider: A, op: "lease", expectedAccountId: "acct-1", expectedAuthorityRevision: 1, selectedModelId: "model-a" });
	// Replies echo id/provider/op; leaked internals never reach the server process (token only inside the lease reply).
	for (const r of wire) { assert.equal(r.channel, "lh:subscription"); assert.ok(r.id && r.provider && r.op); }
	assert.ok(!JSON.stringify(wire.filter((r) => r.op !== "lease")).includes("LEAK"));
	assert.ok(!JSON.stringify(wire.filter((r) => r.op === "lease")).includes("LEAK"));
	assert.ok(!JSON.stringify(nativeSubscriptionStatus(A)).includes("LEAK"));
	assert.deepEqual(nativeSubscriptionStatus(A).accounts, [{ id: "acct-1", label: "Claude account 1", connected: true }]);
	// Grok token is accepted as-is: no format rule.
	assert.equal((await nativeSubscriptionLease(nativeSubscriptionScope(X, "model-a"), false)).accessToken, "grok-e2e-opaque");
});

test("real state pushes (kind:state) invalidate and abort exactly as main notifies", async () => {
	await refreshNativeSubscriptionModels();
	const bg = nativeSubscriptionAbortController(A, true), fg = nativeSubscriptionAbortController(A, false), grok = nativeSubscriptionAbortController(X, true);
	await notify(A, "background");
	assert.equal(bg.controller.signal.reason, "background"); assert.equal(fg.controller.signal.aborted, false); assert.equal(grok.controller.signal.aborted, false);
	conns[A].authorityRevision++; await notify(A, "all");
	assert.equal(fg.controller.signal.reason, "all"); assert.equal(grok.controller.signal.aborted, false);
	assert.equal(nativeSubscriptionModelIds(A).size, 0, "catalog invalidated by 'all'");
	await refreshNativeSubscriptionModels();
	assert.deepEqual([...nativeSubscriptionModelIds(A)], ["model-a"]);
	bg.release(); fg.release(); grok.release();
});

test("main-authored public errors become the rejection; raw internals never reach the bridge", async () => {
	await refreshNativeSubscriptionModels();
	const scope = nativeSubscriptionScope(A, "model-a");
	conns[A].leaseError = Object.assign(new Error("RAW-SECRET refresh_token=abc"), { code: "expired" });
	await assert.rejects(nativeSubscriptionLease(scope, false), (e: Error) => /Claude session could not be refreshed/.test(e.message) && !/RAW|abc/.test(e.message));
	conns[A].leaseError = Object.assign(new Error("RAW-SECRET"), { code: "weird" });
	await assert.rejects(nativeSubscriptionLease(scope, false), (e: Error) => /no API-key fallback/.test(e.message) && !/RAW/.test(e.message));
	conns[A].leaseError = null;
});

test("unknown provider and malformed lease requests get a safe error, not a hang", async () => {
	await assert.rejects(nativeSubscriptionRequest("subscription-openai-codex" as any, "status", {}), /Unsupported/, "bridge refuses before sending");
	// Malformed lease (no boolean background) is rejected by main with the generic request error.
	await assert.rejects(nativeSubscriptionRequest(X, "lease", { background: "yes" }), /Invalid Grok request/);
});

test("a change of account on main makes an older lease expectation fail closed", async () => {
	await refreshNativeSubscriptionModels();
	const scope = nativeSubscriptionScope(X, "model-a");
	conns[X].activeId = "acct-2"; conns[X].authorityRevision++; await notify(X, "all");
	await assert.rejects(nativeSubscriptionLease(scope, false), /catalog authority changed/);
	conns[X].activeId = "acct-1";
});
