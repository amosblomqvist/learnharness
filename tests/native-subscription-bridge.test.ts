import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	nativeSubscriptionAbortController, nativeSubscriptionConnected, nativeSubscriptionDenial, nativeSubscriptionLease, nativeSubscriptionModelIds,
	nativeSubscriptionRequest, nativeSubscriptionScope, nativeSubscriptionScopeCurrent, nativeSubscriptionStatus, refreshNativeSubscriptionModels,
	type NativeSubscriptionProviderId,
} from "../src/agent/native-subscription-bridge.ts";

const A: NativeSubscriptionProviderId = "subscription-anthropic", X: NativeSubscriptionProviderId = "subscription-xai";
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET;
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const status = (id = "acct-1", extra: object = {}) => ({ available: true, pending: false, allowBackgroundUse: true, activeId: id, accounts: [{ id, label: "scratch", connected: true }], error: null, ...extra });
let base = 0;
/** Revisions only ever increase in the module-global state, so each test works in its own band. */
const stamp = (revision = 1, epoch = 1, authorityRevision = 1) => ({ epoch, authorityRevision, revision: base + revision });
let sent: any[] = [];
/** Per-test reply hook: return false to leave the request unanswered. */
let respond: (m: any) => Record<string, unknown> | false = (m) => defaultReply(m);
let accountFor: Record<string, string> = {};
function defaultReply(m: any) {
	const acct = accountFor[m.provider] ?? "acct-1";
	if (m.op === "lease") return { ok: true, value: { accessToken: `oauth-${m.provider}`, accountId: acct, ...stamp() } };
	if (m.op === "models") return { ok: true, value: { ...stamp(), status: status(acct), accountId: acct, models: [{ id: "model-a", name: "A" }, { id: "model-b", name: "B" }] } };
	return { ok: true, value: { ...stamp(), status: status(acct) } };
}
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		sent.push(message);
		queueMicrotask(() => { const r = respond(message); if (r) ipc({ channel: "lh:subscription", id: message.id, provider: message.provider, op: message.op, ...r }); });
		callback?.(); return true;
	} });
});
beforeEach(async () => {
	sent = []; accountFor = {}; respond = defaultReply;
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	base += 1000;
	const off = { available: false, pending: false, allowBackgroundUse: false, activeId: null, accounts: [], error: null };
	for (const provider of [A, X]) ipc({ channel: "lh:subscription", kind: "state", provider, stamp: stamp(0), status: off, invalidate: "all" });
	sent = [];
});
after(() => {
	if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
	if (secret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = secret;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});

test("catalog is per provider and strict; connected needs an active connected local connection", async () => {
	assert.equal(nativeSubscriptionConnected(A), false);
	await refreshNativeSubscriptionModels();
	assert.deepEqual(sent.map((m) => [m.provider, m.op, m.channel]).sort(), [[A, "models", "lh:subscription"], [X, "models", "lh:subscription"]]);
	assert.deepEqual([...nativeSubscriptionModelIds(A)], ["model-a", "model-b"]);
	assert.equal(nativeSubscriptionConnected(A), true); assert.equal(nativeSubscriptionConnected(X), true);
	assert.throws(() => nativeSubscriptionScope(A, "not-in-catalog"), /unavailable/);
	const scope = nativeSubscriptionScope(A, "model-a");
	assert.deepEqual(scope, { provider: A, accountId: "acct-1", epoch: 1, authorityRevision: 1, selectedModelId: "model-a" });
	// Other provider's state is independent.
	ipc({ channel: "lh:subscription", kind: "state", provider: X, stamp: stamp(5), status: status("acct-1", { accounts: [{ id: "acct-1", label: "s", connected: false }] }), invalidate: "none" });
	assert.equal(nativeSubscriptionConnected(X), false); assert.equal(nativeSubscriptionConnected(A), true);
	assert.equal(nativeSubscriptionScopeCurrent(scope), true);
});

test("connected status without an active connected account is not connected", async () => {
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(2), status: status("missing", { accounts: [{ id: "other", label: "o", connected: true }] }), invalidate: "none" });
	assert.equal(nativeSubscriptionConnected(A), false);
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(3), status: status("acct-1", { available: false }), invalidate: "none" });
	assert.equal(nativeSubscriptionConnected(A), false);
});

