/**
 * Cross-process lock directory and local process identity.
 *
 * The lock is a directory created with mkdir (atomic on POSIX and NTFS).
 * Its owner.json records a per-process nonce, hostname, PID and a process
 * birth identity (boot id + /proc start time on Linux; random fallback on
 * platforms without /proc). Acquisition is bounded and abortable.
 *
 * A lock is reclaimed only when `isOwnerAlive` proves the recorded owner
 * is dead on this host. "unknown" (foreign host, unreadable /proc, PID
 * reuse ambiguity) is NOT age-based permission: it waits, then fails
 * closed. The entire acquisition sequence (observe, reclaim, mkdir and
 * owner write) runs under a separate mkdir guard at `${lockDir}.acquire`,
 * so two recoverers cannot move a newly created live lock. The guard is
 * deliberately never reclaimed by age, timeout or a dead-owner proof:
 * an orphan or corrupt guard is an operator-recovery condition. Every
 * mutation also revalidates the nonce, so a paused/stale owner whose lock
 * was taken over fails before writing.
 *
 * Shared network filesystems and multi-host access to one data directory
 * are unsupported: the liveness proof is same-host only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
	SUBSCRIPTION_LOCK_DIR,
	SubscriptionStorageError,
	type StoreOwner,
	validateStoreOwner,
} from "./subscription-types.ts";
import { readOptionalJsonFile, writeDurableJsonFile } from "./subscription-fs.ts";

const ACQUIRE_TIMEOUT_MS = 15_000;
const RETRY_MS = 25;
const OWNER_FILE = "owner.json";
const POSIX = process.platform !== "win32";

let localOwner: StoreOwner | undefined;
let cachedBootId: string | undefined | null = null;

function bootId(): string | undefined {
	if (cachedBootId !== null) return cachedBootId;
	try {
		cachedBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
	} catch {
		cachedBootId = undefined;
	}
	return cachedBootId;
}

/**
 * The OS birth identity for a PID. On Linux this is boot id plus the
 * starttime field of /proc/<pid>/stat, which distinguishes a reused PID.
 * Undefined means the platform cannot prove identity; callers must treat
 * a live PID as "unknown", never alive.
 */
