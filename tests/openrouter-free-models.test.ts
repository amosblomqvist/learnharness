import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { modelCatalog, validateChatSettings, validateModelsSettings } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";

const specimens = [
	{ id: "recursive/flint-v1.0:free", input: ["text"] },
	{ id: "xingchen-agi/xing4.0-29b-a4b:free", input: ["text"] },
	{ id: "nvidia/nemotron-3.5-super-vl:free", input: ["text", "image"] },
	{ id: "openrouter/free", input: ["text", "image"] },
];

describe("native 1.4 OpenRouter free catalog (offline, no live discovery)", { concurrency: false }, () => {
	for (const { id, input } of specimens) {
		it(`${id}: shared listing, validation, tool-capable engine, native modality, and zero cost`, async () => {
			const before = process.env;
			const originalFetch = globalThis.fetch;
			process.env = { NODE_ENV: "test", HOME: "/nonexistent/free-catalog", OPENROUTER_API_KEY: "dummy-free-catalog" };
			try {
				const catalog = modelCatalog();
				const listed = catalog.models.find((m) => m.provider === "openrouter" && m.id === id);
				assert.ok(listed);
				assert.deepEqual(listed.input, input);
				assert.deepEqual(listed.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
				const model = { provider: "openrouter", id };
				assert.deepEqual(validateChatSettings({ model }), { ok: true });
				assert.deepEqual(validateModelsSettings({ strong: { model }, cheap: { model } }), { ok: true });
				assert.equal(validateModelsSettings({ vision: { model } }).ok, true, "server catalog validation stays provider/model based; vision filtering belongs to the picker");
				assert.equal(catalog.models.filter((m) => m.input.includes("image")).some((m) => m.provider === "openrouter" && m.id === id), input.includes("image"));
				const engine = piEngineForSpec(model);
				assert.equal(engine.model, piModels().getModel("openrouter", id));
				assert.equal(engine.model.api, "openai-completions");
				assert.deepEqual(engine.model.input, input);
				assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }, `openrouter:${id}`), 0);
				let payload: Record<string, unknown> | undefined;
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					assert.equal(new URL(request.url).origin, "https://openrouter.ai");
					assert.equal(request.headers.get("authorization"), "Bearer dummy-free-catalog");
					payload = JSON.parse(await request.text());
					return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
				};
				await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }], tools: [{ name: "offline_tool", description: "offline", parameters: Type.Object({}) }] }), { sessionId: "chat_free_offline" }).result();
				assert.equal(payload?.model, id);
				assert.match(JSON.stringify(payload?.tools), /offline_tool/);
				delete process.env.OPENROUTER_API_KEY;
				assert.ok(!modelCatalog().models.some((m) => m.provider === "openrouter"), "even free models retain the provider key gate");
			} finally { process.env = before; globalThis.fetch = originalFetch; }
		});
	}
	it("removed/unknown native models remain unpriced and unresolvable, never aliased to a paid fallback", () => {
		assert.equal(callCost({ inputTokens: 1, outputTokens: 1 }, "openrouter:removed/no-such-model"), null);
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "removed/no-such-model" }), /catalog has no model/);
	});
});
