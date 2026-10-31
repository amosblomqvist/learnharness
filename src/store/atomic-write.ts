/**
 * Crash-safe file replacement for the store adapters (#403).
 *
 * writeFileAtomicSync(file, text) replaces files so readers, or the next
 * boot, see the old bytes or the new bytes, never empty or half-written
 * files. It writes the temp file beside the target, fsyncs it, and renames it
 * over the target. Every store write goes through here instead of
 * fs.writeFileSync. Callers keep building the exact bytes and keep their own
 * mkdirSync.
 *
 *   writeFileAtomicSync(file, JSON.stringify(record, null, "\t"));
 *   writeFileAtomicSync(AUTH_FILE, text, { mode: 0o600 }); // secrets
 *   removeLeftoverTemps(file); // after deleting `file`
 *
 * Limits:
 *  - Safe against process crashes and, because the temp file is fsynced,
 *    against power cuts. The folder is not fsynced, so after power cuts the
 *    file may still hold the old version, complete.
 *  - No locking: two writers of one file still race, and the last one wins.
 *  - Windows refuses to rename over files another process holds open
 *    (antivirus, the Search indexer, backup tools). The rename is retried for
 *    about 100 ms, blocking the thread. If the file is still held, the save
 *    falls back to writing in place, which is only as safe as before #403;
 *    the fsynced temp file stays until that write lands.
 *  - Symlinked targets are written in place, so the link survives.
 *  - Crashes can leave `<file>.tmp-<uuid>` beside the target. Store listings
 *    only read names ending in .json or .md, so they skip it.
 *  - New files get `mode` (default 0o666 minus umask), not the old file's.
 */

import fs from "node:fs"; // default import on purpose: tests patch fs.renameSync on this object, namespace imports would not see it
import path from "node:path";
import { randomUUID } from "node:crypto";

const TEMP_MARKER = ".tmp-";
const RENAME_RETRY_MS = 100;

/** Replace `file` with `text` (UTF-8). Throws on failure, with the old file untouched. */
export function writeFileAtomicSync(file: string, text: string, options?: { mode?: number }): void {
	if (isSymlink(file)) {
		fs.writeFileSync(file, text, { encoding: "utf-8", mode: options?.mode });
		return;
	}
	const tmp = `${file}${TEMP_MARKER}${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", options?.mode ?? 0o666);
		try {
			if (options?.mode !== undefined) fs.fchmodSync(fd, options.mode); // umask may have cleared bits of the create mode
			fs.writeFileSync(fd, text, "utf-8");
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		// `file` goes to renameSync exactly as given: test fault hooks match on it.
		if (renameRetryingSync(tmp, file)) return;
		console.warn(`[store] ${file} is held open by another program; saved it in place`);
		fs.writeFileSync(file, text, "utf-8");
		removeTemp(tmp);
	} catch (error) {
		removeTemp(tmp);
		throw error;
	}
}

/** Delete temp files that crashes left beside `file`. Call it after deleting `file`,
 *  or leftovers would keep the deleted record's newest bytes on disk. */
export function removeLeftoverTemps(file: string): void {
	const prefix = `${path.basename(file)}${TEMP_MARKER}`;
	let names: string[];
	try {
		names = fs.readdirSync(path.dirname(file));
	} catch (error) {
		// No folder means no leftovers. Anything else is reported, not thrown:
		// the record itself is already deleted.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[store] could not look for temp files beside ${file}:`, error);
		return;
	}
	for (const name of names) if (name.startsWith(prefix)) removeTemp(path.join(path.dirname(file), name));
}

/** True when the rename landed, false when Windows kept refusing because
 *  another process holds the target. Every other failure throws. */
function renameRetryingSync(tmp: string, file: string): boolean {
	const deadline = Date.now() + RENAME_RETRY_MS;
	for (let delay = 5; ; delay = Math.min(delay * 2, 40)) {
		try {
			fs.renameSync(tmp, file);
			return true;
		} catch (error) {
			if (!isSharingViolation(error, file)) throw error;
			if (Date.now() >= deadline) return false;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); // sleep without spinning
		}
	}
}

/** Windows rename errors that held handles explain (on the target, or on
 *  the fresh temp file when scanners open it). Read-only files or folders
 *  at the target fail the same way, but waiting can't fix those. */
function isSharingViolation(error: unknown, file: string): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) return false;
	let stat: fs.Stats | undefined;
	try {
		stat = fs.statSync(file, { throwIfNoEntry: false });
	} catch {
		return false; // can't tell: report the rename error itself
	}
	if (!stat) return true; // no target yet: the handle is on the temp file
	return stat.isFile() && (stat.mode & 0o200) !== 0;
}

function isSymlink(file: string): boolean {
	return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false; // missing: plain new file
}

function removeTemp(tmp: string): void {
	try {
		fs.rmSync(tmp, { force: true });
	} catch (error) {
		console.warn(`[store] could not remove temp file ${tmp}:`, error); // harmless: listings skip it
	}
}
