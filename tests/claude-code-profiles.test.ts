import assert from "node:assert/strict";
import nodeFs, { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isValidClaudeConfigDir } from "../src/core/contracts/claude-code.ts";
import { discoverClaudeCodeProfiles, type ClaudeCodeProfileFs } from "../src/server/claude-code-profiles.ts";

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

test("discoverClaudeCodeProfiles reads .claude.json metadata for default and custom profiles without cross-fallback", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-meta-");
	const defaultDir = join(homeDir, ".claude");
	const workDir = join(homeDir, ".claude-work");
	const bareDir = join(homeDir, ".claude-bare");
	mkdirSync(defaultDir);
	mkdirSync(workDir);
	mkdirSync(bareDir);

	writeFileSync(
		join(homeDir, ".claude.json"),
		JSON.stringify({
			oauthAccount: {
				emailAddress: "  default@example.com\n",
				billingType: "stripe_subscription",
				accountUuid: "SECRET_UUID_SHOULD_NOT_SURFACE",
			},
			primaryApiKey: "SECRET_PRIMARY_KEY",
			mcpServers: { local: { env: { API_TOKEN: "SECRET_MCP_ENV" } } },
		}),
	);
	writeFileSync(
		join(workDir, ".claude.json"),
		JSON.stringify({
			oauthAccount: {
				emailAddress: "work@example.com",
				billingType: "unknown_internal_billing",
			},
		}),
	);

	const result = discoverClaudeCodeProfiles({ homeDir, env: {} });
	const defaultProfile = result.profiles.find((p) => p.label === "Default (.claude)");
	const workProfile = result.profiles.find((p) => p.label === ".claude-work");
	const bareProfile = result.profiles.find((p) => p.label === ".claude-bare");

	assert.equal(defaultProfile?.email, "default@example.com");
	assert.equal(defaultProfile?.subscriptionPlan, "Subscription");
	assert.equal(workProfile?.email, "work@example.com");
	assert.equal("subscriptionPlan" in (workProfile ?? {}), false);
	assert.equal("email" in (bareProfile ?? {}), false);
	assert.equal("subscriptionPlan" in (bareProfile ?? {}), false);

	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes("SECRET_UUID_SHOULD_NOT_SURFACE"), false);
	assert.equal(serialized.includes("SECRET_PRIMARY_KEY"), false);
	assert.equal(serialized.includes("SECRET_MCP_ENV"), false);
	assert.equal(serialized.includes("unknown_internal_billing"), false);
});

test("discoverClaudeCodeProfiles prefers <defaultDir>/.claude.json over <homeDir>/.claude.json and handles corrupt/oversized/partial fs", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-edge-");
	const defaultDir = join(homeDir, ".claude");
	const corruptDir = join(homeDir, ".claude-corrupt");
	const hugeDir = join(homeDir, ".claude-huge");
	mkdirSync(defaultDir);
	mkdirSync(corruptDir);
	mkdirSync(hugeDir);

	writeFileSync(
		join(homeDir, ".claude.json"),
		JSON.stringify({ oauthAccount: { emailAddress: "home@example.com", billingType: "stripe_subscription" } }),
	);
	writeFileSync(
		join(defaultDir, ".claude.json"),
		JSON.stringify({ oauthAccount: { emailAddress: "default-dir@example.com" } }),
	);
	writeFileSync(join(corruptDir, ".claude.json"), "{not-valid-json");
	writeFileSync(
		join(hugeDir, ".claude.json"),
		JSON.stringify({
			oauthAccount: { emailAddress: "huge@example.com" },
			padding: "x".repeat(1024 * 1024 + 64),
		}),
	);

	const result = discoverClaudeCodeProfiles({ homeDir, env: {} });
	const defaultProfile = result.profiles.find((p) => p.label === "Default (.claude)");
	const corruptProfile = result.profiles.find((p) => p.label === ".claude-corrupt");
	const hugeProfile = result.profiles.find((p) => p.label === ".claude-huge");

	assert.equal(defaultProfile?.email, "default-dir@example.com");
	assert.equal(defaultProfile?.subscriptionPlan, "Subscription");
	assert.equal("email" in (corruptProfile ?? {}), false);
	assert.equal("email" in (hugeProfile ?? {}), false);

	// Partial fs mock omitting readFileSync works without throwing
	const partialFs: ClaudeCodeProfileFs = {
		readdirSync: nodeFs.readdirSync,
		statSync: nodeFs.statSync,
		realpathSync: nodeFs.realpathSync,
	};
	const partialResult = discoverClaudeCodeProfiles({ homeDir, env: {}, fs: partialFs });
	assert.equal("email" in (partialResult.profiles[0] ?? {}), false);
});

test("discoverClaudeCodeProfiles (.claude.json-only variant) never reads .credentials.json and never leaks secrets", (t) => {
	const homeDir = makeTempDir(t, "lh-profiles-nocreds-");
	const defaultDir = join(homeDir, ".claude");
	const workDir = join(homeDir, ".claude-work");
	mkdirSync(defaultDir);
	mkdirSync(workDir);

	writeFileSync(
		join(workDir, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: "SECRET_OAUTH_ACCESS",
				refreshToken: "SECRET_OAUTH_REFRESH",
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
			apiKey: "SECRET_API_KEY",
		}),
	);
	writeFileSync(
		join(workDir, ".claude.json"),
		JSON.stringify({
			oauthAccount: { emailAddress: "work@example.com" },
			primaryApiKey: "SECRET_PRIMARY_API_KEY",
		}),
	);

	const readPaths: string[] = [];
	const spyFs: ClaudeCodeProfileFs = {
		readdirSync: nodeFs.readdirSync,
		statSync: nodeFs.statSync,
		realpathSync: nodeFs.realpathSync,
		readFileSync: ((filePath: nodeFs.PathOrFileDescriptor, options?: unknown) => {
			readPaths.push(String(filePath));
			return nodeFs.readFileSync(filePath, options as BufferEncoding);
		}) as typeof nodeFs.readFileSync,
	};

	const result = discoverClaudeCodeProfiles({ homeDir, env: {}, fs: spyFs });
	assert.equal(readPaths.some((p) => p.endsWith(".credentials.json")), false);
	const workProfile = result.profiles.find((p) => p.label === ".claude-work");
	assert.equal(workProfile?.hasCredentials, true);
	assert.equal(workProfile?.email, "work@example.com");
	assert.equal("subscriptionPlan" in (workProfile ?? {}), false);

	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes("SECRET_OAUTH_ACCESS"), false);
	assert.equal(serialized.includes("SECRET_OAUTH_REFRESH"), false);
	assert.equal(serialized.includes("SECRET_API_KEY"), false);
	assert.equal(serialized.includes("SECRET_PRIMARY_API_KEY"), false);
});
