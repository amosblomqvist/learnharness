/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19; encrypted at rest by
 * the auth-encryption change): the flat {VAR: value} BYOK key map.
 *
 * AT REST. Values live in config.AUTH_ENC_FILE (auth.enc.json, next to
 * config.AUTH_FILE — same directory and basename + ".enc.json"):
 *   { "version": 1, "alg": "aes-256-gcm", "entries": { VAR: {iv, tag, ct} } }
 * each value AES-256-GCM with a fresh random 12-byte IV and the VAR name as
 * AAD (entries cannot be swapped between names). A non-string value (a
 * future entry this version does not understand) is encrypted as its JSON
 * text and flagged `json: true`, so it survives rewrites verbatim. Written
 * atomically at mode 0600 (atomic-write.ts).
 *
 * THE MASTER KEY is a random 32-byte key in the OS credential store via
 * @napi-rs/keyring (service "LearnHarness", account "auth-master-key",
 * base64): Windows Credential Manager, macOS Keychain, Linux Secret Service.
 * Created on the first write, cached in memory for the process. Env
 * LH_AUTH_MASTER_KEY (base64, 32 bytes) overrides it and the keyring is then
 * never touched — tests, CI, headless Linux. NO SILENT PLAINTEXT FALLBACK:
 * with no key source writes throw a readable error (the keys API turns it
 * into a 500) and reads return {} with one logged warning. Under
 * NODE_ENV=test the native keyring is never loaded (a suite must not touch
 * the developer's real credential store): the default backend is a
 * process-local in-memory one, and tests inject their own through
 * authStoreTesting. A test that shares a store across processes sets
 * LH_AUTH_MASTER_KEY.
 *
 * LOCKED STATE. If the encrypted file exists but cannot be decrypted (key
 * missing from the keyring, wrong key, tampered or corrupt file) the store
 * reads as empty and warns; it REFUSES writes rather than clobber entries it
 * cannot read. The fix is the user's: delete auth.enc.json and re-enter keys.
 *
 * THE INBOX. config.AUTH_FILE (plaintext auth.json) is no longer storage —
 * it is the hand-edit / legacy-migration inbox. On every store access, if it
 * exists, its entries are imported (plaintext wins over an existing
 * encrypted entry: a hand-edit is newer intent), then the file is overwritten
 * with random bytes, fsynced and unlinked. With no usable key source the
 * plaintext file is left untouched (never delete keys we could not re-store).
 * Threat model: this defends against file exfiltration (backups, sync, copied
 * data dirs, accidental commits), NOT malware running as the same OS user.
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). Ordinary reads never throw (a store that cannot be read is
 * {} = "no keys yet" plus the one warning); custom-only pair reads/writes
 * below are deliberately strict so an unreadable private record is never
 * overwritten as {}. Writes preserve unknown vars verbatim (forward-compat:
 * future entries — e.g. a plans-login token — ride along untouched until a
 * catalog entry adopts them).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AUTH_ENC_FILE, AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CUSTOM_AUTH_BINDING, parseCustomAuthBinding, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEYRING_SERVICE = "LearnHarness";
const KEYRING_ACCOUNT = "auth-master-key";
/** Negative keyring results (store missing/locked/unavailable) are retried
 *  at most this often — a headless box must not hit D-Bus on every read. */
const NEGATIVE_TTL_MS = 15_000;

interface EncEntry {
	iv: string;
	tag: string;
	ct: string;
	/** The plaintext is JSON text of a non-string value. */
	json?: true;
}
interface EncFile {
	version: 1;
	alg: typeof ALG;
	entries: Record<string, EncEntry>;
}

// ─── logging ────────────────────────────────────────────────────────────────

const warned = new Set<string>();
/** One warning per distinct message per process (reads are frequent). */
function warnOnce(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(`[auth-store] ${message}`);
}

// ─── master key ─────────────────────────────────────────────────────────────

/** The slice of @napi-rs/keyring's Entry this store uses. */
export interface KeyringBackend {
	get(): string | null;
	set(value: string): void;
}

/** The real backend: lazy, synchronous load so a missing/broken native
 *  binding degrades to "no key source" instead of failing the module. Linux
 *  is pinned to Secret Service: the library's default falls back to the
 *  kernel keyutils store, which does not survive a reboot — the key would
 *  vanish and strand the encrypted file. */
