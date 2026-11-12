import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { catalogProviders, validateChatSettings, validateModelsSettings } from "../src/server/model-catalog.ts";
import { isWritableAuthKey, providerKeyList, resolveKeyStatuses } from "../src/server/keys.ts";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";

describe("9router integration", () => {
	it("piModels() includes 9router provider", () => {
		const providers = piModels().getProviders();
		assert.ok(providers.some((p) => p.id === "9router"), "9router is in piModels providers");
	});

	it("catalogProviders includes 9router entry", () => {
		const providers = catalogProviders();
		const p9 = providers.find((p) => p.id === "9router");
		assert.ok(p9, "9router in catalogProviders");
		assert.equal(p9?.envVar, "NINEROUTER_API_KEY");
		assert.equal(typeof p9?.keyPresent, "boolean");
	});

	it("piModels() exposes 9router baseline models", () => {
		const ninerouterModels = piModels().getModels("9router");
		assert.ok(ninerouterModels.length > 0, "has 9router models");
		const gemini = ninerouterModels.find((m) => m.id === "gemini/gemini-3.8-flash");
		assert.ok(gemini, "gemini-3.8-flash is present in 9router catalog");
		assert.equal(gemini?.provider, "9router");
	});

	it("validateModelsSettings accepts 9router model slot", () => {
		const result = validateModelsSettings({
			strong: { model: { provider: "9router", id: "gemini/gemini-3.8-flash" } },
		});
		assert.equal(result.ok, true);
	});

	it("validateChatSettings accepts 9router chat model", () => {
		const result = validateChatSettings({
			model: { provider: "9router", id: "gemini/gemini-3.8-flash" },
		});
		assert.equal(result.ok, true);
	});

	it("piEngineForSpec resolves engine for 9router spec", () => {
		const engine = piEngineForSpec({
			provider: "9router",
			id: "gemini/gemini-3.8-flash",
		});
		assert.ok(engine, "engine created");
		assert.equal(engine.model.provider, "9router");
		assert.equal(engine.model.id, "gemini/gemini-3.8-flash");
		assert.equal(typeof engine.streamFn, "function");
	});

	it("providerKeyList includes 9router for Settings Providers UI", () => {
		const list = providerKeyList();
		const row = list.find((p) => p.id === "9router");
		assert.ok(row, "9router in providerKeyList");
		assert.equal(row?.envVar, "NINEROUTER_API_KEY");
		assert.equal(isWritableAuthKey("NINEROUTER_API_KEY"), true);
	});

	it("keyStatuses handles NINEROUTER_API_KEY when key is present", () => {
		const statuses = resolveKeyStatuses({ NINEROUTER_API_KEY: "sk-9router-test-key" }, {}, new Set(), new Set(["NINEROUTER_API_KEY"]));
		const row = statuses.find((s) => s.id === "NINEROUTER_API_KEY");
		assert.ok(row, "NINEROUTER_API_KEY status row exists");
		assert.equal(row?.present, true);
	});
});
