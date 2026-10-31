/** No real endpoints/accounts. Actual process death and cold startup, not HMR. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { CUSTOM_AUTH_BINDING } from "../src/core/custom-provider-auth.ts";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-restart-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const base = "http://first.invalid/v1";
function profile() {
	const home = fs.mkdtempSync(path.join(root, "case-"));
	const id = "a".repeat(32);
	fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ version: 1, appearance: { mode: "dark" }, customProvider: { baseUrl: base, authMode: "apiKey", credentialBindingId: id, models: [{ id: "m" }] } }));
	fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ CUSTOM_OPENAI_API_KEY: "fixture-old-key", OTHER_PROVIDER_KEY: "untouched", future: { preserve: true }, [CUSTOM_AUTH_BINDING]: JSON.stringify({ version: 1, id, baseUrl: base, authMode: "apiKey", fileKeyBaseUrl: base }) }), { mode: 0o600 });
	return home;
}
function child(home: string, mode: "mutate" | "inspect", action = "key", fault = "none", envKey?: string) {
	const result = spawnSync(process.execPath, ["--import", "tsx", "tests/helpers/custom-provider-crash.ts", mode, action, fault], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NODE_ENV: "test", LH_DATA_DIR: home, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "0", ...(envKey ? { CUSTOM_OPENAI_API_KEY: envKey } : {}) }, encoding: "utf8", timeout: 15000 });
	assert.ifError(result.error);
	assert.ok(result.status === 0 || result.status === 77, `${result.status}: ${result.stderr}`);
	return { exit: result.status, data: result.stdout.trim() ? JSON.parse(result.stdout.trim().split("\n").at(-1)!) : undefined };
}
function closed(home: string, envKey?: string) {
	const { data } = child(home, "inspect", "key", "none", envKey);
	assert.equal(data.enabled, false); assert.deepEqual(data.requests, []); assert.equal(data.metadataInEnv, false);
	assert.ok(!data.statusIds.includes(CUSTOM_AUTH_BINDING));
}
test("cold restart refuses the new auth/old URL gap and double-I/O failure, with or without env", () => {
	for (const fault of ["after-auth", "double-io"]) {
		const home = profile(); const result = child(home, "mutate", "key", fault);
		if (fault === "after-auth") assert.equal(result.exit, 77); else assert.equal(result.data.status, 500);
		closed(home); closed(home, "fixture-real-env");
		const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
		assert.equal(auth.OTHER_PROVIDER_KEY, "untouched"); assert.deepEqual(auth.future, { preserve: true });
	}
});
test("failed auth publication retains old matching setup; landed settings plus restored auth fails closed", () => {
	const home = profile(); assert.equal(child(home, "mutate", "key", "auth-before-rename").data.status, 500);
	const old = child(home, "inspect").data; assert.equal(old.enabled, true); assert.equal(old.requests[0].url, base + "/chat/completions"); assert.equal(old.requests[0].authorization, "Bearer fixture-old-key");
	const other = profile(); assert.equal(child(other, "mutate", "key", "settings-landed").data.status, 500); closed(other);
});
test("clear/disconnect half commits stay closed across restart even with genuine env keys", () => {
	for (const action of ["keyless", "disconnect"]) {
		for (const fault of ["after-auth", "double-io"]) {
			const home = profile(); child(home, "mutate", action, fault, "fixture-real-env"); closed(home, "fixture-real-env");
		}
	}
});
test("successful keyless checks only binding; disconnect tombstone blocks latent env after restart", () => {
	const home = profile(); assert.equal(child(home, "mutate", "keyless", "none", "fixture-real-env").data.status, 200);
	const state = child(home, "inspect", "key", "none", "fixture-real-env").data; assert.equal(state.enabled, true); assert.equal(state.requests[0].authorization, "Bearer not-needed");
	assert.equal(child(home, "mutate", "disconnect", "none", "fixture-real-env").data.status, 200); closed(home, "fixture-real-env");
});
test("env reuse never reauthorizes a shadowed file key for another destination", () => {
	const home = profile(); assert.equal(child(home, "mutate", "envMove", "none", "fixture-real-env").data.status, 200);
	const live = child(home, "inspect", "key", "none", "fixture-real-env").data; assert.equal(live.enabled, true); assert.equal(live.requests[0].url, "http://second.invalid/v1/chat/completions"); assert.equal(live.requests[0].authorization, "Bearer fixture-real-env");
	closed(home);
	const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")); assert.equal(JSON.parse(auth[CUSTOM_AUTH_BINDING]).fileKeyBaseUrl, base); assert.equal(auth.CUSTOM_OPENAI_API_KEY, "fixture-old-key");
	assert.equal(child(home, "mutate", "reuse").data.status, 200); assert.equal(child(home, "inspect").data.requests[0].authorization, "Bearer fixture-old-key");
});
test("unbound development records require explicit manual reauthorization, never automatic migration", () => {
	const home = profile(); const file = path.join(home, "auth.json"); const auth = JSON.parse(fs.readFileSync(file, "utf8")); delete auth[CUSTOM_AUTH_BINDING]; fs.writeFileSync(file, JSON.stringify(auth));
	closed(home); closed(home, "fixture-real-env");
	assert.equal(child(home, "mutate", "reuse").data.status, 200); assert.equal(child(home, "inspect").data.enabled, true);
});
test("malformed/unreadable private snapshots are never rewritten or used, unrelated bytes survive", () => {
	for (const raw of ['{"OTHER_PROVIDER_KEY":"do-not-erase",', '[]', JSON.stringify({ OTHER_PROVIDER_KEY: "do-not-erase", [CUSTOM_AUTH_BINDING]: "not-json" })]) {
		const home = profile(); const file = path.join(home, "auth.json"); fs.writeFileSync(file, raw);
		closed(home, "fixture-real-env"); assert.equal(child(home, "mutate").data.status, 500); assert.equal(fs.readFileSync(file, "utf8"), raw);
	}
	const home = profile(); const file = path.join(home, "auth.json"); const before = fs.readFileSync(file, "utf8");
	assert.equal(child(home, "mutate", "key", "unreadable").data.status, 500); assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.equal(child(home, "inspect", "key", "unreadable", "fixture-real-env").data.enabled, false);
});
test("missing auth file initializes normally with explicit new key, preserving other settings", () => {
	const home = profile(); fs.unlinkSync(path.join(home, "auth.json")); closed(home);
	assert.equal(child(home, "mutate").data.status, 200); const live = child(home, "inspect").data; assert.equal(live.enabled, true); assert.equal(live.requests[0].authorization, "Bearer fixture-new-key");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).appearance, { mode: "dark" });
});