function processBirth(pid: number): string | undefined {
	const boot = bootId();
	if (!boot) return undefined;
	let stat: string;
	try {
		stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = stat.slice(close + 1).trim().split(/\s+/);
	// fields[0] is state (field 3); starttime is field 22, i.e. index 19.
	const starttime = fields[19];
	if (!starttime || !/^\d+$/.test(starttime)) return undefined;
	return `${boot}:${starttime}`;
}

export function getLocalOwner(): StoreOwner {
	if (localOwner) return localOwner;
	try {
		const birth = processBirth(process.pid) ?? `random:${randomUUID()}`;
		const owner = Object.freeze({
			host: os.hostname(),
			pid: process.pid,
			nonce: randomUUID(),
			processBirth: birth,
		});
		localOwner = owner;
		return owner;
	} catch (error) {
		throw SubscriptionStorageError.fromSystem(
			error,
			"io",
			"A local process identity could not be created.",
		);
	}
}

/**
 * `true` = the recorded process is provably this host's live process;
 * `false` = provably dead or the PID now belongs to a different process;
 * `"unknown"` = cannot be proven (foreign host, missing /proc, permission).
 */
export function isOwnerAlive(owner: StoreOwner): boolean | "unknown" {
	let candidate: StoreOwner;
	try {
		candidate = validateStoreOwner(owner);
	} catch {
		return "unknown";
	}
	try {
		if (candidate.host !== os.hostname()) return "unknown";
	} catch {
		return "unknown";
	}
	// Self is alive by definition, even on platforms without a readable
	// process-birth identity (where the generic proof below is "unknown").
	if (localOwner && sameOwner(candidate, localOwner)) return true;

	try {
		process.kill(candidate.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === "ESRCH") return false;
		if (code !== "EPERM") return "unknown";
	}

	const currentBirth = processBirth(candidate.pid);
	if (!currentBirth) return "unknown";
	return currentBirth === candidate.processBirth;
}

function abortedReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortedReason(signal);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortedReason(signal));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortedReason(signal as AbortSignal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function readLockOwner(lockDir: string): StoreOwner | undefined {
	try {
		const raw = readOptionalJsonFile(path.join(lockDir, OWNER_FILE), "Subscription store lock");
		return raw === undefined ? undefined : validateStoreOwner(raw);
	} catch {
		// A missing/partial/tampered owner record is an UNKNOWN owner, not a
		// reclaimable one. Waiting then failing closed is the safe outcome.
		return undefined;
	}
}

function sameOwner(a: StoreOwner, b: StoreOwner): boolean {
	return (
		a.host === b.host &&
		a.pid === b.pid &&
		a.nonce === b.nonce &&
		a.processBirth === b.processBirth
	);
}

/**
 * Rename the observed dead lock out of the way, verify the nonce did not
 * change between observation and rename, and only then delete it. If the
 * rename captured a different owner (another reclaimer won the race), try
 * to put it back; failing that, fail closed rather than deleting an
 * active owner's lock.
 */
function reclaimStaleLock(lockDir: string, observed: StoreOwner): boolean {
	const quarantine = `${lockDir}.stale-${randomUUID()}`;
	try {
		fs.renameSync(lockDir, quarantine);
	} catch {
		return false;
	}

	const moved = readLockOwner(quarantine);
	if (!moved || !sameOwner(moved, observed)) {
		try {
			fs.renameSync(quarantine, lockDir);
		} catch {
			throw new SubscriptionStorageError(
				"lock_unavailable",
				"The subscription store lock changed owners during recovery.",
			);
		}
		return false;
	}

	try {
		fs.rmSync(quarantine, { recursive: true, force: true });
	} catch {
		// The dead owner's quarantine directory is harmless inside the
		// owner-only store directory; the lock path itself is now free.
	}
	return true;
}

export interface LockHandle {
	readonly owner: StoreOwner;
	/** Throw if this handle no longer owns the lock. Called before every write. */
	assertHeld(): void;
	release(): void;
}

function lockFailure(
	error: unknown,
	code: "lock_unavailable" | "lock_ownership" | "io",
	message: string,
): SubscriptionStorageError {
	if (error instanceof SubscriptionStorageError) return error;
	return SubscriptionStorageError.fromSystem(error, code, message);
}

interface AcquisitionGuard {
	readonly directory: string;
	readonly owner: StoreOwner;
}

function guardDirectory(lockDir: string): string {
	return `${lockDir}.acquire`;
}

/**
 * Serialize the whole main-lock acquisition sequence. The guard is a
 * separate mkdir directory and is never inspected for liveness: any
 * existing guard (dead owner, unreadable owner, file, symlink or empty
 * directory) means an operator must stop the service, prove no acquirer
 * is running, and remove it manually. Waiting is bounded by the caller's
 * deadline and abortable.
 */
async function acquireAcquisitionGuard(
	lockDir: string,
	owner: StoreOwner,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<AcquisitionGuard> {
	const directory = guardDirectory(lockDir);

	for (;;) {
		throwIfAborted(signal);
		try {
			fs.mkdirSync(directory, { mode: 0o700 });
			try {
				if (POSIX) fs.chmodSync(directory, 0o700);
				writeDurableJsonFile(path.join(directory, OWNER_FILE), owner);
			} catch (error) {
				// Never remove a guard we just created but could not label:
				// another process may already be waiting on it. An ownerless
				// guard fails closed for operator recovery.
				throw lockFailure(
					error,
					"io",
					"The subscription store acquisition guard could not be created.",
				);
			}
			return { directory, owner };
		} catch (error) {
			if (error instanceof SubscriptionStorageError) throw error;
			if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
				throw lockFailure(
					error,
					"io",
					"The subscription store acquisition guard could not be acquired.",
				);
			}
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new SubscriptionStorageError(
				"lock_unavailable",
				"The subscription store acquisition guard exists; an operator must verify no acquirer is running and remove it manually.",
			);
		}
		await sleep(Math.min(RETRY_MS, remaining), signal);
	}
}

/**
 * Release only the guard this acquisition created. The owner nonce is
 * checked once; the owner record and then the empty directory are removed
 * exactly once. A changed, damaged or non-empty guard is left in place so
 * it keeps failing closed instead of being deleted blindly.
 */
function releaseAcquisitionGuard(guard: AcquisitionGuard): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(guard.directory);
	} catch (error) {
		throw lockFailure(
			error,
			"io",
			"The subscription store acquisition guard could not be inspected.",
		);
	}
	if (!stat.isDirectory()) {
		throw new SubscriptionStorageError(
			"lock_ownership",
			"The subscription store acquisition guard is no longer a directory.",
		);
	}
	if (POSIX && (stat.mode & 0o777) !== 0o700) {
		throw new SubscriptionStorageError(
			"lock_ownership",
			"The subscription store acquisition guard is no longer owner-only.",
		);
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new SubscriptionStorageError(
			"lock_ownership",
			"The subscription store acquisition guard is no longer owned by this account.",
		);
	}

	const current = readLockOwner(guard.directory);
	if (!current || !sameOwner(current, guard.owner)) {
		throw new SubscriptionStorageError(
			"lock_ownership",
			"The subscription store acquisition guard is no longer owned by this process.",
		);
	}
	try {
		fs.unlinkSync(path.join(guard.directory, OWNER_FILE));
		fs.rmdirSync(guard.directory);
	} catch (error) {
		throw lockFailure(
			error,
			"io",
			"The subscription store acquisition guard could not be released.",
		);
	}
}

