import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The learner-filesystem ACCESS POLICY (file-access wave): which paths the
 * read/ls/find/grep tools and the pdf job may touch. The agent layer may not
 * import settings or config-derived secrets locations, so the policy
 * arrives through this seam — the server composition root installs a
 * provider (src/server/file-access.ts) that reads settings FRESH per call,
 * so a folder change in the settings page applies on the next tool call.
 *
 * Two rules, checked on the REAL path (symlinks resolved first, so a link
 * inside an allowed folder cannot reach outside it):
 *   - denied: the app's own private files (keys, credentials, data dir) are
 *     refused ALWAYS — the tutor has no reason to read them, and a prompt-
 *     injected tutor must not be able to;
 *   - folders: when non-empty, every path must sit inside one of them.
 *     Empty = the home-wide sources-v1 scope.
 */

export interface FileAccessPolicy {
	/** Absolute folders the tools may read inside; empty = unrestricted. */
	folders: readonly string[];
	/** Absolute files/folders never readable, whatever `folders` says. */
	denied: readonly string[];
}

const OPEN_POLICY: FileAccessPolicy = { folders: [], denied: [] };
let currentPolicy: () => FileAccessPolicy = () => OPEN_POLICY;

/** Install the policy provider (composition root only; tests reset it). */
export function setFileAccessPolicy(provider: () => FileAccessPolicy): void {
	currentPolicy = provider;
}

export function fileAccessPolicy(): FileAccessPolicy {
	return currentPolicy();
}

/** The anchor for relative/absent paths: the first allowed folder when the
 *  scope is restricted (home would be refused anyway), else home. */
export function sourceAnchor(policy: FileAccessPolicy = fileAccessPolicy()): string {
	return policy.folders[0] ?? os.homedir();
}

/** `child` is `parent` or lies beneath it (both absolute, normalized). */
export function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath when the path exists; otherwise the resolved path (a denied
 *  file that doesn't exist yet must still match once it does). */
async function realOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/** The policy with every entry realpath-resolved — compare like with like
 *  (macOS: /var → /private/var, /tmp → /private/tmp). */
export async function resolvePolicy(policy: FileAccessPolicy = fileAccessPolicy()): Promise<FileAccessPolicy> {
	const [folders, denied] = await Promise.all([
		Promise.all(policy.folders.map(realOrResolved)),
		Promise.all(policy.denied.map(realOrResolved)),
	]);
	return { folders, denied };
}

/** True when a REAL path is refused by an already-resolved policy. */
export function isRefused(realPath: string, resolved: FileAccessPolicy): boolean {
	if (resolved.denied.some((d) => isWithin(realPath, d))) return true;
	return resolved.folders.length > 0 && !resolved.folders.some((f) => isWithin(realPath, f));
}

/**
 * Gate one tool path: resolve it to its real location and refuse it per the
 * policy. Returns the real path — callers read THAT, never the raw input, so
 * the checked path and the opened path are the same file. Missing paths
 * throw "Path not found" (the tools' existing wording) with the errno code.
 */
export async function guardSourcePath(absolute: string): Promise<string> {
	let real: string;
	try {
		real = await fs.realpath(absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new Error(`Path not found: ${absolute}${code ? ` (${code})` : ""}`);
	}
	const resolved = await resolvePolicy();
	if (resolved.denied.some((d) => isWithin(real, d))) {
		throw new Error(`Access denied: ${absolute} is LearnHarness's private app data (keys, credentials, records) and is never readable by the tutor.`);
	}
	if (isRefused(real, resolved)) {
		throw new Error(
			`Access denied: ${absolute} is outside the folders the learner allowed (${fileAccessPolicy().folders.join(", ")}). ` +
				"Ask the learner to move the file into an allowed folder or add its folder in Settings → Agent → File access.",
		);
	}
	return real;
}
