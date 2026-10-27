/**
 * THE PROFILE SEAM (multi-user profiles, 2026-10-27): browser sessions,
 * who may do what, the first-profile claim, and `withUser` — the wrapper
 * every learner route runs under so the stores resolve the signed-in
 * profile's folder (config.ts learnerRoot).
 *
 * Rules:
 * - The first profile is the only admin; it claims an unclaimed install.
 * - Anyone may add a profile from the select screen while restricted
 *   signups is off; the admin always may.
 * - Everyone edits their own name, color, and PIN; the admin edits anyone.
 * - Only the admin deletes, never an admin profile (so never itself).
 *
 * The PIN only gates opening a profile through the app. Local profiles,
 * not authentication; nothing is encrypted.
 */

import fs from "node:fs";
import path from "node:path";
import { INSTALL, LEARNER_ENTRIES, runAsUser, userDataDir } from "../../config.ts";
import {
	isProfileColor,
	isValidPin,
	normalizeProfileName,
	profileNameProblem,
	publicProfile,
	type Profile,
	type ProfileColor,
	type PublicProfile,
	type UsersSnapshot,
} from "../core/users.ts";
import {
	createSession,
	deleteSession,
	deleteSessionsOf,
	mintUserId,
	readHostSettings,
	readProfiles,
	registryExists,
	sessionUserId,
	writeHostSettings,
	writeProfiles,
} from "../store/users.ts";

export { registryExists } from "../store/users.ts";
export { runAsUser, activeUserId } from "../../config.ts";

export const SESSION_COOKIE = "lh_session";

/** A refused profile operation; the route turns it into its status. */
export class UsersError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "UsersError";
	}
}

function cookieValue(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
	}
	return null;
}

/** The profile id behind a session id, if the session and profile both exist. */
export function sessionProfileId(sessionId: string | null | undefined): string | null {
	if (!sessionId) return null;
	const userId = sessionUserId(sessionId);
	if (!userId) return null;
	return readProfiles().some((p) => p.id === userId) ? userId : null;
}

export function requestSessionId(req: Request | undefined): string | null {
	return req ? cookieValue(req.headers.get("cookie"), SESSION_COOKIE) : null;
}

export function requestProfile(req: Request | undefined): Profile | null {
	const id = sessionProfileId(requestSessionId(req));
	return id ? (readProfiles().find((p) => p.id === id) ?? null) : null;
}

/** Session cookie: no Max-Age, so a closed app or browser lands on the
 *  select screen again. */
export function sessionCookieHeader(sessionId: string): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearedSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Unclaimed install that already holds learner records at the root. */
export function hasUnclaimedData(): boolean {
	if (registryExists()) return false;
	return LEARNER_ENTRIES.some((entry) => fs.existsSync(path.join(INSTALL.root, entry)));
}

function canSignUp(caller: Profile | null, profiles: readonly Profile[]): boolean {
	if (profiles.length === 0) return true;
	if (caller?.role === "admin") return true;
	return !readHostSettings().restrictedSignups;
}

export function usersSnapshot(req: Request | undefined): UsersSnapshot {
	const profiles = readProfiles();
	const caller = requestProfile(req);
	return {
		profiles: profiles.map(publicProfile),
		host: readHostSettings(),
		current: caller ? publicProfile(caller) : null,
		canSignUp: canSignUp(caller, profiles),
		existingData: hasUnclaimedData(),
	};
}

interface ProfileInput {
	name?: unknown;
	color?: unknown;
	pin?: unknown;
}

function parseName(raw: unknown, others: readonly Profile[]): string {
	if (typeof raw !== "string") throw new UsersError(400, "Enter a name.");
	const name = normalizeProfileName(raw);
	const problem = profileNameProblem(name, others);
	if (problem) throw new UsersError(400, problem);
	return name;
}

function parseColor(raw: unknown): ProfileColor {
	if (!isProfileColor(raw)) throw new UsersError(400, "Pick a color.");
	return raw;
}

/** undefined = leave as is, null = clear, string = set. */
function parsePin(raw: unknown): string | null | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || raw === "") return null;
	if (!isValidPin(raw)) throw new UsersError(400, "A PIN is 4 to 8 digits.");
	return raw;
}

/** Move an unclaimed root's learner entries into the first profile's folder. */
function claimRoot(userId: string): void {
	const dir = userDataDir(userId);
	fs.mkdirSync(dir, { recursive: true });
	for (const entry of LEARNER_ENTRIES) {
		const from = path.join(INSTALL.root, entry);
		if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, entry));
	}
}

