/**
 * Agent file tools must not open plugin secrets: credentials.json (and its
 * atomic-write temp) inside core-plugin-data/<id> or plugins/<id>/data.
 * LH_DATA_DIR points at one throwaway folder BEFORE the first config import
 * (module-load-bound seam), so no real plugin data is touched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-credentials-")));
process.env.LH_DATA_DIR = DATA;

// Import AFTER the env redirect.
const { isSensitivePath, resolveSourcePath, walkFiles } = await import("../src/agent/tools/fs-shared.ts");

after(() => {
	fs.rmSync(DATA, { recursive: true, force: true });
});

const TEMP = ".credentials.json-0b5c1e8a-3f2d-4c6b-9a1e-7d4f2b8c6e10.tmp";
const core = path.join(DATA, "core-plugin-data", "listening");
const community = path.join(DATA, "plugins", "some-plugin", "data");

describe("plugin credential files", () => {
	it("denies credentials.json and its temp in core and community plugin data folders", () => {
		for (const file of [path.join(core, "credentials.json"), path.join(core, TEMP), path.join(community, "credentials.json"), path.join(community, TEMP)]) {
			assert.equal(isSensitivePath(file), true, file);
		}
	});

	it("keeps other plugin data and look-alike paths readable", () => {
		for (const file of [
			path.join(core, "settings.json"),
			path.join(core, "cache", "credentials.json"),
			path.join(DATA, "core-plugin-data", "credentials.json"),
			path.join(DATA, "plugins", "some-plugin", "credentials.json"),
			path.join(DATA, "notes", "credentials.json"),
		]) {
			assert.equal(isSensitivePath(file), false, file);
		}
	});

	it("read refuses the key file and walks skip it", async () => {
		fs.mkdirSync(core, { recursive: true });
		fs.writeFileSync(path.join(core, "credentials.json"), JSON.stringify({ version: 1, keys: { elevenlabs: "synthetic-key" } }));
		fs.writeFileSync(path.join(core, "settings.json"), JSON.stringify({ version: 1 }));
		assert.throws(() => resolveSourcePath(path.join(core, "credentials.json")), /Access denied/);
		const visited: string[] = [];
		await walkFiles(DATA, (file) => { visited.push(path.basename(file)); return true; });
		assert.deepEqual(visited.sort(), ["settings.json"]);
	});
});
