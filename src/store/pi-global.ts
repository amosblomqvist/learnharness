/**
 * The PiGlobalStore adapter: a read-only, live view of a Pi config
 * directory — auth.json's credentials and models.json's custom providers.
 *
 * The app NEVER writes these files (Pi owns them, including OAuth token
 * refresh). Each access stats the file and re-parses only when its
 * mtime/size changed, and an unchanged file returns the SAME object
 * (consumers diff by identity). Absent or corrupt files read as empty.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PiGlobalCredential, PiGlobalProviderConfig, PiGlobalSetup, PiGlobalStore } from "../core/ports.ts";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One mtime-cached JSON file projection. */
function cachedJson<T>(project: (raw: unknown) => T, empty: T): (file: string) => { value: T; found: boolean } {
	const cache = new Map<string, { stamp: string; value: T }>();
	return (file) => {
		let stamp: string;
		try {
			const st = fs.statSync(file);
			stamp = `${st.mtimeMs}:${st.size}`;
		} catch {
			return { value: empty, found: false };
		}
		const hit = cache.get(file);
		if (hit?.stamp === stamp) return { value: hit.value, found: true };
		let value: T;
		try {
			value = project(JSON.parse(fs.readFileSync(file, "utf-8")));
		} catch {
			value = empty; // corrupt — same as absent
		}
		cache.set(file, { stamp, value });
		return { value, found: true };
	};
}

const NO_CREDENTIALS: Readonly<Record<string, PiGlobalCredential>> = Object.freeze({});
const NO_PROVIDERS: readonly PiGlobalProviderConfig[] = Object.freeze([]);

const readCredentials = cachedJson((raw) => {
	const out: Record<string, PiGlobalCredential> = {};
	if (!isObject(raw)) return NO_CREDENTIALS;
	for (const [provider, cred] of Object.entries(raw)) {
		if (!isObject(cred)) continue;
		if (cred.type === "api_key") {
			out[provider] = cred as PiGlobalCredential;
		} else if (cred.type === "oauth" && typeof cred.access === "string" && typeof cred.expires === "number") {
			out[provider] = cred as PiGlobalCredential;
		}
	}
	return Object.freeze(out);
}, NO_CREDENTIALS);

const readProviders = cachedJson((raw) => {
	if (!isObject(raw) || !isObject(raw.providers)) return NO_PROVIDERS;
	return Object.freeze(
		Object.entries(raw.providers)
			.filter(([, p]) => isObject(p))
			.map(([id, p]) => ({ ...(p as object), id }) as PiGlobalProviderConfig),
	);
}, NO_PROVIDERS);

/** Pi's home (~/.pi) holds its config under agent/; an agent dir (what
 *  PI_CODING_AGENT_DIR names) is used as-is. A leading ~ expands. */
function agentDir(dir: string): string {
	const expanded = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
	const nested = path.join(expanded, "agent");
	try {
		if (fs.statSync(nested).isDirectory()) return nested;
	} catch {
		/* not Pi's home — the agent dir itself */
	}
	return expanded;
}

export const piGlobalStore: PiGlobalStore = {
	read(dir: string): PiGlobalSetup {
		const resolved = agentDir(dir);
		const auth = readCredentials(path.join(resolved, "auth.json"));
		const models = readProviders(path.join(resolved, "models.json"));
		return {
			dir: resolved,
			found: auth.found || models.found,
			credentials: auth.value,
			providers: models.value,
		};
	},
};