/**
 * Add a profile. The first one is the admin and claims the install. A
 * request with no signed-in profile (the select screen) is signed in as
 * the new profile; the admin adding someone from Settings stays put.
 */
export function createProfile(req: Request | undefined, input: ProfileInput): { profile: PublicProfile; sessionId: string | null } {
	const profiles = readProfiles();
	const caller = requestProfile(req);
	if (!canSignUp(caller, profiles)) throw new UsersError(403, "Sign-ups are restricted. Ask the admin to add you.");
	const name = parseName(input.name, profiles);
	const color = parseColor(input.color);
	const pin = parsePin(input.pin);
	const first = profiles.length === 0;
	const profile: Profile = {
		id: mintUserId(),
		name,
		color,
		role: first ? "admin" : "member",
		...(pin ? { pin } : {}),
		createdAt: new Date().toISOString(),
	};
	if (first && !registryExists()) claimRoot(profile.id);
	else fs.mkdirSync(userDataDir(profile.id), { recursive: true });
	writeProfiles([...profiles, profile]);
	const sessionId = caller ? null : createSession(profile.id);
	return { profile: publicProfile(profile), sessionId };
}

export function updateProfile(req: Request | undefined, id: string, input: ProfileInput): PublicProfile {
	const profiles = readProfiles();
	const caller = requestProfile(req);
	if (!caller) throw new UsersError(401, "Choose a profile first.");
	const target = profiles.find((p) => p.id === id);
	if (!target) throw new UsersError(404, "No such profile.");
	if (caller.id !== id && caller.role !== "admin") throw new UsersError(403, "Only the admin can edit other profiles.");
	const next: Profile = { ...target };
	if (input.name !== undefined) next.name = parseName(input.name, profiles.filter((p) => p.id !== id));
	if (input.color !== undefined) next.color = parseColor(input.color);
	const pin = parsePin(input.pin);
	if (pin === null) delete next.pin;
	else if (pin !== undefined) next.pin = pin;
	writeProfiles(profiles.map((p) => (p.id === id ? next : p)));
	return publicProfile(next);
}

/** Admin only; an admin profile is never deleted. Removes the folder. */
export function deleteProfile(req: Request | undefined, id: string): void {
	const profiles = readProfiles();
	const caller = requestProfile(req);
	if (!caller) throw new UsersError(401, "Choose a profile first.");
	if (caller.role !== "admin") throw new UsersError(403, "Only the admin can delete profiles.");
	const target = profiles.find((p) => p.id === id);
	if (!target) throw new UsersError(404, "No such profile.");
	if (target.role === "admin") throw new UsersError(409, "The admin profile can't be deleted.");
	writeProfiles(profiles.filter((p) => p.id !== id));
	deleteSessionsOf(id);
	fs.rmSync(userDataDir(id), { recursive: true, force: true });
}

/** Open a profile: checks the PIN when it has one. Returns the session id. */
export function unlockProfile(id: unknown, pin: unknown): string {
	const profile = readProfiles().find((p) => p.id === id);
	if (!profile) throw new UsersError(404, "No such profile.");
	if (profile.pin && profile.pin !== pin) throw new UsersError(401, "Wrong PIN.");
	return createSession(profile.id);
}

export function endSession(req: Request | undefined): void {
	const sessionId = requestSessionId(req);
	if (sessionId) deleteSession(sessionId);
}

export function setRestrictedSignups(req: Request | undefined, restricted: unknown): void {
	const caller = requestProfile(req);
	if (!caller) throw new UsersError(401, "Choose a profile first.");
	if (caller.role !== "admin") throw new UsersError(403, "Only the admin can change sign-ups.");
	if (typeof restricted !== "boolean") throw new UsersError(400, "restrictedSignups must be true or false.");
	writeHostSettings({ ...readHostSettings(), restrictedSignups: restricted });
}

/** The JSON refusal for a UsersError (anything else rethrows). */
export function usersErrorResponse(err: unknown): Response {
	if (err instanceof UsersError) return Response.json({ error: err.message }, { status: err.status });
	throw err;
}

/**
 * Run a route handler as the request's signed-in profile. Unclaimed
 * installs pass straight through (learner paths resolve to the root);
 * once claimed, no valid session = 401.
 */
export function withUser<A extends unknown[]>(
	handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
	return async (...args: A): Promise<Response> => {
		if (!registryExists()) return handler(...args);
		const req = args[0] instanceof Request ? args[0] : undefined;
		const userId = sessionProfileId(requestSessionId(req));
		if (!userId) return Response.json({ error: "Choose a profile first." }, { status: 401 });
		return runAsUser(userId, () => handler(...args));
	};
}
