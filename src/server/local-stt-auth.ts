/** The local transcription key, bound to the base URL it was saved for (the
 * custom endpoint's credential-binding principle). The key and its binding
 * are written together in one atomic auth record write; a base-URL change
 * clears both before the new URL is stored, and a binding that does not
 * match the current URL is never sent. The environment variable is not read:
 * an environment value cannot carry a binding. */
import { LOCAL_STT_KEY_ID } from "../core/dictation.ts";
import { resolveSettings } from "../core/settings-resolution.ts";
import type { DictationSettings } from "../core/settings.ts";
import { validateKeyShape } from "../core/auth-keys.ts";
import { readLocalSttAuth, writeLocalSttAuth } from "../store/auth.ts";
import { readSettings } from "../store/settings.ts";

/** The effective local base URL for a stored dictation section. */
export function effectiveLocalSttBaseUrl(section: DictationSettings | undefined): string {
	return resolveSettings({ version: 1, dictation: section ?? {} }).dictation.localBaseUrl;
}

/** The stored key, only when it was saved for exactly `baseUrl`. */
export function localSttKeyFor(baseUrl: string): string | undefined {
	try {
		const auth = readLocalSttAuth();
		if (auth.binding?.baseUrl !== baseUrl) return undefined;
		return auth.fileKey()?.trim() || undefined;
	} catch {
		return undefined; // unreadable auth record: send nothing
	}
}

/** Is a stored key present and bound to the current URL? (status view) */
export function localSttKeyUsable(): boolean {
	return localSttKeyFor(effectiveLocalSttBaseUrl(readSettings()?.dictation)) !== undefined;
}

/** Save a key bound to the currently configured local base URL. */
export function saveLocalSttKey(value: string): { ok: true } | { ok: false; error: string } {
	const shape = validateKeyShape(LOCAL_STT_KEY_ID, value);
	if (!shape.ok) return shape;
	const baseUrl = effectiveLocalSttBaseUrl(readSettings()?.dictation);
	writeLocalSttAuth({ version: 1, baseUrl }, value.trim());
	return { ok: true };
}

export function deleteLocalSttKey(): void {
	writeLocalSttAuth(undefined, undefined);
}

/** Before a dictation write: if the effective base URL changes, clear the key
 * and its binding FIRST, so a failed settings write still fails closed.
 * Returns whether a stored key was cleared. */
export function clearLocalSttKeyOnRebind(before: DictationSettings | undefined, after: DictationSettings): boolean {
	if (effectiveLocalSttBaseUrl(before) === effectiveLocalSttBaseUrl(after)) return false;
	const auth = readLocalSttAuth();
	if (auth.binding === undefined && auth.fileKey() === undefined) return false;
	writeLocalSttAuth(undefined, undefined);
	return auth.fileKey() !== undefined;
}
