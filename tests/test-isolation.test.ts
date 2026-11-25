/** The test run must never point at the real data folder, auth file or home
 *  (tests/setup.mjs, loaded by `npm test`). */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AUTH_FILE, PATHS, ROOT } from "../config.ts";

describe("test isolation", () => {
	it("keeps data, auth and home out of the repo and the real home", () => {
		const tmp = path.resolve(os.tmpdir());
		for (const p of [PATHS.data, AUTH_FILE, os.homedir()]) {
			assert.ok(path.resolve(p).startsWith(tmp + path.sep), `${p} is not under ${tmp}`);
		}
		assert.notEqual(PATHS.data, path.join(ROOT, "data"));
		assert.notEqual(AUTH_FILE, path.join(ROOT, "auth.json"));
	});
});
