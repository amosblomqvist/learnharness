/**
 * The readAloud settings section (ElevenLabs voice slice 9): sanitizer,
 * resolution (absent = default), the body parser and the section PUT, which
 * replaces the whole section and leaves its siblings alone.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_TTS_VOICE_ID } from "../src/core/index.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseReadAloudSettingsBody } from "../src/server/settings-body.ts";

const testData = mkdtempSync(path.join(tmpdir(), "lh-read-aloud-settings-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

describe("sanitizeUserSettings: readAloud", () => {
	const sanitize = (readAloud: unknown) => sanitizeUserSettings({ version: 1, readAloud })?.readAloud;

	it("keeps plain-id voice and model", () => {
		assert.deepEqual(sanitize({ voiceId: "Xb7hH8MSUJpSbSDYk0k2", modelId: "eleven_flash_v2_5" }), { voiceId: "Xb7hH8MSUJpSbSDYk0k2", modelId: "eleven_flash_v2_5" });
		assert.deepEqual(sanitize({ modelId: "eleven_v3" }), { modelId: "eleven_v3" });
	});

	it("drops anything that is not a plain id, each field on its own", () => {
		assert.deepEqual(sanitize({ voiceId: "../x", modelId: "eleven_v3" }), { modelId: "eleven_v3" });
		assert.deepEqual(sanitize({ voiceId: 7, modelId: "a b", autoRead: "yes" }), {});
		assert.deepEqual(sanitize({ voiceId: "" }), {});
		for (const raw of [null, [], "nope", 3]) assert.deepEqual(sanitize(raw), {});
	});
});

describe("readAloud.autoRead", () => {
	const sanitize = (readAloud: unknown) => sanitizeUserSettings({ version: 1, readAloud })?.readAloud;

	it("is kept when boolean and dropped otherwise", () => {
		assert.deepEqual(sanitize({ autoRead: true }), { autoRead: true });
		assert.deepEqual(sanitize({ voiceId: "abc", autoRead: false }), { voiceId: "abc", autoRead: false });
		for (const autoRead of [1, "true", null, {}]) assert.deepEqual(sanitize({ autoRead }), {}, JSON.stringify(autoRead));
	});

	it("resolves to off by default and when invalid, on when saved on", () => {
		assert.equal(resolveSettings(null).readAloud.autoRead, false);
		assert.equal(resolveSettings({ version: 1, readAloud: {} }).readAloud.autoRead, false);
		assert.equal(resolveSettings({ version: 1, readAloud: { autoRead: "on" } as never }).readAloud.autoRead, false);
		assert.equal(resolveSettings({ version: 1, readAloud: { autoRead: true } }).readAloud.autoRead, true);
	});

	it("the body parser accepts a boolean and rejects anything else", () => {
		assert.deepEqual(parseReadAloudSettingsBody({ autoRead: true }), { ok: true, settings: { autoRead: true } });
		for (const autoRead of ["true", 1, null]) assert.equal(parseReadAloudSettingsBody({ autoRead }).ok, false, JSON.stringify(autoRead));
	});
});

describe("readAloud resolution", () => {
	it("absent means the default voice and an unchosen model", () => {
		assert.deepEqual(resolveSettings(null).readAloud, { voiceId: DEFAULT_TTS_VOICE_ID, modelId: undefined, autoRead: false });
		assert.deepEqual(resolveSettings({ version: 1, readAloud: {} }).readAloud, { voiceId: DEFAULT_TTS_VOICE_ID, modelId: undefined, autoRead: false });
	});

	it("saved values win", () => {
		assert.deepEqual(
			resolveSettings({ version: 1, readAloud: { voiceId: "abc", modelId: "eleven_v3" } }).readAloud,
			{ voiceId: "abc", modelId: "eleven_v3", autoRead: false },
		);
	});
});

describe("parseReadAloudSettingsBody", () => {
	it("accepts each field optionally", () => {
		assert.deepEqual(parseReadAloudSettingsBody({ voiceId: "abc", modelId: "eleven_v3" }), { ok: true, settings: { voiceId: "abc", modelId: "eleven_v3" } });
		assert.deepEqual(parseReadAloudSettingsBody({ voiceId: "abc" }), { ok: true, settings: { voiceId: "abc" } });
		assert.deepEqual(parseReadAloudSettingsBody({}), { ok: true, settings: {} });
	});

	it("rejects non-plain ids and non-objects", () => {
		for (const body of [{ voiceId: "../x" }, { modelId: "a b" }, { voiceId: 5 }, { modelId: null }, null, []]) {
			assert.equal(parseReadAloudSettingsBody(body).ok, false, JSON.stringify(body));
		}
	});
});

it("the section route replaces the whole readAloud section and leaves siblings alone", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false }, dictation: { language: "pl" } });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/readAloud", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "readAloud" }) });

	assert.equal((await put({ voiceId: "abc", modelId: "eleven_v3" })).status, 200);
	const saved = { version: 1, general: { autoUpdate: false }, dictation: { language: "pl" }, readAloud: { voiceId: "abc", modelId: "eleven_v3" } };
	assert.deepEqual(readSettings(), saved);

	assert.equal((await put({ voiceId: "../x" })).status, 400);
	assert.deepEqual(readSettings(), saved, "a rejected write changes nothing");

	assert.equal((await put({ modelId: "eleven_v3" })).status, 200);
	assert.deepEqual(readSettings()?.readAloud, { modelId: "eleven_v3" }, "an omitted voice is un-chosen (replace-whole)");
});