/**
 * Acquire the main lock while the caller already holds the acquisition
 * guard. The guard spans the initial mkdir, every EEXIST observation, the
 * dead-owner rename/recheck, the re-mkdir and the durable owner write.
 */
async function acquireMainLock(
	lockDir: string,
	owner: StoreOwner,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<LockHandle> {
	for (;;) {
		throwIfAborted(signal);
		try {
			fs.mkdirSync(lockDir, { mode: 0o700 });
			try {
				if (POSIX) fs.chmodSync(lockDir, 0o700);
				writeDurableJsonFile(path.join(lockDir, OWNER_FILE), owner);
			} catch (error) {
				// Never unlink here. Once mkdir succeeds another process may be
				// racing to acquire the same path; an ownerless lock is an
				// unknown owner and must be recovered by an operator, not
				// deleted blindly by the process that failed to label it.
				throw lockFailure(error, "io", "The subscription store lock could not be created.");
			}
			return {
				owner,
				assertHeld() {
					const current = readLockOwner(lockDir);
					if (!current || !sameOwner(current, owner)) {
						throw new SubscriptionStorageError(
							"lock_ownership",
							"The subscription store lock is no longer owned by this transaction.",
						);
					}
				},
				release() {
					const current = readLockOwner(lockDir);
					if (!current || !sameOwner(current, owner)) {
						throw new SubscriptionStorageError(
							"lock_ownership",
							"The subscription store lock is no longer owned by this transaction.",
						);
					}
					try {
						fs.rmSync(lockDir, { recursive: true, force: true });
					} catch (error) {
						throw lockFailure(error, "io", "The subscription store lock could not be released.");
					}
				},
			};
		} catch (error) {
			if (error instanceof SubscriptionStorageError) throw error;
			if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
				throw lockFailure(error, "io", "The subscription store lock could not be acquired.");
			}
		}

		const observed = readLockOwner(lockDir);
		if (observed && isOwnerAlive(observed) === false) {
			if (reclaimStaleLock(lockDir, observed)) continue;
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new SubscriptionStorageError(
				"lock_unavailable",
				"The subscription store is busy; no safe lock takeover was possible.",
			);
		}
		await sleep(Math.min(RETRY_MS, remaining), signal);
	}
}

export async function acquireLock(
	lockDir: string,
	signal: AbortSignal | undefined,
): Promise<LockHandle> {
	const owner = getLocalOwner();
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	const guard = await acquireAcquisitionGuard(lockDir, owner, deadline, signal);

	let handle: LockHandle;
	try {
		handle = await acquireMainLock(lockDir, owner, deadline, signal);
	} catch (error) {
		try {
			releaseAcquisitionGuard(guard);
		} catch {
			// The guard stays behind and keeps the store fail-closed.
		}
		throw error;
	}

	try {
		releaseAcquisitionGuard(guard);
	} catch (error) {
		// The guard was not released. Do not leave a main lock that no
		// caller can ever use behind it; release that lock once, while the
		// guard still fences all other acquirers.
		try {
			handle.release();
		} catch {
			// An ownerless/stale main lock remains fail-closed.
		}
		throw error;
	}

	return handle;
}

export function lockDirectory(storeDirectory: string): string {
	return path.join(storeDirectory, SUBSCRIPTION_LOCK_DIR);
}

