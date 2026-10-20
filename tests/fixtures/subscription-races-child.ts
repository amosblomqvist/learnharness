/** Isolated real-service subprocess probes. All network calls are replaced. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { syncBuiltinESMExports } from "node:module";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createSubscriptionStore, SUBSCRIPTION_LOCK_DIR, SUBSCRIPTION_STATE_FILE, type SubscriptionStore } from "../../src/store/subscription-credentials.ts";
import { createSubscriptionService } from "../../src/server/subscription.ts";
import { createSubscriptionEngine } from "../../src/server/subscription-engine.ts";

const [mode, directoryArgument] = process.argv.slice(2);
if (!directoryArgument || !process.env.LH_DATA_DIR || !process.env.LH_AUTH_FILE) throw new Error("Isolation paths are required");
const directory: string = directoryArgument;
const print = (value: unknown) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin });
const commands: string[] = [];
const waiters: Array<(line: string) => void> = [];
input.on("line", (line) => { const waiter = waiters.shift(); if (waiter) waiter(line); else commands.push(line); });
function next(): Promise<string> { const command = commands.shift(); return command === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(command); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "race-rotated" } })).toString("base64url")}.signature`;
const context = () => normalizeContext({ messages: [{ role: "user", content: "Isolated race probe", timestamp: 1 }] });
const store = createSubscriptionStore(directory);
globalThis.fetch = async () => { throw new Error("Unapproved network request"); };

async function main() {
	if (mode === "disconnect") {
		const service = createSubscriptionService(store);
		print({ event: "ready" });
		assert.equal(await next(), "go");
		print({ event: "disconnect_started" });
		const status = await service.disconnect();
		print({ event: "disconnected", status });
		return;
	}
	if (mode === "sender") {
		// Instrument only the public transaction seam. The real transaction,
		// journal read and OS lock all remain active across the test barrier.
		let armed = false;
		const observed: SubscriptionStore = {
			...store, directory: store.directory, owner: store.owner,
			getSnapshot: () => store.getSnapshot(), snapshot: () => store.snapshot(),
			isOwnerAlive: (owner) => store.isOwnerAlive(owner),
			transaction: (fn, signal) => store.transaction((tx) => fn(new Proxy(tx, {
				get(target, property) {
					if (property === "journal") return async () => {
						const journal = await target.journal();
						if (armed) { armed = false; print({ event: "check_locked" }); assert.equal(await next(), "release-check"); }
						return journal;
					};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			})), signal),
		};
		const service = createSubscriptionService(observed);
		const generation = await service.assertAvailable();
		const lease = await service.acquireLease(generation);
		const response = deferred<Response>();
		globalThis.fetch = (request, init) => {
			assert.equal(String(request), endpoint);
			assert.equal(init?.method, "POST");
			const owner = JSON.parse(fs.readFileSync(path.join(directory, SUBSCRIPTION_LOCK_DIR, "owner.json"), "utf8"));
			assert.equal(owner.nonce, store.owner.nonce, "underlying fetch invocation must own the real lock");
			print({ event: "fetch_invoked", lockHeld: true });
			return response.promise;
		};
		print({ event: "ready", generation });
		assert.equal(await next(), "go");
		armed = true;
		const pending = lease.fetch(endpoint, { method: "POST" });
		void pending.catch(() => {});
		// The check barrier consumes release-check; do not compete for input.
		await new Promise<void>((resolve) => {
			const check = () => { if (!armed) resolve(); else setImmediate(check); };
			check();
		});
		// Wait for a separate command only after the barrier has consumed its line.
		// fetch_invoked is emitted synchronously before this command can arrive.
		assert.equal(await next(), "respond");
		response.resolve(new Response("isolated response"));
		assert.equal((await pending).status, 200);
		lease.release();
		print({ event: "sender_done" });
		return;
	}
	if (mode === "refresh-crash" || mode === "refresh-fsync") {
		let rotating = false;
		let renamed = false;
		let faulted = false;
		const rename = fs.renameSync;
		const fsync = fs.fsyncSync;
		fs.renameSync = (oldPath, newPath) => {
			rename(oldPath, newPath);
			if (rotating && String(newPath) === path.join(directory, SUBSCRIPTION_STATE_FILE)) {
				renamed = true;
				if (mode === "refresh-crash") { print({ event: "crash_after_rename" }); process.exit(73); }
			}
		};
		fs.fsyncSync = (fd) => {
			if (renamed && !faulted && fs.fstatSync(fd).isDirectory()) {
				faulted = true;
				throw Object.assign(new Error("isolated directory fsync fault"), { code: "EIO" });
			}
			fsync(fd);
		};
		syncBuiltinESMExports();
		let refreshes = 0;
		globalThis.fetch = async (request) => {
			assert.equal(String(request), "https://auth.openai.com/oauth/token");
			assert.ok(fs.existsSync(path.join(directory, "subscription-refresh-journal.json")));
			refreshes++;
			rotating = true;
			return Response.json({ access_token: token, refresh_token: "race-refresh-rotated", expires_in: 3600 });
		};
		const service = createSubscriptionService(store);
		const engine = createSubscriptionEngine(service, { provider: "openai-codex", id: "gpt-6-luna" }, await service.assertAvailable());
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(refreshes, 1);
		assert.ok(faulted);
		assert.match(result.errorMessage!, /subscription_recovery_required/);
		print({ event: "refresh_failed", refreshes, faulted, renamed, status: await service.status() });
		return;
	}
	if (mode === "probe") {
		let calls = 0;
		globalThis.fetch = async () => { calls++; throw new Error("Quarantined process must not send"); };
		const service = createSubscriptionService(store);
		const snapshot = await store.snapshot();
		const generation = snapshot.state.generation;
		assert.ok(snapshot.journal);
		assert.equal(snapshot.state.credential?.refresh, "race-refresh-rotated");
		await assert.rejects(service.assertAvailable(), { code: "subscription_recovery_required" });
		await assert.rejects(service.credentials(generation).read("openai-codex"), { code: "subscription_recovery_required" });
		await assert.rejects(service.acquireLease(generation), { code: "subscription_recovery_required" });
		const engine = createSubscriptionEngine(service, { provider: "openai-codex", id: "gpt-6-luna" }, generation);
		const result = await engine.streamFn(engine.model, context()).result();
		assert.match(result.errorMessage!, /subscription_recovery_required/);
		assert.equal(calls, 0);
		print({ event: "quarantined", calls, journal: true, rotatedVisible: true, status: await service.status() });
		await service.disconnect();
		assert.equal((await service.status()).state, "disconnected");
		assert.equal((await store.snapshot()).journal, undefined);
		print({ event: "recovered_by_disconnect" });
		return;
	}
	throw new Error("Unknown probe mode");
}
main().then(() => { input.close(); process.exit(0); }, (error: unknown) => {
	print({ event: "fatal", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown" });
	input.close(); process.exit(1);
});