test("replies must echo id, provider and op; stale and wrong-provider replies are ignored", async () => {
	respond = (m) => { ipc({ channel: "lh:subscription", id: m.id, provider: m.provider === A ? X : A, op: m.op, ok: true, value: { ...stamp(), status: status("evil"), accountId: "evil", models: [{ id: "evil", name: "e" }] } }); ipc({ channel: "lh:subscription", id: m.id, provider: m.provider, op: "status", ok: true, value: {} }); return false; };
	const p = nativeSubscriptionRequest<unknown>(A, "models");
	let settled = false; void p.then(() => { settled = true; }, () => { settled = true; });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(settled, false);
	assert.equal(nativeSubscriptionModelIds(A).size, 0);
	// Correct echo resolves.
	ipc({ channel: "lh:subscription", id: sent[0].id, provider: A, op: "models", ok: true, value: "fine" });
	assert.equal(await p, "fine");
});

test("stale state pushes and stale model replies cannot overwrite newer authority", async () => {
	await refreshNativeSubscriptionModels();
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(9), status: status("acct-1"), invalidate: "none" });
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(4), status: status("acct-OLD"), invalidate: "all" });
	assert.equal(nativeSubscriptionStatus(A).activeId, "acct-1");
	assert.equal(nativeSubscriptionModelIds(A).size, 2);
	// A reply with an older revision is ignored wholesale.
	respond = (m) => ({ ok: true, value: { ...stamp(3), status: status("acct-1"), accountId: "acct-1", models: [{ id: "only-stale", name: "s" }] } });
	await refreshNativeSubscriptionModels();
	assert.ok(!nativeSubscriptionModelIds(A).has("only-stale"));
	// Malformed state is ignored.
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: { epoch: -1, authorityRevision: 1, revision: 99 }, status: status("bad"), invalidate: "all" });
	ipc({ channel: "lh:subscription", kind: "state", provider: "chatgpt", stamp: stamp(99), status: status("bad") });
	assert.equal(nativeSubscriptionStatus(A).activeId, "acct-1");
});

test("generation fence: an account switch during an in-flight catalog request drops the old response", async () => {
	let first: any;
	respond = (m) => { first ??= m; return false; };
	const refresh = refreshNativeSubscriptionModels();
	await new Promise((r) => setTimeout(r, 5));
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(2), status: status("acct-2"), invalidate: "all" });
	const reqA = sent.find((m) => m.provider === A); const reqX = sent.find((m) => m.provider === X);
	ipc({ channel: "lh:subscription", id: reqA.id, provider: A, op: "models", ok: true, value: { ...stamp(1), status: status("acct-1"), accountId: "acct-1", models: [{ id: "model-a", name: "A" }] } });
	ipc({ channel: "lh:subscription", id: reqX.id, provider: X, op: "models", ok: true, value: { ...stamp(1), status: status("acct-1"), accountId: "acct-1", models: [{ id: "model-a", name: "A" }] } });
	await refresh;
	assert.equal(nativeSubscriptionModelIds(A).size, 0);
	assert.equal(nativeSubscriptionStatus(A).activeId, "acct-2");
	assert.deepEqual([...nativeSubscriptionModelIds(X)], ["model-a"]);
});

test("lease sends scope fields, validates the stamp/account, and refuses non-oat Claude tokens", async () => {
	await refreshNativeSubscriptionModels();
	const scope = nativeSubscriptionScope(X, "model-a");
	// Grok: no token-format rule; trust is main + provider/op/stamp.
	respond = (m) => ({ ok: true, value: { accessToken: "xai-looks-like-anything", accountId: "acct-1", ...stamp() } });
	assert.equal((await nativeSubscriptionLease(scope, false)).accessToken, "xai-looks-like-anything");
	respond = defaultReply;
	const lease = await nativeSubscriptionLease(scope, true);
	assert.equal(lease.accessToken, "oauth-subscription-xai");
	const req = sent.filter((m) => m.op === "lease").at(-1);
	assert.deepEqual({ ...req, id: undefined }, { id: undefined, channel: "lh:subscription", provider: X, op: "lease", background: true, expectedAccountId: "acct-1", expectedAuthorityRevision: 1, selectedModelId: "model-a" });
	for (const bad of [{ accessToken: "" }, { accountId: "other" }, { authorityRevision: 2 }, { epoch: 7 }]) {
		respond = (m) => ({ ok: true, value: { accessToken: "oauth-ok", accountId: "acct-1", ...stamp(), ...bad } });
		await assert.rejects(nativeSubscriptionLease(scope, false), /stale/, JSON.stringify(Object.keys(bad)));
	}
	// Claude: pinned SDK would send a non-oat token as x-api-key, so refuse it before dispatch.
	const claudeScope = nativeSubscriptionScope(A, "model-a");
	respond = (m) => ({ ok: true, value: { accessToken: "sk-ant-api03-abc", accountId: "acct-1", ...stamp() } });
	await assert.rejects(nativeSubscriptionLease(claudeScope, false), /stale/);
	respond = (m) => ({ ok: true, value: { accessToken: "sk-ant-oat01-fine", accountId: "acct-1", ...stamp() } });
	assert.equal((await nativeSubscriptionLease(claudeScope, false)).accessToken, "sk-ant-oat01-fine");
});

