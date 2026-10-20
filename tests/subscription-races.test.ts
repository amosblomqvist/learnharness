/** Independent issue #8 race acceptance. Real services, stores, SDK and OS children.
 * No listener, real account, home auth, or external request is used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createSubscriptionStore, SUBSCRIPTION_LOCK_DIR, type OAuthCredential } from "../src/store/subscription-credentials.ts";

// Set isolation before any config-bearing module is imported. Keep fixtures as
// evidence instead of deleting a computed path after a failed acceptance run.
const root = mkdtempSync(path.join(process.env.LH_RACE_ARTIFACT_DIR ?? os.tmpdir(), "lh-independent-races-"));
process.env.LH_DATA_DIR = path.join(root, "application-data");
process.env.LH_AUTH_FILE = path.join(root, "unused-auth.json");
const { createSubscriptionService } = await import("../src/server/subscription.ts");
const { createSubscriptionEngine } = await import("../src/server/subscription-engine.ts");
const originalFetch = globalThis.fetch;
const denyFetch: typeof fetch = async () => { throw new Error("Unapproved external request"); };
globalThis.fetch = denyFetch;
after(() => { globalThis.fetch = originalFetch; console.log(`Isolated evidence directory: ${root}`); });
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const jwt = (account = "race-account") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const grant = (expires = Date.now() + 3600_000): OAuthCredential => ({ type: "oauth", access: jwt(), refresh: "race-refresh-old", expires, accountId: "race-account" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
	let timer!: ReturnType<typeof setTimeout>;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); })]); }
	finally { clearTimeout(timer); }
}
async function fixture(connected = true, expired = false) {
	const directory = mkdtempSync(path.join(root, "instance-"));
	const store = createSubscriptionStore(directory);
	if (connected) await store.transaction(async (tx) => { await tx.save({ ...tx.state, credential: grant(expired ? Date.now() - 1000 : undefined) }); });
	const service = createSubscriptionService(store);
	const generation = (await store.getSnapshot()).generation;
	return { directory, store, service, generation };
}
const context = () => normalizeContext({ messages: [{ role: "user", content: "Isolated race", timestamp: 1 }] });
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const childScript = fileURLToPath(new URL("./fixtures/subscription-races-child.ts", import.meta.url));
type Event = { event: string; [key: string]: unknown };
function child(mode: string, directory: string) {
	const processChild = spawn(process.execPath, ["--import", tsx, childScript, mode, directory], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: { ...process.env, LH_DATA_DIR: path.join(root, `child-data-${mode}`), LH_AUTH_FILE: path.join(root, "unused-child-auth.json") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	const events: Event[] = [];
	const queued: Event[] = [];
	const waiters: Array<(event: Event) => void> = [];
	processChild.stderr.on("data", (data) => { stderr += data.toString(); });
	const lines = readline.createInterface({ input: processChild.stdout });
	lines.on("line", (line) => {
		const event: Event = JSON.parse(line); events.push(event);
		const waiter = waiters.shift(); if (waiter) waiter(event); else queued.push(event);
	});
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		processChild.once("error", reject);
		processChild.once("exit", (code, signal) => resolve({ code, signal }));
	});
	return {
		events,
		send: (line: string) => { processChild.stdin.write(`${line}\n`); },
		next: () => bounded(queued.length ? Promise.resolve(queued.shift()!) : new Promise<Event>((resolve) => waiters.push(resolve)), `child ${mode}; ${stderr}`),
		finish: async (expected = 0) => { const result = await bounded(exit, `exit ${mode}; ${stderr}`); assert.equal(result.code, expected, stderr); console.log(`child ${mode} exit=${result.code} events=${JSON.stringify(events)}`); },
		stop: async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); await exit; lines.close(); },
	};
}

for (const action of ["cancel", "disconnect"] as const) {
	test(`real device login late token response cannot revive ${action} or overwrite replacement`, { timeout: 15000 }, async () => {
		const f = await fixture(false);
		const tokenEntered = deferred<void>();
		const tokenRelease = deferred<Response>();
		let tokenCalls = 0;
		const calls: string[] = [];
		globalThis.fetch = async (request) => {
			const url = String(request); calls.push(url);
			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") return Response.json({ device_auth_id: "isolated-device", user_code: "ABCD-EFGH", interval: 0 });
			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") return Response.json({ authorization_code: "isolated-code", code_verifier: "isolated-verifier" });
			assert.equal(url, "https://auth.openai.com/oauth/token");
			tokenCalls++;
			if (tokenCalls === 1) { tokenEntered.resolve(); return tokenRelease.promise; }
			return Response.json({ access_token: jwt("replacement-account"), refresh_token: "replacement-refresh", expires_in: 3600 });
		};
		try {
			const first = await f.service.start("device_code");
			await bounded(tokenEntered.promise, "first token exchange");
			const firstCompletion = f.service.finished(first.attempt!.id);
			assert.equal((await f.service.interactionReady(first.attempt!.id)).state, "authorizing");
			if (action === "cancel") await f.service.cancel(first.attempt!.id); else await f.service.disconnect();
			assert.equal((await f.service.status()).state, "disconnected");
			const tombstone = (await f.store.getSnapshot()).generation;
			assert.notEqual(tombstone, f.generation);
			const replacement = await f.service.start("device_code");
			await bounded(f.service.finished(replacement.attempt!.id), "replacement login");
			assert.equal((await f.service.status()).state, "connected");
			tokenRelease.resolve(Response.json({ access_token: jwt("late-old-account"), refresh_token: "late-refresh", expires_in: 3600 }));
			await bounded(firstCompletion, "late old login completion");
			const stored = await f.store.getSnapshot();
			assert.equal(stored.generation, tombstone);
			assert.equal(stored.credential?.accountId, "replacement-account");
			assert.equal(stored.credential?.refresh, "replacement-refresh");
			assert.equal(calls.length, 6);
			assert.doesNotMatch(JSON.stringify(await f.service.status()), /refresh|signature|isolated-device|isolated-verifier/);
		} finally { tokenRelease.resolve(Response.json({})); globalThis.fetch = denyFetch; }
	});
}

test("separate data roots isolate authorization; same-root services share state and cannot steal active attempts", { timeout: 15000 }, async () => {
	const a = await fixture(false);
	const b = await fixture(false);
	const peer = createSubscriptionService(createSubscriptionStore(a.directory));
	const gate = deferred<Response>();
	const entered = deferred<void>();
	globalThis.fetch = async (request) => { assert.equal(String(request), "https://auth.openai.com/api/accounts/deviceauth/usercode"); entered.resolve(); return gate.promise; };
	try {
		const started = await a.service.start("device_code");
		await bounded(entered.promise, "device start");
		assert.equal((await peer.status()).state, "authorizing");
		assert.equal((await peer.status()).attempt?.ownedHere, false);
		assert.equal((await b.service.status()).state, "disconnected");
		await assert.rejects(peer.start("device_code"), { code: "subscription_conflict" });
		await assert.rejects(peer.cancel(started.attempt!.id), { code: "subscription_wrong_owner" });
		await a.service.cancel(started.attempt!.id);
		gate.resolve(Response.json({ device_auth_id: "cancelled-device", user_code: "CANCELLED", interval: 0 }));
		await bounded(a.service.finished(started.attempt!.id), "cancelled device completion");
		assert.equal((await peer.status()).state, "disconnected");
		assert.equal((await b.service.status()).state, "disconnected");
		await a.store.transaction(async (tx) => { await tx.save({ ...tx.state, credential: grant() }); });
		assert.equal((await peer.status()).state, "connected");
		await peer.disconnect();
		assert.equal((await a.service.status()).state, "disconnected");
		assert.equal((await b.service.status()).state, "disconnected");
	} finally { gate.resolve(Response.json({})); globalThis.fetch = denyFetch; }
});

test("two real processes linearize underlying fetch under lock and disconnect before pending fetch resolves", { timeout: 15000 }, async () => {
	const f = await fixture();
	const sender = child("sender", f.directory);
	const closer = child("disconnect", f.directory);
	try {
		assert.equal((await sender.next()).event, "ready");
		assert.equal((await closer.next()).event, "ready");
		sender.send("go");
		assert.equal((await sender.next()).event, "check_locked");
		closer.send("go");
		assert.equal((await closer.next()).event, "disconnect_started");
		// A bounded negative observation complements the positive lock-owner check
		// inside underlying fetch. It is not the sole proof of serialization.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(closer.events.some((event) => event.event === "disconnected"), false);
		sender.send("release-check");
		assert.deepEqual(await sender.next(), { event: "fetch_invoked", lockHeld: true });
		assert.equal((await closer.next()).event, "disconnected");
		await closer.finish();
		assert.equal(sender.events.some((event) => event.event === "sender_done"), false, "native fetch response is still unresolved");
		assert.equal((await f.service.status()).state, "disconnected");
		sender.send("respond");
		assert.equal((await sender.next()).event, "sender_done");
		await sender.finish();
	} finally { await Promise.all([sender.stop(), closer.stop()]); }
});

test("disconnect in another process first rejects an old lease and old real SDK engine with zero sends", { timeout: 15000 }, async () => {
	const f = await fixture();
	const lease = await f.service.acquireLease(f.generation);
	const engine = createSubscriptionEngine(f.service, { provider: "openai-codex", id: "gpt-6-luna" }, f.generation);
	const closer = child("disconnect", f.directory);
	let sends = 0;
	globalThis.fetch = async () => { sends++; throw new Error("Old generation must not send"); };
	try {
		await closer.next(); closer.send("go"); await closer.next();
		assert.equal((await closer.next()).event, "disconnected");
		await closer.finish();
		// Seed a later account without changing the disconnect tombstone.
		await f.store.transaction(async (tx) => { await tx.save({ ...tx.state, credential: { ...grant(), accountId: "new-account" } }); });
		await assert.rejects(lease.fetch(endpoint, { method: "POST" }), { code: "subscription_needs_login" });
		const result = await engine.streamFn(engine.model, context()).result();
		assert.match(result.errorMessage!, /subscription_needs_login/);
		assert.equal(sends, 0);
	} finally { lease.release(); globalThis.fetch = denyFetch; await closer.stop(); }
});

test("real SDK open SSE lifetime does not retain the store lock or block local disconnect", { timeout: 15000 }, async () => {
	const f = await fixture();
	const entered = deferred<void>();
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const reading = deferred<void>();
	const body = new ReadableStream<Uint8Array>({
		start(controller) { streamController = controller; },
		pull() { reading.resolve(); },
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 });
	globalThis.fetch = async (request) => {
		assert.equal(String(request), endpoint);
		const owner = JSON.parse(readFileSync(path.join(f.directory, SUBSCRIPTION_LOCK_DIR, "owner.json"), "utf8"));
		assert.equal(owner.nonce, f.store.owner.nonce);
		entered.resolve();
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	const engine = createSubscriptionEngine(f.service, { provider: "openai-codex", id: "gpt-6-luna" }, f.generation);
	const pending = engine.streamFn(engine.model, context()).result();
	try {
		await bounded(entered.promise, "SSE send");
		await bounded(reading.promise, "real SDK reading open SSE body");
		assert.equal(cancelled, false);
		assert.equal((await bounded(f.service.disconnect(), "disconnect with SSE open", 2000)).state, "disconnected");
		if (!cancelled) streamController.close();
		await bounded(pending, "SSE completion after disconnect");
		assert.equal((await f.service.status()).state, "disconnected");
	} finally { try { streamController.close(); } catch {} await pending; globalThis.fetch = denyFetch; }
});

for (const mode of ["refresh-fsync", "refresh-crash"] as const) {
	test(`real SDK ${mode} after rotated rename quarantines a fresh process with zero network`, { timeout: 15000 }, async () => {
		const f = await fixture(true, true);
		const writer = child(mode, f.directory);
		try {
			assert.equal((await writer.next()).event, mode === "refresh-crash" ? "crash_after_rename" : "refresh_failed");
			await writer.finish(mode === "refresh-crash" ? 73 : 0);
		} finally { await writer.stop(); }
		const probe = child("probe", f.directory);
		try {
			const result = await probe.next();
			assert.equal(result.event, "quarantined");
			assert.equal(result.calls, 0);
			assert.equal(result.rotatedVisible, true);
			assert.equal((await probe.next()).event, "recovered_by_disconnect");
			await probe.finish();
			assert.equal((await f.service.status()).state, "disconnected");
		} finally { await probe.stop(); }
	});
}
