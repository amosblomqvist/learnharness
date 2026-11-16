/**
 * The temp folders a Claude Code turn writes (stream.ts createTurnFiles): an
 * empty working folder, and a private one with the system prompt and the MCP
 * config, which carries the loopback bridge's bearer token. A turn removes
 * both when it closes; a turn the app never finishes (stopped mid-turn)
 * leaves them behind, so the first turn of each process removes any older
 * than STALE_TURN_MS.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TURN_CWD_PREFIX = "claude-code-cwd-";
export const TURN_PRIVATE_PREFIX = "claude-code-private-";

/** Older than any turn: a younger folder may belong to a turn still running,
 *  in this process or another instance of the app. */
export const STALE_TURN_MS = 24 * 60 * 60_000;

/** A prefix, then mkdtemp's six-character suffix. */
const TURN_FOLDER = new RegExp(`^(?:${TURN_CWD_PREFIX}|${TURN_PRIVATE_PREFIX})[A-Za-z0-9]{6}$`);

async function isStaleTurnFolder(dir: string, name: string, cutoff: number): Promise<boolean> {
	if (!TURN_FOLDER.test(name)) return false;
	const stat = await lstat(join(dir, name)); // lstat: a link is never followed
	return stat.isDirectory() && stat.mtimeMs < cutoff;
}

async function removeIfStale(dir: string, name: string, cutoff: number): Promise<string | null> {
	if (!(await isStaleTurnFolder(dir, name, cutoff))) return null;
	await rm(join(dir, name), { recursive: true, force: true });
	return name;
}

/** Remove turn folders in `dir` last modified more than `maxAgeMs` before
 *  `now`; the names removed. Entries that cannot be checked or removed (in
 *  use, another account's) are left as they are. */
export async function sweepStaleTurnFiles(dir = tmpdir(), now = Date.now(), maxAgeMs = STALE_TURN_MS): Promise<string[]> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const results = await Promise.allSettled(names.map((name) => removeIfStale(dir, name, now - maxAgeMs)));
	return results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
}

let sweep: Promise<string[]> | undefined;

/** The process's one sweep of the temp folder, started by its first turn. */
export function sweepStaleTurnFilesOnce(): Promise<string[]> {
	sweep ??= sweepStaleTurnFiles();
	return sweep;
}