test("authority change while a lease is in flight rejects the lease", async () => {
	await refreshNativeSubscriptionModels();
	const scope = nativeSubscriptionScope(A, "model-a");
	respond = (m) => { queueMicrotask(() => ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(3, 1, 2), status: status("acct-1"), invalidate: "none" })); return { ok: true, value: { accessToken: "oauth-late", accountId: "acct-1", ...stamp(2) } }; };
	await assert.rejects(nativeSubscriptionLease(scope, false), /stale/);
	assert.equal(nativeSubscriptionScopeCurrent(scope), false);
});

test("state notifications abort active controllers: all aborts everything, background only background", async () => {
	const fg = nativeSubscriptionAbortController(A, false), bg = nativeSubscriptionAbortController(A, true), other = nativeSubscriptionAbortController(X, true);
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(2), status: status("acct-1", { allowBackgroundUse: false }), invalidate: "background" });
	assert.equal(bg.controller.signal.aborted, true); assert.equal(bg.controller.signal.reason, "background");
	assert.equal(fg.controller.signal.aborted, false); assert.equal(other.controller.signal.aborted, false);
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(3), status: status("acct-1"), invalidate: "all" });
	assert.equal(fg.controller.signal.reason, "all"); assert.equal(other.controller.signal.aborted, false);
	fg.release(); bg.release(); other.release();
});

test("denial messages are fixed and provider specific", async () => {
	assert.match(nativeSubscriptionDenial(A), /Claude is not connected/);
	assert.match(nativeSubscriptionDenial(X), /Grok is not connected/);
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(2), status: status("acct-1", { allowBackgroundUse: false }), invalidate: "none" });
	assert.match(nativeSubscriptionDenial(A, "background"), /Claude background use is off/);
	assert.match(nativeSubscriptionDenial(A), /unavailable/);
});

test("error replies carry only a main-authored message; mismatched ids never settle", async () => {
	respond = () => ({ ok: false, error: "Claude session expired. Reconnect.", stamp: stamp() });
	await assert.rejects(nativeSubscriptionRequest(A, "status"), /expired/);
});

test("Next-dev style IPC (no desktop marker) fails immediately, sends nothing, and starts no timer", async () => {
	delete process.env.LH_DESKTOP_SERVER;
	const started = Date.now();
	await assert.rejects(nativeSubscriptionRequest(A, "status"), /only in the desktop app/);
	await refreshNativeSubscriptionModels();
	assert.ok(Date.now() - started < 1000, "must not wait for the 45s request timeout");
	assert.equal(sent.length, 0);
	ipc({ channel: "lh:subscription", kind: "state", provider: A, stamp: stamp(50), status: status("x"), invalidate: "none" });
	assert.equal(nativeSubscriptionConnected(A), false);
	// Marker without a capability secret is not enough either.
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "short";
	await assert.rejects(nativeSubscriptionRequest(A, "status"), /only in the desktop app/);
	assert.equal(sent.length, 0);
	process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	// Marker without a connected IPC channel is also not enough.
	Object.defineProperty(process, "connected", { configurable: true, value: false });
	await assert.rejects(nativeSubscriptionRequest(X, "lease"), /only in the desktop app/);
	assert.equal(sent.length, 0);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
});

test("process disconnect aborts requests and clears every provider", async () => {
	await refreshNativeSubscriptionModels();
	const c = nativeSubscriptionAbortController(X, false);
	respond = () => false;
	const pending = nativeSubscriptionRequest(A, "status");
	process.emit("disconnect");
	await assert.rejects(pending, /connection closed/);
	assert.equal(c.controller.signal.reason, "all");
	assert.equal(nativeSubscriptionConnected(A), false); assert.equal(nativeSubscriptionModelIds(X).size, 0);
	c.release();
});
