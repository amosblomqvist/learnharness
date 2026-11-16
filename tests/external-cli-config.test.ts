import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-external-cli-config-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const {
	CLAUDE_CODE_PROVIDER,
	EXTERNAL_CLI_LABELS,
	EXTERNAL_CLI_PROVIDERS,
	isExternalCliProvider,
} = await import("../src/core/index.ts");
import type { ExternalCliProvider } from "../src/core/index.ts";
const { claudeCodeAvailable, claudeCodeEnabled } = await import("../src/server/claude-code-config.ts");
const { externalCliAvailable, externalCliEnabled } = await import("../src/server/external-cli-config.ts");
const { geminiBinaryOf, GeminiInstallKind } = await import("../src/agent/gemini-cli/binary.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

function setup(t: TestContext) {
	const previous = readSettings();
	const previousPath = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "external-cli-bin-"));
	// Never executed: only installation discovery observes this marker.
	writeFileSync(join(dir, process.platform === "win32" ? "claude.exe" : "claude"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

test("isExternalCliProvider matches only the three CLI provider ids", () => {
	for (const id of Object.values(EXTERNAL_CLI_PROVIDERS)) {
		assert.equal(isExternalCliProvider(id), true);
	}
	assert.equal(CLAUDE_CODE_PROVIDER, EXTERNAL_CLI_PROVIDERS.claudeCode);
	assert.deepEqual(EXTERNAL_CLI_LABELS, {
		"claude-code": "Claude Code",
		codex: "Codex",
		"gemini-cli": "Gemini CLI",
	});

	for (const id of ["openai", "anthropic", "openai-codex", "", null, undefined, 123]) {
		assert.equal(isExternalCliProvider(id), false);
	}

	// @ts-expect-error non-CLI providers must be rejected by ExternalCliProvider
	const invalidProvider: ExternalCliProvider = "openai";
	assert.equal(invalidProvider, "openai");
});

test("Claude Code opt-in off returns false even when the binary exists", (t) => {
	setup(t);
	writeSettings({ version: 1 });
	assert.equal(externalCliEnabled(EXTERNAL_CLI_PROVIDERS.claudeCode), false);
	assert.equal(externalCliAvailable(EXTERNAL_CLI_PROVIDERS.claudeCode), false);
	assert.equal(claudeCodeEnabled(), false);
	assert.equal(claudeCodeAvailable(), false);

	writeSettings({ version: 1, claudeCode: { enabled: false } });
	assert.equal(externalCliEnabled(EXTERNAL_CLI_PROVIDERS.claudeCode), false);
	assert.equal(externalCliAvailable(EXTERNAL_CLI_PROVIDERS.claudeCode), false);
	assert.equal(claudeCodeEnabled(), false);
	assert.equal(claudeCodeAvailable(), false);

	writeSettings({ version: 1, claudeCode: { enabled: true } });
	assert.equal(externalCliEnabled(EXTERNAL_CLI_PROVIDERS.claudeCode), true);
	assert.equal(externalCliAvailable(EXTERNAL_CLI_PROVIDERS.claudeCode), true);
	assert.equal(claudeCodeEnabled(), true);
	assert.equal(claudeCodeAvailable(), true);
});

test("a Gemini CLI bundle whose node is missing counts as installed, so the turn reaches the launcher", () => {
	const script = "C:/npm/node_modules/@google/gemini-cli/bundle/gemini.js";
	assert.equal(geminiBinaryOf({ kind: GeminiInstallKind.NODE_MISSING, script }), script);
	assert.equal(geminiBinaryOf({ kind: GeminiInstallKind.NOT_FOUND }), null);
});

if (process.platform === "win32") {
	test("Gemini CLI with gemini.cmd and its bundle but no node on PATH is available when opted in", (t) => {
		const previous = readSettings();
		const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, npm_config_prefix: process.env.npm_config_prefix };
		const dir = mkdtempSync(join(tmpdir(), "gemini-node-missing-"));
		t.after(() => {
			if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
			for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(dir, { recursive: true, force: true });
		});
		writeFileSync(join(dir, "gemini.cmd"), "");
		const bundleDir = join(dir, "node_modules", "@google", "gemini-cli", "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "gemini.js"), "");
		process.env.PATH = dir;
		process.env.APPDATA = dir;
		delete process.env.npm_config_prefix;

		writeSettings({ version: 1, geminiCli: { enabled: true } });
		assert.equal(externalCliAvailable(EXTERNAL_CLI_PROVIDERS.geminiCli), true);
		writeSettings({ version: 1, geminiCli: { enabled: false } });
		assert.equal(externalCliAvailable(EXTERNAL_CLI_PROVIDERS.geminiCli), false);
	});
}