function nativeKeyring(): KeyringBackend {
	if (process.env.NODE_ENV === "test") return testKeyring;
	const req = createRequire(import.meta.url);
	const { Entry } = req("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
	// LH_AUTH_KEYRING_ACCOUNT exists for the manual keyring smoke test only.
	const account = process.env.LH_AUTH_KEYRING_ACCOUNT || KEYRING_ACCOUNT;
	const entry = new Entry(KEYRING_SERVICE, account, { linux: { store: "secret-service" } });
	return { get: () => entry.getPassword(), set: (v) => entry.setPassword(v) };
}

/** NODE_ENV=test stand-in for the OS credential store: lives and dies with
 *  the process, so no suite can read or write the developer's real entry. */
let testSecret: string | null = null;
const testKeyring: KeyringBackend = { get: () => testSecret, set: (v) => void (testSecret = v) };

let makeKeyring: () => KeyringBackend = nativeKeyring;
/** The keyring-sourced key, cached for the process (env override is parsed
 *  live, never cached). */
let cachedKey: Buffer | null = null;
let negative: { at: number; result: KeyFailure } | null = null;

type KeyFailure = { ok: false; reason: "missing" } | { ok: false; reason: "unavailable"; message: string };
type KeyResult = { ok: true; key: Buffer } | KeyFailure;

function decodeKey(b64: string): Buffer | null {
	const key = Buffer.from(b64.trim(), "base64");
	return key.length === KEY_BYTES ? key : null;
}

/** Find the master key. `create` generates + stores one when the keyring is
 *  reachable but empty — only legal when no encrypted data exists (a fresh
 *  key could never decrypt an existing file). */
function resolveKey(create: boolean): KeyResult {
	const override = process.env.LH_AUTH_MASTER_KEY;
	if (override) {
		const key = decodeKey(override);
		return key
			? { ok: true, key }
			: { ok: false, reason: "unavailable", message: "LH_AUTH_MASTER_KEY must be base64 of exactly 32 bytes" };
	}
	if (cachedKey) return { ok: true, key: cachedKey };
	if (negative && Date.now() - negative.at < NEGATIVE_TTL_MS) {
		if (negative.result.reason === "unavailable" || !create) return negative.result;
	}
	try {
		const keyring = makeKeyring();
		const stored = keyring.get();
		if (stored) {
			const key = decodeKey(stored);
			if (!key) {
				throw new Error(
					`the OS credential store entry ${KEYRING_SERVICE}/${KEYRING_ACCOUNT} is not a base64 32-byte key (remove it to start over)`,
				);
			}
			cachedKey = key;
			negative = null;
			return { ok: true, key };
		}
		if (!create) {
			negative = { at: Date.now(), result: { ok: false, reason: "missing" } };
			return negative.result;
		}
		const fresh = crypto.randomBytes(KEY_BYTES);
		const b64 = fresh.toString("base64");
		keyring.set(b64);
		if (keyring.get() !== b64) throw new Error("the OS credential store did not persist the new key");
		cachedKey = fresh;
		negative = null;
		return { ok: true, key: fresh };
	} catch (err) {
		const message = `OS credential store unavailable (${err instanceof Error ? err.message : String(err)})`;
		negative = { at: Date.now(), result: { ok: false, reason: "unavailable", message } };
		return negative.result;
	}
}

// ─── AES-256-GCM ────────────────────────────────────────────────────────────

function encryptValue(key: Buffer, name: string, value: unknown): EncEntry {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const iv = crypto.randomBytes(IV_BYTES);
	const cipher = crypto.createCipheriv(ALG, key, iv);
	cipher.setAAD(Buffer.from(name, "utf8"));
	const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	const entry: EncEntry = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
	if (typeof value !== "string") entry.json = true;
	return entry;
}

/** Throws on any authentication/shape failure. */
function decryptValue(key: Buffer, name: string, entry: EncEntry): unknown {
	if (!entry || typeof entry.iv !== "string" || typeof entry.tag !== "string" || typeof entry.ct !== "string") {
		throw new Error("malformed entry");
	}
	const iv = Buffer.from(entry.iv, "base64");
	const tag = Buffer.from(entry.tag, "base64");
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("malformed entry");
	const decipher = crypto.createDecipheriv(ALG, key, iv);
	decipher.setAAD(Buffer.from(name, "utf8"));
	decipher.setAuthTag(tag);
	const text = Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
	return entry.json === true ? JSON.parse(text) : text;
}

// ─── the encrypted file ─────────────────────────────────────────────────────

type EncRead = { kind: "absent" } | { kind: "bad"; why: string } | { kind: "ok"; file: EncFile };

function readEnc(): EncRead {
	let text: string;
	try {
		text = fs.readFileSync(AUTH_ENC_FILE, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "bad", why: `cannot be read (${(err as Error).message})` };
	}
	try {
		const raw = JSON.parse(text) as Partial<EncFile> | null;
		if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.alg !== ALG) {
			return { kind: "bad", why: "has an unsupported version/algorithm" };
		}
		if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
			return { kind: "bad", why: "has no entries map" };
		}
		return { kind: "ok", file: raw as EncFile };
	} catch {
		return { kind: "bad", why: "is not valid JSON" };
	}
}

