import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createLanConfig, verifyPassword } = require("../electron/lan-config.cjs");

function tmpFile() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-")), "lan.json");
}

test("defaults are disabled on port 4747 with no password", () => {
	const cfg = createLanConfig(tmpFile());
	assert.deepEqual(cfg.publicView(), { enabled: false, port: 4747, hasPassword: false });
	assert.equal(cfg.getAuth(), null);
});

test("settings persist to lan.json with mode 0600 and survive a reload", () => {
	const file = tmpFile();
	const cfg = createLanConfig(file);
	cfg.setEnabled(true);
	cfg.setPort(5050);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ["lan.json"], "no tmp file left behind");
	assert.deepEqual(createLanConfig(file).publicView(), { enabled: true, port: 5050, hasPassword: false });
});

test("port must be an integer from 1024 to 65535", () => {
	const cfg = createLanConfig(tmpFile());
	for (const bad of [1023, 65536, 80.5, "4747", NaN, null]) assert.throws(() => cfg.setPort(bad as never), /port/i);
	cfg.setPort(1024);
	cfg.setPort(65535);
	assert.equal(cfg.publicView().port, 65535);
});

test("a corrupt lan.json falls back to defaults", () => {
	const file = tmpFile();
	fs.writeFileSync(file, "{nope");
	assert.deepEqual(createLanConfig(file).publicView(), { enabled: false, port: 4747, hasPassword: false });
});

test("verifyPassword and checkPassword are async (they must not block the main process)", async () => {
	const cfg = createLanConfig(tmpFile());
	cfg.setPassword("x");
	assert.ok(verifyPassword("x", cfg.getAuth().passwordHash) instanceof Promise);
	assert.ok(cfg.checkPassword("x") instanceof Promise);
});

test("password is stored as a scrypt hash, verified, and never in the public view", async () => {
	const file = tmpFile();
	const cfg = createLanConfig(file);
	cfg.setPassword("hunter2!");
	assert.equal(cfg.publicView().hasPassword, true);
	assert.equal(JSON.stringify(cfg.publicView()).includes("scrypt"), false);
	assert.deepEqual(Object.keys(cfg.publicView()).sort(), ["enabled", "hasPassword", "port"]);
	const raw = fs.readFileSync(file, "utf8");
	assert.equal(raw.includes("hunter2!"), false);
	const { passwordHash, sessionKey } = cfg.getAuth();
	assert.match(passwordHash, /^scrypt\$/);
	assert.ok(sessionKey.length >= 32);
	assert.equal(await verifyPassword("hunter2!", passwordHash), true);
	assert.equal(await verifyPassword("hunter3!", passwordHash), false);
	assert.equal(await verifyPassword("hunter2!", "garbage"), false);
	assert.equal(await cfg.checkPassword("hunter2!"), true);
	assert.equal(await cfg.checkPassword("nope"), false);
	assert.equal(await createLanConfig(file).checkPassword("hunter2!"), true);
});

test("the same password hashes differently each time (random salt)", () => {
	const a = createLanConfig(tmpFile());
	a.setPassword("same");
	const first = a.getAuth().passwordHash;
	a.setPassword("same");
	assert.notEqual(a.getAuth().passwordHash, first);
});

test("setting, changing and removing the password rotates the session key", () => {
	const cfg = createLanConfig(tmpFile());
	cfg.setPassword("one");
	const k1 = Buffer.from(cfg.getAuth().sessionKey).toString("hex");
	cfg.setPassword("two");
	const k2 = Buffer.from(cfg.getAuth().sessionKey).toString("hex");
	assert.notEqual(k1, k2);
	cfg.setPassword(null);
	assert.equal(cfg.publicView().hasPassword, false);
	assert.equal(cfg.getAuth(), null);
	cfg.setPassword("three");
	assert.notEqual(Buffer.from(cfg.getAuth().sessionKey).toString("hex"), k2);
});

test("changing port or enabled does not rotate the session key", () => {
	const cfg = createLanConfig(tmpFile());
	cfg.setPassword("one");
	const k1 = Buffer.from(cfg.getAuth().sessionKey).toString("hex");
	cfg.setEnabled(true);
	cfg.setPort(6000);
	assert.equal(Buffer.from(cfg.getAuth().sessionKey).toString("hex"), k1);
});

test("an empty password is rejected", () => {
	assert.throws(() => createLanConfig(tmpFile()).setPassword(""), /password/i);
});
