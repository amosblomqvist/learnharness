import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, createProvider, createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, normalizeContext, type CacheRetention, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { CACHE_RETENTIONS, sanitizeUserSettings, ROLE_SLOT, type UserSettings } from "../src/core/settings.ts";
import { resolveSettings, resolveConversationSpec, resolveRoleSpec } from "../src/core/settings-resolution.ts";
import { parseModelsSettingsBody, parseAgentSettingsBody, parseSettingsBody } from "../src/server/settings-body.ts";

// All runtime/store imports follow isolation. No ambient auth, profiles, models,
// data, provider/CLI calls or network: real adapters stop at payload capture.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cache-retention-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture", OPENAI_API_KEY: "fixture", OPENROUTER_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { piModels, piEngineForSpec, configureProviderSource } = await import("../src/agent/models.ts");
const { clampModelsLevels, catalogSlots } = await import("../src/server/model-catalog.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
const model = { provider: "anthropic", id: "claude-sonnet-4-6" };
const context = normalizeContext({ systemPrompt: "Stable instructions", messages: [{ role: "user", content: "offline", timestamp: 1 }] });

async function payload(engine: ReturnType<typeof piEngineForSpec>, options: SimpleStreamOptions = {}) {
	let captured: unknown;
	const result = await engine.streamFn(engine.model, context, {
		...options,
		onPayload: (value) => { captured = value; throw new Error("CLOSED: captured payload"); },
	}).result();
	assert.ok(captured, result.errorMessage);
	return captured as Record<string, unknown>;
}

for (const cacheRetention of CACHE_RETENTIONS) test(`slot ${cacheRetention} survives parse, sanitize, clamp, disk and catalog`, async () => {
	const body = { strong: { model, thinkingLevel: "high", cacheRetention }, cheap: { model } };
	const parsed = parseModelsSettingsBody(body);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(sanitizeUserSettings({ version: 1, models: body })?.models, body);
	assert.equal(clampModelsLevels(parsed.settings).strong?.cacheRetention, cacheRetention);
	const response = await PUT(new Request("http://localhost/api/settings/models", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ section: "models" }) });
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(readSettings()?.models?.strong?.cacheRetention, cacheRetention);
	assert.equal(catalogSlots().strong?.cacheRetention, cacheRetention);
	assert.ok(!Object.hasOwn(readSettings()!.models!.cheap!, "cacheRetention"));
});

test("unset remains absent through storage/resolution; Pi default clears rather than serializes a new default", async () => {
	const before = { version: 1, models: { strong: { model, thinkingLevel: "high" } } };
	assert.deepEqual(sanitizeUserSettings(before), before);
	writeSettings(before);
	assert.deepEqual(readSettings(), before);
	assert.ok(!Object.hasOwn(resolveSettings(readSettings()).models.strong!, "cacheRetention"));
	assert.ok(!Object.hasOwn(catalogSlots().strong!, "cacheRetention"));
	const parsed = parseModelsSettingsBody({ strong: { model, cacheRetention: "default" } });
	assert.equal(parsed.ok, false, "default is UI-only; omitted is the native default");
});

test("known invalid retention rejects on write, drops on read; no role/chat retention override", () => {
	for (const value of [null, false, 5, {}, [], "5m", "1h", "LONG", ""]) {
		assert.equal(parseModelsSettingsBody({ strong: { model, cacheRetention: value } }).ok, false);
		assert.deepEqual(sanitizeUserSettings({ version: 1, models: { strong: { model, cacheRetention: value } } })?.models?.strong, { model });
	}
	assert.deepEqual(parseAgentSettingsBody({ models: { researcher: { model, cacheRetention: "long" } } }), { ok: true, settings: { models: { researcher: { model } } } });
	assert.deepEqual(parseSettingsBody({ model, cacheRetention: "long" }), { ok: true, settings: { model } });
});

test("retention belongs to the workload slot, independently of conversation and role model overrides", () => {
	const record: UserSettings = { version: 1, models: {
		strong: { model, cacheRetention: "long" }, cheap: { model, cacheRetention: "short" }, vision: { model, cacheRetention: "none" },
	}, agent: { models: { researcher: { model: { provider: "openai", id: "gpt-4o-mini" } } } } };
	const chatModel = { provider: "openrouter", id: "openrouter/free" };
	assert.equal(resolveConversationSpec({ model: chatModel }, resolveSettings(record).models.strong)?.provider, chatModel.provider);
	for (const [role, slot] of Object.entries(ROLE_SLOT)) {
		const spec = resolveRoleSpec(role as keyof typeof ROLE_SLOT, record)!;
		assert.equal(spec.provider, role === "researcher" ? "openai" : model.provider);
		assert.equal(record.models![slot]!.cacheRetention, slot === "strong" ? "long" : slot === "cheap" ? "short" : "none");
	}
});

