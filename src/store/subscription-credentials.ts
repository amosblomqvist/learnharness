/**
 * Durable subscription credential store (issue #8, implementation plan
 * 2026-10-19).
 *
 * This adapter owns one dedicated directory (the composition root passes
 * `<instance data>/subscription`) and nothing else. It persists:
 *
 *   subscription-auth.json            versioned envelope + tombstone
 *   subscription-refresh-journal.json nonsecret refresh-in-progress marker
 *   .subscription-auth.lock/          cross-process lock directory
 *
 * Guarantees:
 * - strict versioned schema; unknown versions/fields, symlinks and
 *   non-regular files fail closed instead of being treated as empty;
 * - owner-only directory/files on POSIX (see subscription-fs.ts for the
 *   Windows ACL boundary);
 * - durable same-directory tmp+rename writes with file and directory
 *   fsync;
 * - one cross-process lock, bounded and abortable; a stale lock is
 *   reclaimed only with proof of owner death (subscription-lock.ts);
 * - a refresh journal is written durably BEFORE the provider callback can
 *   rotate a token and is removed only AFTER the rotated credential (and
 *   its directory entry) is durable. Any failure leaves the journal, so
 *   every process blocks refresh/inference rather than exposing an
 *   uncertain old refresh token as usable.
 *
 * The store is deliberately low-level. Callers check generation and
 * credential state themselves; the store only enforces schema, locking,
 * durability, the refresh fence and the disconnect tombstone rule.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
	SUBSCRIPTION_JOURNAL_FILE,
	SUBSCRIPTION_STATE_FILE,
	SubscriptionStorageError,
	validateEnvelope,
	validateJournal,
	validateOAuthCredential,
	type OAuthCredential,
	type RefreshJournal,
	type StoreOwner,
	type SubscriptionEnvelope,
} from "./subscription-types.ts";
import {
	ensurePrivateDirectory,
	readOptionalJsonFile,
	removeDurableFile,
	writeDurableJsonFile,
} from "./subscription-fs.ts";
import { acquireLock, getLocalOwner, isOwnerAlive, lockDirectory } from "./subscription-lock.ts";

export {
	SUBSCRIPTION_JOURNAL_FILE,
	SUBSCRIPTION_LOCK_DIR,
	SUBSCRIPTION_STATE_FILE,
	SubscriptionStorageError,
} from "./subscription-types.ts";
export type {
	OAuthCredential,
	RefreshJournal,
	StoreOwner,
	SubscriptionAttempt,
	SubscriptionEnvelope,
	SubscriptionLoginMethod,
	SubscriptionStorageErrorCode,
} from "./subscription-types.ts";

/** The low-level handle passed to a transaction callback. */
export interface SubscriptionTransaction {
	/** The complete envelope as of the last successful read/save. */
	readonly state: SubscriptionEnvelope;
	/** Persist a complete envelope (credential, attempt or tombstone). */
	save(next: SubscriptionEnvelope): Promise<void>;
	/** Nonsecret refresh journal, if a refresh may have rotated a token. */
	journal(): Promise<RefreshJournal | undefined>;
	/** Durably record a refresh before any provider callback may run. */
	beginRefresh(): Promise<RefreshJournal>;
	/** Persist the rotated credential, then clear the matching journal. */
	commitRefresh(credential: OAuthCredential, journal: RefreshJournal): Promise<void>;
	/** Clear an old-generation journal only after a durable tombstone. */
	clearJournalAfterDisconnect(): Promise<void>;
}

export interface SubscriptionSnapshot {
	readonly state: SubscriptionEnvelope;
	readonly journal?: RefreshJournal;
}