/** Atomic, 0600 write (atomic-write.ts: fsynced temp beside the target, mode
 *  set before the rename, so a relaxed mode never exists on the final path
 *  and a partial write never looks like "no keys"). */
function writeEnc(key: Buffer, map: Record<string, unknown>): void {
	const entries: Record<string, EncEntry> = {};
	for (const [name, value] of Object.entries(map)) entries[name] = encryptValue(key, name, value);
	const file: EncFile = { version: 1, alg: ALG, entries };
	fs.mkdirSync(path.dirname(AUTH_ENC_FILE), { recursive: true });
	writeFileAtomicSync(AUTH_ENC_FILE, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

/** Own, enumerable data property — a "__proto__" var stays data. */
function put(map: Record<string, unknown>, name: string, value: unknown): void {
	Object.defineProperty(map, name, { value, enumerable: true, configurable: true, writable: true });
}

// ─── opening the store ──────────────────────────────────────────────────────

type Opened =
	| { ok: true; key: Buffer | null; map: Record<string, unknown> }
	| { ok: false; kind: "locked" | "unavailable"; message: string };

const locked = (why: string): Opened => ({
	ok: false,
	kind: "locked",
	message:
		`Stored API keys in ${AUTH_ENC_FILE} cannot be decrypted: ${why}. ` +
		`They will not be overwritten. To reset, delete auth.enc.json and re-enter your keys.`,
});
const unavailable = (message: string): Opened => ({
	ok: false,
	kind: "unavailable",
	message:
		`Cannot store API keys securely: ${message}. Set LH_AUTH_MASTER_KEY (base64, 32 bytes) ` +
		`or fix the OS credential store; keys are never written in plaintext.`,
});

/** Load the decrypted map. `write` = the caller intends to persist, so a
 *  missing key may be generated — but ONLY when there is no encrypted data
 *  (a read, or a write over live entries, never mints a replacement key).
 *  `key` is null only for a read that needed no key (nothing stored). */
function open(write: boolean): Opened {
	const enc = readEnc();
	if (enc.kind === "bad") return locked(`the file ${enc.why}`);
	const stored = enc.kind === "ok" ? enc.file.entries : {};
	const names = Object.keys(stored);
	if (names.length === 0) {
		if (!write) return { ok: true, key: null, map: {} };
		const k = resolveKey(true);
		return k.ok ? { ok: true, key: k.key, map: {} } : unavailable(k.reason === "unavailable" ? k.message : "no key");
	}
	const k = resolveKey(false);
	if (!k.ok) {
		return k.reason === "missing" ? locked("its master key is missing from the OS credential store") : unavailable(k.message);
	}
	const map: Record<string, unknown> = {};
	for (const name of names) {
		try {
			put(map, name, decryptValue(k.key, name, stored[name] as EncEntry));
		} catch {
			return locked("the master key does not match (or an entry was altered)");
		}
	}
	return { ok: true, key: k.key, map };
}

// ─── the plaintext inbox ────────────────────────────────────────────────────

/** Overwrite with random bytes of the same length, fsync, unlink.
 *  Best-effort by nature on SSD/journaling/CoW filesystems. A symlink is
 *  only unlinked: its referent is not ours to rewrite. */
function secureRemove(file: string): void {
	try {
		if (fs.lstatSync(file).isSymbolicLink()) {
			warnOnce(`${file} is a symlink: the link was removed, its target keeps the plaintext copy`);
		} else {
			const size = fs.statSync(file).size;
			if (size > 0) {
				const fd = fs.openSync(file, "r+");
				try {
					fs.writeSync(fd, crypto.randomBytes(size), 0, size, 0);
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
			}
		}
	} catch (err) {
		warnOnce(`could not overwrite ${file} before removal (${(err as Error).message}); removing it anyway`);
	}
	try {
		fs.unlinkSync(file);
	} catch (err) {
		warnOnce(`could not remove ${file} (${(err as Error).message}) — delete it by hand`);
	}
}

/** Absorb a plaintext auth.json (hand-edit or legacy) into the encrypted
 *  store, then wipe it. Never removes a file whose keys were not safely
 *  re-stored; never throws. */
function absorbInbox(): void {
	let text: string;
	try {
		text = fs.readFileSync(AUTH_FILE, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			warnOnce(`cannot read plaintext inbox ${AUTH_FILE} (${(err as Error).message})`);
		}
		return;
	}
	const incoming: [string, unknown][] = [];
	if (text.trim() !== "") {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			warnOnce(`plaintext inbox ${AUTH_FILE} is not valid JSON — left untouched`);
			return;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warnOnce(`plaintext inbox ${AUTH_FILE} is not a {VAR: value} object — left untouched`);
			return;
		}
		incoming.push(...Object.entries(raw));
	}
	if (incoming.length > 0) {
		const o = open(true);
		if (!o.ok) {
			warnOnce(`${incoming.length} key(s) in plaintext ${AUTH_FILE} were NOT encrypted and the file was left untouched: ${o.message}`);
			return;
		}
		for (const [name, value] of incoming) put(o.map, name, value); // plaintext = newer intent
		try {
			writeEnc(o.key!, o.map);
		} catch (err) {
			warnOnce(`could not write ${AUTH_ENC_FILE} (${(err as Error).message}); plaintext ${AUTH_FILE} left untouched`);
			return;
		}
	}
	secureRemove(AUTH_FILE);
	console.info(
		`[auth-store] absorbed ${incoming.length} key(s) from plaintext ${path.basename(AUTH_FILE)} (${incoming.map(([n]) => n).join(", ") || "none"}) into ${path.basename(AUTH_ENC_FILE)}; plaintext removed`,
	);
}

// ─── the port ───────────────────────────────────────────────────────────────

/** Run one read-modify-write; throws a readable error when the store is
 *  locked or has no key source. */
function mutate(fn: (map: Record<string, unknown>) => void): void {
	absorbInbox();
	const o = open(true);
	if (!o.ok) throw new Error(o.message);
	fn(o.map);
	writeEnc(o.key!, o.map);
}

export const authStore: AuthStore = {
	authVars() {
		absorbInbox();
		const o = open(false);
		if (!o.ok) {
			warnOnce(o.message);
			return {};
		}
		return Object.fromEntries(Object.entries(o.map).filter(([, v]) => typeof v === "string")) as Record<string, string>;
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		mutate((map) => put(map, name, value));
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		absorbInbox();
		const o = open(false);
		if (o.ok && !Object.hasOwn(o.map, name)) return; // absent = silent success, idempotent
		mutate((map) => {
			delete map[name];
		});
	},
};

/** Custom writes must never turn an unreadable/locked private store into {}.
 * Other providers retain their existing adapter semantics. Unknown JSON values
 * survive custom-only updates, not just the ordinary string projection. */
function openCustom(write: boolean): { key: Buffer | null; map: Record<string, unknown> } {
	absorbInbox();
	const o = open(write);
	if (!o.ok) throw new Error("Custom authorization storage unavailable");
	const map = o.map;
	if (Object.hasOwn(map, CUSTOM_AUTH_BINDING) && !parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING])) throw new Error("Invalid custom authorization record");
	if (Object.hasOwn(map, CUSTOM_PROVIDER.envVar) && typeof map[CUSTOM_PROVIDER.envVar] !== "string") throw new Error("Invalid custom credential record");
	return o;
}
function assertOrdinaryVar(name: string): void {
	if (name === CUSTOM_AUTH_BINDING || name === CUSTOM_PROVIDER.envVar) throw new Error("Use the custom endpoint editor");
}
/** One immutable store snapshot. Keyless callers never invoke fileKey(). */
export function readCustomAuth() {
	const { map } = openCustom(false);
	return { binding: parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING]), fileKey: () => map[CUSTOM_PROVIDER.envVar] as string | undefined };
}
/** Replace just the custom pair in ONE existing atomic record write. */
export function writeCustomAuth(binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	const { key, map } = openCustom(true);
	if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
	if (fileKey === undefined) delete map[CUSTOM_PROVIDER.envVar];
	else put(map, CUSTOM_PROVIDER.envVar, fileKey);
	if (binding === undefined) delete map[CUSTOM_AUTH_BINDING];
	else put(map, CUSTOM_AUTH_BINDING, JSON.stringify(binding));
	writeEnc(key!, map);
}

/** Test seam — NOT for app code. Swap the keyring backend (or restore the
 *  native one with undefined) and clear the per-process key/warning caches,
 *  so the suite never touches the real OS credential store. */
export const authStoreTesting = {
	reset(backend?: () => KeyringBackend): void {
		makeKeyring = backend ?? nativeKeyring;
		testSecret = null;
		cachedKey = null;
		negative = null;
		warned.clear();
	},
};
