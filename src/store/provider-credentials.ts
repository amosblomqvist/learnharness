/**
 * App-owned provider credential store for Codex subscription login. Implements the SDK's CredentialStore plus two synchronous
 * views (`has`, `peek`) for code that cannot await.
 *
 * Storage: one JSON file {version:1, credentials:{[providerId]: Credential}}
 * inside a private directory (0700), written atomically at 0600
 * (tmp + fsync + rename). Symlinks are refused for the directory, the file
 * and the lock. Cross-process mutual exclusion is a lock directory created
 * with a bounded, abort-aware wait. A lock is reclaimed ONLY when its owner
 * record names this host and a pid that is positively dead; age alone never
 * reclaims a lock (refresh or slow IO may legitimately hold it for long), and
 * an unknown/unreadable owner fails closed into the bounded wait.
 *
 * Every change to the lock directory (create, reclaim, release) happens
 * while holding a short-lived acquisition guard, a file created with
 * open(O_EXCL) next to the store. That removes the check-then-rename race
 * between processes (a stale lock cannot be swapped for a live one between
 * the owner check and the rename). The guard is never reclaimed by age or
 * pid: if a process dies inside its few synchronous operations, the store
 * fails closed with lock_timeout until `<file>.guard` (and `<file>.lock`
 * if present) are removed by hand while no LearnHarness process is running.
 *
 * A corrupt or unreadable state file is NEVER silently replaced: reads
 * throw CredentialStoreError("corrupt") for async calls, sync views report
 * "absent", and writes refuse until the file is repaired by hand.
 *
 * Secrets never appear in error messages.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";

export type CredentialStoreErrorCode =
	| "invalid_id"
	| "invalid_credential"
	| "corrupt"
	| "unsafe_path"
	| "lock_timeout"
	| "io";

export class CredentialStoreError extends Error {
	readonly code: CredentialStoreErrorCode;
	constructor(code: CredentialStoreErrorCode, message: string) {
		super(message);
		this.name = "CredentialStoreError";
		this.code = code;
	}
}

export interface ProviderCredentialStoreOptions {
	/** Max time to wait for the cross-process lock. Default 10s. */
	lockTimeoutMs?: number;
	/** Poll interval while waiting for the lock. Default 25ms. */
	pollMs?: number;
}

