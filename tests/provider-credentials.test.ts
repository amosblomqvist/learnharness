/** File-backed provider credential store: perms, atomicity, locking, fail-closed. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { CredentialStoreError, PROVIDER_CREDENTIALS_FILE, createProviderCredentialStore } from "../src/store/provider-credentials.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pcred-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(TMP, `case${n++}`, "creds", "credentials.json");
const oauth = (access = "a1") => ({ type: "oauth" as const, access, refresh: "r1", expires: 123 });
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("provider credential store", () => {
	it("default path is inside the data dir's own connections subtree", async () => {
		const { PATHS } = await import("../config.ts");
		assert.equal(PROVIDER_CREDENTIALS_FILE, path.join(PATHS.data, "connections", "provider-credentials.json"));
	});

	it("absent = empty; modify persists oauth and api_key with 0600/0700", async () => {
		const file = fresh();
		const s = createProviderCredentialStore(file);
		assert.equal(await s.read("subscription-xai"), undefined);
		assert.equal(s.has("subscription-xai"), false);
		await s.modify("subscription-xai", async () => oauth());
		await s.modify("custom-proxy", async () => ({ type: "api_key", key: "k" }));
		if (process.platform !== "win32") {
			assert.equal(mode(file), 0o600);
			assert.equal(mode(path.dirname(file)), 0o700);
		}
		assert.equal(s.has("subscription-xai"), true);
		assert.equal(s.peek("custom-proxy")?.type, "api_key");
		assert.deepEqual((await s.list()).map((i) => i.providerId).sort(), ["custom-proxy", "subscription-xai"]);
		assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["credentials.json"]);
	});

	it("modify returning undefined leaves entry unchanged; fn sees a copy", async () => {
		const s = createProviderCredentialStore(fresh());
		await s.modify("p1", async () => oauth());
		const r = await s.modify("p1", async (cur) => {
			(cur as { access: string }).access = "mutated";
			return undefined;
		});
		assert.equal((r as { access: string }).access, "a1");
		assert.equal((s.peek("p1") as { access: string }).access, "a1");
	});

	it("delete removes, is idempotent, and sync views follow", async () => {
		const s = createProviderCredentialStore(fresh());
		await s.modify("p1", async () => oauth());
		await s.delete("p1");
		await s.delete("p1");
		assert.equal(s.has("p1"), false);
	});

	it("validates ids and credentials", async () => {
		const s = createProviderCredentialStore(fresh());
		for (const bad of ["", "__proto__", "../x", "A", "a/b", "x".repeat(65)]) {
			await assert.rejects(s.read(bad), (e: unknown) => (e as CredentialStoreError).code === "invalid_id");
			assert.equal(s.has(bad), false);
		}
		await assert.rejects(
			s.modify("p1", async () => ({ type: "oauth", access: "a" }) as never),
			(e: unknown) => (e as CredentialStoreError).code === "invalid_credential",
		);
		assert.equal(s.has("p1"), false);
	});

	it("corrupt state fails closed: reads reject, sync views absent, writes refuse, file untouched", async () => {
		const file = fresh();
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		for (const text of ["{not json", '{"version":2,"credentials":{}}', '{"version":1,"credentials":{"p1":{"type":"oauth"}}}']) {
			fs.writeFileSync(file, text, { mode: 0o600 });
			const s = createProviderCredentialStore(file);
			await assert.rejects(s.read("p1"), (e: unknown) => (e as CredentialStoreError).code === "corrupt");
			await assert.rejects(s.list());
			await assert.rejects(s.modify("p1", async () => oauth()));
			await assert.rejects(s.delete("p1"));
			assert.equal(s.has("p1"), false);
			assert.equal(s.peek("p1"), undefined);
			assert.equal(fs.readFileSync(file, "utf-8"), text);
		}
	});

	it("refuses symlinked file and symlinked directory", { skip: process.platform === "win32" ? "File symlinks require Windows developer mode or administrator privileges" : false }, async () => {
		const base = path.join(TMP, `sym${n++}`);
		fs.mkdirSync(base, { recursive: true });
		const real = path.join(base, "real.json");
		fs.writeFileSync(real, '{"version":1,"credentials":{}}');
		const dir = path.join(base, "d");
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.symlinkSync(real, path.join(dir, "credentials.json"));
		const s = createProviderCredentialStore(path.join(dir, "credentials.json"));
		await assert.rejects(s.read("p1"), (e: unknown) => (e as CredentialStoreError).code === "unsafe_path");
		await assert.rejects(s.modify("p1", async () => oauth()));
		assert.equal(fs.readFileSync(real, "utf-8"), '{"version":1,"credentials":{}}');

		const linkDir = path.join(base, "ld");
		fs.symlinkSync(dir, linkDir);
		const s2 = createProviderCredentialStore(path.join(linkDir, "credentials.json"));
		await assert.rejects(s2.modify("p1", async () => oauth()), (e: unknown) => (e as CredentialStoreError).code === "unsafe_path");
		assert.equal(s2.has("p1"), false);
	});

	it("refuses a linked credential directory including unprivileged Windows junctions", async () => {
		const base = path.join(TMP, "linked-directory");
		const real = path.join(base, "real");
		const linked = path.join(base, "linked");
		fs.mkdirSync(real, { recursive: true });
		fs.symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
		const store = createProviderCredentialStore(path.join(linked, "credentials.json"));
		await assert.rejects(store.modify("p1", async () => oauth()), (err: unknown) => (err as CredentialStoreError).code === "unsafe_path");
		assert.equal(fs.existsSync(path.join(real, "credentials.json")), false);
	});

	it("serializes concurrent modify (refresh-style read-modify-write)", async () => {
		const s = createProviderCredentialStore(fresh(), { pollMs: 2 });
		await s.modify("p1", async () => ({ ...oauth(), expires: 0 }));
		let inside = 0;
		let max = 0;
		let refreshes = 0;
		const refresh = () =>
			s.modify("p1", async (cur) => {
				inside++;
				max = Math.max(max, inside);
				await new Promise((r) => setTimeout(r, 5));
				inside--;
				if (cur && (cur as { expires: number }).expires > 0) return undefined; // another caller refreshed
				refreshes++;
				return { ...oauth("fresh"), expires: 999 };
			});
		await Promise.all(Array.from({ length: 8 }, refresh));
		assert.equal(max, 1);
		assert.equal(refreshes, 1);
		assert.equal((s.peek("p1") as { access: string }).access, "fresh");
	});

	it("two store instances (cross-process stand-in) exclude each other", async () => {
		const file = fresh();
		const a = createProviderCredentialStore(file, { pollMs: 2 });
		const b = createProviderCredentialStore(file, { pollMs: 2 });
		let inside = 0;
		let max = 0;
		const bump = (s: typeof a, v: string) =>
			s.modify("p1", async () => {
				inside++;
				max = Math.max(max, inside);
				await new Promise((r) => setTimeout(r, 10));
				inside--;
				return oauth(v);
			});
		await Promise.all([bump(a, "A"), bump(b, "B"), bump(a, "C")]);
		assert.equal(max, 1);
	});

	it("lock wait is bounded and abort-aware; stale locks recover", async () => {
		const file = fresh();
		const s = createProviderCredentialStore(file, { lockTimeoutMs: 80, pollMs: 5 });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const holder = s.modify("p1", async () => {
			await gate;
			return oauth();
		});
		await new Promise((r) => setTimeout(r, 20));
		await assert.rejects(s.modify("p2", async () => oauth()), (e: unknown) => (e as CredentialStoreError).code === "lock_timeout");
		const ac = new AbortController();
		const waiting = createProviderCredentialStore(file, { lockTimeoutMs: 5000, pollMs: 5 }).delete("p1", { signal: ac.signal });
		setTimeout(() => ac.abort(new Error("stop")), 20);
		await assert.rejects(waiting, /stop/);
		release();
		await holder;

	});

	it("never reclaims a live or unknown lock by age; reclaims only a positively dead same-host owner", async () => {
		const mkLock = (f: string, owner: unknown) => {
			fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
			fs.mkdirSync(`${f}.lock`);
			if (owner !== undefined) {
				fs.writeFileSync(path.join(`${f}.lock`, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
			}
			const old = new Date(Date.now() - 3_600_000);
			fs.utimesSync(`${f}.lock`, old, old);
		};
		const host = os.hostname();
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
		const cases: [string, unknown][] = [
			["live same-host owner, ancient mtime", { pid: process.pid, host, token: "t" }],
			["other-host owner", { pid: deadPid, host: "some-other-host", token: "t" }],
			["owner record without token", { pid: deadPid, host }],
			["garbage owner record", "{{"],
		];
		for (const [label, owner] of cases) {
			const f = fresh();
			mkLock(f, owner);
			const s = createProviderCredentialStore(f, { lockTimeoutMs: 60, pollMs: 5 });
			await assert.rejects(s.modify("p1", async () => oauth()), (e: unknown) => (e as CredentialStoreError).code === "lock_timeout", label);
			assert.equal(fs.existsSync(`${f}.lock`), true, label);
		}
		const f = fresh();
		mkLock(f, { pid: deadPid, host, token: "dead" });
		const s = createProviderCredentialStore(f, { pollMs: 2 });
		await s.modify("p1", async () => oauth());
		assert.equal(s.has("p1"), true);
		assert.equal(fs.existsSync(`${f}.lock`), false);
	});

	it("release does not remove a lock it no longer owns", async () => {
		const f = fresh();
		const s = createProviderCredentialStore(f, { pollMs: 2 });
		await s.modify("p1", async () => {
			fs.writeFileSync(path.join(`${f}.lock`, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "someone-else" }));
			return oauth();
		});
		assert.equal(fs.existsSync(`${f}.lock`), true);
	});

	it("failed fn releases the lock and writes nothing", async () => {
		const s = createProviderCredentialStore(fresh(), { lockTimeoutMs: 200, pollMs: 2 });
		await assert.rejects(s.modify("p1", async () => { throw new Error("boom"); }), /boom/);
		await s.modify("p1", async () => oauth());
		assert.equal(s.has("p1"), true);
	});

	it("errors never contain secrets", async () => {
		const file = fresh();
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, '{"leak":"SECRET-TOKEN-123"', { mode: 0o600 });
		const s = createProviderCredentialStore(file);
		await assert.rejects(s.read("p1"), (e: Error) => !e.message.includes("SECRET"));
	});
});

describe("acquisition guard and multi-process contention", () => {
	it("an abandoned guard fails closed: no age or pid reclaim, nothing written", async () => {
		const f = fresh();
		fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
		fs.writeFileSync(`${f}.guard`, JSON.stringify({ pid: deadPid, host: os.hostname(), token: "x" }));
		const old = new Date(Date.now() - 3_600_000);
		fs.utimesSync(`${f}.guard`, old, old);
		const s = createProviderCredentialStore(f, { lockTimeoutMs: 80, pollMs: 5 });
		await assert.rejects(s.modify("p1", async () => oauth()), (e: unknown) => (e as CredentialStoreError).code === "lock_timeout");
		assert.equal(fs.existsSync(`${f}.guard`), true);
		assert.equal(s.has("p1"), false);
		fs.unlinkSync(`${f}.guard`); // documented manual recovery
		await s.modify("p1", async () => oauth());
		assert.equal(s.has("p1"), true);
	});

	it("guard and lock are cleaned up after normal operations and failures", async () => {
		const f = fresh();
		const s = createProviderCredentialStore(f, { pollMs: 2 });
		await s.modify("p1", async () => oauth());
		await assert.rejects(s.modify("p1", async () => { throw new Error("x"); }));
		await s.delete("p1");
		assert.deepEqual(fs.readdirSync(path.dirname(f)).sort(), ["credentials.json"]);
	});

	it("a contender cannot steal a live lock while a stale one is being reclaimed (guard serializes)", async () => {
		// Reclaim path under contention: many contenders race over one dead-owner lock.
		const f = fresh();
		fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
		fs.mkdirSync(`${f}.lock`);
		fs.writeFileSync(path.join(`${f}.lock`, "owner.json"), JSON.stringify({ pid: deadPid, host: os.hostname(), token: "dead" }));
		const stores = Array.from({ length: 6 }, () => createProviderCredentialStore(f, { pollMs: 1 }));
		let inside = 0;
		let max = 0;
		await Promise.all(
			stores.map((s, i) =>
				s.modify(`p${i}`, async () => {
					inside++;
					max = Math.max(max, inside);
					await new Promise((r) => setTimeout(r, 8));
					inside--;
					return oauth(`v${i}`);
				}),
			),
		);
		assert.equal(max, 1);
		assert.equal(createProviderCredentialStore(f).has("p5"), true);
	});

	it("separate OS processes: no lost updates and no overlap inside the critical section", async () => {
		const f = fresh();
		const dir = path.dirname(f);
		const storeUrl = new URL("../src/store/provider-credentials.ts", import.meta.url).href;
		const child = `
			import fs from "node:fs";
			import path from "node:path";
			const { createProviderCredentialStore } = await import(${JSON.stringify(storeUrl)});
			const f = ${JSON.stringify(f)};
			const marker = path.join(path.dirname(f), "inside.marker");
			const s = createProviderCredentialStore(f, { pollMs: 1, lockTimeoutMs: 60000 });
			for (let i = 0; i < 12; i++) {
				await s.modify("p1", async (cur) => {
					fs.writeFileSync(marker, String(process.pid), { flag: "wx" }); // throws on overlap
					await new Promise((r) => setTimeout(r, 2));
					fs.unlinkSync(marker);
					return { type: "oauth", access: "a", refresh: "r", expires: (cur ? cur.expires : 0) + 1 };
				});
			}
		`;
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const { spawn } = await import("node:child_process");
		const run = () =>
			new Promise<{ code: number | null; err: string }>((resolve) => {
				const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], { cwd: process.cwd() });
				let err = "";
				p.stderr.on("data", (d) => (err += d));
				p.on("close", (code) => resolve({ code, err }));
			});
		const results = await Promise.all([run(), run(), run(), run()]);
		for (const r of results) assert.equal(r.code, 0, r.err.slice(0, 500));
		const s = createProviderCredentialStore(f);
		assert.equal((s.peek("p1") as { expires: number }).expires, 48);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["credentials.json"]);
	});
});
