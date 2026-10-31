/**
 * Per-request data scope (mobile-web branch, 2026-10-29).
 *
 * The app became multi-user: every chat, graph ledger, job and settings
 * record belongs to ONE account. `config.ts` resolves its data root through
 * `scopedDataRoot()` so the existing store adapters keep their module-level
 * `PATHS.*` call sites while the paths themselves follow the signed-in user.
 *
 * Contract:
 *   - Inside a request (route handler wrapped by `withUser`, and everything
 *     that request spawns — services, turn runs, sub-agent jobs) the scope
 *     carries the user's data root.
 *   - Outside a request (scripts, tests, CLI: import-notes, backfill, smoke)
 *     no scope exists and `config.ts` falls back to the legacy base data dir,
 *     byte-for-byte the old behavior.
 *
 * This module imports nothing from the app on purpose: `config.ts` imports
 * IT, so a cycle here would poison every module that touches a path.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type UserRole = "admin" | "user";

export type DataScope = {
	userId: string;
	email: string;
	role: UserRole;
	/** Absolute root of this user's mutable records (chats/, graph/, jobs/…). */
	dataRoot: string;
};

const storage = new AsyncLocalStorage<DataScope>();

export function currentScope(): DataScope | undefined {
	return storage.getStore();
}

/** Run `fn` (and everything it awaits) as `scope`. */
export function runInScope<T>(scope: DataScope, fn: () => T): T {
	return storage.run(scope, fn);
}

/** The scoped root, or the caller's legacy fallback when out of request. */
export function scopedDataRoot(fallback: string): string {
	return storage.getStore()?.dataRoot ?? fallback;
}

/** The signed-in user id, or null outside a request (scripts/tests). */
export function scopedUserId(): string | null {
	return storage.getStore()?.userId ?? null;
}
