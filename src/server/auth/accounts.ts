/**
 * Account lifecycle (mobile-web, 2026-10-29): first-run admin creation,
 * login, admin-created accounts, invite acceptance, legacy-data migration.
 *
 * Route handlers stay thin (parse + respond); the rules live here so they can
 * be unit-tested without HTTP.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BASE_DATA, userDataRoot } from "../../../config.ts";
import {
	adminCount,
	consumeInvite,
	countUsers,
	createAccount,
	deleteAccount,
	getUserByEmail,
	getUserById,
	normalizeEmail,
	pendingInvite,
	updateAccount,
	type AccountRecord,
} from "../../store/users.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, needsRehash, verifyPassword } from "./password.ts";

export type PublicAccount = {
	id: string;
	name: string;
	email: string;
	role: "admin" | "user";
	createdAt: string;
	disabled: boolean;
};

export function publicAccount(account: AccountRecord): PublicAccount {
	return {
		id: account.id,
		name: account.name,
		email: account.email,
		role: account.role,
		createdAt: account.createdAt,
		disabled: account.disabled === true,
	};
}

export function validateCredentials(input: {
	name?: unknown;
	email?: unknown;
	password?: unknown;
}): { name: string; email: string; password: string } | { error: string } {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
	const password = typeof input.password === "string" ? input.password : "";
	if (name.length < 1) return { error: "Tell us your name." };
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email doesn't look right." };
	if (password.length < MIN_PASSWORD_LENGTH) return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
	return { name, email, password };
}

/** First-run: create the admin account and adopt any pre-existing data. */
export async function createFirstAdmin(input: { name: string; email: string; password: string }): Promise<AccountRecord> {
	if (countUsers() > 0) throw new Error("already_initialized");
	const passwordHash = await hashPassword(input.password);
	const account = createAccount({ name: input.name, email: input.email, passwordHash, role: "admin" });
	migrateLegacyData(account.id);
	return account;
}

/**
 * Move the single-user era's records into the admin's own root. Moves (not
 * copies) — the base directories are left empty, nothing is deleted, and a
 * second call is a no-op.
 */
export function migrateLegacyData(userId: string): void {
	const target = userDataRoot(userId);
	fs.mkdirSync(target, { recursive: true });
	const entries = ["chats", "graph", "jobs", "prompts", "debug", "settings.json"];
	for (const entry of entries) {
		const from = path.join(BASE_DATA, entry);
		const to = path.join(target, entry);
		if (!fs.existsSync(from) || fs.existsSync(to)) continue;
		try {
			fs.renameSync(from, to);
		} catch {
			// Cross-device or locked file: copy, then drop the source.
			try {
				fs.cpSync(from, to, { recursive: true });
				fs.rmSync(from, { recursive: true, force: true });
			} catch {
				/* leave the legacy copy in place */
			}
		}
	}
}

// ─── Login throttling ───────────────────────────────────────────────────────
// In-memory, per-process: a wrong-password burst stops after a few tries per
// minute. Enough for a personal server behind an SSH tunnel.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;

export function loginBlocked(email: string): boolean {
	const key = normalizeEmail(email);
	const entry = attempts.get(key);
	if (!entry) return false;
	if (Date.now() > entry.resetAt) {
		attempts.delete(key);
		return false;
	}
	return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(email: string): void {
	const key = normalizeEmail(email);
	const entry = attempts.get(key);
	if (!entry || Date.now() > entry.resetAt) {
		attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
		return;
	}
	entry.count += 1;
}

export async function authenticate(email: string, password: string): Promise<AccountRecord | null> {
	if (loginBlocked(email)) return null;
	const account = getUserByEmail(email);
	if (!account || account.disabled) {
		// Constant work for unknown accounts: never leak existence by timing.
		await hashPassword(password).catch(() => undefined);
		noteFailure(email);
		return null;
	}
	const ok = await verifyPassword(password, account.passwordHash);
	if (!ok) {
		noteFailure(email);
		return null;
	}
	attempts.delete(normalizeEmail(email));
	if (needsRehash(account.passwordHash)) {
		updateAccount(account.id, { passwordHash: await hashPassword(password) });
	}
	return account;
}

/** Admin-created account (no invite round-trip needed). */
export async function createUserByAdmin(input: {
	name: string;
	email: string;
	password: string;
	role: "admin" | "user";
}): Promise<AccountRecord> {
	const passwordHash = await hashPassword(input.password);
	const account = createAccount({ name: input.name, email: input.email, passwordHash, role: input.role });
	fs.mkdirSync(userDataRoot(account.id), { recursive: true });
	return account;
}

export async function resetPassword(accountId: string, password: string): Promise<boolean> {
	if (!getUserById(accountId)) return false;
	updateAccount(accountId, { passwordHash: await hashPassword(password), bumpSession: true });
	return true;
}

export function setDisabled(accountId: string, disabled: boolean): boolean {
	if (!getUserById(accountId)) return false;
	if (disabled && getUserById(accountId)?.role === "admin" && adminCount() <= 1) return false;
	updateAccount(accountId, { disabled, bumpSession: true });
	return true;
}

/** Remove an account. Refuses to remove the last admin; keeps their data on disk. */
export function deleteUserAccount(accountId: string): boolean {
	const account = getUserById(accountId);
	if (!account) return false;
	if (account.role === "admin" && adminCount() <= 1) return false;
	return deleteAccount(accountId);
}

/** Accept an invite: the code decides the role (and optionally the email). */
export async function joinWithInvite(input: {
	code: string;
	name: string;
	email: string;
	password: string;
}): Promise<AccountRecord | null> {
	const invite = pendingInvite(input.code.trim());
	if (!invite) return null;
	const email = invite.email ?? normalizeEmail(input.email);
	const passwordHash = await hashPassword(input.password);
	const account = createAccount({ name: input.name, email, passwordHash, role: invite.role });
	if (!consumeInvite(invite.code, account.id)) {
		// Lost a race: undo the account so the code stays meaningful.
		deleteAccount(account.id);
		return null;
	}
	fs.mkdirSync(userDataRoot(account.id), { recursive: true });
	return account;
}
