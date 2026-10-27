/**
 * MULTI-USER PROFILES (2026-10-27): the profile shape, the avatar
 * palette, and the validation rules — pure, browser-safe. The registry
 * itself lives in src/store/users.ts; the session/route seam in
 * src/server/users.ts.
 *
 * Local profiles only: the PIN gates opening a profile in the app, it is
 * not authentication and the files are not encrypted.
 */

export const PROFILE_COLORS = ["rose", "orange", "amber", "lime", "teal", "sky", "indigo", "violet"] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];

/** Each swatch's avatar gradient: light stop → deep stop. */
export const PROFILE_GRADIENTS: Record<ProfileColor, readonly [string, string]> = {
	rose: ["#fda4af", "#e11d48"],
	orange: ["#fdba74", "#ea580c"],
	amber: ["#fcd34d", "#d97706"],
	lime: ["#bef264", "#65a30d"],
	teal: ["#5eead4", "#0d9488"],
	sky: ["#7dd3fc", "#0284c7"],
	indigo: ["#a5b4fc", "#4f46e5"],
	violet: ["#c4b5fd", "#7c3aed"],
};

export type ProfileRole = "admin" | "member";

/** One stored profile (users.json). `pin` is plaintext; absent = no PIN. */
export interface Profile {
	id: string;
	name: string;
	color: ProfileColor;
	role: ProfileRole;
	pin?: string;
	createdAt: string;
}

/** What the browser sees: never the PIN itself. */
export interface PublicProfile {
	id: string;
	name: string;
	color: ProfileColor;
	role: ProfileRole;
	hasPin: boolean;
}

/** Install-wide switches the admin owns (host.json). */
export interface HostSettings {
	restrictedSignups: boolean;
}

export const DEFAULT_HOST_SETTINGS: HostSettings = { restrictedSignups: false };

/** GET /api/users — everything the select screen needs. */
export interface UsersSnapshot {
	profiles: PublicProfile[];
	host: HostSettings;
	/** The signed-in profile on this browser, if any. */
	current: PublicProfile | null;
	/** True when the select screen may offer "Add profile". */
	canSignUp: boolean;
	/** Unclaimed install with learner records at the root: the first
	 *  profile takes them over. */
	existingData: boolean;
}

export const PROFILE_NAME_MAX = 32;

export function isProfileColor(value: unknown): value is ProfileColor {
	return typeof value === "string" && (PROFILE_COLORS as readonly string[]).includes(value);
}

export function publicProfile(profile: Profile): PublicProfile {
	return { id: profile.id, name: profile.name, color: profile.color, role: profile.role, hasPin: !!profile.pin };
}

/** Trimmed, inner whitespace collapsed. */
export function normalizeProfileName(raw: string): string {
	return raw.trim().replace(/\s+/g, " ");
}

/** null = valid; otherwise the reason, shown inline. */
export function profileNameProblem(name: string, others: readonly { name: string }[] = []): string | null {
	if (name.length === 0) return "Enter a name.";
	if (name.length > PROFILE_NAME_MAX) return `Keep the name under ${PROFILE_NAME_MAX + 1} characters.`;
	const lower = name.toLowerCase();
	if (others.some((p) => p.name.toLowerCase() === lower)) return "Another profile already has that name.";
	return null;
}

/** PINs are 4–8 digits. */
export function isValidPin(value: unknown): value is string {
	return typeof value === "string" && /^\d{4,8}$/.test(value);
}

/** First letter of the first two words; a single word gives its first two letters. */
export function profileInitials(name: string): string {
	const words = normalizeProfileName(name).split(" ").filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
	return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

/** The avatar's CSS background. */
export function profileGradient(color: ProfileColor): string {
	const [from, to] = PROFILE_GRADIENTS[color];
	return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}
