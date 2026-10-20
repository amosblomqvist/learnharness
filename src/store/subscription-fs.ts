/**
 * Owner-only, durable file primitives for the subscription store.
 *
 * The store directory is private to the instance's account (0700 on
 * POSIX). Every state/journal write is a same-directory temporary file,
 * fsync, rename and parent-directory fsync, so a crash leaves either the
 * old record or the complete new one. Reads open with O_NOFOLLOW and
 * require a regular file; symlinked or non-regular targets fail closed.
 *
 * Windows boundary: Node's core API exposes POSIX mode bits but not NTFS
 * ACLs. On Windows the store therefore relies on the inherited per-user
 * profile ACL of the instance data directory; it can reject unsafe file
 * TYPES but cannot verify or tighten the ACL. No dependency is added for
 * this. On POSIX the UID and 0700/0600 modes are enforced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
	SubscriptionStorageError,
} from "./subscription-types.ts";

const POSIX = process.platform !== "win32";

function systemFailure(
	error: unknown,
	message: string,
	code: "invalid_directory" | "unsafe_permissions" | "unsafe_file_type" | "io" = "io",
): SubscriptionStorageError {
	if (error instanceof SubscriptionStorageError) return error;
	return SubscriptionStorageError.fromSystem(error, code, message);
}

function currentUid(): number | undefined {
	try {
		return typeof process.geteuid === "function" ? process.geteuid() : undefined;
	} catch {
		return undefined;
	}
}

function assertOwnedByCurrentUser(stat: fs.Stats, message: string): void {
	if (!POSIX) return;
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) {
		throw new SubscriptionStorageError("unsafe_permissions", message);
	}
}

function assertPrivateMode(stat: fs.Stats, expected: number, message: string): void {
	if (!POSIX) return;
	if ((stat.mode & 0o777) !== expected) {
		throw new SubscriptionStorageError("unsafe_permissions", message);
	}
}

/**
 * Create (if needed) and canonicalize the store directory, then enforce
 * owner-only access. The returned path is the real path; a symlinked
 * input is resolved once and all later operations use the target.
 */
export function ensurePrivateDirectory(input: string): string {
	let created: string;
	try {
		fs.mkdirSync(input, { recursive: true, mode: 0o700 });
		created = fs.realpathSync(input);
	} catch (error) {
		throw systemFailure(error, "The subscription storage directory could not be prepared.", "invalid_directory");
	}

	let before: fs.Stats;
	try {
		before = fs.statSync(created);
	} catch (error) {
		throw systemFailure(error, "The subscription storage directory could not be inspected.", "invalid_directory");
	}
	if (!before.isDirectory()) {
		throw new SubscriptionStorageError(
			"invalid_directory",
			"The subscription storage path is not a directory.",
		);
	}
	assertOwnedByCurrentUser(
		before,
		"The subscription storage directory is not owned by the current account.",
	);

	if (POSIX) {
		try {
			fs.chmodSync(created, 0o700);
		} catch (error) {
			throw systemFailure(
				error,
				"The subscription storage directory permissions could not be restricted.",
				"unsafe_permissions",
			);
		}
		let after: fs.Stats;
		try {
			after = fs.statSync(created);
		} catch (error) {
			throw systemFailure(
				error,
				"The subscription storage directory could not be inspected.",
				"invalid_directory",
			);
		}
		assertPrivateMode(
			after,
			0o700,
			"The subscription storage directory is not owner-only.",
		);
	}
	return created;
}

export function fsyncDirectory(directory: string): void {
	if (!POSIX) return;
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		// A directory fsync that cannot be performed is a durability
		// failure, not a reason to report a successful atomic write.
		throw systemFailure(error, "The subscription storage directory could not be synchronized.");
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The fsync result is what matters; a close failure cannot
				// retroactively make a successful fsync unsafe.
			}
		}
	}
}

export function lstatOrUndefined(filePath: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
		throw systemFailure(error, "The subscription storage file could not be inspected.");
	}
}

function assertRegularOwnedFile(stat: fs.Stats, messageType: string): void {
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new SubscriptionStorageError("unsafe_file_type", messageType);
	}
	assertOwnedByCurrentUser(stat, "The subscription storage file is not owned by the current account.");
}

/**
 * Read a JSON record. Absent returns undefined; malformed JSON, a symlink,
 * a non-regular file or an unreadable file throws. A relaxed POSIX mode is
 * repaired to 0600 on the open descriptor before any bytes are returned.
 */
export function readOptionalJsonFile(filePath: string, label: string): unknown | undefined {
	const stat = lstatOrUndefined(filePath);
	if (!stat) return undefined;
	assertRegularOwnedFile(stat, `${label} is not a regular file.`);

	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === "ELOOP" || code === "EISDIR") {
			throw new SubscriptionStorageError("unsafe_file_type", `${label} is not a regular file.`);
		}
		throw systemFailure(error, `${label} could not be read.`);
	}

	try {
		const opened = fs.fstatSync(fd);
		assertRegularOwnedFile(opened, `${label} is not a regular file.`);
		if (POSIX && (opened.mode & 0o777) !== 0o600) {
			try {
				fs.fchmodSync(fd, 0o600);
			} catch (error) {
				throw systemFailure(
					error,
					"The subscription storage file permissions could not be restricted.",
					"unsafe_permissions",
				);
			}
		}
		const raw = fs.readFileSync(fd, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			throw new SubscriptionStorageError("invalid_json", `${label} is not valid JSON.`);
		}
	} catch (error) {
		if (error instanceof SubscriptionStorageError) throw error;
		throw systemFailure(error, `${label} could not be read.`);
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// Read-only descriptor; the bytes were already returned.
		}
	}
}

/**
 * Atomically replace (or create) a JSON file. The caller must already hold
 * the store lock and have validated `value`. Any failure is a storage
 * error; a visible rename followed by a failed directory fsync is reported
 * as a failure and the caller's protocol record (e.g. refresh journal) is
 * retained.
 */
export function writeDurableJsonFile(filePath: string, value: unknown): void {
	const existing = lstatOrUndefined(filePath);
	if (existing) assertRegularOwnedFile(existing, "The subscription storage target is not a regular file.");

	const directory = path.dirname(filePath);
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	let fd: number | undefined;
	let renamed = false;
	try {
		fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		if (POSIX) fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, filePath);
		renamed = true;
		fsyncDirectory(directory);
	} catch (error) {
		throw systemFailure(error, "The subscription storage record could not be persisted.");
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The primary failure is reported below.
			}
		}
		if (!renamed) {
			try {
				fs.rmSync(temporary, { force: true });
			} catch {
				// A leftover temporary file is inside the owner-only
				// directory and never becomes authoritative.
			}
		}
	}
}

/**
 * Remove a record durably. Absent is a no-op. A symlink or non-regular
 * target is refused rather than unlinked, so cleanup can never delete some
 * unrelated target outside the store.
 */
export function removeDurableFile(filePath: string, label: string): void {
	const stat = lstatOrUndefined(filePath);
	if (!stat) return;
	assertRegularOwnedFile(stat, `${label} is not a regular file.`);
	try {
		fs.unlinkSync(filePath);
		fsyncDirectory(path.dirname(filePath));
	} catch (error) {
		throw systemFailure(error, `${label} could not be removed.`);
	}
}
