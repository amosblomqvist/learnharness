"use strict";
/**
 * LAN access config: persistence, password hashing and session-key rotation.
 * Node builtins only; no Electron import, so it is testable under tsx.
 *
 * API (used by electron/main.cjs and the IPC handlers):
 *   const cfg = createLanConfig(path.join(app.getPath("userData"), "lan.json"));
 *   cfg.publicView()          -> { enabled, port, hasPassword }   (safe for the UI; never holds the hash)
 *   cfg.setEnabled(boolean)
 *   cfg.setPort(n)            -> throws RangeError unless an integer in 1024..65535
 *   cfg.setPassword(str|null) -> str sets/changes, null removes; always rotates the session key
 *   cfg.checkPassword(str)    -> Promise<boolean>
 *   cfg.getAuth()             -> { passwordHash, sessionKey: Buffer } | null (null = no password);
 *                                pass it straight to createLanGateway({ getAuth })
 * Also exported: hashPassword(pw), async verifyPassword(pw, hash), DEFAULT_PORT.
 *
 * lan.json: { enabled, port, passwordHash?, sessionKey } written atomically with mode 0600.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const DEFAULT_PORT = 4747;
const KEY_LEN = 64;

function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(password, salt, KEY_LEN);
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const scryptAsync = promisify(crypto.scrypt);

async function verifyPassword(password, stored) {
	const [scheme, saltB64, hashB64] = String(stored).split("$");
	if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
	const expected = Buffer.from(hashB64, "base64");
	if (expected.length !== KEY_LEN) return false;
	const actual = await scryptAsync(String(password), Buffer.from(saltB64, "base64"), KEY_LEN);
	return crypto.timingSafeEqual(actual, expected);
}

function checkPort(port) {
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError("port must be an integer from 1024 to 65535");
	return port;
}

function createLanConfig(file) {
	const state = load();

	function load() {
		let raw = {};
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		return {
			enabled: raw.enabled === true,
			port: Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : DEFAULT_PORT,
			passwordHash: typeof raw.passwordHash === "string" ? raw.passwordHash : undefined,
			sessionKey: typeof raw.sessionKey === "string" && raw.sessionKey ? raw.sessionKey : crypto.randomBytes(32).toString("base64"),
		};
	}

	function save() {
		const tmp = `${file}.${process.pid}.tmp`;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	return {
		publicView: () => ({ enabled: state.enabled, port: state.port, hasPassword: Boolean(state.passwordHash) }),
		setEnabled(enabled) {
			state.enabled = enabled === true;
			save();
		},
		setPort(port) {
			state.port = checkPort(port);
			save();
		},
		setPassword(password) {
			if (password === null) state.passwordHash = undefined;
			else {
				if (typeof password !== "string" || !password) throw new TypeError("password must be a non-empty string, or null to remove it");
				state.passwordHash = hashPassword(password);
			}
			state.sessionKey = crypto.randomBytes(32).toString("base64");
			save();
		},
		checkPassword: async (password) => Boolean(state.passwordHash) && (await verifyPassword(password, state.passwordHash)),
		getAuth: () => (state.passwordHash ? { passwordHash: state.passwordHash, sessionKey: Buffer.from(state.sessionKey, "base64") } : null),
	};
}

module.exports = { createLanConfig, hashPassword, verifyPassword, DEFAULT_PORT };
