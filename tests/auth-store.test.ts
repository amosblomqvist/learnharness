/**
 * The AuthStore fs adapter (auth-keys wave, 2026-09-19; encrypted at rest by
 * the auth-encryption change) — AES-256-GCM entries in auth.enc.json beside
 * config.AUTH_FILE, master key from LH_AUTH_MASTER_KEY here (tests NEVER touch
 * the real OS keyring: the keyring tests inject a fake backend through
 * authStoreTesting.reset, and under NODE_ENV=test the native one refuses to
 * load). THIS FILE is the sole owner of its auth dir: LH_AUTH_FILE is
 * redirected to a fresh tmp dir BEFORE the first config import (the seam is
 * module-load-bound — data-dir-seam precedent).
 *
 * Pinning: absent = {}; set/delete round-trip with unknown vars preserved; no
 * plaintext on disk; wrong key = empty read + refused writes (file untouched);
 * AAD binds entries to their names; the plaintext auth.json is an inbox that
 * is absorbed + wiped (never wiped without a key source); mode 0600; atomic;
 * the file tools deny both files and their temps.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs"; // default import on purpose: t.mock patches fs.renameSync on this object
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-store-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Import AFTER the env redirect — module-load-bound seam.
const { authStore, authStoreTesting, readCustomAuth, writeCustomAuth } = await import("../src/store/auth.ts");
const { AUTH_ENC_FILE, AUTH_FILE } = await import("../config.ts");
const { isSensitivePath, resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { CUSTOM_AUTH_BINDING } = await import("../src/core/custom-provider-auth.ts");
const { CUSTOM_PROVIDER } = await import("../src/core/auth-keys.ts");

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");

/** A keyring that must never be asked anything. */
const forbiddenKeyring = () => {
	throw new Error("the keyring must not be touched");
};

beforeEach(() => {
	fs.rmSync(AUTH_FILE, { force: true });
	fs.rmSync(AUTH_ENC_FILE, { force: true });
	process.env.LH_AUTH_MASTER_KEY = KEY_A;
	authStoreTesting.reset(forbiddenKeyring);
});

