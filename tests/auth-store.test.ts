/**
 * The AuthStore fs adapter (auth-keys wave, 2026-09-19) — flat {VAR: value}
 * map at config.AUTH_FILE. THIS FILE is the sole owner of its auth file:
 * LH_AUTH_FILE is redirected to a fresh tmp dir BEFORE the first config
 * import (the seam is module-load-bound — data-dir-seam precedent), so no
 * hand-edited dev/desktop auth.json is ever touched.
 *
 * Pinning: absent/corrupt = {} ("no keys yet") for reads, while writes over
 * a corrupt file throw and keep its bytes; set/delete round-trip with
 * unknown vars preserved verbatim; the file is ALWAYS mode 0600 (secrets);
 * writes are atomic (tmp+rename — no partial JSON state).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-store-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Import AFTER the env redirect — module-load-bound seam.
const { authStore } = await import("../src/store/auth.ts");
const { AUTH_FILE } = await import("../config.ts");
const { isSensitivePath, resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("AuthStore adapter", () => {
	it("absent file = {} (the documented first-boot state), never throws", () => {
		assert.deepEqual(authStore.authVars(), {});
	});

	it("set → read round-trip; trim is the CALLER's (server's) job, verbatim here", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-abc");
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-abc");
	});

	it("the file is mode 0600 (secrets), also after rewrites", () => {
		authStore.setAuthVar("DEEPGRAM_API_KEY", "d".repeat(40));
		const first = fs.statSync(AUTH_FILE).mode & 0o777;
		assert.equal(first, 0o600);
		authStore.setAuthVar("DEEPGRAM_API_KEY", "e".repeat(40));
		assert.equal(fs.statSync(AUTH_FILE).mode & 0o777, 0o600, "rewrite keeps 0600");
	});

	it("set preserves unknown vars verbatim (forward-compat)", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ FUTURE_PLANS_TOKEN: "opaque-xyz", KEEP: "me" }));
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new");
		const vars = authStore.authVars();
		assert.equal(vars.FUTURE_PLANS_TOKEN, "opaque-xyz");
		assert.equal(vars.KEEP, "me");
		assert.equal(vars.OPENROUTER_API_KEY, "sk-or-v1-new");
	});

	it("corrupt/non-object file = {} — never throws, looks like first boot", () => {
		fs.writeFileSync(AUTH_FILE, "{not json");
		assert.deepEqual(authStore.authVars(), {});
		fs.writeFileSync(AUTH_FILE, JSON.stringify(["an", "array"]));
		assert.deepEqual(authStore.authVars(), {});
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OK: "fine", bad: 42 }));
		assert.deepEqual(authStore.authVars(), { OK: "fine" }, "non-string values drop");
	});

	it("delete removes just that var; absent delete = silent no-op", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ A: "1", B: "2" }));
		authStore.deleteAuthVar("A");
		assert.deepEqual(authStore.authVars(), { B: "2" });
		authStore.deleteAuthVar("NOT_THERE");
		assert.deepEqual(authStore.authVars(), { B: "2" });
	});

	it("the actual auth writer's complete 0600 temp is denied before replacement", (t) => {
		const rename = fs.renameSync;
		let observed = false;
		t.mock.method(fs, "renameSync", (...[tmp, destination]: Parameters<typeof rename>) => {
			assert.equal(destination, AUTH_FILE);
			const name = String(tmp);
			assert.match(name, /auth\.json\.tmp-[0-9a-f-]{36}$/);
			assert.equal(JSON.parse(fs.readFileSync(tmp, "utf8")).TEMP_CONTRACT, "synthetic-key");
			if (process.platform !== "win32") assert.equal(fs.statSync(tmp).mode & 0o777, 0o600);
			assert.equal(isSensitivePath(name), true);
			assert.throws(() => resolveSourcePath(name), /Access denied/);
			observed = true;
			return rename(tmp, destination);
		});
		authStore.setAuthVar("TEMP_CONTRACT", "synthetic-key");
		assert.equal(observed, true);
	});

	it("auth replaces a symlink with a 0600 record without modifying its referent", (t) => {
		const referent = path.join(TMP, "referent.json");
		const original = JSON.stringify({ KEEP: "original" });
		fs.writeFileSync(referent, original);
		fs.unlinkSync(AUTH_FILE);
		try { fs.symlinkSync(referent, AUTH_FILE); }
		catch {
			fs.writeFileSync(AUTH_FILE, original, { mode: 0o600 });
			t.skip("symlinks need extra rights on this machine");
			return;
		}
		authStore.setAuthVar("NEW", "synthetic");
		assert.ok(fs.lstatSync(AUTH_FILE).isFile());
		assert.deepEqual(authStore.authVars(), { KEEP: "original", NEW: "synthetic" });
		assert.equal(fs.readFileSync(referent, "utf8"), original);
		if (process.platform !== "win32") assert.equal(fs.statSync(AUTH_FILE).mode & 0o777, 0o600);
	});

	it("atomic writes: no tmp leftovers, valid JSON on disk every time", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-final");
		const files = fs.readdirSync(TMP).filter((f) => f.includes(".tmp-"));
		assert.deepEqual(files, [], "no tmp file survives the rename");
		JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); // must parse
	});

	// Issue #523: a hand-edit typo must never be rewritten as a one-key file.
	it("writes refuse a corrupt/non-object file and leave its bytes unchanged", () => {
		const trailingComma = '{\n\t"OPENROUTER_API_KEY": "sk-or-v1-keep",\n\t"TAVILY_API_KEY": "tvly-keep",\n}\n';
		for (const raw of [trailingComma, "{not json", "[]", "null", '"not a map"']) {
			fs.writeFileSync(AUTH_FILE, raw);
			assert.throws(() => authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new"), /storage unavailable/);
			assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw, "set leaves the bytes alone");
			assert.throws(() => authStore.deleteAuthVar("TAVILY_API_KEY"), /storage unavailable/);
			assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw, "delete leaves the bytes alone");
			assert.deepEqual(authStore.authVars(), {}, "reads still never throw");
		}
	});

	it("writes refuse a file that exists but cannot be read", (t) => {
		const raw = JSON.stringify({ KEEP: "me" });
		fs.writeFileSync(AUTH_FILE, raw);
		t.mock.method(fs, "readFileSync", () => {
			throw Object.assign(new Error("synthetic access error"), { code: "EACCES" });
		});
		assert.throws(() => authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new"), /storage unavailable/);
		assert.throws(() => authStore.deleteAuthVar("KEEP"), /storage unavailable/);
		t.mock.restoreAll();
		assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw);
	});

	it("absent file: set creates it, delete stays a no-op", () => {
		fs.rmSync(AUTH_FILE, { force: true });
		authStore.deleteAuthVar("OPENROUTER_API_KEY");
		assert.equal(fs.existsSync(AUTH_FILE), false, "delete on an absent file writes nothing");
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-fresh");
		assert.deepEqual(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")), { OPENROUTER_API_KEY: "sk-or-v1-fresh" });
	});

	it("valid file: set and delete keep every other entry", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ A: "1", B: "2", C: "3" }));
		authStore.setAuthVar("A", "one");
		authStore.deleteAuthVar("B");
		assert.deepEqual(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")), { A: "one", C: "3" });
	});
});
