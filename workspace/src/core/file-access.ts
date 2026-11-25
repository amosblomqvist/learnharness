/** Non-secret, user-wide learner-source preferences. Absence means OFF;
 * an explicitly restricted empty list means no learner-source access. */
export interface FileAccessSettings {
	restricted: boolean;
	folders: string[];
}

/** Portable syntax for the editor/parser. The server additionally checks
 * whether a path is absolute on ITS filesystem before enforcing it. */
export function isFileAccessFolder(folder: string): boolean {
	return !folder.includes("\0") && (folder === "~" || folder.startsWith("~/") || folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("\\\\"));
}

export type FileAccessSettingsResult =
	| { ok: true; settings: FileAccessSettings }
	| { ok: false; error: string };

/** Security-sensitive preferences use the SAME strict read/write parser:
 * malformed policy must not disappear into a default-unrestricted value. */
export function parseFileAccessSettings(raw: unknown): FileAccessSettingsResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "fileAccess must be an object" };
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).some((key) => key !== "restricted" && key !== "folders")) {
		return { ok: false, error: "fileAccess contains unsupported fields" };
	}
	if (value.restricted !== undefined && typeof value.restricted !== "boolean") {
		return { ok: false, error: "fileAccess.restricted must be a boolean" };
	}
	if (value.folders !== undefined && !Array.isArray(value.folders)) {
		return { ok: false, error: "fileAccess.folders must be an array" };
	}
	const folders: string[] = [];
	for (const entry of (value.folders ?? []) as unknown[]) {
		if (typeof entry !== "string" || !isFileAccessFolder(entry.trim())) {
			return { ok: false, error: "fileAccess.folders entries must be absolute paths (or start with ~/), without NUL characters" };
		}
		const folder = entry.trim();
		if (!folders.includes(folder)) folders.push(folder);
	}
	return { ok: true, settings: { restricted: value.restricted === true, folders } };
}