after(() => {
	delete process.env.LH_AUTH_MASTER_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const encJson = () => JSON.parse(fs.readFileSync(AUTH_ENC_FILE, "utf-8"));

describe("AuthStore adapter — encrypted at rest", () => {
	it("the encrypted file sits beside AUTH_FILE: same dir + basename, .enc.json", () => {
		assert.equal(AUTH_ENC_FILE, path.join(path.dirname(AUTH_FILE), "auth.enc.json"));
	});

	it("absent = {} (the documented first-boot state), never throws", () => {
		assert.deepEqual(authStore.authVars(), {});
		authStore.deleteAuthVar("NOT_THERE"); // idempotent no-op
		assert.ok(!fs.existsSync(AUTH_ENC_FILE));
	});

	it("set → read → delete round-trip; trim is the CALLER's job, verbatim here", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-abc");
		authStore.setAuthVar("DEEPGRAM_API_KEY", " d ".repeat(10));
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-abc");
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, " d ".repeat(10));
		authStore.deleteAuthVar("OPENROUTER_API_KEY");
		assert.deepEqual(Object.keys(authStore.authVars()), ["DEEPGRAM_API_KEY"]);
		authStore.deleteAuthVar("OPENROUTER_API_KEY"); // absent = silent success
		assert.deepEqual(Object.keys(authStore.authVars()), ["DEEPGRAM_API_KEY"]);
	});

	it("unknown vars ride along verbatim (forward-compat)", () => {
		authStore.setAuthVar("FUTURE_PLANS_TOKEN", "opaque-xyz");
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new");
		assert.equal(authStore.authVars().FUTURE_PLANS_TOKEN, "opaque-xyz");
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-new");
	});

	it("on-disk format: version/alg/entries with 12-byte IV and 16-byte tag; no plaintext bytes", () => {
		const secret = "sk-or-v1-SUPER-SECRET-0123456789";
		authStore.setAuthVar("OPENROUTER_API_KEY", secret);
		const raw = fs.readFileSync(AUTH_ENC_FILE);
		assert.ok(!raw.includes(secret), "the secret never appears in the file bytes");
		assert.ok(!raw.includes(Buffer.from(secret).toString("base64")), "nor its bare base64");
		const file = encJson();
		assert.equal(file.version, 1);
		assert.equal(file.alg, "aes-256-gcm");
		const entry = file.entries.OPENROUTER_API_KEY;
		assert.equal(Buffer.from(entry.iv, "base64").length, 12);
		assert.equal(Buffer.from(entry.tag, "base64").length, 16);
		assert.ok(entry.ct.length > 0);
		assert.ok(!fs.existsSync(AUTH_FILE), "no plaintext auth.json is ever created");
	});

	it("a fresh random IV per value, per write", () => {
		authStore.setAuthVar("A_KEY", "same-value");
		const first = encJson().entries.A_KEY;
		authStore.setAuthVar("A_KEY", "same-value");
		const second = encJson().entries.A_KEY;
		assert.notEqual(first.iv, second.iv);
		assert.notEqual(first.ct, second.ct);
	});

	it("the file is mode 0600 (secrets), also after rewrites", { skip: process.platform === "win32" }, () => {
		authStore.setAuthVar("DEEPGRAM_API_KEY", "d".repeat(40));
		assert.equal(fs.statSync(AUTH_ENC_FILE).mode & 0o777, 0o600);
		authStore.setAuthVar("DEEPGRAM_API_KEY", "e".repeat(40));
		assert.equal(fs.statSync(AUTH_ENC_FILE).mode & 0o777, 0o600, "rewrite keeps 0600");
	});

	it("the actual writer's complete 0600 temp holds only ciphertext and is denied before replacement", (t) => {
		const rename = fs.renameSync;
		let observed = false;
		t.mock.method(fs, "renameSync", (...[tmp, destination]: Parameters<typeof rename>) => {
			assert.equal(destination, AUTH_ENC_FILE);
			const name = String(tmp);
			assert.match(name, /auth\.enc\.json\.tmp-[0-9a-f-]{36}$/);
			assert.ok(!fs.readFileSync(tmp).includes("synthetic-key"), "the temp is ciphertext, never plaintext");
			if (process.platform !== "win32") assert.equal(fs.statSync(tmp).mode & 0o777, 0o600);
			assert.equal(isSensitivePath(name), true);
			assert.throws(() => resolveSourcePath(name), /Access denied/);
			observed = true;
			return rename(tmp, destination);
		});
		authStore.setAuthVar("TEMP_CONTRACT", "synthetic-key");
		assert.equal(observed, true);
	});

	it("learner file tools deny both the encrypted store and the plaintext inbox", () => {
		for (const file of [AUTH_ENC_FILE, AUTH_FILE]) {
			assert.equal(isSensitivePath(file), true, file);
			assert.throws(() => resolveSourcePath(file), /Access denied/);
		}
	});

	it("atomic writes: no tmp leftovers, valid JSON on disk every time", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-final");
		assert.deepEqual(
			fs.readdirSync(TMP).filter((f) => f.includes(".tmp-")),
			[],
			"no tmp file survives the rename",
		);
		encJson(); // must parse
	});

	it("non-string values are preserved verbatim across writes but never surface as keys", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ future: { preserve: true, list: [1, 2] }, OK: "fine" }));
		authStore.setAuthVar("NEW_KEY", "n");
		assert.deepEqual(authStore.authVars(), { OK: "fine", NEW_KEY: "n" }, "only strings are keys");
		const entry = encJson().entries.future;
		assert.equal(entry.json, true);
		assert.ok(!fs.readFileSync(AUTH_ENC_FILE).includes("preserve"), "encrypted too");
		authStore.deleteAuthVar("OK");
		assert.equal(Object.hasOwn(encJson().entries, "future"), true, "still there after another write");
	});

	it("under NODE_ENV=test the default backend is process-local: the native keyring is never loaded", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		authStoreTesting.reset(); // restore the DEFAULT backend, as an unconfigured suite sees it
		assert.equal(process.env.NODE_ENV, "test");
		authStore.setAuthVar("A_KEY", "x");
		assert.deepEqual(authStore.authVars(), { A_KEY: "x" });
		const loaded = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.includes("keyring"));
		assert.deepEqual(loaded, [], "@napi-rs/keyring was never required");
		authStoreTesting.reset(); // a "new process": the in-memory key is gone, so the file is locked
		assert.deepEqual(authStore.authVars(), {});
		assert.throws(() => authStore.setAuthVar("B_KEY", "y"), /master key is missing/);
	});
});

