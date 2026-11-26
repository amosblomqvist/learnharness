import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-claude-cfg-dir-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { getConfiguredClaudeConfigDir } = await import("../src/agent/claude-code/config-dir.ts");
const { effectiveClaudeConfigDir, expandClaudeConfigDir } = await import("../src/server/claude-code-config.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
await import("../src/server/stores.ts");

test("expandClaudeConfigDir expands ~ and ~/ against the provided home directory", () => {
	const fakeHome = join(tmpdir(), "lh-fake-home");
	assert.equal(expandClaudeConfigDir("~", fakeHome), resolve(fakeHome));
	assert.equal(expandClaudeConfigDir("~/.claude-work", fakeHome), resolve(fakeHome, ".claude-work"));
	const abs = join(tmpdir(), "lh-abs-profile");
	assert.equal(expandClaudeConfigDir(`  ${abs}  `, fakeHome), resolve(abs));
	assert.throws(() => expandClaudeConfigDir("relative/path", fakeHome));
	assert.throws(() => expandClaudeConfigDir("~/../escape", fakeHome));
});

test("src/server/stores.ts wires getConfiguredClaudeConfigDir dynamically to settingsStore", (t) => {
	const previous = readSettings();
	const customDir = mkdtempSync(join(tmpdir(), "lh-cfg-dir-profile-"));
	mkdirSync(join(customDir, "nested"), { recursive: true });
	t.after(() => {
		if (previous) writeSettings(previous);
		else rmSync(SETTINGS_FILE, { force: true });
		rmSync(customDir, { recursive: true, force: true });
	});

	writeSettings({ version: 1, claudeCode: { enabled: true } });
	assert.equal(effectiveClaudeConfigDir(), undefined);
	assert.equal(getConfiguredClaudeConfigDir(), undefined);

	writeSettings({ version: 1, claudeCode: { enabled: true, configDir: customDir } });
	assert.equal(effectiveClaudeConfigDir(), resolve(customDir));
	assert.equal(getConfiguredClaudeConfigDir(), resolve(customDir));

	writeSettings({ version: 1, claudeCode: { enabled: true, configDir: "~/custom-claude" } });
	assert.equal(
		effectiveClaudeConfigDir(customDir),
		resolve(customDir, "custom-claude"),
	);

	writeSettings({ version: 1, claudeCode: { enabled: true } });
	assert.equal(getConfiguredClaudeConfigDir(), undefined);
});
