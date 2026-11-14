import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const dir = mkdtempSync(join(process.cwd(), ".pbi-tmp", "codex-models-"));
process.env.LH_DATA_DIR = dir;
const originalPath = process.env.PATH;
process.env.PATH = dir;
writeFileSync(join(dir, process.platform === "win32" ? "codex.exe" : "codex"), "", { mode: 0o755 });
after(() => { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); });
const { listCodexModels, configureCodexModelLister, codexModels, refreshCodexModels, toCodexModel } = await import("../src/agent/codex/provider.ts");
const { modelCatalog, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");

const entry = { id: "test-model", model: "test-model", displayName: "Test Model", hidden: false, isDefault: true, description: "", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }, { reasoningEffort: "high", description: "" }] };
const model = toCodexModel(entry);

test("app-server model pages map visible models and advertised effort levels", async () => {
	process.env.FAKE_CODEX_MODELS = JSON.stringify([{ data: [entry], nextCursor: "1" }, { data: [{ ...entry, id: "hidden", hidden: true }], nextCursor: null }]);
	const fixture = fileURLToPath(new URL("./fixtures/codex/fake-codex.mjs", import.meta.url));
	const models = await listCodexModels(process.execPath, [fixture]);
	delete process.env.FAKE_CODEX_MODELS;
	assert.equal(models.length, 1);
	assert.equal(models[0]?.name, "Test Model");
	assert.deepEqual(models[0]?.thinkingLevelMap, { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null });
});

test("an app-server that exits after input rejects without an uncaught error", async () => {
	await assert.rejects(listCodexModels(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(1))"]));
});

test("opt-in gates refresh and successful catalogs survive failures", async () => {
	let calls = 0;
	configureCodexModelLister(async () => { calls++; return [model]; });
	writeSettings({ version: 1 });
	await refreshConnectionCatalog("codex");
	assert.equal(calls, 0);
	assert.equal(modelCatalog().models.some((m) => m.provider === "codex"), false);
	writeSettings({ version: 1, codex: { enabled: true } });
	await Promise.all([refreshConnectionCatalog("codex"), refreshConnectionCatalog("codex")]);
	assert.equal(calls, 1);
	const found = modelCatalog().models.find((m) => m.provider === "codex");
	assert.equal(found?.id, entry.id);
	assert.equal(found?.cost, null);
	assert.equal(found?.contextWindow, null);
	assert.equal(piEngineForSpec({ provider: "codex", id: entry.id }).model.id, entry.id);
	await refreshCodexModels();
	assert.equal(calls, 1);
});

test("initial failure returns empty; later failure retains successful models", async () => {
	configureCodexModelLister(async () => { throw new Error("offline"); });
	await refreshConnectionCatalog("codex");
	assert.deepEqual(codexModels(), []);
	assert.equal(modelCatalog().models.some((m) => m.provider === "codex"), false);
	let fail = false;
	configureCodexModelLister(async () => { if (fail) throw new Error("offline"); return [model]; });
	const now = Date.now;
	let time = now();
	Date.now = () => time;
	try {
		await refreshConnectionCatalog("codex");
		fail = true; time += 600_001;
		await refreshConnectionCatalog("codex");
		assert.equal(modelCatalog().models.some((m) => m.provider === "codex"), true);
	} finally { Date.now = now; }
});

test("chat admission refreshes an empty Codex catalog", async () => {
	let calls = 0;
	configureCodexModelLister(async () => { calls++; return [model]; });
	writeSettings({ version: 1, codex: { enabled: true } });
	const chat = chatStore.createChat("Codex catalog admission");
	chatStore.saveSettings(chat.id, { model: { provider: "codex", id: entry.id } });
	try {
		await handleChatInput(chat.id, { type: "text", text: "hello" }, () => { throw new Error("reached agent construction"); }).catch(() => undefined);
		assert.equal(calls, 1);
		assert.equal(piEngineForSpec({ provider: "codex", id: entry.id }).model.id, entry.id);
	} finally { chatStore.deleteChat(chat.id); }
});

test("chat admission refreshes Codex for a background role", async () => {
	let calls = 0;
	configureCodexModelLister(async () => { calls++; return [model]; });
	writeSettings({ version: 1, codex: { enabled: true }, models: { cheap: { model: { provider: "codex", id: entry.id } } } });
	const chat = chatStore.createChat("Background Codex catalog admission");
	chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4o" } });
	try {
		await handleChatInput(chat.id, { type: "text", text: "hello" }, () => { throw new Error("reached agent construction"); }).catch(() => undefined);
		assert.equal(calls, 1);
		assert.equal(piEngineForSpec({ provider: "codex", id: entry.id }).model.id, entry.id);
	} finally { chatStore.deleteChat(chat.id); }
});