describe("AuthStore adapter — locked state (key missing/wrong, file damaged)", () => {
	it("wrong key: reads {} and a write refuses without touching the file", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-keepme");
		const before = fs.readFileSync(AUTH_ENC_FILE);
		process.env.LH_AUTH_MASTER_KEY = KEY_B;
		assert.deepEqual(authStore.authVars(), {}, "undecryptable = empty, no crash");
		assert.throws(() => authStore.setAuthVar("DEEPGRAM_API_KEY", "d".repeat(40)), /delete auth\.enc\.json/);
		assert.throws(() => authStore.deleteAuthVar("OPENROUTER_API_KEY"), /delete auth\.enc\.json/);
		assert.ok(before.equals(fs.readFileSync(AUTH_ENC_FILE)), "file bytes untouched");
		process.env.LH_AUTH_MASTER_KEY = KEY_A;
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-keepme", "the right key still reads it");
	});

	it("AAD: swapping two entries' blobs fails to decrypt (store goes locked)", () => {
		authStore.setAuthVar("FIRST_KEY", "value-one");
		authStore.setAuthVar("SECOND_KEY", "value-two");
		const file = encJson();
		[file.entries.FIRST_KEY, file.entries.SECOND_KEY] = [file.entries.SECOND_KEY, file.entries.FIRST_KEY];
		fs.writeFileSync(AUTH_ENC_FILE, JSON.stringify(file));
		assert.deepEqual(authStore.authVars(), {});
		assert.throws(() => authStore.setAuthVar("THIRD_KEY", "x"), /cannot be decrypted/);
	});

	it("a tampered ciphertext is rejected, not returned", () => {
		authStore.setAuthVar("A_KEY", "value-one");
		const file = encJson();
		const ct = Buffer.from(file.entries.A_KEY.ct, "base64");
		ct[0] = ct[0]! ^ 0xff;
		file.entries.A_KEY.ct = ct.toString("base64");
		fs.writeFileSync(AUTH_ENC_FILE, JSON.stringify(file));
		assert.deepEqual(authStore.authVars(), {});
	});

	it("a corrupt encrypted file reads {} and refuses writes (never overwritten)", () => {
		fs.writeFileSync(AUTH_ENC_FILE, "{not json");
		assert.deepEqual(authStore.authVars(), {});
		assert.throws(() => authStore.setAuthVar("A_KEY", "x"), /cannot be decrypted/);
		assert.equal(fs.readFileSync(AUTH_ENC_FILE, "utf-8"), "{not json");
	});

	it("a malformed LH_AUTH_MASTER_KEY is an error, never a silent keyring fallback", () => {
		process.env.LH_AUTH_MASTER_KEY = "dG9vLXNob3J0"; // base64, but not 32 bytes
		assert.throws(() => authStore.setAuthVar("A_KEY", "x"), /LH_AUTH_MASTER_KEY must be base64/);
		assert.ok(!fs.existsSync(AUTH_ENC_FILE));
	});
});

