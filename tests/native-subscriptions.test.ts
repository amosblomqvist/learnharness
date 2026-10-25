import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createSubscription, subscriptionFileStore } = require("../electron/legacy-subscriptions.cjs");
const { attachSubscriptionChild, subscriptionControl } = require("../electron/subscriptions-ipc.cjs");

const CLAUDE = "subscription-anthropic";
const GROK = "subscription-xai";
const cred = (n: string, expires = Date.now() + 3600000) => ({ type: "oauth", access: `access-${n}`, refresh: `refresh-${n}`, expires });
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(5); } assert.fail("condition not reached"); }
async function tmp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-sub-")); return { dir, file: path.join(dir, "sub.json") }; }
const models = async () => [{ id: "m1", name: "Model 1" }];
function make(opts: any = {}) {
	const events: any[] = [];
	const opened: string[] = [];
	const codes: any[] = [];
	const provider = opts.provider ?? CLAUDE;
	const store = opts.store ?? subscriptionFileStore(opts.file, provider);
	const conn = createSubscription({
		provider, label: provider === CLAUDE ? "Claude" : "Grok", store,
		getOAuth: opts.getOAuth ?? (async () => opts.oauth),
		getModels: opts.getModels ?? models,
		openExternal: opts.openExternal ?? (async (u: string) => { opened.push(u); }),
		showDeviceCode: opts.showDeviceCode ?? (async (c: any) => { codes.push(c); }),
		onChange: (e: any) => events.push(e), timeoutMs: opts.timeoutMs ?? 5000,
	});
	return { conn, events, opened, codes };
}
const seed = (provider: string, accounts: any[], activeId: string | null = accounts[0]?.id ?? null, allow = true) => ({ version: 1, provider, activeId, allowBackgroundUse: allow, accounts });
async function seeded(accounts: any[], extra: any = {}) {
	const t = await tmp();
	await subscriptionFileStore(t.file, extra.provider ?? CLAUDE).write(seed(extra.provider ?? CLAUDE, accounts, extra.activeId, extra.allow));
	return { ...t, ...make({ ...extra, file: t.file }) };
}
const acct = (id: string, n: string, expires?: number) => ({ id, label: `Claude account ${id}`, credential: cred(n, expires) });
async function expectFor(conn: any, id: string) {
	await conn.models();
	return { expectedAccountId: id, expectedAuthorityRevision: conn.stamp().authorityRevision, selectedModelId: "m1" };
}
const claudeFlow = (finish: () => Promise<any>, log: any = {}) => ({
	login: async (i: any) => {
		log.method = await i.prompt({ type: "select", message: "x", options: [{ id: "browser", label: "b" }, { id: "copy", label: "c" }] });
		i.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?code=true&state=s" });
		const ac = new AbortController();
		log.manual = i.prompt({ type: "manual_code", message: "paste", signal: ac.signal }).catch((e: any) => { log.manualRejected = e.code; });
		const c = await finish();
		ac.abort();
		await log.manual;
		return c;
	},
	refresh: async () => assert.fail("no refresh"), toAuth: async () => ({}),
});

