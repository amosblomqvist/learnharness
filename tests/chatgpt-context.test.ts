import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-account-context-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { chatGPTModels, refreshChatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
const { catalogContextLimits, modelCatalog, resolveModelContext, toModelDto } = await import("../src/server/model-catalog.ts");
const { effectiveThresholdTokens } = await import("../src/server/compaction.ts");
const { withContextWindow } = await import("../src/server/chat-handler.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const available = piModels().getModels("openai").filter((model): model is Model<"openai-responses"> => model.api === "openai-responses");
const model = available.find((entry) => entry.id === "gpt-6.1-sol")!;

test("account windows flow to the picker, engine and compaction without crossing account boundaries", async () => {
	const oldSend = Object.getOwnPropertyDescriptor(process, "send");
	const oldConnected = Object.getOwnPropertyDescriptor(process, "connected");
	const oldMarker = process.env.LH_DESKTOP_SERVER, oldSecret = process.env.LH_DESKTOP_API_SECRET;
	let account = "account-A", epoch = 1, revision = 1;
	const operations: string[] = [];
	let contextWindow: unknown = 500_000, maxContextWindow: unknown = 872_000;
	const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
	try {
		process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
		Object.defineProperty(process, "connected", { configurable: true, value: true });
		Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
			operations.push(message.op);
			const status = { available: true, pending: false, allowBackgroundUse: true, activeId: account, accounts: [{ id: account, connected: true, planEnabled: true }], error: null };
			queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: { epoch, authorityRevision: revision, revision, status, accountId: account, models: [{ id: model.id, name: "Sol", contextWindow, maxContextWindow }] } }));
			callback?.(); return true;
		} });
		await refreshChatGPTModels(available);
		const accountA = chatGPTModels()[0]!;
		assert.equal(accountA.contextWindow, 500_000);
		assert.equal(accountA.maxContextWindow, 872_000);
		const keyA = resolveModelContext(accountA).contextWindowKey!;
		writeSettings({ version: 1, compaction: { thresholdTokens: 800_000, contextWindows: { [keyA]: 872_000 } } });
		assert.equal(readSettings()?.compaction?.contextWindows?.[keyA], 872_000, "compaction persists without a graph section");
		assert.equal(catalogContextLimits().get(`chatgpt:${model.id}`), 872_000);
		const dto = modelCatalog().models.find((entry) => entry.provider === "chatgpt" && entry.id === model.id)!;
		assert.equal(dto.contextWindow, 872_000);
		assert.equal(dto.defaultContextWindow, 500_000);
		assert.equal(dto.maxContextWindow, 872_000);
		assert.equal(dto.contextWindowSource, "account");
		const cli = piModels().getModel("claude-code", "opus")!;
		assert.ok(cli);
		const cliDto = toModelDto(cli, { [keyA]: 872_000 });
		assert.equal(cliDto.contextWindow, null, "CLI session limits remain unknown while account limits are enabled");
		assert.equal(cliDto.maxTokens, null);
		assert.equal(cliDto.cost, null);
		const engine = piEngineForSpec(withContextWindow({ provider: "chatgpt", id: model.id }), false);
		assert.equal(engine.model.contextWindow, 872_000);
		assert.ok(!JSON.stringify(engine.model).includes("account-A"), "the private admission scope is not serialized with model metadata");
		assert.equal(effectiveThresholdTokens(800_000, engine.model.contextWindow), 800_000);

		account = "account-B"; epoch = 2; revision = 2; contextWindow = 272_000; maxContextWindow = 600_000;
		await refreshChatGPTModels(available);
		const accountB = chatGPTModels()[0]!;
		assert.notEqual(resolveModelContext(accountB).contextWindowKey, keyA);
		const beforeStaleDispatch = operations.length;
		const stale = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: [{ type: "text", text: "fixture" }], timestamp: 1 }] })).result();
		assert.equal(stale.stopReason, "error", "an engine built for A cannot dispatch after switching to B");
		assert.ok(!operations.slice(beforeStaleDispatch).includes("lease"), "the stale window never acquires B's credential");
		assert.equal(catalogContextLimits().get(`chatgpt:${model.id}`), 272_000, "A's opt-in does not apply to B");
		const keyB = resolveModelContext(accountB).contextWindowKey!;
		writeSettings({ version: 1, compaction: { thresholdTokens: 800_000, contextWindows: { [keyA]: 872_000, [keyB]: 800_000 } } });
		assert.equal(catalogContextLimits().get(`chatgpt:${model.id}`), 600_000, "the current account ceiling wins");
		assert.equal(effectiveThresholdTokens(800_000, 600_000), 583_616);

		maxContextWindow = 100_000; revision = 3;
		await refreshChatGPTModels(available);
		assert.equal(chatGPTModels()[0]?.maxContextWindow, undefined, "invalid maximum is discarded");
		assert.equal(catalogContextLimits().get(`chatgpt:${model.id}`), 272_000, "unverified maximum never authorizes an override");
		contextWindow = "500000"; maxContextWindow = 872_000; revision = 4;
		await refreshChatGPTModels(available);
		assert.equal(chatGPTModels()[0]?.contextWindow, model.contextWindow, "invalid account metadata retains the Pi fallback");
		assert.equal(resolveModelContext(chatGPTModels()[0]!, { [keyB]: 800_000 }).contextWindow, model.contextWindow);
	} finally {
		if (oldSend) Object.defineProperty(process, "send", oldSend); else delete process.send;
		if (oldConnected) Object.defineProperty(process, "connected", oldConnected); else delete (process as { connected?: boolean }).connected;
		if (oldMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = oldMarker;
		if (oldSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = oldSecret;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