describe("AuthStore adapter — the plaintext auth.json inbox", () => {
	it("a hand-created auth.json is absorbed on read, the file is gone, values readable", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-hand", FUTURE_PLANS_TOKEN: "opaque" }));
		assert.deepEqual(authStore.authVars(), { OPENROUTER_API_KEY: "sk-or-v1-hand", FUTURE_PLANS_TOKEN: "opaque" });
		assert.ok(!fs.existsSync(AUTH_FILE), "plaintext removed");
		assert.ok(!fs.readFileSync(AUTH_ENC_FILE).includes("sk-or-v1-hand"), "and stored encrypted");
	});

	it("the wipe overwrites the plaintext bytes before unlinking (a hard link sees random bytes)", () => {
		const body = JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-wipe-me-0123456789" });
		fs.writeFileSync(AUTH_FILE, body);
		const alias = path.join(TMP, "alias.bin");
		fs.rmSync(alias, { force: true });
		fs.linkSync(AUTH_FILE, alias); // same inode: what unlink alone would leave behind
		authStore.authVars();
		assert.ok(!fs.existsSync(AUTH_FILE));
		const left = fs.readFileSync(alias);
		assert.equal(left.length, Buffer.byteLength(body), "same length");
		assert.ok(!left.includes("sk-or-v1-wipe-me"), "plaintext is gone from the inode");
		fs.rmSync(alias);
	});

	it("a symlinked inbox is absorbed and the link removed, without modifying its referent", (t) => {
		const referent = path.join(TMP, "referent.json");
		const original = JSON.stringify({ KEEP: "original" });
		fs.writeFileSync(referent, original);
		try { fs.symlinkSync(referent, AUTH_FILE); }
		catch { t.skip("symlinks need extra rights on this machine"); return; }
		assert.deepEqual(authStore.authVars(), { KEEP: "original" });
		assert.equal(fs.existsSync(AUTH_FILE), false, "link removed");
		assert.equal(fs.readFileSync(referent, "utf8"), original, "referent untouched");
		fs.rmSync(referent);
	});

	it("plaintext overwrites a clashing encrypted entry; other encrypted entries survive", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-old");
		authStore.setAuthVar("DEEPGRAM_API_KEY", "d".repeat(40));
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-edited" }));
		assert.deepEqual(authStore.authVars(), {
			OPENROUTER_API_KEY: "sk-or-v1-edited",
			DEEPGRAM_API_KEY: "d".repeat(40),
		});
		assert.ok(!fs.existsSync(AUTH_FILE));
	});

	it("absorbed on a write too; blank/{} files are simply wiped", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OK: "fine" }));
		authStore.setAuthVar("NEW_KEY", "n");
		assert.deepEqual(authStore.authVars(), { OK: "fine", NEW_KEY: "n" });
		fs.writeFileSync(AUTH_FILE, "{}\n");
		authStore.authVars();
		assert.ok(!fs.existsSync(AUTH_FILE));
		fs.writeFileSync(AUTH_FILE, "");
		authStore.authVars();
		assert.ok(!fs.existsSync(AUTH_FILE));
	});

	it("a corrupt inbox is left untouched (not wiped, not parsed into state)", () => {
		fs.writeFileSync(AUTH_FILE, "{not json");
		assert.deepEqual(authStore.authVars(), {});
		assert.equal(fs.readFileSync(AUTH_FILE, "utf-8"), "{not json");
		assert.ok(!fs.existsSync(AUTH_ENC_FILE));
	});

	it("NO key source: the plaintext inbox stays intact; reads {}; writes throw readably", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		const body = JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-stay" });
		fs.writeFileSync(AUTH_FILE, body);
		authStoreTesting.reset(() => {
			throw new Error("no secret service");
		});
		assert.deepEqual(authStore.authVars(), {}, "no plaintext fallback read");
		assert.equal(fs.readFileSync(AUTH_FILE, "utf-8"), body, "plaintext untouched — never delete unstored keys");
		assert.ok(!fs.existsSync(AUTH_ENC_FILE));
		assert.throws(() => authStore.setAuthVar("A_KEY", "x"), /Cannot store API keys securely.*no secret service/);
		assert.ok(!fs.existsSync(AUTH_ENC_FILE));
	});

	it("key missing from the keyring while the encrypted file exists: inbox kept, nothing clobbered", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-keepme");
		const before = fs.readFileSync(AUTH_ENC_FILE);
		delete process.env.LH_AUTH_MASTER_KEY;
		const sets: string[] = [];
		authStoreTesting.reset(() => ({ get: () => null, set: (v) => void sets.push(v) }));
		const body = JSON.stringify({ DEEPGRAM_API_KEY: "d".repeat(40) });
		fs.writeFileSync(AUTH_FILE, body);
		assert.deepEqual(authStore.authVars(), {});
		assert.equal(fs.readFileSync(AUTH_FILE, "utf-8"), body);
		assert.throws(() => authStore.setAuthVar("A_KEY", "x"), /delete auth\.enc\.json/);
		assert.deepEqual(sets, [], "no replacement master key was minted over live entries");
		assert.ok(before.equals(fs.readFileSync(AUTH_ENC_FILE)));
	});
});

