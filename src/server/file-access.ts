/**
 * The learner-filesystem policy provider (file-access wave): plugs the
 * settings record and the app's private locations into the agent layer's
 * seam (src/agent/tools/file-access.ts). Installed by the turn composition
 * root (chat-handler.ts) — every tool registry is built there.
 *
 * Read FRESH per tool call: a folder added or removed in the settings page
 * applies to the very next read/ls/find/grep/pdf call, no restart.
 */

import os from "node:os";
import path from "node:path";
import { AUTH_FILE, PATHS, ROOT } from "../../config.ts";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { settingsStore } from "../store/settings.ts";

/** "~" / "~/x" → the home directory; everything else resolved as given. */
export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	return path.resolve(folder);
}

/**
 * The paths the tutor may NEVER read: the BYOK key store, the dev env file,
 * the data dir (chats, graph, jobs, debug recordings), and — in the desktop
 * app — the whole userData directory, which also holds the ChatGPT and
 * subscription credential stores and the logs.
 */
export function privatePaths(env: Record<string, string | undefined> = process.env): string[] {
	const denied = [AUTH_FILE, path.join(ROOT, ".env.local"), PATHS.data];
	if (env.LH_DESKTOP_SERVER === "1") denied.push(path.dirname(AUTH_FILE));
	return denied;
}

export function fileAccessPolicy(): FileAccessPolicy {
	const folders = settingsStore.readSettings()?.agent?.fileAccess?.folders ?? [];
	return { folders: folders.map((f) => expandFolder(f)), denied: privatePaths() };
}
