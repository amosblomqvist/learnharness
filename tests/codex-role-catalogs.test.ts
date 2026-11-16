/**
 * Engines resolved outside a chat turn (a job respawned after a restart, a notes import) need the Codex catalog,
 * which is fetched at run time. refreshRoleCatalogs loads it when a role resolves to Codex.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-codex-role-catalogs-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { configureCodexModelLister, toCodexModel } = await import("../src/agent/codex/provider.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { EXTERNAL_CLI_PROVIDERS } = await import("../src/core/contracts/external-cli.ts");
const { refreshRoleCatalogs } = await import("../src/server/chat-handler.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

const MODEL_ID = "gpt-5-codex";
const MODEL_ENTRY = {
	id: MODEL_ID,
	model: MODEL_ID,
	displayName: "GPT-5 Codex",
	hidden: false,
	isDefault: true,
	description: "",
	defaultReasoningEffort: "medium",
	supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
};

function useCodexOnCheapSlot(t: TestContext): { listed: () => number } {
	let calls = 0;
	configureCodexModelLister(async () => { calls++; return [toCodexModel(MODEL_ENTRY)]; });
	const settings = readSettings();
	writeSettings({
		...(settings ?? { version: 1 }),
		codex: { enabled: true },
		models: { cheap: { model: { provider: EXTERNAL_CLI_PROVIDERS.codex, id: MODEL_ID } } },
	});
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });

	const dir = mkdtempSync(join(tmpdir(), "codex-role-catalogs-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Satisfies the presence check; never executed (the lister above replaces the real call).
	writeFileSync(join(dir, process.platform === "win32" ? "codex.exe" : "codex"), "", { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });
	return { listed: () => calls };
}

test("a role on Codex loads the Codex catalog, so an engine resolves outside a chat turn", async (t) => {
	const { listed } = useCodexOnCheapSlot(t);
	assert.equal(piModels().getModel(EXTERNAL_CLI_PROVIDERS.codex, MODEL_ID), undefined, "the catalog starts empty");

	await refreshRoleCatalogs();

	assert.equal(listed(), 1);
	assert.ok(piModels().getModel(EXTERNAL_CLI_PROVIDERS.codex, MODEL_ID));
	assert.doesNotThrow(() => piEngineForSpec({ provider: EXTERNAL_CLI_PROVIDERS.codex, id: MODEL_ID }));
});

test("no role and no conversation on Codex leaves the Codex catalog alone", async (t) => {
	let calls = 0;
	configureCodexModelLister(async () => { calls++; return []; });
	const settings = readSettings();
	writeSettings({ ...(settings ?? { version: 1 }), models: {} });
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });

	await refreshRoleCatalogs("openrouter");

	assert.equal(calls, 0);
});