test("store: round trip, 0700/0600, corrupt data and wrong provider fail closed, symlinks refused", async () => {
	const t = await tmp();
	const sub = path.join(t.dir, "nested", "sub.json");
	try {
		const s = subscriptionFileStore(sub, CLAUDE);
		assert.equal(await s.read(), null);
		const state = seed(CLAUDE, [acct("a", "1")]);
		await s.write(state);
		assert.deepEqual(await s.read(), state);
		if (process.platform !== "win32") {
			assert.equal((await fs.stat(sub)).mode & 0o777, 0o600);
			assert.equal((await fs.stat(path.dirname(sub))).mode & 0o777, 0o700);
			await fs.chmod(sub, 0o644);
			await assert.rejects(s.read(), { code: "storage" });
			await fs.chmod(sub, 0o600);
		}
		await assert.rejects(subscriptionFileStore(sub, GROK).read(), { code: "storage" });
		for (const bad of ["{", JSON.stringify({ ...state, extra: 1 }), JSON.stringify({ ...state, activeId: "zzz" }), JSON.stringify({ ...state, accounts: [{ id: "a", label: "x", credential: { ...cred("1"), id_token: "t" } }] }), JSON.stringify({ ...state, allowBackgroundUse: "yes" })]) {
			await fs.writeFile(sub, bad, { mode: 0o600 });
			await assert.rejects(s.read(), { code: "storage" });
		}
		await assert.rejects(s.write({ ...state, activeId: "zzz" }), { code: "storage" });
		const link = path.join(t.dir, "link.json");
		await fs.symlink(sub, link);
		await assert.rejects(subscriptionFileStore(link, CLAUDE).read(), { code: "storage" });
		await assert.rejects(subscriptionFileStore(link, CLAUDE).write(state), { code: "storage" });
		const c = make({ file: sub });
		assert.equal((await c.conn.status()).available, false, "corrupt file => unavailable");
		assert.match((await c.conn.status()).error ?? "", /could not be read or saved/);
		await assert.rejects(c.conn.lease(false, { expectedAccountId: "a", expectedAuthorityRevision: 0, selectedModelId: "m1" }));
		c.conn.close();
	} finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("Claude login auto-selects browser, opens a trusted URL, manual prompt waits for abort, saves local account", async () => {
	const t = await tmp(); const log: any = {};
	let release: (c: any) => void = () => {};
	const { conn, events, opened } = make({ file: t.file, oauth: claudeFlow(() => new Promise((r) => { release = r; }), log) });
	try {
		const s = await conn.login();
		assert.equal(s.pending, true);
		await until(() => opened.length === 1);
		assert.equal(log.method, "browser");
		await sleep(30);
		assert.equal(log.manualRejected, undefined, "manual_code prompt keeps waiting for the loopback callback");
		release(cred("1"));
		await until(() => !conn.stamp || events.at(-1)?.status.pending === false);
		const st = await conn.status();
		assert.deepEqual(st.accounts.map((a: any) => a.label), ["Claude account 1"]);
		assert.match(st.accounts[0].id, /^[0-9a-f-]{36}$/);
		assert.equal(st.activeId, st.accounts[0].id);
		assert.equal(st.accounts[0].connected, true);
		assert.equal(log.manualRejected, "cancelled");
		assert.doesNotMatch(JSON.stringify(events), /claude\.ai|access-1|refresh-1|oauth/);
		assert.deepEqual(Object.keys(events.at(-1)).sort(), ["channel", "invalidate", "kind", "provider", "stamp", "status"]);
		assert.equal(events.at(-1).channel, "lh:subscription");
		assert.equal(events.at(-1).provider, CLAUDE);
		// second login adds a distinct local account (no identity dedupe)
		release = () => {};
		const o2 = make({ file: t.file, oauth: claudeFlow(async () => cred("2")) });
		await o2.conn.login(); await until(async () => (await o2.conn.status()).accounts.length === 2 && !(await o2.conn.status()).pending);
		assert.deepEqual((await o2.conn.status()).accounts.map((a: any) => a.label), ["Claude account 1", "Claude account 2"]);
		o2.conn.close();
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("untrusted auth URLs and device-code links are never opened", async () => {
	for (const url of ["http://claude.ai/x", "https://evil.example/x", "https://u:p@claude.ai/x", "https://claude.ai.evil.example/x", "javascript:alert(1)"]) {
		const t = await tmp();
		const { conn, opened } = make({ file: t.file, oauth: { login: async (i: any) => { i.notify({ type: "auth_url", url }); return new Promise(() => {}); } } });
		try {
			await conn.login();
			await until(async () => !(await conn.status()).pending);
			assert.equal(opened.length, 0);
			const st = await conn.status();
			assert.match(st.error ?? "", /not trusted/);
			assert.doesNotMatch(JSON.stringify(st), /evil|javascript/);
			assert.equal(st.accounts.length, 0);
		} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	}
	const t = await tmp();
	const { conn, opened, codes } = make({ provider: GROK, file: t.file, oauth: { login: async (i: any) => { i.notify({ type: "device_code", userCode: "AB-12", verificationUri: "http://x.ai/device" }); return new Promise(() => {}); } } });
	try { await conn.login(); await until(async () => !(await conn.status()).pending); assert.equal(opened.length + codes.length, 0); } finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("Grok device code opens the verified link, shows the code natively, and OAuth success does not wait on the dialog", async () => {
	const t = await tmp();
	const { conn, events, opened, codes } = make({
		provider: GROK, file: t.file, showDeviceCode: () => new Promise(() => {}),
		oauth: { login: async (i: any) => { i.notify({ type: "device_code", userCode: "AB-12", verificationUri: "https://accounts.x.ai/device?c=AB-12" }); await sleep(20); return cred("g"); } },
	});
	const seen: any[] = [];
	try {
		await conn.login();
		await until(async () => { const s = await conn.status(); return !s.pending && s.accounts.length === 1; });
		assert.deepEqual(opened, ["https://accounts.x.ai/device?c=AB-12"]);
		void seen;
		assert.equal((await conn.status()).accounts[0].label, "Grok account 1");
		assert.doesNotMatch(JSON.stringify(events), /AB-12|x\.ai|access-g/);
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	const t2 = await tmp();
	const m = make({ provider: GROK, file: t2.file, oauth: { login: async (i: any) => { i.notify({ type: "device_code", userCode: "ZZ", verificationUri: "https://accounts.x.ai/d" }); await sleep(20); return cred("g"); } } });
	try {
		await m.conn.login(); await until(async () => (await m.conn.status()).accounts.length === 1);
		assert.deepEqual(m.codes, [{ provider: GROK, label: "Grok", userCode: "ZZ" }]);
	} finally { m.conn.close(); await fs.rm(t2.dir, { recursive: true, force: true }); }
});

test("openExternal rejection blocks OAuth commit with a friendly error", async () => {
	const t = await tmp();
	const { conn } = make({ file: t.file, openExternal: async () => { throw new Error("secret https://claude.ai/leak"); }, oauth: claudeFlow(async () => { await sleep(20); return cred("1"); }) });
	try {
		await conn.login();
		await until(async () => !(await conn.status()).pending);
		const st = await conn.status();
		assert.equal(st.accounts.length, 0);
		assert.match(st.error ?? "", /could not open your browser/);
		assert.doesNotMatch(JSON.stringify(st), /secret|leak/);
		assert.equal((await subscriptionFileStore(t.file, CLAUDE).read()).accounts.length, 0);
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("cancelled login cannot commit late, even when the SDK ignores abort; timeout is friendly", async () => {
	const t = await tmp();
	let release: (c: any) => void = () => {};
	const { conn } = make({ file: t.file, oauth: { login: () => new Promise((r) => { release = r; }) } });
	try {
		await conn.login();
		assert.equal((await conn.status()).pending, true);
		const s = conn.cancelLogin();
		assert.equal(s.pending, false);
		assert.match(s.error ?? "", /cancelled/);
		release(cred("late"));
		await sleep(40);
		const st = await conn.status();
		assert.equal(st.accounts.length, 0);
		assert.equal((await subscriptionFileStore(t.file, CLAUDE).read()).accounts.length, 0);
		assert.match(st.error ?? "", /cancelled/);
		await assert.rejects(Promise.all([conn.login(), conn.login()]), { code: "pending" });
		conn.cancelLogin();
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	const t2 = await tmp();
	const m = make({ file: t2.file, timeoutMs: 30, oauth: claudeFlow(() => new Promise(() => {})) });
	try {
		await m.conn.login();
		await until(async () => !(await m.conn.status()).pending);
		const st = await m.conn.status();
		assert.match(st.error ?? "", /timed out/);
		assert.doesNotMatch(JSON.stringify(st), /paste|code#state|manual/i);
	} finally { m.conn.close(); await fs.rm(t2.dir, { recursive: true, force: true }); }
});

test("cancel during persistence rolls back; storage failure on commit fails closed", async () => {
	const t = await tmp();
	const real = subscriptionFileStore(t.file, CLAUDE);
	let gate: Promise<void> | null = null; let writes = 0; let entered: () => void = () => {};
	const store = { read: () => real.read(), write: async (s: any) => { writes++; if (writes === 2) { const g = new Promise<void>((r) => { entered = r; }); gate = g; await new Promise((r) => setTimeout(r, 50)); } return real.write(s); } };
	const { conn } = make({ store, oauth: claudeFlow(async () => cred("1")) });
	try {
		await conn.status();
		await conn.login();
		await until(() => gate !== null);
		conn.cancelLogin();
		await sleep(150);
		assert.equal((await real.read()).accounts.length, 0, "late cancel rolled the account back");
		assert.equal((await conn.status()).accounts.length, 0);
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	const t2 = await tmp();
	const real2 = subscriptionFileStore(t2.file, CLAUDE);
	let fail = false;
	const m = make({ store: { read: () => real2.read(), write: async (s: any) => { if (fail) throw new Error("disk /secret/path"); return real2.write(s); } }, oauth: claudeFlow(async () => cred("1")) });
	try {
		await m.conn.status(); fail = true;
		await m.conn.login();
		await until(async () => !(await m.conn.status()).pending);
		const st = await m.conn.status();
		assert.match(st.error ?? "", /could not be read or saved/);
		assert.doesNotMatch(JSON.stringify(st), /secret|path/);
		assert.equal(st.accounts.length, 0);
	} finally { m.conn.close(); await fs.rm(t2.dir, { recursive: true, force: true }); }
});

test("reconnect of an explicit account replaces its credential in place", async () => {
	const s = await seeded([acct("a", "old"), acct("b", "b")], { activeId: "b", oauth: claudeFlow(async () => cred("new")) });
	try {
		await s.conn.login("a");
		await until(async () => { const x = await s.conn.status(); return !x.pending && x.activeId === "a"; });
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.equal(saved.accounts.length, 2);
		assert.equal(saved.accounts[0].credential.refresh, "refresh-new");
		await assert.rejects(s.conn.login("missing"), { code: "account" });
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("refresh is serialized, rotated credential persisted before lease, omitted refresh keeps the old one", async () => {
	let calls = 0; let concurrent = 0; let maxConcurrent = 0;
	const oauth = { refresh: async (c: any) => { calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await sleep(30); concurrent--; return { type: "oauth", access: "access-fresh", expires: Date.now() + 3600000 }; } };
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth });
	try {
		await s.conn.status();
		const exp = await expectFor(s.conn, "a");
		const [l1, l2] = await Promise.all([s.conn.lease(false, exp), s.conn.lease(true, exp)]);
		assert.equal(calls, 1);
		assert.equal(maxConcurrent, 1);
		assert.deepEqual(Object.keys(l1).sort(), ["accessToken", "accountId", "authorityRevision", "epoch", "revision"]);
		assert.equal(l1.accessToken, "access-fresh"); assert.equal(l2.accessToken, "access-fresh");
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.equal(saved.accounts[0].credential.access, "access-fresh");
		assert.equal(saved.accounts[0].credential.refresh, "refresh-1");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("rotated refresh token is persisted; invalid rotation and storage failure fail closed", async () => {
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth: { refresh: async () => ({ type: "oauth", access: "acc2", refresh: "ref2", expires: Date.now() + 3600000 }) } });
	try {
		const exp = await expectFor(s.conn, "a");
		await s.conn.lease(false, exp);
		assert.equal((await subscriptionFileStore(s.file, CLAUDE).read()).accounts[0].credential.refresh, "ref2");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	for (const bad of [{ type: "oauth", access: "", expires: Date.now() + 1e6 }, { type: "oauth", access: "x", refresh: "has space", expires: Date.now() + 1e6 }, { type: "oauth", access: "x", expires: NaN }, null]) {
		const b = await seeded([acct("a", "1", Date.now() - 1000)], { oauth: { refresh: async () => bad } });
		try {
			const exp = await expectFor(b.conn, "a");
			await assert.rejects(b.conn.lease(false, exp));
			assert.equal((await b.conn.status()).accounts[0].connected, false, "all use stopped after a bad rotation");
			assert.match((await b.conn.status()).error ?? "", /could not be refreshed/);
		} finally { b.conn.close(); await fs.rm(b.dir, { recursive: true, force: true }); }
	}
	const t = await tmp();
	const real = subscriptionFileStore(t.file, CLAUDE);
	await real.write(seed(CLAUDE, [acct("a", "1", Date.now() - 1000)]));
	let failWrites = false;
	const { conn } = make({ store: { read: () => real.read(), write: async (s: any) => { if (failWrites) throw new Error("boom"); return real.write(s); } }, oauth: { refresh: async () => ({ type: "oauth", access: "n", refresh: "n", expires: Date.now() + 1e6 }) } });
	try {
		const exp = await expectFor(conn, "a"); failWrites = true;
		await assert.rejects(conn.lease(false, exp), { code: "storage" });
		const st = await conn.status();
		assert.equal(st.accounts[0].connected, false);
		await assert.rejects(conn.lease(false, exp));
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("lease signal guards: expected account, authority revision, catalog membership, boolean background", async () => {
	const s = await seeded([acct("a", "1"), acct("b", "2")], {});
	try {
		const exp = await expectFor(s.conn, "a");
		assert.equal((await s.conn.lease(false, exp)).accountId, "a");
		await assert.rejects(s.conn.lease(false, { ...exp, selectedModelId: "nope" }), { code: "catalog" });
		await assert.rejects(s.conn.lease(false, { ...exp, expectedAccountId: "b" }), { code: "catalog" });
		await assert.rejects(s.conn.lease(false, { ...exp, expectedAuthorityRevision: exp.expectedAuthorityRevision + 1 }), { code: "catalog" });
		await assert.rejects(s.conn.lease("no" as any, exp), { code: "catalog" });
		await assert.rejects(s.conn.lease(false, { expectedAccountId: "a" } as any), { code: "catalog" });
		const before = s.conn.stamp();
		await s.conn.select("b");
		assert.ok(s.conn.stamp().epoch > before.epoch && s.conn.stamp().authorityRevision > before.authorityRevision);
		await assert.rejects(s.conn.lease(false, exp), "old stamp no longer valid after account change");
		const m = await s.conn.models();
		assert.equal(m.accountId, "b");
		assert.deepEqual(m.models, [{ id: "m1", name: "Model 1" }]);
		assert.deepEqual(Object.keys(m).sort(), ["accountId", "authorityRevision", "epoch", "models", "revision", "status"]);
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("catalog failure clears models and reports catalogError without leaking", async () => {
	const s = await seeded([acct("a", "1")], { getModels: async () => { throw new Error("https://api.x/secret"); } });
	try {
		const m = await s.conn.models();
		assert.deepEqual(m.models, []);
		assert.match(m.status.catalogError, /catalog is unavailable/);
		assert.doesNotMatch(JSON.stringify(m), /secret/);
		const bad = await seeded([acct("a", "1")], { getModels: async () => [{ id: "", name: "x" }] });
		assert.deepEqual((await bad.conn.models()).models, []); bad.conn.close(); await fs.rm(bad.dir, { recursive: true, force: true });
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("consent false denies background at once, keeps foreground usable, and persists; ON waits for save", async () => {
	const s = await seeded([acct("a", "1")], {});
	try {
		const exp = await expectFor(s.conn, "a");
		await s.conn.lease(true, exp);
		const st = await s.conn.consent(false);
		assert.equal(st.allowBackgroundUse, false);
		assert.ok(s.events.some((e: any) => e.invalidate === "background"));
		await assert.rejects(s.conn.lease(true, exp), { code: "background" });
		assert.equal((await s.conn.lease(false, exp)).accountId, "a", "foreground still works with the same stamp");
		assert.equal((await subscriptionFileStore(s.file, CLAUDE).read()).allowBackgroundUse, false);
		await s.conn.consent(true);
		assert.equal((await s.conn.lease(true, exp)).accountId, "a");
		await assert.rejects(s.conn.consent("yes" as any), { code: "request" });
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	const t = await tmp();
	const real = subscriptionFileStore(t.file, CLAUDE);
	await real.write(seed(CLAUDE, [acct("a", "1")], "a", false));
	let failWrites = false;
	const { conn } = make({ store: { read: () => real.read(), write: async (x: any) => { if (failWrites) throw new Error("x"); return real.write(x); } } });
	try {
		const exp = await expectFor(conn, "a"); failWrites = true;
		await assert.rejects(conn.consent(true));
		assert.equal((await conn.status()).allowBackgroundUse, false, "failed ON never grants background");
	} finally { conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("disconnect forgets locally with a warning and never auto-selects; logout keeps the account without credential", async () => {
	const s = await seeded([acct("a", "1"), acct("b", "2")], { activeId: "a" });
	try {
		const exp = await expectFor(s.conn, "a");
		const st = await s.conn.disconnect("a");
		assert.equal(st.activeId, null);
		assert.deepEqual(st.accounts.map((x: any) => x.id), ["b"]);
		assert.equal(st.accounts[0].connected, true);
		assert.match(st.error ?? "", /Remote revocation could not be confirmed/);
		await assert.rejects(s.conn.lease(false, exp));
		await assert.rejects(s.conn.disconnect("a"), { code: "account" });
		const out = await s.conn.logout("b");
		assert.deepEqual(out.accounts, [{ id: "b", label: "Claude account b", connected: false }]);
		assert.match(out.error ?? "", /Remote revocation could not be confirmed/);
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.deepEqual(saved.accounts, [{ id: "b", label: "Claude account b" }]);
		assert.equal(saved.activeId, null);
		await assert.rejects(s.conn.select("b"), { code: "disconnected" });
		assert.equal((await s.conn.status()).activeId, null);
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("inactive disconnect does not interrupt the active account; select to a credential-less account is refused", async () => {
	const s = await seeded([acct("a", "1"), { id: "c", label: "Claude account c" }], { activeId: "a" });
	try {
		const exp = await expectFor(s.conn, "a");
		await s.conn.disconnect("c");
		assert.equal((await s.conn.lease(false, exp)).accountId, "a");
		assert.equal((await s.conn.status()).activeId, "a");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("in-flight refresh is aborted by disconnect and a late SDK result cannot resurrect the account", async () => {
	let seenSignal: AbortSignal | undefined; let finishRefresh: (c: any) => void = () => {};
	const oauth = { refresh: (_c: any, signal: AbortSignal) => { seenSignal = signal; return new Promise((r) => { finishRefresh = r; }); } };
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth });
	try {
		const exp = await expectFor(s.conn, "a");
		const lease = s.conn.lease(false, exp);
		lease.catch(() => {});
		await until(() => !!seenSignal);
		const disconnecting = s.conn.disconnect("a");
		await until(() => seenSignal!.aborted);
		await assert.rejects(lease);
		finishRefresh({ type: "oauth", access: "late", refresh: "late-r", expires: Date.now() + 1e6 });
		await disconnecting;
		await sleep(40);
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.deepEqual(saved.accounts, []);
		assert.equal(JSON.stringify(saved).includes("late"), false);
		assert.equal((await s.conn.status()).accounts.length, 0);
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("account change aborts an in-flight refresh; pause stops leases and resume restores state", async () => {
	let seenSignal: AbortSignal | undefined;
	const oauth = { refresh: (_c: any, signal: AbortSignal) => { seenSignal = signal; return new Promise(() => {}); } };
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth });
	try {
		const exp = await expectFor(s.conn, "a");
		const lease = s.conn.lease(false, exp); lease.catch(() => {});
		await until(() => !!seenSignal);
		await s.conn.select("a"); // account change aborts in-flight refresh
		assert.equal(seenSignal!.aborted, true);
		await assert.rejects(lease);
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	const p = await seeded([acct("a", "1")], {});
	try {
		const exp = await expectFor(p.conn, "a");
		p.conn.pause();
		await assert.rejects(p.conn.lease(false, exp));
		assert.equal((await p.conn.status()).available, false);
		p.conn.resume();
		await p.conn.models();
		assert.equal((await p.conn.lease(false, await expectFor(p.conn, "a"))).accountId, "a");
		p.conn.close();
		await assert.rejects(p.conn.status().then((s: any) => { if (s.available) return; throw new Error("closed"); }));
	} finally { p.conn.close(); await fs.rm(p.dir, { recursive: true, force: true }); }
});

function fakeChild() {
	const child: any = new EventEmitter();
	child.connected = true; child.sent = [] as any[];
	child.send = (m: any, cb?: () => void) => { child.sent.push(m); cb?.(); return true; };
	return child;
}
test("child IPC answers status/models/lease per provider, rejects bad ops, never leaks beyond the contract", async () => {
	const s = await seeded([acct("a", "1")], {});
	const g = await seeded([], { provider: GROK });
	const child = fakeChild();
	const map = new Map([[CLAUDE, s.conn], [GROK, g.conn]]);
	const h = attachSubscriptionChild(child, map);
	const ask = async (m: any) => { const n = child.sent.length; child.emit("message", m); await until(() => child.sent.length > n); return child.sent.at(-1); };
	try {
		const st = await ask({ channel: "lh:subscription", id: "1", op: "status", provider: CLAUDE });
		assert.equal(st.ok, true); assert.equal(st.provider, CLAUDE); assert.equal(st.id, "1"); assert.equal(st.op, "status");
		assert.deepEqual(Object.keys(st.value).sort(), ["authorityRevision", "epoch", "revision", "status"]);
		assert.deepEqual(st.value.status.accounts, [{ id: "a", label: "Claude account a", connected: true }]);
		assert.doesNotMatch(JSON.stringify(st), /access-|refresh-/);
		const gs = await ask({ channel: "lh:subscription", id: "2", op: "status", provider: GROK });
		assert.deepEqual(gs.value.status.accounts, []);
		const m = await ask({ channel: "lh:subscription", id: "3", op: "models", provider: CLAUDE });
		assert.deepEqual(m.value.models, [{ id: "m1", name: "Model 1" }]);
		assert.doesNotMatch(JSON.stringify(m), /access-|refresh-/);
		const l = await ask({ channel: "lh:subscription", id: "4", op: "lease", provider: CLAUDE, background: false, expectedAccountId: "a", expectedAuthorityRevision: m.value.authorityRevision, selectedModelId: "m1" });
		assert.equal(l.ok, true); assert.equal(l.value.accessToken, "access-1");
		assert.deepEqual(Object.keys(l.value).sort(), ["accessToken", "accountId", "authorityRevision", "epoch", "revision"]);
		const bl = await ask({ channel: "lh:subscription", id: "5", op: "lease", provider: CLAUDE, background: false, expectedAccountId: "a", expectedAuthorityRevision: 999, selectedModelId: "m1" });
		assert.equal(bl.ok, false); assert.equal(typeof bl.error, "string"); assert.ok(bl.stamp.epoch >= 0);
		assert.doesNotMatch(JSON.stringify(bl), /access-|refresh-|Error|stack/);
		for (const bad of [{ id: "6", op: "lease", provider: CLAUDE, background: "no" }, { id: "7", op: "login", provider: CLAUDE }, { id: "8", op: "status" }, { id: "9", op: "status", provider: "subscription-other" }, { id: "10", op: "status", provider: "__proto__" }]) {
			const r = await ask({ channel: "lh:subscription", ...bad });
			assert.equal(r.ok, false); assert.equal(r.id, bad.id);
		}
		const n = child.sent.length;
		child.emit("message", { channel: "other", id: "x", op: "status", provider: CLAUDE });
		child.emit("message", { channel: "lh:subscription", id: 5, op: "status", provider: CLAUDE });
		await sleep(20); assert.equal(child.sent.length, n);
		h.dispose(); assert.equal(child.listenerCount("message"), 0);
	} finally { s.conn.close(); g.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); await fs.rm(g.dir, { recursive: true, force: true }); }
});

test("renderer control exposes only account controls and sanitized status", async () => {
	const s = await seeded([acct("a", "1"), acct("b", "2")], { oauth: { login: () => new Promise(() => {}) } });
	const map = new Map([[CLAUDE, s.conn]]);
	try {
		const st = await subscriptionControl({ provider: CLAUDE, op: "status" }, map);
		assert.deepEqual(Object.keys(st).sort(), ["accounts", "activeId", "allowBackgroundUse", "available", "catalogError", "error", "pending"]);
		assert.doesNotMatch(JSON.stringify(st), /access-|refresh-/);
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "select", id: "b" }, map)).activeId, "b");
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "consent", enabled: false }, map)).allowBackgroundUse, false);
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "login" }, map)).pending, true);
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "cancel" }, map)).pending, false);
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "logout", id: "b" }, map)).accounts[1].connected, false);
		assert.equal((await subscriptionControl({ provider: CLAUDE, op: "disconnect", id: "a" }, map)).accounts.length, 1);
		for (const bad of [{ op: "lease" }, { op: "import" }, { op: "url" }, { op: "code", code: "x" }, { op: "token" }, { op: "select" }, { op: "consent", enabled: "yes" }, { op: "status", provider: "nope" }]) {
			const r: any = await subscriptionControl({ provider: CLAUDE, ...bad }, map);
			assert.equal(typeof r.error, "string"); assert.equal(r.accounts, undefined);
		}
		const err: any = await subscriptionControl({ provider: CLAUDE, op: "disconnect", id: "missing" }, map);
		assert.match(err.error, /no longer saved/);
		assert.equal(((await subscriptionControl({ provider: CLAUDE, op: "status" }, new Map())) as any).error, "Unsupported subscription control.");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("malicious or late-failing SDK links never commit credentials, even if the SDK later returns tokens", async () => {
	const cases: [string, (i: any) => void][] = [
		[CLAUDE, (i) => { i.notify({ type: "auth_url", url: "https://claude.ai/ok" }); i.notify({ type: "auth_url", url: "https://evil.example/phish" }); }],
		[CLAUDE, (i) => i.notify({ type: "device_code", userCode: "A", verificationUri: "https://claude.ai/d" })],
		[GROK, (i) => i.notify({ type: "device_code", userCode: "A", verificationUri: "javascript:alert(1)" })],
		[GROK, (i) => i.notify({ type: "device_code", userCode: "A", verificationUri: "https://user:pw@accounts.x.ai/d" })],
		[GROK, (i) => i.notify({ type: "device_code", userCode: "bad code\n", verificationUri: "https://accounts.x.ai/d" })],
	];
	for (const [provider, notify] of cases) {
		const t = await tmp();
		const m = make({ provider, file: t.file, oauth: { login: async (i: any) => { notify(i); await sleep(20); return cred("tok"); } } });
		try {
			await m.conn.login();
			await until(async () => !(await m.conn.status()).pending);
			await sleep(30);
			assert.equal((await m.conn.status()).accounts.length, 0);
			assert.equal(JSON.stringify(await subscriptionFileStore(t.file, provider).read()).includes("tok"), false);
			assert.equal(m.codes.length, 0);
			assert.ok(!m.opened.some((u) => /evil|javascript|user:pw/.test(u)));
		} finally { m.conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	}
	// openExternal / device-code open rejects AFTER the SDK already returned tokens
	for (const provider of [CLAUDE, GROK]) {
		const t = await tmp(); let rejectOpen: (e: Error) => void = () => {};
		const m = make({
			provider, file: t.file, openExternal: () => new Promise((_, rej) => { rejectOpen = rej; }),
			oauth: { login: async (i: any) => { i.notify(provider === CLAUDE ? { type: "auth_url", url: "https://claude.ai/ok" } : { type: "device_code", userCode: "A", verificationUri: "https://accounts.x.ai/d" }); return cred("late-open"); } },
		});
		try {
			await m.conn.login();
			await sleep(40);
			assert.equal((await m.conn.status()).pending, true, "commit waits for the pending open");
			assert.equal((await subscriptionFileStore(t.file, provider).read()).accounts.length, 0);
			rejectOpen(new Error("late"));
			await until(async () => !(await m.conn.status()).pending);
			assert.equal((await m.conn.status()).accounts.length, 0);
			assert.equal((await subscriptionFileStore(t.file, provider).read()).accounts.length, 0);
			assert.equal(m.codes.length, 0);
		} finally { m.conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	}
});

test("consent(false) during a refreshing lease never revives background; foreground refresh still completes", async () => {
	let finish: (c: any) => void = () => {}; let started = false;
	const oauth = { refresh: () => { started = true; return new Promise((r) => { finish = r; }); } };
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth });
	try {
		const exp = await expectFor(s.conn, "a");
		const fg = s.conn.lease(false, exp);
		await until(() => started);
		const queuedBg = s.conn.lease(true, exp); queuedBg.catch(() => {});
		const off = s.conn.consent(false);
		assert.equal((await s.conn.status()).allowBackgroundUse, false, "denied immediately, before the save");
		finish({ type: "oauth", access: "fresh", expires: Date.now() + 1e6 });
		assert.equal((await fg).accessToken, "fresh", "foreground survives consent off");
		await off;
		await assert.rejects(queuedBg, { code: "background" });
		await assert.rejects(s.conn.lease(true, exp), { code: "background" });
		assert.equal((await s.conn.status()).allowBackgroundUse, false);
		assert.equal((await subscriptionFileStore(s.file, CLAUDE).read()).allowBackgroundUse, false);
		assert.equal((await s.conn.lease(false, exp)).accessToken, "fresh");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("consent(false) does not abort an in-flight background refresh: rotation saved, background denied, foreground works, no model call", async () => {
	let signalSeen: AbortSignal | undefined; let finish: (c: any) => void = () => {}; let refreshCalls = 0; let modelCalls = 0;
	const oauth = { refresh: (_c: any, signal: AbortSignal) => { refreshCalls++; signalSeen = signal; return new Promise((r) => { finish = r; }); } };
	const s = await seeded([acct("a", "1", Date.now() - 1000)], { oauth, getModels: async () => { modelCalls++; return [{ id: "m1", name: "Model 1" }]; } });
	try {
		const exp = await expectFor(s.conn, "a");
		const bg = s.conn.lease(true, exp); bg.catch(() => {});
		await until(() => !!signalSeen);
		const off = s.conn.consent(false); // its save queues behind the refresh; the denial is immediate
		assert.equal((await s.conn.status()).allowBackgroundUse, false);
		assert.equal(signalSeen!.aborted, false, "consent off leaves the refresh running");
		finish({ type: "oauth", access: "rot-access", refresh: "rot-refresh", expires: Date.now() + 1e6 });
		await assert.rejects(bg, { code: "background" });
		await off;
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.equal(saved.accounts[0].credential.refresh, "rot-refresh", "consumed rotation durably saved");
		assert.equal(saved.accounts[0].credential.access, "rot-access");
		await assert.rejects(s.conn.lease(true, exp), { code: "background" });
		assert.equal((await s.conn.lease(false, exp)).accessToken, "rot-access");
		assert.equal(refreshCalls, 1);
		assert.equal(modelCalls, 1, "only the catalog call from setup; no extra call");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("Grok links are pinned to x.ai / grok.com; foreign https is rejected with a clear error", async () => {
	const { trustedUrl } = require("../electron/legacy-subscriptions.cjs");
	for (const ok of ["https://x.ai/a", "https://accounts.x.ai/d", "https://grok.com/d", "https://auth.grok.com/d?c=1"]) assert.equal(trustedUrl(ok, GROK), true, ok);
	for (const bad of ["https://evilx.ai/d", "https://x.ai.evil.example/d", "https://grok.com.evil.example/d", "https://example.com/d", "http://x.ai/d", "https://u@x.ai/d", "https://notgrok.com/d"]) assert.equal(trustedUrl(bad, GROK), false, bad);
	const t = await tmp();
	const m = make({ provider: GROK, file: t.file, oauth: { login: async (i: any) => { i.notify({ type: "device_code", userCode: "A", verificationUri: "https://example.com/device" }); return new Promise(() => {}); } } });
	try {
		await m.conn.login(); await until(async () => !(await m.conn.status()).pending);
		const st = await m.conn.status();
		assert.match(st.error ?? "", /not trusted/); assert.equal(m.opened.length, 0); assert.equal(m.codes.length, 0);
		assert.doesNotMatch(JSON.stringify(st), /example\.com/);
	} finally { m.conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("refresh failures (getOAuth or SDK) fail closed: status disconnected with a reconnect message, credential kept, no stale fallback", async () => {
	for (const mode of ["getOAuth", "sdk"]) {
		const getOAuth = mode === "getOAuth" ? async () => { throw new Error("loader /secret"); } : async () => ({ refresh: async () => { throw new Error("invalid_grant https://x"); } });
		const s = await seeded([acct("a", "1", Date.now() - 1000)], { getOAuth });
		try {
			const exp = await expectFor(s.conn, "a");
			await assert.rejects(s.conn.lease(false, exp), { code: "expired" });
			const st = await s.conn.status();
			assert.equal(st.accounts[0].connected, false);
			assert.match(st.error ?? "", /could not be refreshed.*Reconnect/);
			assert.doesNotMatch(JSON.stringify(st), /secret|invalid_grant/);
			assert.ok(s.events.some((e: any) => e.invalidate === "all" && e.status.error));
			await assert.rejects(s.conn.lease(false, exp));
			assert.equal((await subscriptionFileStore(s.file, CLAUDE).read()).accounts.length, 1);
		} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	}
});

test("store refuses a symlinked or group/other-writable parent directory on read and write; missing parent reads as fresh", async () => {
	const t = await tmp();
	try {
		const real = path.join(t.dir, "real"); const link = path.join(t.dir, "link");
		const state = seed(CLAUDE, [acct("a", "1")]);
		await subscriptionFileStore(path.join(real, "sub.json"), CLAUDE).write(state);
		await fs.symlink(real, link);
		const viaLink = subscriptionFileStore(path.join(link, "sub.json"), CLAUDE);
		await assert.rejects(viaLink.read(), { code: "storage" });
		await assert.rejects(viaLink.write(state), { code: "storage" });
		const c = make({ file: path.join(link, "sub.json") });
		assert.equal((await c.conn.status()).available, false);
		c.conn.close();
		assert.equal(await subscriptionFileStore(path.join(t.dir, "missing", "sub.json"), CLAUDE).read(), null);
		if (process.platform !== "win32") {
			await fs.chmod(real, 0o777);
			await assert.rejects(subscriptionFileStore(path.join(real, "sub.json"), CLAUDE).read(), { code: "storage" });
			await fs.chmod(real, 0o700);
			assert.deepEqual(await subscriptionFileStore(path.join(real, "sub.json"), CLAUDE).read(), state);
		}
	} finally { await fs.rm(t.dir, { recursive: true, force: true }); }
});

test("login(id, allowBackgroundUse) persists the choice with the credential: first status and lease obey it; cancel rolls back both", async () => {
	const t = await tmp();
	const m = make({ file: t.file, oauth: claudeFlow(async () => cred("1")) });
	try {
		await m.conn.login(undefined, false);
		await until(async () => { const x = await m.conn.status(); return !x.pending && x.accounts.length === 1; });
		const st = await m.conn.status();
		assert.equal(st.allowBackgroundUse, false);
		const first = m.events.find((e: any) => e.status.accounts.some((a: any) => a.connected));
		assert.equal(first.status.allowBackgroundUse, false, "first connected status already carries the choice");
		const saved = await subscriptionFileStore(t.file, CLAUDE).read();
		assert.equal(saved.allowBackgroundUse, false);
		const exp = await expectFor(m.conn, st.activeId!);
		await assert.rejects(m.conn.lease(true, exp), { code: "background" });
		assert.equal((await m.conn.lease(false, exp)).accountId, st.activeId);
		await assert.rejects(m.conn.login(undefined, "no" as any), { code: "request" });
		const via = await subscriptionControl({ provider: CLAUDE, op: "login", allowBackgroundUse: "x" }, new Map([[CLAUDE, m.conn]])) as any;
		assert.equal(typeof via.error, "string");
	} finally { m.conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
	// omitted choice keeps the existing policy; a pre-success cancel leaves the old policy and credentials untouched
	const s = await seeded([acct("a", "old")], { allow: false, oauth: { login: () => new Promise(() => {}) } });
	try {
		await s.conn.login("a", true);
		assert.equal((await s.conn.status()).allowBackgroundUse, false, "no pre-login mutation");
		s.conn.cancelLogin();
		const saved = await subscriptionFileStore(s.file, CLAUDE).read();
		assert.equal(saved.allowBackgroundUse, false);
		assert.equal(saved.accounts[0].credential.refresh, "refresh-old");
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	// late cancel during persistence restores policy and credential
	const t3 = await tmp();
	const real = subscriptionFileStore(t3.file, CLAUDE);
	await real.write(seed(CLAUDE, [acct("a", "old")], "a", false));
	let writes = 0; let inWrite = false;
	const store = { read: () => real.read(), write: async (x: any) => { writes++; if (writes === 1) { inWrite = true; await sleep(60); } return real.write(x); } };
	const r = make({ store, oauth: claudeFlow(async () => cred("new")) });
	try {
		await r.conn.login("a", true);
		await until(() => inWrite);
		r.conn.cancelLogin();
		await sleep(200);
		const after = await real.read();
		assert.equal(after.allowBackgroundUse, false);
		assert.equal(after.accounts[0].credential.refresh, "refresh-old");
		const st = await r.conn.status();
		assert.equal(st.allowBackgroundUse, false);
	} finally { r.conn.close(); await fs.rm(t3.dir, { recursive: true, force: true }); }
});

test("refused select (missing or logged-out target) keeps the prior active account connected and usable after a catalog refresh", async () => {
	const s = await seeded([acct("a", "1"), { id: "c", label: "Claude account c" }], { activeId: "a" });
	try {
		await expectFor(s.conn, "a");
		const before = await subscriptionFileStore(s.file, CLAUDE).read();
		for (const id of ["missing", "c"]) {
			await assert.rejects(s.conn.select(id), { code: "disconnected" });
			const st = await s.conn.status();
			assert.equal(st.activeId, "a");
			assert.equal(st.accounts.find((x: any) => x.id === "a").connected, true, "prior account resumed");
			assert.equal(s.events.at(-1).status.accounts.find((x: any) => x.id === "a").connected, true, "resume was announced");
			assert.deepEqual(await subscriptionFileStore(s.file, CLAUDE).read(), before, "no state or credential change");
			assert.equal((await s.conn.lease(false, await expectFor(s.conn, "a"))).accountId, "a");
		}
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("a failed active refresh leaves other credentialed accounts selectable; storage failure makes the connection unavailable", async () => {
	const oauth = { refresh: async () => { throw new Error("invalid_grant"); } };
	const s = await seeded([acct("bad", "1", Date.now() - 1000), acct("good", "2")], { activeId: "bad", oauth });
	try {
		const exp = await expectFor(s.conn, "bad");
		await assert.rejects(s.conn.lease(false, exp), { code: "expired" });
		const st = await s.conn.status();
		assert.deepEqual(st.accounts.map((a: any) => [a.id, a.connected]), [["bad", false], ["good", true]]);
		assert.equal(st.activeId, "bad", "no auto-selection");
		await assert.rejects(s.conn.lease(false, exp));
		assert.equal((await s.conn.select("good")).activeId, "good");
		const lease = await s.conn.lease(false, await expectFor(s.conn, "good"));
		assert.deepEqual([lease.accountId, lease.accessToken], ["good", "access-2"]);
	} finally { s.conn.close(); await fs.rm(s.dir, { recursive: true, force: true }); }
	const t = await tmp();
	const real = subscriptionFileStore(t.file, CLAUDE);
	await real.write(seed(CLAUDE, [acct("a", "1")]));
	let failWrites = false;
	const m = make({ store: { read: () => real.read(), write: async (x: any) => { if (failWrites) throw new Error("x"); return real.write(x); } } });
	try {
		await m.conn.status(); failWrites = true;
		await assert.rejects(m.conn.consent(false), { code: "storage" });
		const st = await m.conn.status();
		assert.equal(st.available, false);
		assert.match(st.error ?? "", /restart the app, then reconnect/);
		await assert.rejects(m.conn.login(), { code: "storage" });
		assert.equal(st.accounts[0].connected, false);
	} finally { m.conn.close(); await fs.rm(t.dir, { recursive: true, force: true }); }
});
