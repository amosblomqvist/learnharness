/**
 * The shell's update state (in-app update controls, owner 2026-10-25):
 * main keeps ONE state, folded from electron-updater's events, so Settings
 * can render whatever happened before it mounted. Pure — no Electron here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { INITIAL_UPDATE_STATE, nextUpdateState, readAutoUpdateSetting } = require("../electron/update-state.cjs");

const fold = (events: object[]) => events.reduce((s, e) => nextUpdateState(s, e), INITIAL_UPDATE_STATE);

describe("nextUpdateState", () => {
	it("starts idle with nothing to say", () => {
		assert.deepEqual(INITIAL_UPDATE_STATE, { status: "idle", version: null, error: null, manual: false });
	});

	it("a manual check that finds nothing ends up-to-date", () => {
		const s = fold([{ type: "checking", manual: true }, { type: "not-available" }]);
		assert.equal(s.status, "up-to-date");
	});

	it("an automatic check that finds nothing goes back to idle (no noise)", () => {
		const s = fold([{ type: "checking", manual: false }, { type: "not-available" }]);
		assert.equal(s.status, "idle");
	});

	it("available → downloading → downloaded carries the version", () => {
		const s1 = fold([{ type: "checking", manual: false }, { type: "available", version: "0.3.8" }]);
		assert.deepEqual([s1.status, s1.version], ["downloading", "0.3.8"]);
		const s2 = nextUpdateState(s1, { type: "downloaded", version: "0.3.8" });
		assert.deepEqual([s2.status, s2.version], ["downloaded", "0.3.8"]);
	});

	it("an error keeps the raw message", () => {
		const s = fold([{ type: "checking", manual: true }, { type: "error", message: "net::ERR_PROXY" }]);
		assert.deepEqual([s.status, s.error], ["error", "net::ERR_PROXY"]);
	});

	it("a new check clears the previous error", () => {
		const s = fold([{ type: "error", message: "x" }, { type: "checking", manual: true }]);
		assert.deepEqual([s.status, s.error], ["checking", null]);
	});

	it("downloaded is sticky: later checks and errors don't hide the staged update", () => {
		const staged = fold([{ type: "downloaded", version: "0.3.8" }]);
		for (const e of [{ type: "checking", manual: true }, { type: "available", version: "0.3.8" }, { type: "not-available" }, { type: "error", message: "x" }])
			assert.equal(nextUpdateState(staged, e), staged, JSON.stringify(e));
	});

	it("a newer download replaces a staged one", () => {
		const s = nextUpdateState(fold([{ type: "downloaded", version: "0.3.8" }]), { type: "downloaded", version: "0.3.9" });
		assert.equal(s.version, "0.3.9");
	});

	it("disabled is terminal (dev / unpackaged builds)", () => {
		const s = fold([{ type: "disabled" }, { type: "checking", manual: true }]);
		assert.equal(s.status, "disabled");
	});
});

describe("readAutoUpdateSetting", () => {
	const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-update-"));

	it("defaults to on with no settings file", () => {
		assert.equal(readAutoUpdateSetting(dir()), true);
	});

	it("defaults to on with a corrupt file", () => {
		const d = dir();
		fs.writeFileSync(path.join(d, "settings.json"), "{nope");
		assert.equal(readAutoUpdateSetting(d), true);
	});

	it("is off only for an explicit false", () => {
		const d = dir();
		fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ general: { autoUpdate: false } }));
		assert.equal(readAutoUpdateSetting(d), false);
		fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ general: { autoUpdate: "no" } }));
		assert.equal(readAutoUpdateSetting(d), true);
	});
});