export interface ProviderCredentialStore extends CredentialStore {
	/** Sync: is a credential stored for this id? Never throws. */
	has(providerId: string): boolean;
	/** Sync: a copy of the stored credential, or undefined. Never throws. */
	peek(providerId: string): Credential | undefined;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STRING = 64 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function isValidCredentialId(id: unknown): id is string {
	return typeof id === "string" && ID_RE.test(id);
}

function assertId(id: unknown): asserts id is string {
	if (!isValidCredentialId(id)) throw new CredentialStoreError("invalid_id", "Invalid provider id.");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function validString(v: unknown): v is string {
	return typeof v === "string" && v.length <= MAX_STRING;
}

/** Shape validation shared by reads (corrupt) and writes (invalid_credential). */
function isCredential(v: unknown): v is Credential {
	if (!isPlainObject(v)) return false;
	if (v.type === "oauth") {
		return (
			validString(v.refresh) &&
			validString(v.access) &&
			typeof v.expires === "number" &&
			Number.isFinite(v.expires)
		);
	}
	if (v.type === "api_key") {
		if (v.key !== undefined && !validString(v.key)) return false;
		if (v.env !== undefined) {
			if (!isPlainObject(v.env)) return false;
			for (const val of Object.values(v.env)) if (val !== undefined && !validString(val)) return false;
		}
		return true;
	}
	return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function ownerOk(st: fs.Stats): boolean {
	return typeof process.getuid !== "function" || st.uid === process.getuid();
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

type State = Map<string, Credential>;

class FileProviderCredentialStore implements ProviderCredentialStore {
	private readonly file: string;
	private readonly dir: string;
	private readonly lockDir: string;
	private readonly lockTimeoutMs: number;
	private readonly pollMs: number;

	constructor(filePath: string, opts: ProviderCredentialStoreOptions = {}) {
		this.file = path.resolve(filePath);
		this.dir = path.dirname(this.file);
		this.lockDir = `${this.file}.lock`;
		this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
		this.pollMs = opts.pollMs ?? 25;
	}

	// ---- path safety -------------------------------------------------

	/** Create (0700) and verify the private parent directory. */
	private ensureDir(): void {
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			const st = fs.lstatSync(this.dir);
			if (st.isSymbolicLink() || !st.isDirectory() || !ownerOk(st)) {
				throw new CredentialStoreError("unsafe_path", "Credential directory is not safe.");
			}
			if ((st.mode & 0o777) !== 0o700) fs.chmodSync(this.dir, 0o700);
		} catch (e) {
			if (e instanceof CredentialStoreError) throw e;
			throw new CredentialStoreError("io", "Credential directory is unavailable.");
		}
	}

	private dirIsSafeNoCreate(): boolean {
		try {
			const st = fs.lstatSync(this.dir);
			return st.isDirectory() && !st.isSymbolicLink() && ownerOk(st);
		} catch {
			return false;
		}
	}

	// ---- read ---------------------------------------------------------

	/** Returns undefined when the file is absent. Throws on corrupt/unsafe. */
	private readStateSync(): State | undefined {
		if (!this.dirIsSafeNoCreate()) {
			if (!fs.existsSync(this.dir)) return undefined;
			throw new CredentialStoreError("unsafe_path", "Credential directory is not safe.");
		}
		let fd: number;
		try {
			fd = fs.openSync(this.file, fs.constants.O_RDONLY | O_NOFOLLOW);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			if (code === "ELOOP") throw new CredentialStoreError("unsafe_path", "Credential file is not safe.");
			throw new CredentialStoreError("io", "Credential file is unreadable.");
		}
		try {
			const st = fs.fstatSync(fd);
			if (!st.isFile() || !ownerOk(st)) {
				throw new CredentialStoreError("unsafe_path", "Credential file is not safe.");
			}
			if (st.size > MAX_FILE_BYTES) throw new CredentialStoreError("corrupt", "Credential file is corrupt.");
			const text = fs.readFileSync(fd, "utf-8");
			return this.parse(text);
		} finally {
			fs.closeSync(fd);
		}
	}

	private parse(text: string): State {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new CredentialStoreError("corrupt", "Credential file is corrupt.");
		}
		if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.credentials)) {
			throw new CredentialStoreError("corrupt", "Credential file is corrupt.");
		}
		const state: State = new Map();
		for (const [id, cred] of Object.entries(raw.credentials)) {
			if (!isValidCredentialId(id) || !isCredential(cred)) {
				throw new CredentialStoreError("corrupt", "Credential file is corrupt.");
			}
			state.set(id, cred);
		}
		return state;
	}

	// ---- write --------------------------------------------------------