test("untouched/default source produces exactly the native payload, including environment override", async () => {
	for (const env of [undefined, "long"]) {
		if (env === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = env;
		for (const spec of [model, { provider: "openai", id: "gpt-4o-mini" }, { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }]) {
			const baseline = await payload(piEngineForSpec({ ...spec, thinkingLevel: "off" }));
			const defaultSource = await payload(piEngineForSpec({ ...spec, thinkingLevel: "off" }, true, undefined, () => undefined));
			assert.deepEqual(defaultSource, baseline, `${spec.provider}: untouched default must change nothing`);
		}
	}
	delete process.env.PI_CACHE_RETENTION;
});

test("explicit native preferences win over environment; resetting to default restores it in the SAME engine", async () => {
	process.env.PI_CACHE_RETENTION = "long";
	let retention: CacheRetention | undefined;
	const engine = piEngineForSpec({ ...model, thinkingLevel: "off" }, true, undefined, () => retention);
	for (const value of [undefined, "short", "none", "long", undefined] as const) {
		retention = value;
		const body = await payload(engine);
		const serialized = JSON.stringify(body);
		if (value === "none") assert.ok(!serialized.includes("cache_control"));
		else {
			assert.ok(serialized.includes('"type":"ephemeral"'));
			assert.equal(serialized.includes('"ttl":"1h"'), value !== "short");
		}
	}
	delete process.env.PI_CACHE_RETENTION;
});

test("real conversation wiring inherits live Strong retention without changing the chat's own model", async () => {
	const id = "cache-chat-fixture";
	const faux = createFauxCore({});
	const entry = { ...faux.getModel(), provider: id, id: "chat-model" };
	const seen: Array<{ model: string; options: SimpleStreamOptions }> = [];
	const stream: StreamFunction = (m, c, options) => {
		seen.push({ model: m.id, options: options ?? {} });
		return faux.streamSimple(m, c, options);
	};
	piModels().setProvider(createProvider({ id, models: [entry, { ...entry, id: "strong-model" }], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
	const record: UserSettings = { version: 1, graph: { enabled: false }, models: { strong: { model: { provider: id, id: "strong-model" }, cacheRetention: "long" } } };
	writeSettings(record);
	const chat = chatStore.createChat("Synthetic cache-retention test");
	chatStore.saveSettings(chat.id, { model: { provider: id, id: "chat-model" } });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("again", {}, { id: "cache-again" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const response = await handleChatInput(chat.id, { type: "text", text: "offline" }, (options) => createTeacherAgent(undefined, {
		...options,
		tools: { again: { name: "again", label: "again", description: "fixture", parameters: Type.Object({}), execute: async () => {
			writeSettings({ ...record, models: { strong: { ...record.models!.strong, cacheRetention: "short" } } });
			return { content: [{ type: "text", text: "done" }], details: {} };
		} } },
	}));
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chat.id);
	if (handle) await new Response(handle.subscribe()).text();
	assert.deepEqual(seen.map((call) => [call.model, call.options.cacheRetention]), [["chat-model", "long"], ["chat-model", "short"]]);
	assert.deepEqual(chatStore.getChat(chat.id)?.settings?.model, { provider: id, id: "chat-model" });
	piModels().deleteProvider(id);
});

test("slot source passes native values unchanged; freshness and in-flight snapshot apply to built-in AND custom dispatch", async () => {
	for (const custom of [false, true]) {
		const id = custom ? "cache-custom-fixture" : "cache-native-fixture";
		const faux = createFauxCore({});
		const entry = { ...faux.getModel(), provider: id };
		const seen: SimpleStreamOptions[] = [];
		const stream: StreamFunction = (m, c, options) => {
			seen.push(options ?? {});
			faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			return faux.streamSimple(m, c, options);
		};
		const provider = createProvider({ id, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } });
		if (custom) configureProviderSource({ isCustom: (value) => value === id, sync: (models) => { models.setProvider(provider); } });
		else piModels().setProvider(provider);
		let retention: CacheRetention | undefined;
		const engine = piEngineForSpec({ provider: id, id: entry.id }, true, undefined, () => retention);
		for (const value of [undefined, "long", "short", "none", undefined] as const) {
			retention = value;
			const request = engine.streamFn(engine.model, context, { sessionId: "same-agent" });
			retention = value === "long" ? "short" : "long"; // does not change an operation already started
			await request.result();
			assert.equal(seen.at(-1)!.cacheRetention, value);
			assert.equal(Object.hasOwn(seen.at(-1)!, "cacheRetention"), value !== undefined, "default must not inject even an undefined request property");
		}
		piModels().deleteProvider(id);
	}
});
