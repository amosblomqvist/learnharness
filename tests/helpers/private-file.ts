import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/**
 * Assert a secrets file or folder is private to its owner, in the terms the
 * operating system enforces (N4 R1, settled 14-11-2026).
 *
 * On Unix that is the permission bits the app sets (0600 files, 0700
 * folders). Windows ignores those bits and reports 0666 for every file; a
 * file is private there when its access list grants nothing to a broad
 * group, so this checks the access list the file actually has.
 */
const BROAD_GROUPS = /\b(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users|NT AUTHORITY\\INTERACTIVE)\b/i;

export function assertPrivate(file: string, posixMode: number): void {
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(file).mode & 0o777, posixMode, `${file} is not mode ${posixMode.toString(8)}`);
		return;
	}
	const acl = execFileSync("icacls", [file], { encoding: "utf8" });
	assert.doesNotMatch(acl, BROAD_GROUPS, `${file} is readable beyond its owner:\n${acl}`);
}
