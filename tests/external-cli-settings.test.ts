import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";

const testData = mkdtempSync(join(process.cwd(), ".pbi-7-test-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { SETTINGS_SECTIONS } = await import("../src/server/settings-body.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");

test("external CLI opt-ins sanitize invalid values and default to off", () => {
	for (const section of ["claudeCode", "codex", "geminiCli"] as const) {
		assert.equal(sanitizeUserSettings({ version: 1 })?.[section], undefined);
		for (const value of [null, [], true, "on", {}, { enabled: "yes" }, { enabled: 1 }]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, [section]: value })?.[section], {});
		}
		for (const enabled of [true, false]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, [section]: { enabled } })?.[section], { enabled });
		}
	}
});

test("external CLI section parsers validate opt-ins", () => {
	for (const parse of [SETTINGS_SECTIONS.codex, SETTINGS_SECTIONS.geminiCli]) {
		assert.deepEqual(parse({}), { ok: true, settings: {} });
		assert.deepEqual(parse({ enabled: true }), { ok: true, settings: { enabled: true } });
		assert.equal(parse({ enabled: "yes" }).ok, false);
	}
});

test("saving codex preserves the other CLI sections", async () => {
	writeSettings({ version: 1, claudeCode: { enabled: true }, geminiCli: { enabled: false } });
	const response = await PUT(new Request("http://test/api/settings/codex", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
	}), { params: Promise.resolve({ section: "codex" }) });
	assert.equal(response.status, 200);
	assert.deepEqual(readSettings()?.codex, { enabled: true });
	assert.deepEqual(readSettings()?.claudeCode, { enabled: true });
	assert.deepEqual(readSettings()?.geminiCli, { enabled: false });
});
