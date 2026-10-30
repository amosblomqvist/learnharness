import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-cli-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing } = await import("../src/core/settings.ts");
const { parseClaudeCodeSettingsBody } = await import("../src/server/settings-body.ts");
const { claudeCodeAvailable, claudeCodeEnabled } = await import("../src/server/claude-code-config.ts");
const { claudeCodeInstallationResponse } = await import("../src/server/claude-code.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { CLAUDE_CODE_MODELS } = await import("../src/agent/claude-code/provider.ts");

function setup(t: TestContext) {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "claude-opt-in-"));
	// Never executed: only installation discovery observes this marker.
	writeFileSync(join(dir, process.platform === "win32" ? "claude.exe" : "claude"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}
async function save(body: unknown) {
	return PUT(new Request("http://test/api/settings/claudeCode", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ section: "claudeCode" }) });
}

test("opt-in parses strictly and malformed stored values never enable the CLI", () => {
	assert.deepEqual(parseClaudeCodeSettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseClaudeCodeSettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseClaudeCodeSettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) assert.equal(parseClaudeCodeSettingsBody(raw).ok, false);
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, claudeCode: raw })?.claudeCode?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.claudeCode, undefined);
});

test("default off even with an installed binary; section writes toggle availability but preserve saved model pins and unrelated settings", async (t) => {
	setup(t);
	const models = { strong: { model: { provider: "claude-code", id: "sonnet" } }, cheap: { model: { provider: "claude-code", id: "haiku" } } };
	writeSettings({ version: 1, models, graph: { enabled: false }, futureSection: { keep: 1 } });
	assert.equal(claudeCodeEnabled(), false); assert.equal(claudeCodeAvailable(), false);
	assert.equal(providerKeyPresent("claude-code"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "claude-code"));
	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(claudeCodeEnabled(), true); assert.equal(claudeCodeAvailable(), true);
	assert.equal(modelCatalog().models.filter((m) => m.provider === "claude-code").length, 3);
	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(claudeCodeAvailable(), false);
	assert(!modelCatalog().models.some((m) => m.provider === "claude-code"));
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(validateModelsSettings(models, models).ok, true, "saved unavailable pins remain repairable, not silently removed");
	assert.equal((await save({ enabled: "true" })).status, 400); assert.equal(claudeCodeEnabled(), false);
	assert.equal((await save({})).status, 200); assert.equal(claudeCodeEnabled(), false);
});

test("off cannot launch a version probe even through an otherwise authorized HTTP request", async (t) => {
	setup(t);
	const request = new Request("http://test/api/claude-code", { headers: { "x-learnharness-claude-code": "1" } });
	const response = await claudeCodeInstallationResponse(request, async () => assert.fail("disabled CLI must not execute"));
	assert.equal(response.status, 403);
});

test("a saved CLI background job is refused before model execution while opt-in is off", async (t) => {
	setup(t);
	const chat = chatStore.createChat("CLI opt-in job fixture");
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "cli-off-job" });
	let calls = 0;
	const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {},
		engineFor: () => ({ model: CLAUDE_CODE_MODELS[0]!, streamFn: () => { calls++; assert.fail("must not run a disabled CLI model"); } }),
		providerKeyMissing: (provider, tier) => providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
	});
	await runner.runJob(job.id, { question: "Synthetic fixture only" });
	assert.equal(calls, 0);
	const refused = jobStore.getJob(job.id)!;
	assert.equal(refused.status, "error");
	assert.match(JSON.stringify(refused.result), /Enable and set it up in Settings/);
	assert(!JSON.stringify(refused.result).includes("add one in Settings → Keys"));
});
