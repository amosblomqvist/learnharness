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
import {
	CUSTOM_AUTH_BINDING,
	customBindingAuthKey,
	customCredentialAuthKey,
	isReservedCustomAuthKey,
	parseCustomAuthBinding,
	type CustomAuthBinding,
} from "../core/custom-provider-auth.ts";

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
 *  tmp-in-same-dir + rename keeps the swap atomic; chmod BEFORE the
 *  rename so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
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
	for (const [name, value] of Object.entries(map)) {
		if (name.startsWith(CUSTOM_AUTH_BINDING)) {
			if (!parseCustomAuthBinding(value)) throw new Error("Invalid custom authorization record");
		} else if (isReservedCustomAuthKey(name) && typeof value !== "string") {
			throw new Error("Invalid custom credential record");
		}
	}
	return map;
}
function assertOrdinaryVar(name: string): void {
	if (isReservedCustomAuthKey(name)) throw new Error("Use the custom endpoint editor");
}
/** One provider's immutable file snapshot. Keyless callers never invoke
 *  fileKey(). The id defaults to the legacy endpoint. */
export function readCustomAuth(id: string = CUSTOM_PROVIDER.id) {
	const map = readCustomMap();
	return { binding: parseCustomAuthBinding(map[customBindingAuthKey(id)]), fileKey: () => map[customCredentialAuthKey(id)] as string | undefined };
}
/** Replace just one provider's custom pair in ONE atomic record write. */
export function writeCustomAuth(id: string = CUSTOM_PROVIDER.id, binding?: CustomAuthBinding, fileKey?: string): void {
	const map = readCustomMap();
	const bindingKey = customBindingAuthKey(id);
	const credentialKey = customCredentialAuthKey(id);
	if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
	if (fileKey === undefined) delete map[credentialKey];
	else Object.defineProperty(map, credentialKey, { value: fileKey, enumerable: true, configurable: true, writable: true });
	if (binding === undefined) delete map[bindingKey];
	else Object.defineProperty(map, bindingKey, { value: JSON.stringify(binding), enumerable: true, configurable: true, writable: true });
	writeMap(map);
}
