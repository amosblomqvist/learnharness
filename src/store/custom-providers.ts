/**
 * Metadata-only persistence for custom providers: PATHS.data/custom-providers.json
 * `{ version: 1, providers: CustomProviderDefinition[] }`. Secrets never live
 * here (they belong to the provider credential store).
 *
 * Exports:
 *  - createCustomProviderStore(file): CustomProviderStore  (tests inject a temp file)
 *  - CustomProviderStoreError
 *  - readCustomProviders(): CustomProviderDefinition[]      tolerant: [] when the
 *      file is missing, corrupt, a symlink, or an entry is invalid (invalid
 *      entries are skipped). Safe for runtime assembly.
 *  - readCustomProvidersStrict(): same, but throws CustomProviderStoreError.
 *  - saveCustomProvider(def): CustomProviderDefinition      upsert by id
 *  - removeCustomProvider(id): boolean                      true if it existed
 *
 * Writes are strict: a symlink, non-regular file, unreadable or corrupt file
 * (or any invalid entry) makes the write throw and leaves the file untouched,
 * so unrecognized user content is never overwritten. Writes are atomic
 * (exclusive temp file + rename), directory 0700, file 0600.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../config.ts";
import type { CustomProviderDefinition } from "../core/provider-connections.ts";
import { validateCustomProviderDefinition } from "../core/custom-provider-validation.ts";

export class CustomProviderStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomProviderStoreError";
	}
}

export interface CustomProviderStore {
	readonly file: string;
	read(): CustomProviderDefinition[];
	readTolerant(): CustomProviderDefinition[];
	save(def: CustomProviderDefinition): CustomProviderDefinition;
	remove(id: string): boolean;
}

export const CUSTOM_PROVIDERS_FILENAME = "custom-providers.json";

export function createCustomProviderStore(file: string): CustomProviderStore {
	function load(): CustomProviderDefinition[] | null {
		let st: fs.Stats;
		try {
			st = fs.lstatSync(file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new CustomProviderStoreError("custom provider file is not accessible");
		}
		if (st.isSymbolicLink()) throw new CustomProviderStoreError("custom provider file is a symlink; refusing to use it");
		if (!st.isFile()) throw new CustomProviderStoreError("custom provider file is not a regular file");
		if (st.size > 4 * 1024 * 1024) throw new CustomProviderStoreError("custom provider file is too large");
		let parsed: unknown;
		try {
			const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				parsed = JSON.parse(fs.readFileSync(fd, "utf-8"));
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			throw new CustomProviderStoreError("custom provider file is unreadable or corrupt");
		}
		const rec = parsed as { version?: unknown; providers?: unknown } | null;
		if (!rec || typeof rec !== "object" || rec.version !== 1 || !Array.isArray(rec.providers)) {
			throw new CustomProviderStoreError("custom provider file has an unrecognized format");
		}
		const out: CustomProviderDefinition[] = [];
		const seen = new Set<string>();
		for (const p of rec.providers) {
			const v = validateCustomProviderDefinition(p);
			if (!v.ok) throw new CustomProviderStoreError("custom provider file contains an invalid entry");
			if (seen.has(v.value.id)) throw new CustomProviderStoreError("custom provider file contains a duplicate id");
			seen.add(v.value.id);
			out.push(v.value);
		}
		return out;
	}

	function loadTolerant(): CustomProviderDefinition[] {
		try {
			return load() ?? [];
		} catch (e) {
			if (!(e instanceof CustomProviderStoreError)) throw e;
		}
		// Salvage valid entries only when the file itself is a readable regular file.
		try {
			const st = fs.lstatSync(file);
			if (!st.isFile() || st.size > 4 * 1024 * 1024) return [];
			const rec = JSON.parse(fs.readFileSync(file, "utf-8")) as { providers?: unknown };
			if (!Array.isArray(rec?.providers)) return [];
			const out: CustomProviderDefinition[] = [];
			const seen = new Set<string>();
			for (const p of rec.providers) {
				const v = validateCustomProviderDefinition(p);
				if (v.ok && !seen.has(v.value.id)) {
					seen.add(v.value.id);
					out.push(v.value);
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	function write(providers: CustomProviderDefinition[]): void {
		const dir = path.dirname(file);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
		const body = JSON.stringify({ version: 1, providers }, null, "\t") + "\n";
		let fd: number | null = null;
		try {
			fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			fs.writeSync(fd, body);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = null;
			fs.renameSync(tmp, file);
		} catch {
			if (fd !== null) fs.closeSync(fd);
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* already gone */
			}
			throw new CustomProviderStoreError("custom provider file could not be written");
		}
	}

	return {
		file,
		read: () => load() ?? [],
		readTolerant: loadTolerant,
		save(def) {
			const v = validateCustomProviderDefinition(def);
			if (!v.ok) throw new CustomProviderStoreError(`invalid provider: ${v.error}`);
			const all = load() ?? [];
			const i = all.findIndex((p) => p.id === v.value.id);
			if (i >= 0) all[i] = v.value;
			else all.push(v.value);
			write(all);
			return v.value;
		},
		remove(id) {
			const all = load();
			if (!all) return false;
			const next = all.filter((p) => p.id !== id);
			if (next.length === all.length) return false;
			write(next);
			return true;
		},
	};
}

let defaultStore: CustomProviderStore | null = null;
/** The production store, bound lazily so PATHS.data is read at first use. */
export function customProviderStore(): CustomProviderStore {
	return (defaultStore ??= createCustomProviderStore(path.join(PATHS.data, CUSTOM_PROVIDERS_FILENAME)));
}

export function readCustomProviders(): CustomProviderDefinition[] {
	return customProviderStore().readTolerant();
}
export function readCustomProvidersStrict(): CustomProviderDefinition[] {
	return customProviderStore().read();
}
export function saveCustomProvider(def: CustomProviderDefinition): CustomProviderDefinition {
	return customProviderStore().save(def);
}
export function removeCustomProvider(id: string): boolean {
	return customProviderStore().remove(id);
}
