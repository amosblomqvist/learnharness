import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DICTATION_PROVIDERS, isDictationProvider } from "../src/core/dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

describe("dictation provider setting", () => {
	it("offers exactly Deepgram and Parakeet, and recognizes only those", () => {
		assert.deepEqual([...DICTATION_PROVIDERS], ["deepgram", "parakeet"]);
		assert.equal(isDictationProvider("parakeet"), true);
		for (const bad of ["Parakeet", "whisper", "", null, undefined, 1]) assert.equal(isDictationProvider(bad), false, String(bad));
	});

	it("defaults to Deepgram, including for records written before the provider existed", () => {
		assert.equal(resolveSettings(null).dictation.provider, "deepgram");
		assert.equal(resolveSettings({ version: 1, dictation: { language: "pl" } }).dictation.provider, "deepgram");
		assert.equal(resolveSettings({ version: 1, dictation: { language: "pl" } }).dictation.language, "pl");
	});

	it("keeps a saved provider next to the language and drops invalid providers", () => {
		const both = sanitizeUserSettings({ version: 1, dictation: { language: "pl", provider: "parakeet" } });
		assert.deepEqual(both?.dictation, { language: "pl", provider: "parakeet" });
		assert.equal(resolveSettings(both).dictation.provider, "parakeet");
		const bad = sanitizeUserSettings({ version: 1, dictation: { language: "pl", provider: "whisper" } });
		assert.deepEqual(bad?.dictation, { language: "pl" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { provider: "parakeet" } })?.dictation, { provider: "parakeet" });
	});

	it("parses provider in the section body strictly and keeps the language-only body valid", () => {
		assert.deepEqual(parseDictationSettingsBody({ provider: "parakeet" }), { ok: true, settings: { provider: "parakeet" } });
		assert.deepEqual(
			parseDictationSettingsBody({ language: "multi", provider: "deepgram" }),
			{ ok: true, settings: { language: "multi", provider: "deepgram" } },
		);
		assert.deepEqual(parseDictationSettingsBody({ language: "multi" }), { ok: true, settings: { language: "multi" } });
		for (const provider of ["whisper", 3, null, ""]) assert.equal(parseDictationSettingsBody({ provider }).ok, false, String(provider));
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-provider-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route persists the provider with the language and rejects unknown providers without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false } });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await put({ language: "pl", provider: "parakeet" })).status, 200);
	const saved = { version: 1, dictation: { language: "pl", provider: "parakeet" }, general: { autoUpdate: false } };
	assert.deepEqual(readSettings(), saved);
	assert.equal((await put({ language: "pl", provider: "whisper" })).status, 400);
	assert.deepEqual(readSettings(), saved);
});
