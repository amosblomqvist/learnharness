import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isValidClaudeConfigDir } from "../src/core/contracts/claude-code.ts";
import { discoverClaudeCodeProfiles } from "../src/server/claude-code-profiles.ts";

function makeTempDir(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("isValidClaudeConfigDir accepts portable absolute and ~/ paths and rejects unsafe values", () => {
	for (const valid of [
		"/",
		"/tmp/claude",
		"/Users/alice/.claude-work",
		"C:\\claude",
		"D:/claude-work",
		"\\\\server\\share\\.claude",
		"~",
		"~/",
		"~/.claude",
		"~/.claude-work",
	]) {
		assert.equal(isValidClaudeConfigDir(valid), true, `expected ${JSON.stringify(valid)} to be valid`);
	}

	for (const invalid of [
		"",
		"   ",
		" /abs",
		"/abs ",
		"/tmp/a\0b",
		"relative",
		"./.claude",
		"../.claude",
		"~user/.claude",
		"/tmp/a/.",
		"/tmp/a/../b",
		"~/.",
		"~/../etc",
		"~/.claude/..",
		"\\\\",
		"\\\\server",
	]) {
		assert.equal(isValidClaudeConfigDir(invalid), false, `expected ${JSON.stringify(invalid)} to be invalid`);
	}
});

test("discoverClaudeCodeProfiles handles empty home directory", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-empty-");
	const result = discoverClaudeCodeProfiles({ homeDir, env: {} });
	assert.equal(result.defaultDir, join(homeDir, ".claude"));
	assert.equal(result.configuredDir, null);
	assert.equal(result.inheritedEnvDir, null);
	assert.equal(result.effectiveDir, null);
	assert.deepEqual(result.profiles, [
		{
			path: join(homeDir, ".claude"),
			displayPath: "~/.claude",
			label: "Default (.claude)",
			source: "default",
			exists: false,
			hasSettings: false,
			hasCredentials: false,
		},
	]);
});

test("discoverClaudeCodeProfiles sorts .claude* directories, excludes files, and resolves directory symlinks only", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-scan-");
	const externalTarget = makeTempDir(t, "lh-profiles-ext-");
	mkdirSync(join(homeDir, ".claude"));
	mkdirSync(join(homeDir, ".claude-work"));
	mkdirSync(join(homeDir, ".claude_personal"));
	writeFileSync(join(homeDir, ".claude", "settings.json"), "{}");
	writeFileSync(join(homeDir, ".claude-work", ".credentials.json"), '{"token":"SYNTHETIC_SECRET_TOKEN_123"}');
	writeFileSync(join(homeDir, ".claude.json"), "{}");
	writeFileSync(join(homeDir, ".claude.json.backup"), "{}");

	writeFileSync(join(externalTarget, "settings.json"), "{}");
	const targetFile = join(externalTarget, "plain.txt");
	writeFileSync(targetFile, "not a dir");

	symlinkSync(externalTarget, join(homeDir, ".claude-link-dir"));
	symlinkSync(targetFile, join(homeDir, ".claude-link-file"));
	symlinkSync(join(externalTarget, "missing-target"), join(homeDir, ".claude-link-dangling"));

	const result = discoverClaudeCodeProfiles({ homeDir, env: {} });
	assert.deepEqual(
		result.profiles.map((p) => p.label),
		["Default (.claude)", ".claude_personal", ".claude-link-dir", ".claude-work"],
	);
	assert.equal(result.profiles[0]?.hasSettings, true);
	assert.equal(result.profiles[0]?.hasCredentials, false);
	const work = result.profiles.find((p) => p.label === ".claude-work");
	assert.equal(work?.exists, true);
	assert.equal(work?.hasCredentials, true);
	assert.equal(work?.hasSettings, false);
	assert.equal(JSON.stringify(result).includes("SYNTHETIC_SECRET_TOKEN_123"), false);
});

test("discoverClaudeCodeProfiles deduplicates canonical aliases and honors configured > env precedence", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-dedup-");
	const defaultDir = join(homeDir, ".claude");
	const workDir = join(homeDir, ".claude-work");
	const envDir = makeTempDir(t, "lh-profiles-env-");
	const missingConfigured = join(homeDir, ".claude-missing");
	mkdirSync(defaultDir);
	mkdirSync(workDir);
	symlinkSync(defaultDir, join(homeDir, ".claude-alias"));

	const withConfigured = discoverClaudeCodeProfiles({
		homeDir,
		configuredDir: "~/.claude-work",
		env: { CLAUDE_CONFIG_DIR: envDir },
	});
	assert.equal(withConfigured.configuredDir, workDir);
	assert.equal(withConfigured.inheritedEnvDir, envDir);
	assert.equal(withConfigured.effectiveDir, workDir);
	assert.equal(withConfigured.profiles.filter((p) => realpathSync(p.path) === realpathSync(defaultDir)).length, 1);
	const workProfiles = withConfigured.profiles.filter((p) => p.path === workDir);
	assert.equal(workProfiles.length, 1);
	assert.equal(workProfiles[0]?.source, "configured");

	const withEnvOnly = discoverClaudeCodeProfiles({
		homeDir,
		configuredDir: null,
		env: { CLAUDE_CONFIG_DIR: envDir },
	});
	assert.equal(withEnvOnly.effectiveDir, envDir);
	assert.equal(withEnvOnly.profiles.find((p) => p.path === envDir)?.source, "env");

	const withMissingConfigured = discoverClaudeCodeProfiles({
		homeDir,
		configuredDir: missingConfigured,
		env: { CLAUDE_CONFIG_DIR: envDir },
	});
	assert.equal(withMissingConfigured.effectiveDir, missingConfigured);
	assert.deepEqual(
		withMissingConfigured.profiles.find((p) => p.path === missingConfigured),
		{
			path: missingConfigured,
			displayPath: "~/.claude-missing",
			label: ".claude-missing",
			source: "configured",
			exists: false,
			hasSettings: false,
			hasCredentials: false,
		},
	);
});

test("discoverClaudeCodeProfiles avoids homeDir prefix collisions in displayPath", (t) => {
	const root = makeTempDir(t, "lh-profiles-prefix-");
	const homeDir = join(root, "home");
	const siblingDir = join(root, "home2", ".claude");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(siblingDir, { recursive: true });

	const result = discoverClaudeCodeProfiles({
		homeDir,
		configuredDir: siblingDir,
		env: {},
	});
	const siblingProfile = result.profiles.find((p) => p.path === siblingDir);
	assert.ok(siblingProfile);
	assert.equal(siblingProfile.displayPath, siblingDir);
	assert.equal(siblingProfile.displayPath.startsWith("~2"), false);
});
