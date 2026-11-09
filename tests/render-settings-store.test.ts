import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-render-settings-"));
process.env.LH_DATA_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { RENDER_SETTINGS_FILE } = await import("../config.ts");
const { readRenderSettings } = await import("../src/store/render-settings.ts");
afterEach(() => fs.rmSync(RENDER_SETTINGS_FILE, { recursive: true, force: true }));

it("reads no settings file as nothing saved yet", () => {
	assert.equal(readRenderSettings(), null);
});

it("throws when the settings file exists but cannot be read", () => {
	fs.mkdirSync(RENDER_SETTINGS_FILE, { recursive: true });
	assert.throws(() => readRenderSettings(), { code: "EISDIR" });
});

it("reads corrupt JSON as nothing saved yet", () => {
	fs.mkdirSync(path.dirname(RENDER_SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(RENDER_SETTINGS_FILE, "{ not json");
	assert.equal(readRenderSettings(), null);
});
