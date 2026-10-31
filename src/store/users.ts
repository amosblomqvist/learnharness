/**
 * The account registry (mobile-web, 2026-10-29).
 *
 * ONE JSON document at the machine-global data root (config.USERS_FILE):
 * accounts + pending invites. It is deliberately NOT per-account — it is the
 * document that tells the server which account a session belongs to.
 *
 * Idioms follow the other fs adapters (src/store/*.ts): sync fs, atomic
 * tmp+rename writes, mode 0600 (password hashes, invite codes), hand-edits
 * tolerated (absent/corrupt = no accounts yet = first-run setup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { USERS_FILE } from "../../config.ts";
import type { UserRole } from "../server/scope.ts";

export type AccountRecord = {
	id: string;
	name: string;
	email: string;
	role: UserRole;
	/** `scrypt$…` (src/server/auth/password.ts). Never leaves the server. */
	passwordHash: string;
	createdAt: string;
	disabled?: true;
	/** Bumped on password change / disable: old session cookies stop verifying. */
	sessionVersion: number;
};

export type InviteRecord = {
	code: string;
	role: UserRole;
	email?: string;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedBy?: string;
};

type UsersDoc = {
	version: 1;
	users: AccountRecord[];
	invites: InviteRecord[];
};

const EMPTY: UsersDoc = { version: 1, users: [], invites: [] };

function readDoc(): UsersDoc {
	try {
		const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")) as Partial<UsersDoc>;
		return {
			version: 1,
			users: Array.isArray(raw.users) ? (raw.users.filter(isAccount) as AccountRecord[]) : [],
			invites: Array.isArray(raw.invites) ? (raw.invites.filter(isInvite) as InviteRecord[]) : [],
		};
	} catch {
		return { ...EMPTY, users: [], invites: [] };
	}
}

function isAccount(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.email === "string" && typeof v.passwordHash === "string";
}

function isInvite(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.code === "string" && typeof v.expiresAt === "string";
}

function writeDoc(doc: UsersDoc): void {
	const dir = path.dirname(USERS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.users.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, USERS_FILE);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function countUsers(): number {
	return readDoc().users.length;
}

export function listAccounts(): AccountRecord[] {
	return readDoc().users;
}

export function getUserById(id: string): AccountRecord | null {
	return readDoc().users.find((u) => u.id === id) ?? null;
}

export function getUserByEmail(email: string): AccountRecord | null {
	const wanted = normalizeEmail(email);
	return readDoc().users.find((u) => u.email === wanted) ?? null;
}

/** The first admin (or, failing that, the first account) — the desktop shell's identity. */
export function ownerAccount(): AccountRecord | null {
	const users = readDoc().users;
	return users.find((u) => u.role === "admin") ?? users[0] ?? null;
}

export function createAccount(input: {
	name: string;
	email: string;
	passwordHash: string;
	role: UserRole;
}): AccountRecord {
	const doc = readDoc();
	const email = normalizeEmail(input.email);
	if (doc.users.some((u) => u.email === email)) throw new Error("email_taken");
	const record: AccountRecord = {
		id: `usr_${randomBytes(9).toString("base64url")}`,
		name: input.name.trim(),
		email,
		role: input.role,
		passwordHash: input.passwordHash,
		createdAt: new Date().toISOString(),
		sessionVersion: 1,
	};
	doc.users.push(record);
	writeDoc(doc);
	return record;
}

export function updateAccount(
	id: string,
	patch: Partial<Pick<AccountRecord, "name" | "passwordHash" | "role">> & { disabled?: boolean; bumpSession?: boolean },
): AccountRecord | null {
	const doc = readDoc();
	const user = doc.users.find((u) => u.id === id);
	if (!user) return null;
	if (patch.name !== undefined) user.name = patch.name.trim();
	if (patch.passwordHash !== undefined) user.passwordHash = patch.passwordHash;
	if (patch.role !== undefined) user.role = patch.role;
	if (patch.disabled !== undefined) {
		if (patch.disabled) user.disabled = true;
		else delete user.disabled;
	}
	if (patch.bumpSession) user.sessionVersion = (user.sessionVersion ?? 1) + 1;
	writeDoc(doc);
	return user;
}

export function deleteAccount(id: string): boolean {
	const doc = readDoc();
	const before = doc.users.length;
	doc.users = doc.users.filter((u) => u.id !== id);
	if (doc.users.length === before) return false;
	writeDoc(doc);
	return true;
}

export function adminCount(): number {
	return readDoc().users.filter((u) => u.role === "admin" && !u.disabled).length;
}

export function createInvite(input: { role: UserRole; createdBy: string; email?: string; ttlMs?: number }): InviteRecord {
	const doc = readDoc();
	const now = Date.now();
	// 12 random bytes → 16 base32-ish chars, unroutable guess space.
	const code = randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, 16);
	const invite: InviteRecord = {
		code,
		role: input.role,
		...(input.email ? { email: normalizeEmail(input.email) } : {}),
		createdBy: input.createdBy,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + (input.ttlMs ?? 7 * 24 * 3600 * 1000)).toISOString(),
	};
	// Prune expired invites while we are here — they are worthless.
	doc.invites = doc.invites.filter((i) => !i.usedBy && new Date(i.expiresAt).getTime() > now);
	doc.invites.push(invite);
	writeDoc(doc);
	return invite;
}

export function listInvites(): InviteRecord[] {
	const now = Date.now();
	return readDoc().invites.filter((i) => !i.usedBy && new Date(i.expiresAt).getTime() > now);
}

export function revokeInvite(code: string): boolean {
	const doc = readDoc();
	const before = doc.invites.length;
	doc.invites = doc.invites.filter((i) => i.code !== code);
	if (doc.invites.length === before) return false;
	writeDoc(doc);
	return true;
}

export function pendingInvite(code: string): InviteRecord | null {
	const invite = readDoc().invites.find((i) => i.code === code);
	if (!invite || invite.usedBy) return null;
	if (new Date(invite.expiresAt).getTime() <= Date.now()) return null;
	return invite;
}

/** Mark the invite consumed by `userId` (idempotent: second use is refused). */
export function consumeInvite(code: string, userId: string): boolean {
	const doc = readDoc();
	const invite = doc.invites.find((i) => i.code === code);
	if (!invite || invite.usedBy) return false;
	invite.usedBy = userId;
	writeDoc(doc);
	return true;
}
