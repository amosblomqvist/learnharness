/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { readFileAccessSettings } from "../store/settings.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(): FileAccessPolicy {
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	if (!result.settings.restricted) return { restricted: false, folders: [] };
	const folders = result.settings.folders.map((folder) => expandFolder(folder));
	// Web uploads (POST /api/attachments) land in the app's own data dir; the
	// agent must be able to read what the user just attached, so this root is
	// always allowed alongside the learner's chosen folders.
	try {
		fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
		if (!folders.includes(ATTACHMENTS_DIR)) folders.push(ATTACHMENTS_DIR);
	} catch {
		/* an unwritable data dir surfaces as the agent's own read error */
	}
	return { restricted: true, folders };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