export interface SubscriptionStore {
	/** Canonical resolved store directory. */
	readonly directory: string;
	/** Stable local process identity for attempt records. */
	readonly owner: StoreOwner;
	/**
	 * Serialize a read-modify-write section against every process sharing
	 * this directory. Callback errors are rethrown as the same object.
	 * Cancellation rejects with the signal's reason.
	 */
	transaction<T>(
		fn: (tx: SubscriptionTransaction) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T>;
	/** Authoritative envelope, read inside a transaction. */
	getSnapshot(): Promise<SubscriptionEnvelope>;
	/** Authoritative envelope plus journal, read inside one transaction. */
	snapshot(): Promise<SubscriptionSnapshot>;
	isOwnerAlive(owner: StoreOwner): boolean | "unknown";
}

const PROCESS_LOCK_TIMEOUT_MS = 15_000;
const processQueues = new Map<string, Promise<void>>();
const activeTransactions = new AsyncLocalStorage<readonly string[]>();

function abortedReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function waitForQueue(
	previous: Promise<void>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error === undefined) resolve();
			else reject(error);
		};
		const timer = setTimeout(() => {
			finish(
				new SubscriptionStorageError(
					"lock_unavailable",
					"The subscription store is busy in this process.",
				),
			);
		}, timeoutMs);
		const onAbort = () => finish(abortedReason(signal as AbortSignal));
		if (signal?.aborted) {
			finish(abortedReason(signal));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		previous.then(
			() => finish(),
			() => finish(),
		);
	});
}

async function withProcessQueue<T>(
	directory: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = processQueues.get(directory) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	processQueues.set(directory, tail);
	try {
		await waitForQueue(previous, signal, PROCESS_LOCK_TIMEOUT_MS);
		if (signal?.aborted) throw abortedReason(signal);
		return await fn();
	} finally {
		release();
	}
}

function journalAsStorageError(error: unknown): unknown {
	if (error instanceof SubscriptionStorageError && error.code === "invalid_state") {
		return new SubscriptionStorageError("invalid_journal", "Refresh journal has an invalid shape.");
	}
	return error;
}

class StoreTransaction implements SubscriptionTransaction {
	constructor(
		private readonly store: SubscriptionStoreImpl,
		private readonly lock: Awaited<ReturnType<typeof acquireLock>>,
		private currentState: SubscriptionEnvelope,
	) {}

	get state(): SubscriptionEnvelope {
		return this.currentState;
	}

	async save(next: SubscriptionEnvelope): Promise<void> {
		const validated = validateEnvelope(next);
		this.lock.assertHeld();
		writeDurableJsonFile(this.store.statePath, validated);
		this.currentState = validated;
	}

	async journal(): Promise<RefreshJournal | undefined> {
		this.lock.assertHeld();
		return this.store.readJournalLocked();
	}

	async beginRefresh(): Promise<RefreshJournal> {
		this.lock.assertHeld();
		if (!this.currentState.credential) {
			throw new SubscriptionStorageError(
				"no_credential",
				"No subscription credential is available to refresh.",
			);
		}
		const existing = this.store.readJournalLocked();
		if (existing) {
			throw new SubscriptionStorageError(
				"journal_exists",
				"A previous refresh outcome is unresolved; refusing a second refresh.",
			);
		}
		const journal: RefreshJournal = Object.freeze({
			version: 1 as const,
			generation: this.currentState.generation,
			operationId: randomUUID(),
		});
		writeDurableJsonFile(this.store.journalPath, journal);
		return journal;
	}

	async commitRefresh(credential: OAuthCredential, journal: RefreshJournal): Promise<void> {
		const validatedCredential = validateOAuthCredential(credential);
		const expected = validateJournal(journal);
		this.lock.assertHeld();
		if (!this.currentState.credential) {
			throw new SubscriptionStorageError(
				"no_credential",
				"No subscription credential is available to commit a refresh.",
			);
		}
		const onDisk = this.store.readJournalLocked();
		if (!onDisk) {
			throw new SubscriptionStorageError(
				"journal_required",
				"The refresh journal is missing; the rotated credential was not committed.",
			);
		}
		if (
			onDisk.generation !== expected.generation ||
			onDisk.operationId !== expected.operationId
		) {
			throw new SubscriptionStorageError(
				"journal_mismatch",
				"The refresh journal no longer matches this operation.",
			);
		}
		if (onDisk.generation !== this.currentState.generation) {
			throw new SubscriptionStorageError(
				"journal_mismatch",
				"The authorization generation changed during refresh.",
			);
		}

		const next = validateEnvelope({
			version: 1,
			generation: this.currentState.generation,
			credential: validatedCredential,
			...(this.currentState.attempt ? { attempt: this.currentState.attempt } : {}),
		});
		// The envelope schema is fixed and carries no refresh operation id.
		// The journal is the durable operation record: it was verified above
		// and is removed only after this credential write (and its directory
		// entry) is durable.
		writeDurableJsonFile(this.store.statePath, next);
		this.currentState = next;
		removeDurableFile(this.store.journalPath, "Refresh journal");
	}

