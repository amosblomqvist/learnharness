import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFileAccessFolder, parseFileAccessSettings } from "../src/core/file-access.ts";

// file-access-settings.test.ts covers the persisted policy and HTTP repair.
// These pins cover the portable path grammar and the strict read parser itself.
describe("isFileAccessFolder", () => {
	it("accepts home, POSIX, Windows drive and UNC roots", () => {
		for (const folder of ["~", "~/notes", "/home/u/notes", "C:\\notes", "C:/notes", "\\\\nas\\share"]) {
			assert.equal(isFileAccessFolder(folder), true, folder);
		}
	});

	it("rejects relative paths, bare drives and NUL characters", () => {
		for (const folder of ["", "notes", "a/b", "C:", "C:notes", "~/a\0b"]) {
			assert.equal(isFileAccessFolder(folder), false, folder);
		}
	});
});

describe("parseFileAccessSettings", () => {
	it("absence means unrestricted and off; an explicit empty list is still restricted", () => {
		assert.deepEqual(parseFileAccessSettings({}), { ok: true, settings: { restricted: false, folders: [] } });
		assert.deepEqual(parseFileAccessSettings({ restricted: true, folders: [] }), { ok: true, settings: { restricted: true, folders: [] } });
	});

	it("trims and deduplicates folder entries", () => {
		assert.deepEqual(parseFileAccessSettings({ folders: ["/a", "/a", " /a " ] }),
			{ ok: true, settings: { restricted: false, folders: ["/a"] } });
	});

	it("fails closed on malformed or unsupported input", () => {
		assert.equal(parseFileAccessSettings(null).ok, false);
		assert.equal(parseFileAccessSettings([]).ok, false);
		assert.equal(parseFileAccessSettings({ extra: 1 }).ok, false);
		assert.equal(parseFileAccessSettings({ restricted: "yes" }).ok, false);
		assert.equal(parseFileAccessSettings({ folders: {} }).ok, false);
		assert.equal(parseFileAccessSettings({ folders: ["relative"] }).ok, false);
		assert.equal(parseFileAccessSettings({ folders: [1] }).ok, false);
	});
});
