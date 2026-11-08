import { LOCAL_DICTATION_AUTH, normalizeDictationUrl } from "../core/local-dictation.ts";
/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). Ordinary reads never throw (absent/corrupt file = {} =
 * "no keys yet"); custom-only pair reads/writes below are deliberately
 * strict so an unreadable private record is never overwritten as {}.
 * Ordinary writes preserve unknown string vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CUSTOM_AUTH_BINDING, parseCustomAuthBinding, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  atomic-write.ts sets the mode on the temp file before the rename, so
 *  the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
	writeFileAtomicSync(AUTH_FILE, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};

/** Custom writes must never turn an unreadable/corrupt private file into {}.
 * Other providers retain their existing adapter semantics. Unknown JSON values
 * survive custom-only updates, not just the ordinary string projection. */
function readCustomMap(): Record<string, unknown> {
	let text: string;
	try { text = fs.readFileSync(AUTH_FILE, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Custom authorization storage unavailable"); }
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { throw new Error("Custom authorization storage unavailable"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Custom authorization storage unavailable");
	const map = raw as Record<string, unknown>;
	if (Object.hasOwn(map, CUSTOM_AUTH_BINDING) && !parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING])) throw new Error("Invalid custom authorization record");
	if (Object.hasOwn(map, CUSTOM_PROVIDER.envVar) && typeof map[CUSTOM_PROVIDER.envVar] !== "string") throw new Error("Invalid custom credential record");
	return map;
}
function assertOrdinaryVar(name: string): void {
	if (name === LOCAL_DICTATION_AUTH || name === CUSTOM_AUTH_BINDING || name === CUSTOM_PROVIDER.envVar) throw new Error("Use the custom endpoint editor");
}
/** One immutable file snapshot. Keyless callers never invoke fileKey(). */
export function readCustomAuth() {
	const map = readCustomMap();
	return { binding: parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING]), fileKey: () => map[CUSTOM_PROVIDER.envVar] as string | undefined };
}
/** Replace just the custom pair in ONE existing atomic record write. */
export function writeCustomAuth(binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	const map = readCustomMap();
	if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
	if (fileKey === undefined) delete map[CUSTOM_PROVIDER.envVar];
	else Object.defineProperty(map, CUSTOM_PROVIDER.envVar, { value: fileKey, enumerable: true, configurable: true, writable: true });
	if (binding === undefined) delete map[CUSTOM_AUTH_BINDING];
	else Object.defineProperty(map, CUSTOM_AUTH_BINDING, { value: JSON.stringify(binding), enumerable: true, configurable: true, writable: true });
	writeMap(map);
}

/** Private key and its authorized destination are published in one atomic write. */
export function readDictationAuth(): { url: string; key: string } | undefined {
	const raw = readCustomMap()[LOCAL_DICTATION_AUTH];
	if (raw === undefined) return;
	const value = typeof raw === "string" ? JSON.parse(raw) : undefined;
	if (!value || !normalizeDictationUrl(value.url) || typeof value.key !== "string") throw new Error("Invalid local dictation credential record");
	return { url: normalizeDictationUrl(value.url), key: value.key };
}
export function writeDictationAuth(url: string, key: string): void {
	const map = readCustomMap();
	if (key) map[LOCAL_DICTATION_AUTH] = JSON.stringify({ url, key });
	else delete map[LOCAL_DICTATION_AUTH];
	writeMap(map);
}