	async clearJournalAfterDisconnect(): Promise<void> {
		this.lock.assertHeld();
		if (this.currentState.credential || this.currentState.attempt) {
			throw new SubscriptionStorageError(
				"not_disconnected",
				"The journal cannot be cleared while the instance is still connected or attempting.",
			);
		}
		const onDisk = this.store.readJournalLocked();
		if (!onDisk) return;
		if (onDisk.generation === this.currentState.generation) {
			throw new SubscriptionStorageError(
				"journal_mismatch",
				"The journal generation has not been invalidated by a disconnect tombstone.",
			);
		}
		removeDurableFile(this.store.journalPath, "Refresh journal");
	}
}

class SubscriptionStoreImpl implements SubscriptionStore {
	readonly directory: string;
	readonly owner: StoreOwner;

	constructor(directory: string) {
		this.directory = ensurePrivateDirectory(directory);
		this.owner = getLocalOwner();
	}

	get statePath(): string {
		return path.join(this.directory, SUBSCRIPTION_STATE_FILE);
	}

	get journalPath(): string {
		return path.join(this.directory, SUBSCRIPTION_JOURNAL_FILE);
	}

	async transaction<T>(
		fn: (tx: SubscriptionTransaction) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const directory = this.directory;
		const stack = activeTransactions.getStore() ?? [];
		if (stack.includes(directory)) {
			throw new SubscriptionStorageError(
				"transaction_nested",
				"A subscription store transaction cannot nest inside another one.",
			);
		}
		return withProcessQueue(directory, signal, () =>
			activeTransactions.run([...stack, directory], async () => {
				ensurePrivateDirectory(directory);
				const lock = await acquireLock(lockDirectory(directory), signal);
				let result: T | undefined;
				let failure: unknown;
				let failed = false;
				try {
					const state = this.readStateLocked();
					result = await fn(new StoreTransaction(this, lock, state));
				} catch (error) {
					failed = true;
					failure = error;
				}
				try {
					lock.release();
				} catch (error) {
					if (!failed) {
						failed = true;
						failure = error;
					}
				}
				if (failed) throw failure;
				return result as T;
			}),
		);
	}

	async getSnapshot(): Promise<SubscriptionEnvelope> {
		// Envelope-only read: a corrupt/uncertain journal must not make the
		// last durable connection state unreadable. Callers that decide
		// whether inference is allowed use snapshot() instead.
		return this.transaction(async (tx) => tx.state);
	}

	async snapshot(): Promise<SubscriptionSnapshot> {
		return this.transaction(async (tx) => {
			const journal = await tx.journal();
			return Object.freeze(journal ? { state: tx.state, journal } : { state: tx.state });
		});
	}

	isOwnerAlive(owner: StoreOwner): boolean | "unknown" {
		return isOwnerAlive(owner);
	}

	/** Caller holds the store lock. Absent = first boot, never "empty map". */
	readStateLocked(): SubscriptionEnvelope {
		const raw = readOptionalJsonFile(this.statePath, "Subscription state");
		if (raw === undefined) {
			const initial = validateEnvelope({ version: 1, generation: randomUUID() });
			writeDurableJsonFile(this.statePath, initial);
			return initial;
		}
		return validateEnvelope(raw);
	}

	/** Caller holds the store lock. A corrupt journal is never auto-cleared. */
	readJournalLocked(): RefreshJournal | undefined {
		const raw = readOptionalJsonFile(this.journalPath, "Refresh journal");
		if (raw === undefined) return undefined;
		try {
			return validateJournal(raw);
		} catch (error) {
			throw journalAsStorageError(error);
		}
	}
}

/**
 * Create (or reopen) the durable store at `directory`. The directory is
 * canonicalized and tightened to 0700 on POSIX. The initial envelope is
 * written lazily inside the first transaction, under the cross-process
 * lock.
 */
export function createSubscriptionStore(directory: string): SubscriptionStore {
	if (typeof directory !== "string" || directory.length === 0) {
		throw new SubscriptionStorageError(
			"invalid_directory",
			"A subscription storage directory is required.",
		);
	}
	return new SubscriptionStoreImpl(directory);
}
