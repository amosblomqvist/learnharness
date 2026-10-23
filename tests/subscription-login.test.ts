/** Subscription login flow with a fake OAuth provider and a temp credential store. No network. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { createProviderCredentialStore } from "../src/store/provider-credentials.ts";
import { createSubscriptionService } from "../src/server/subscriptions.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sub-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const ID = "subscription-openai-codex" as const;
const cred = (access = "ACCESS-SECRET"): OAuthCredential => ({ type: "oauth", access, refresh: "REFRESH-SECRET", expires: 1_900_000_000_000 });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
	return { promise, resolve, reject };
}

type Login = OAuthAuth["login"];
function setup(login: Login, extra: Partial<Parameters<typeof createSubscriptionService>[0]> = {}) {
	const store = createProviderCredentialStore(path.join(TMP, `c${n++}`, "credentials.json"), { pollMs: 2 });
	let loads = 0;
	const oauth = { name: "fake", login, refresh: async (c: OAuthCredential) => c, toAuth: async () => ({}) } as OAuthAuth;
	const svc = createSubscriptionService({ credentials: store, getOAuth: () => (loads++, oauth), ...extra });
	return { store, svc, loads: () => loads };
}
const services: { dispose(): void }[] = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));
function mk(login: Login, extra = {}) {
	const s = setup(login, extra);
	services.push(s.svc);
	return s;
}
async function settle(svc: ReturnType<typeof setup>["svc"], id: string) {
	for (let i = 0; i < 200; i++) {
		const v = svc.get(id);
		if (v.state !== "pending") return v;
		await tick(2);
	}
	throw new Error("did not settle");
}

describe("subscription login", () => {
	it("passes agentName, persists on success, status shows connected without secrets", async () => {
		let seen: unknown;
		const { svc, store } = mk(async (_i, opts) => ((seen = opts), cred()));
		const v = await svc.start(ID);
		assert.deepEqual(seen, { agentName: "LearnHarness" });
		const done = await settle(svc, v.id);
		assert.equal(done.state, "connected");
		assert.equal((store.peek(ID) as OAuthCredential).access, "ACCESS-SECRET");
		const st = await svc.statuses();
		assert.equal(st.length, 3);
		const row = st.find((s) => s.id === ID)!;
		assert.equal(row.connected, true);
		assert.equal(row.expires, 1_900_000_000_000);
		assert.ok(!JSON.stringify([st, done]).includes("SECRET"));
	});

	it("status is read-only: no provider load, corrupt store reads as disconnected", async () => {
		const { svc, store, loads } = mk(async () => cred());
		assert.equal((await svc.statuses()).every((s) => !s.connected), true);
		assert.equal(loads(), 0);
		const f = path.join(TMP, `bad${n++}`, "credentials.json");
		fs.mkdirSync(path.dirname(f), { mode: 0o700 });
		fs.writeFileSync(f, "{{", { mode: 0o600 });
		const bad = createSubscriptionService({ credentials: createProviderCredentialStore(f), getOAuth: () => undefined });
		assert.equal((await bad.statuses()).every((s) => !s.connected), true);
		void store;
	});

	it("rejects unknown providers and unavailable oauth", async () => {
		const { svc } = mk(async () => cred());
		await assert.rejects(svc.start("openai"), { status: 400 });
		await assert.rejects(svc.disconnect("custom-x"), { status: 400 });
		const none = createSubscriptionService({ credentials: createProviderCredentialStore(path.join(TMP, `n${n++}`, "c.json")), getOAuth: () => undefined });
		await assert.rejects(none.start(ID), { status: 503 });
	});

	it("prompts: sanitized view, answer resolves, wrong prompt id/stale/invalid select rejected", async () => {
		let got: string | undefined;
		const { svc } = mk(async (i) => {
			i.notify({ type: "auth_url", url: "https://auth.example/authorize?x=1", instructions: "Open it" });
			i.notify({ type: "auth_url", url: "javascript:alert(1)" });
			i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" });
			const pick = await i.prompt({ type: "select", message: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
			got = pick + (await i.prompt({ type: "manual_code", message: "Paste" }));
			return cred();
		});
		const v = await svc.start(ID);
		await tick();
		const cur = svc.get(v.id);
		assert.deepEqual(cur.events.map((e) => e.type), ["auth_url", "device_code"]);
		assert.equal(cur.prompt?.type, "select");
		assert.throws(() => svc.answer(v.id, "nope", "a"), { status: 409 });
		assert.throws(() => svc.answer(v.id, cur.prompt!.id, "zzz"), { status: 400 });
		assert.throws(() => svc.answer(v.id, cur.prompt!.id, 5), { status: 400 });
		svc.answer(v.id, cur.prompt!.id, "b");
		assert.throws(() => svc.answer(v.id, cur.prompt!.id, "b"), { status: 409 }); // stale
		await tick();
		const p2 = svc.get(v.id).prompt!;
		assert.equal(p2.type, "manual_code");
		assert.throws(() => svc.answer(v.id, p2.id, "x".repeat(20_000)), { status: 400 });
		svc.answer(v.id, p2.id, "CODE");
		assert.equal((await settle(svc, v.id)).state, "connected");
		assert.equal(got, "bCODE");
	});

	it("prompt answers are not echoed into views", async () => {
		const { svc } = mk(async (i) => (await i.prompt({ type: "secret", message: "k" }), cred()));
		const v = await svc.start(ID);
		await tick();
		const p = svc.get(v.id).prompt!;
		const after = svc.answer(v.id, p.id, "TYPED-SECRET");
		assert.ok(!JSON.stringify(after).includes("TYPED-SECRET"));
	});

	it("caps and drops oldest events", async () => {
		const { svc } = mk(
			async (i) => {
				for (let k = 0; k < 20; k++) i.notify({ type: "progress", message: `m${k}` });
				await new Promise(() => {});
				return cred();
			},
			{ maxEvents: 5 },
		);
		const v = await svc.start(ID);
		const cur = svc.get(v.id);
		assert.equal(cur.events.length, 5);
		assert.equal(cur.events[0]?.message, "m15");
	});

	it("failure reports a fixed message, never supplier text", async () => {
		const { svc, store } = mk(async () => {
			throw new Error("invalid_grant code=SUPPLIER-CODE-99 token=TOKEN-XYZ");
		});
		const v = await svc.start(ID);
		const done = await settle(svc, v.id);
		assert.equal(done.state, "failed");
		assert.equal(done.error, "Login failed.");
		assert.ok(!JSON.stringify(done).includes("SUPPLIER"));
		assert.equal(store.has(ID), false);
	});

	it("malformed credential from provider fails", async () => {
		const { svc, store } = mk((async () => ({ type: "oauth", access: "a" })) as unknown as Login);
		const done = await settle(svc, (await svc.start(ID)).id);
		assert.equal(done.state, "failed");
		assert.equal(store.has(ID), false);
	});

	it("cancel aborts the flow, rejects pending prompt, and a late result is NOT persisted", async () => {
		const late = deferred<OAuthCredential>();
		let signal!: AbortSignal;
		let promptRejected = false;
		const { svc, store } = mk(async (i) => {
			signal = i.signal;
			i.prompt({ type: "text", message: "x" }).catch(() => (promptRejected = true));
			return late.promise; // flow ignores abort and resolves late
		});
		const v = await svc.start(ID);
		await tick();
		const c = await svc.cancel(v.id);
		assert.equal(c.state, "cancelled");
		assert.equal(c.prompt, undefined);
		assert.equal(signal.aborted, true);
		await tick();
		assert.equal(promptRejected, true);
		late.resolve(cred());
		await tick(20);
		assert.equal(store.has(ID), false);
		assert.equal(svc.get(v.id).state, "cancelled");
		assert.throws(() => svc.answer(v.id, "p", "v"), { status: 409 });
		await assert.rejects(svc.cancel("missing"), { status: 404 });
	});

	it("disconnect during login drops the late result and keeps old credential gone", async () => {
		const late = deferred<OAuthCredential>();
		const { svc, store } = mk(async () => late.promise);
		const v = await svc.start(ID);
		await store.modify(ID, async () => cred("OLD"));
		await svc.disconnect(ID);
		assert.equal(store.has(ID), false);
		late.resolve(cred("NEW"));
		await tick(20);
		assert.equal(store.has(ID), false);
		assert.equal(svc.get(v.id).state, "cancelled");
	});

	it("disconnect while the persist waits on the store lock still wins", async () => {
		const { svc, store } = mk(async () => cred("NEW"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const holder = store.modify("other-provider", async () => (await gate, { type: "api_key", key: "k" }));
		await tick();
		const v = await svc.start(ID); // login resolves, persist queues behind the lock
		const dis = svc.disconnect(ID);
		release();
		await holder;
		await dis;
		await tick(30);
		assert.equal(store.has(ID), false);
		assert.equal(svc.get(v.id).state, "cancelled");
	});

	it("a new attempt supersedes the old one; the old late result cannot win", async () => {
		const first = deferred<OAuthCredential>();
		let call = 0;
		const { svc, store } = mk(async () => (call++ === 0 ? first.promise : cred("SECOND")));
		const a = await svc.start(ID);
		const b = await svc.start(ID);
		assert.equal(svc.get(a.id).state, "cancelled");
		assert.equal((await settle(svc, b.id)).state, "connected");
		first.resolve(cred("FIRST"));
		await tick(20);
		assert.equal((store.peek(ID) as OAuthCredential).access, "SECOND");
	});

	it("expires pending attempts after the TTL", async () => {
		let t = 1000;
		const { svc } = mk(async () => new Promise<OAuthCredential>(() => {}), { now: () => t, ttlMs: 600_000 });
		const v = await svc.start(ID);
		t += 600_001;
		const done = svc.get(v.id);
		assert.equal(done.state, "failed");
		assert.equal(done.error, "Login timed out.");
	});

	it("timer-based TTL fires", async () => {
		const { svc } = mk(async () => new Promise<OAuthCredential>(() => {}), { ttlMs: 20 });
		const v = await svc.start(ID);
		await tick(60);
		assert.equal(svc.get(v.id).state, "failed");
	});

	it("terminal attempts are pruned after retention; attempt count is bounded", async () => {
		let t = 0;
		const { svc } = mk(async () => cred(), { now: () => t, retentionMs: 100 });
		const v = await svc.start(ID);
		await settle(svc, v.id);
		t += 101;
		assert.throws(() => svc.get(v.id), { status: 404 });

		const hung = mk(async () => new Promise<OAuthCredential>(() => {}), { maxAttempts: 1 });
		await hung.svc.start(ID);
		await hung.svc.start("subscription-anthropic").then(
			() => assert.fail("expected limit"),
			(e) => assert.equal(e.status, 429),
		);
	});

	it("disconnect is idempotent and removes stored credential", async () => {
		const { svc, store } = mk(async () => cred());
		await store.modify(ID, async () => cred());
		await svc.disconnect(ID);
		await svc.disconnect(ID);
		assert.equal((await svc.statuses()).find((s) => s.id === ID)!.connected, false);
	});

	it("start refuses while already connected; disconnect then reconnect works", async () => {
		const { svc, store } = mk(async () => cred("RECONNECTED"));
		await store.modify(ID, async () => cred("ESTABLISHED"));
		await assert.rejects(svc.start(ID), { status: 409 });
		assert.equal((store.peek(ID) as OAuthCredential).access, "ESTABLISHED");
		await svc.disconnect(ID);
		const v = await svc.start(ID);
		assert.equal((await settle(svc, v.id)).state, "connected");
		assert.equal((store.peek(ID) as OAuthCredential).access, "RECONNECTED");
	});

	it("cancelling an already-settled attempt never touches the store", async () => {
		const { svc, store } = mk(async () => cred("KEEP"));
		const v = await svc.start(ID);
		assert.equal((await settle(svc, v.id)).state, "connected");
		const c = await svc.cancel(v.id);
		assert.equal(c.state, "connected");
		assert.equal((store.peek(ID) as OAuthCredential).access, "KEEP");
		await assert.rejects(svc.start(ID), { status: 409 }); // and a new start doesn't delete it either
		assert.equal((store.peek(ID) as OAuthCredential).access, "KEEP");
	});

	it("concurrent start() calls: at most one pending attempt and one committed credential", async () => {
		const gates = [deferred<OAuthCredential>(), deferred<OAuthCredential>(), deferred<OAuthCredential>()];
		let call = 0;
		const { svc, store } = mk(async () => gates[call++]!.promise);
		const views = await Promise.all([svc.start(ID), svc.start(ID), svc.start(ID)]);
		const states = views.map((v) => svc.get(v.id).state);
		assert.equal(states.filter((s) => s === "pending").length, 1);
		assert.equal(states.filter((s) => s === "cancelled").length, 2);
		// resolve in reverse order; only the surviving attempt may persist
		const live = views.findIndex((v) => svc.get(v.id).state === "pending");
		gates.forEach((g, i) => g.resolve(cred(`C${i}`)));
		await tick(40);
		const finalStates = views.map((v) => svc.get(v.id).state);
		assert.equal(finalStates.filter((s) => s === "connected").length, 1);
		assert.equal(finalStates[live], "connected");
		assert.equal((store.peek(ID) as OAuthCredential).access, `C${live}`);
	});

	it("TTL never fails an attempt whose write is already accepted", async () => {
		const real = createProviderCredentialStore(path.join(TMP, `ttl${n++}`, "credentials.json"), { pollMs: 2 });
		const gate = deferred<void>();
		let accepted!: () => void;
		const acceptedP = new Promise<void>((r) => (accepted = r));
		const slow: typeof real = Object.assign(Object.create(real), {
			modify: (id: string, fn: Parameters<typeof real.modify>[1], o?: Parameters<typeof real.modify>[2]) =>
				real.modify(id, async (cur) => {
					const r = await fn(cur);
					if (r) {
						accepted();
						await gate.promise; // write accepted, persistence still in flight
					}
					return r;
				}, o),
		});
		const oauth = { name: "f", login: async () => cred("SLOW"), refresh: async (c: OAuthCredential) => c, toAuth: async () => ({}) } as OAuthAuth;
		const svc = createSubscriptionService({ credentials: slow, getOAuth: () => oauth, ttlMs: 20 });
		services.push(svc);
		const v = await svc.start(ID);
		await acceptedP;
		await tick(60); // timer fired, and polling prunes
		assert.equal(svc.get(v.id).state, "pending");
		gate.resolve();
		assert.equal((await settle(svc, v.id)).state, "connected");
		assert.equal((real.peek(ID) as OAuthCredential).access, "SLOW");
	});
});
