/**
 * The AuthStore fs adapter (auth-keys wave, 2026-09-19) — flat {VAR: value}
 * map at config.AUTH_FILE. THIS FILE is the sole owner of its auth file:
 * LH_AUTH_FILE is redirected to a fresh tmp dir BEFORE the first config
 * import (the seam is module-load-bound — data-dir-seam precedent), so no
 * hand-edited dev/desktop auth.json is ever touched.
 *
 * Pinning: absent/corrupt = {} ("no keys yet"); set/delete round-trip with
 * unknown vars preserved verbatim; the file is ALWAYS mode 0600 (secrets);
 * writes are atomic (tmp+rename — no partial JSON state).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-store-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Import AFTER the env redirect — module-load-bound seam.
const { authStore } = await import("../src/store/auth.ts");
const { AUTH_FILE } = await import("../config.ts");

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

	it("atomic writes: no tmp leftovers, valid JSON on disk every time", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-final");
		const files = fs.readdirSync(TMP).filter((f) => f.startsWith(".auth.json.tmp"));
		assert.deepEqual(files, [], "no tmp file survives the rename");
		JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); // must parse
	});

	it("refuses writes over malformed or non-object records without changing their bytes", () => {
		for (const raw of ['{"OPENAI_API_KEY":"recoverable",', "[]", "null", '"not a map"']) {
			fs.writeFileSync(AUTH_FILE, raw);
			assert.throws(() => authStore.setAuthVar("AWS_BEARER_TOKEN_BEDROCK", "fixture-token"));
			assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw);
			assert.throws(() => authStore.deleteAuthVar("OPENAI_API_KEY"));
			assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw);
		}
	});

	it("refuses writes when reading the existing file fails", () => {
		const raw = '{"OPENAI_API_KEY":"recoverable"}';
		fs.writeFileSync(AUTH_FILE, raw);
		const read = mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("synthetic access error"), { code: "EACCES" }); });
		try {
			assert.throws(() => authStore.setAuthVar("AWS_BEARER_TOKEN_BEDROCK", "fixture-token"));
			assert.throws(() => authStore.deleteAuthVar("OPENAI_API_KEY"));
		} finally { read.mock.restore(); }
		assert.equal(fs.readFileSync(AUTH_FILE, "utf8"), raw);
	});

	it("preserves unknown JSON values while updating an ordinary credential", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ future: { version: 2 }, OPENAI_API_KEY: "old" }));
		authStore.setAuthVar("AWS_BEARER_TOKEN_BEDROCK", "fixture-token");
		authStore.deleteAuthVar("OPENAI_API_KEY");
		assert.deepEqual(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")), { future: { version: 2 }, AWS_BEARER_TOKEN_BEDROCK: "fixture-token" });
	});
});
