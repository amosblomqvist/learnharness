/**
 * The profile registry adapter (multi-user profiles, 2026-10-27): three
 * small JSON files at the install root (config.INSTALL) — users.json
 * (profiles), host.json (admin switches), sessions.json (browser session
 * id → profile id). Read-modify-write with atomic tmp+rename swaps; the
 * read-modify-write sections contain no awaits, so they are atomic within
 * the single-threaded event loop.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INSTALL, isUserId } from "../../config.ts";
import {
	DEFAULT_HOST_SETTINGS,
	isProfileColor,
	isValidPin,
	type HostSettings,
	type Profile,
} from "../core/users.ts";

export interface SessionEntry {
	userId: string;
	createdAt: string;
}

/** Sessions older than this are dropped whenever a new one is issued. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, file);
}

function sanitizeProfile(raw: unknown): Profile | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (!isUserId(r.id) || typeof r.name !== "string" || !isProfileColor(r.color)) return null;
	if (r.role !== "admin" && r.role !== "member") return null;
	return {
		id: r.id,
		name: r.name,
		color: r.color,
		role: r.role,
		...(isValidPin(r.pin) ? { pin: r.pin } : {}),
		createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
	};
}

/** True once the first profile exists — the install is claimed. */
export function registryExists(): boolean {
	return fs.existsSync(INSTALL.users);
}

export function readProfiles(): Profile[] {
	const raw = readJson(INSTALL.users) as { profiles?: unknown } | null;
	if (!raw || !Array.isArray(raw.profiles)) return [];
	return raw.profiles.map(sanitizeProfile).filter((p): p is Profile => p !== null);
}

export function writeProfiles(profiles: readonly Profile[]): void {
	writeJson(INSTALL.users, { version: 1, profiles });
}

export function readHostSettings(): HostSettings {
	const raw = readJson(INSTALL.host) as Partial<HostSettings> | null;
	return {
		restrictedSignups:
			typeof raw?.restrictedSignups === "boolean" ? raw.restrictedSignups : DEFAULT_HOST_SETTINGS.restrictedSignups,
	};
}

export function writeHostSettings(settings: HostSettings): void {
	writeJson(INSTALL.host, settings);
}

function readSessions(): Record<string, SessionEntry> {
	const raw = readJson(INSTALL.sessions);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, SessionEntry> = {};
	for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
		const e = entry as Partial<SessionEntry> | null;
		if (e && isUserId(e.userId) && typeof e.createdAt === "string") out[id] = { userId: e.userId, createdAt: e.createdAt };
	}
	return out;
}

/** Issue a random session id bound to the profile. */
export function createSession(userId: string): string {
	const now = Date.now();
	const sessions = Object.fromEntries(
		Object.entries(readSessions()).filter(([, e]) => now - Date.parse(e.createdAt) < SESSION_MAX_AGE_MS),
	);
	const id = crypto.randomBytes(32).toString("hex");
	sessions[id] = { userId, createdAt: new Date(now).toISOString() };
	writeJson(INSTALL.sessions, sessions);
	return id;
}

export function sessionUserId(sessionId: string): string | null {
	return readSessions()[sessionId]?.userId ?? null;
}

export function deleteSession(sessionId: string): void {
	const sessions = readSessions();
	if (!(sessionId in sessions)) return;
	delete sessions[sessionId];
	writeJson(INSTALL.sessions, sessions);
}

/** Drop every session of a profile (profile deleted). */
export function deleteSessionsOf(userId: string): void {
	const sessions = readSessions();
	const kept = Object.fromEntries(Object.entries(sessions).filter(([, e]) => e.userId !== userId));
	if (Object.keys(kept).length !== Object.keys(sessions).length) writeJson(INSTALL.sessions, kept);
}

export function mintUserId(): string {
	return `usr_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}