describe("AuthStore adapter — the custom-endpoint pair", () => {
	const binding = { version: 1, id: "a".repeat(32), authMode: "apiKey", baseUrl: "https://example.test/v1", fileKeyBaseUrl: "https://example.test/v1" } as const;

	it("the pair round-trips through ONE encrypted write; ordinary vars and unknown values survive", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OTHER_PROVIDER_KEY: "untouched", future: { preserve: true } }));
		writeCustomAuth(binding, "custom-secret-value");
		const raw = fs.readFileSync(AUTH_ENC_FILE);
		assert.ok(!raw.includes("custom-secret-value") && !raw.includes("example.test"), "key and binding are both ciphertext");
		const snapshot = readCustomAuth();
		assert.equal(snapshot.binding?.id, binding.id);
		assert.equal(snapshot.fileKey(), "custom-secret-value");
		assert.equal(authStore.authVars().OTHER_PROVIDER_KEY, "untouched");
		assert.equal(Object.hasOwn(encJson().entries, "future"), true);
		writeCustomAuth(undefined, undefined);
		assert.equal(readCustomAuth().binding, undefined);
		assert.equal(Object.hasOwn(encJson().entries, CUSTOM_PROVIDER.envVar), false);
		assert.equal(Object.hasOwn(encJson().entries, CUSTOM_AUTH_BINDING), false);
	});

	it("the ordinary API cannot touch the pair", () => {
		assert.throws(() => authStore.setAuthVar(CUSTOM_PROVIDER.envVar, "x"), /custom endpoint editor/);
		assert.throws(() => authStore.deleteAuthVar(CUSTOM_AUTH_BINDING), /custom endpoint editor/);
	});

	it("a locked store makes pair reads and writes throw — never an empty record", () => {
		writeCustomAuth(binding, "custom-secret-value");
		const before = fs.readFileSync(AUTH_ENC_FILE);
		process.env.LH_AUTH_MASTER_KEY = KEY_B;
		assert.throws(() => readCustomAuth(), /Custom authorization storage unavailable/);
		assert.throws(() => writeCustomAuth(undefined, undefined), /Custom authorization storage unavailable/);
		assert.ok(before.equals(fs.readFileSync(AUTH_ENC_FILE)), "file bytes untouched");
	});

	it("with no key source a pair write throws and nothing is written", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		authStoreTesting.reset(() => {
			throw new Error("no secret service");
		});
		assert.throws(() => writeCustomAuth(binding, "custom-secret-value"), /Custom authorization storage unavailable/);
		assert.ok(!fs.existsSync(AUTH_ENC_FILE) && !fs.existsSync(AUTH_FILE));
	});

	it("an invalid stored binding or key record fails closed", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ [CUSTOM_AUTH_BINDING]: "{not a binding" }));
		assert.throws(() => readCustomAuth(), /Invalid custom authorization record/);
		fs.rmSync(AUTH_ENC_FILE);
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ [CUSTOM_PROVIDER.envVar]: 42 }));
		assert.throws(() => readCustomAuth(), /Invalid custom credential record/);
	});
});

describe("AuthStore adapter — OS keyring master key (fake backend)", () => {
	function fakeKeyring() {
		const state = { value: null as string | null, gets: 0, sets: 0 };
		return {
			state,
			factory: () => ({
				get: () => {
					state.gets++;
					return state.value;
				},
				set: (v: string) => {
					state.sets++;
					state.value = v;
				},
			}),
		};
	}

	it("generated on the first write (32 random bytes, base64), cached for the process", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		const fake = fakeKeyring();
		authStoreTesting.reset(fake.factory);
		assert.deepEqual(authStore.authVars(), {});
		assert.equal(fake.state.gets, 0, "nothing stored → the keyring is not even asked");
		authStore.setAuthVar("A_KEY", "alpha");
		assert.equal(fake.state.sets, 1);
		assert.equal(Buffer.from(fake.state.value!, "base64").length, 32);
		const gets = fake.state.gets;
		authStore.setAuthVar("B_KEY", "beta");
		authStore.authVars();
		authStore.authVars();
		assert.equal(fake.state.gets, gets, "cached — no keyring hit on later reads/writes");
		assert.equal(fake.state.sets, 1, "the key is minted once");
	});

	it("a fresh process (cache cleared) reads back through the stored key", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		const fake = fakeKeyring();
		authStoreTesting.reset(fake.factory);
		authStore.setAuthVar("A_KEY", "alpha");
		authStoreTesting.reset(fake.factory);
		assert.deepEqual(authStore.authVars(), { A_KEY: "alpha" });
	});

	it("LH_AUTH_MASTER_KEY set: the keyring is never touched (forbiddenKeyring would throw)", () => {
		authStore.setAuthVar("A_KEY", "alpha");
		assert.deepEqual(authStore.authVars(), { A_KEY: "alpha" });
	});

	it("a malformed keyring entry is never overwritten: writes throw", () => {
		delete process.env.LH_AUTH_MASTER_KEY;
		const fake = fakeKeyring();
		fake.state.value = "not-a-key";
		authStoreTesting.reset(fake.factory);
		assert.throws(() => authStore.setAuthVar("A_KEY", "x"), /not a base64 32-byte key/);
		assert.equal(fake.state.value, "not-a-key");
		assert.equal(fake.state.sets, 0);
	});
});
