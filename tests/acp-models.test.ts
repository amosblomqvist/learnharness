import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ACP_AGENTS, parseAcpConfig, type UserSettings } from "../src/core/index.ts";
import { AcpClient } from "../src/agent/acp/client.ts";
import { discoverAcpModels } from "../src/agent/acp/catalog.ts";
import { createAcpEngine } from "../src/agent/acp/engine.ts";
import { connectAcp, engineForSpec } from "../src/server/acp.ts";
import { modelCatalog, validateModelsSettings, clampModelsLevels } from "../src/server/model-catalog.ts";
import { stores } from "../src/server/stores.ts";
import { configureAcpHost } from "./helpers/acp-host.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "acp-agent.mjs");
const config = (mode: string) => ({ command: process.execPath, args: [fixture, mode] });
const context = () => normalizeContext({ messages: [{ role: "user", content: "Inspect selections", timestamp: Date.now() }] });
const text = (message: { content: Array<{ type: string; text?: string }> }) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");

describe("ACP model and reasoning selection", { concurrency: false }, () => {
	for (const agent of ACP_AGENTS) {
		it(`${agent.id}: discovers model-specific levels, persists the catalog and applies choices before each prompt`, async (test) => {
			configureAcpHost(test, { [agent.id]: config(`models-${agent.id}`) });
			let record: UserSettings = { version: 1 };
			test.mock.method(stores.settingsStore, "readSettings", () => record);
			test.mock.method(stores.settingsStore, "writeSettings", (next: UserSettings) => { record = next; return record; });
			const connection = await connectAcp(agent.id, {});
			assert.equal(connection.ok, true, JSON.stringify(connection));
			const snapshot = record.acp![agent.id]!.models!;
			assert.deepEqual(snapshot.find((model) => model.id === "model/alpha")?.reasoning, { low: "low", high: "high" });
			assert.deepEqual(snapshot.find((model) => model.id === "model/beta")?.reasoning, { medium: "medium", max: "max" });
			assert.ok(snapshot.some((model) => model.id === "default" && model.modelId === undefined));
			assert.ok(snapshot.some((model) => model.id === "model/default" && model.modelId === "default"), "native default ID must not collide with the legacy agent-default alias");
			assert.deepEqual(parseAcpConfig(record.acp![agent.id]), { ok: true, config: record.acp![agent.id] });
			const catalog = modelCatalog();
			assert.deepEqual(catalog.models.find((model) => model.provider === agent.provider && model.id === "model/beta")?.supportedLevels, ["medium", "max"]);
			assert.deepEqual(catalog.models.find((model) => model.provider === agent.provider && model.id === "model/plain")?.supportedLevels, []);
			const pin = { model: { provider: agent.provider, id: "model/beta" }, thinkingLevel: "max" as const };
			assert.equal(validateModelsSettings({ strong: pin, cheap: pin, vision: pin }).ok, true);
			assert.equal(clampModelsLevels({ strong: { ...pin, thinkingLevel: "low" } }).strong?.thinkingLevel, "medium");
			for (let round = 0; round < 2; round++) {
				const engine = engineForSpec({ ...pin.model, thinkingLevel: pin.thinkingLevel });
				const response = await engine.streamFn(engine.model, context()).result();
				assert.equal(response.stopReason, "stop", response.errorMessage);
				assert.equal(response.model, "model/beta");
				const inspected = JSON.parse(text(response));
				assert.equal(inspected.model, "beta");
				assert.equal(inspected.reasoning, "max");
				assert.deepEqual(inspected.selections.map((item: { value: string }) => item.value), ["beta", "max"]);
			}
			const nativeDefault = engineForSpec({ provider: agent.provider, id: "model/default", thinkingLevel: "low" });
			assert.equal(JSON.parse(text(await nativeDefault.streamFn(nativeDefault.model, context()).result())).model, "default");
			const legacy = engineForSpec({ provider: agent.provider, id: "default" });
			const legacyResponse = JSON.parse(text(await legacy.streamFn(legacy.model, context()).result()));
			assert.deepEqual(legacyResponse.selections, [], "unset legacy selection retains the native configuration");
			const oldSetupPin = engineForSpec({ provider: agent.provider, id: "default", thinkingLevel: "off" });
			assert.deepEqual(JSON.parse(text(await oldSetupPin.streamFn(oldSetupPin.model, context()).result())).selections, [], "legacy off placeholder must retain native reasoning, rather than clamp to low");
		});
	}
	it("refuses expired model choices and ignored model changes before inference", async () => {
		const client = new AcpClient("codex", config("models-codex"));
		let models;
		try {
			await client.initialize();
			models = await discoverAcpModels(client, await client.newSession({ mcpServers: [] }));
		} finally { await client.close(); }
		for (const [mode, info, pattern] of [
			["models-codex", { id: "model/gone", modelId: "gone", name: "Gone", reasoning: {} }, /no longer available/],
			["models-ignore", models.find((model) => model.id === "model/beta")!, /did not apply/],
		] as const) {
			const engine = createAcpEngine("codex", config(mode), info);
			const response = await engine.streamFn(engine.model, context()).result();
			assert.equal(response.stopReason, "error");
			assert.match(response.errorMessage!, pattern);
			assert.equal(text(response), "");
		}
		const plainInfo = models.find((model) => model.id === "model/plain")!;
		const plain = createAcpEngine("codex", config("models-codex"), plainInfo, "high");
		const plainResponse = await plain.streamFn(plain.model, context()).result();
		assert.equal(plainResponse.stopReason, "stop", plainResponse.errorMessage);
		assert.deepEqual(JSON.parse(text(plainResponse)).selections.map((item: { value: string }) => item.value), ["plain"], "a non-reasoning model must not inherit an incompatible slot-level effort");
		const stalePlain = createAcpEngine("codex", config("models-codex"), { ...plainInfo, reasoning: { high: "high" } }, "high");
		assert.match((await stalePlain.streamFn(stalePlain.model, context()).result()).errorMessage!, /does not support high reasoning/);
	});
});