	private writeState(state: State): void {
		this.ensureDir();
		try {
			const st = fs.lstatSync(this.file);
			if (!st.isFile() || st.isSymbolicLink()) {
				throw new CredentialStoreError("unsafe_path", "Credential file is not safe.");
			}
		} catch (e) {
			if (e instanceof CredentialStoreError) throw e;
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new CredentialStoreError("io", "Credential file is unavailable.");
			}
		}
		const body = `${JSON.stringify({ version: 1, credentials: Object.fromEntries(state) }, null, "\t")}\n`;
		const tmp = path.join(this.dir, `.${path.basename(this.file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		let fd: number | undefined;
		try {
			fd = fs.openSync(tmp, "wx", 0o600);
			fs.writeFileSync(fd, body);
			fs.fchmodSync(fd, 0o600);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(tmp, this.file);
			try {
				const dfd = fs.openSync(this.dir, "r");
				try {
					fs.fsyncSync(dfd);
				} finally {
					fs.closeSync(dfd);
				}
			} catch {
				// directory fsync is best effort
			}
		} catch (e) {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {}
			}
			try {
				fs.rmSync(tmp, { force: true });
			} catch {}
			if (e instanceof CredentialStoreError) throw e;
			throw new CredentialStoreError("io", "Could not write credentials.");
		}
	}

	// ---- lock ---------------------------------------------------------

	private get guardFile(): string {
		return `${this.file}.guard`;
	}

	/**
	 * Run `fn` (synchronous) while holding the exclusive acquisition guard.
	 * Waits (bounded, abort-aware) for another holder; never reclaims a guard.
	 */
	private async withGuard<T>(fn: () => T, signal?: AbortSignal, timeoutMs = this.lockTimeoutMs): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		const token = randomBytes(12).toString("hex");
		for (;;) {
			signal?.throwIfAborted();
			let fd: number | undefined;
			try {
				fd = fs.openSync(this.guardFile, "wx", 0o600);
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
				fs.closeSync(fd);
				fd = undefined;
				break;
			} catch (e) {
				if (fd !== undefined) {
					try {
						fs.closeSync(fd);
					} catch {}
					try {
						fs.unlinkSync(this.guardFile); // our own half-written guard
					} catch {}
				}
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new CredentialStoreError("io", "Could not lock credentials.");
				}
			}
			if (Date.now() >= deadline) throw new CredentialStoreError("lock_timeout", "Credential store is busy.");
			await sleep(Math.min(this.pollMs, 5), signal);
		}
		try {
			return fn();
		} finally {
			try {
				const held = JSON.parse(fs.readFileSync(this.guardFile, "utf-8"));
				if (held?.token === token) fs.unlinkSync(this.guardFile);
			} catch {}
		}
	}

	private readOwner(): { pid: number; host: string; token: string } | undefined {
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(this.lockDir, "owner.json"), "utf-8"));
			if (typeof meta?.pid === "number" && typeof meta.host === "string" && typeof meta.token === "string") {
				return meta;
			}
		} catch {}
		return undefined;
	}

	/** Positively dead owner on this host only. Everything else fails closed. */
	private lockIsAbandoned(): boolean {
		try {
			if (!fs.lstatSync(this.lockDir).isDirectory()) return false;
		} catch {
			return false;
		}
		const meta = this.readOwner();
		if (!meta || meta.host !== os.hostname() || !Number.isInteger(meta.pid) || meta.pid <= 0) return false;
		return !pidAlive(meta.pid);
	}

	/** One acquisition attempt. MUST run under the guard. */
	private tryTakeLock(token: string): boolean {
		const staging = `${this.lockDir}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
		try {
			// Build the lock fully (owner record included) then rename it into place:
			// rename onto an existing non-empty directory fails, so a lock never
			// exists without its owner record.
			fs.mkdirSync(staging, { mode: 0o700 });
			fs.writeFileSync(
				path.join(staging, "owner.json"),
				JSON.stringify({ pid: process.pid, host: os.hostname(), token }),
				{ mode: 0o600 },
			);
			const attempt = (): boolean => {
				try {
					fs.renameSync(staging, this.lockDir);
					return true;
				} catch (e) {
					const code = (e as NodeJS.ErrnoException).code;
					if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") return false;
					// Windows reports an existing non-empty target directory as EPERM.
					// Only treat it as contention when the target actually exists; the
					// owner check below still refuses unknown, live or unsafe locks.
					if (process.platform === "win32" && code === "EPERM" && fs.existsSync(this.lockDir)) return false;
					throw new CredentialStoreError("io", "Could not lock credentials.");
				}
			};
			if (attempt()) return true;
			if (!this.lockIsAbandoned()) return false;
			// Guard held: nobody can swap the lock between the check and this rename.
			const aside = `${this.lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
			try {
				fs.renameSync(this.lockDir, aside);
				fs.rmSync(aside, { recursive: true, force: true });
			} catch {
				return false;
			}
			return attempt();
		} catch (e) {
			if (e instanceof CredentialStoreError) throw e;
			throw new CredentialStoreError("io", "Could not lock credentials.");
		} finally {
			try {
				fs.rmSync(staging, { recursive: true, force: true });
			} catch {}
		}
	}

	private async acquire(signal?: AbortSignal): Promise<() => Promise<void>> {
		this.ensureDir();
		const deadline = Date.now() + this.lockTimeoutMs;
		const token = randomBytes(12).toString("hex");
		for (;;) {
			signal?.throwIfAborted();
			const remaining = Math.max(1, deadline - Date.now());
			if (await this.withGuard(() => this.tryTakeLock(token), signal, remaining)) {
				return () => this.release(token);
			}
			if (Date.now() >= deadline) throw new CredentialStoreError("lock_timeout", "Credential store is busy.");
			await sleep(this.pollMs, signal);
		}
	}

	private async release(token: string): Promise<void> {
		// Not abortable and given a generous wait: an unreleased live-pid lock would block everyone.
		await this.withGuard(() => {
			if (this.readOwner()?.token !== token) return; // not ours (or already gone)
			try {
				fs.rmSync(this.lockDir, { recursive: true, force: true });
			} catch {}
		}, undefined, Math.max(this.lockTimeoutMs, 30_000));
	}

	private async locked<T>(options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire(options?.signal);
		try {
			return await fn();
		} finally {
			await release();
		}
	}

	// ---- CredentialStore ---------------------------------------------

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		assertId(providerId);
		const cred = this.readStateSync()?.get(providerId);
		return cred ? structuredClone(cred) : undefined;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const state = this.readStateSync();
		return state ? [...state].map(([providerId, c]) => ({ providerId, type: c.type })) : [];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		assertId(providerId);
		options?.signal?.throwIfAborted();
		return this.locked(options, async () => {
			const state = this.readStateSync() ?? new Map();
			const current = state.get(providerId);
			const next = await fn(current ? structuredClone(current) : undefined);
			options?.signal?.throwIfAborted();
			if (next === undefined) return current ? structuredClone(current) : undefined;
			if (!isCredential(next)) throw new CredentialStoreError("invalid_credential", "Invalid credential.");
			const stored = structuredClone(next);
			state.set(providerId, stored);
			this.writeState(state);
			return structuredClone(stored);
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		assertId(providerId);
		options?.signal?.throwIfAborted();
		await this.locked(options, async () => {
			const state = this.readStateSync();
			if (!state?.has(providerId)) return;
			state.delete(providerId);
			this.writeState(state);
		});
	}

	// ---- sync views ---------------------------------------------------

	peek(providerId: string): Credential | undefined {
		if (!isValidCredentialId(providerId)) return undefined;
		try {
			const cred = this.readStateSync()?.get(providerId);
			return cred ? structuredClone(cred) : undefined;
		} catch {
			return undefined;
		}
	}

	has(providerId: string): boolean {
		return this.peek(providerId) !== undefined;
	}
}

export function createProviderCredentialStore(
	filePath: string,
	options?: ProviderCredentialStoreOptions,
): ProviderCredentialStore {
	return new FileProviderCredentialStore(filePath, options);
}

/** Own private subtree of the data dir; the data root itself is never chmod'd. */
export const PROVIDER_CREDENTIALS_FILE = path.join(PATHS.data, "connections", "provider-credentials.json");

const SINGLETON_KEY = Symbol.for("lh.providerCredentials");

function singleton(): ProviderCredentialStore {
	const g = globalThis as Record<symbol, ProviderCredentialStore | undefined>;
	g[SINGLETON_KEY] ??= createProviderCredentialStore(PROVIDER_CREDENTIALS_FILE);
	return g[SINGLETON_KEY];
}

/** Persistent singleton (HMR-safe). Parent injects this into piModels(). */
export const providerCredentials: ProviderCredentialStore = singleton();
