import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { isModelType, normalizeContext, Type } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { withOpenAIGpt62Models } from "../src/agent/openai-gpt62-models.ts";

const dir = mkdtempSync(path.join(tmpdir(), "lh-openai-gpt62-"));
const before = { LH_DATA_DIR: process.env.LH_DATA_DIR, LH_AUTH_FILE: process.env.LH_AUTH_FILE, OPENAI_API_KEY: process.env.OPENAI_API_KEY, LH_IGNORE_ENV_KEYS: process.env.LH_IGNORE_ENV_KEYS };
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.OPENAI_API_KEY;
delete process.env.LH_IGNORE_ENV_KEYS;
writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { modelCatalog, validateChatSettings } = await import("../src/server/model-catalog.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
after(() => {
	for (const [name, value] of Object.entries(before)) {
		if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

const models = [
	{ id: "gpt-6.2-astra", cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 } },
	{ id: "gpt-6.2-sol", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
];

test("GPT-6.2 models are gated by the OpenAI key, selectable as Strong, and dispatched by their exact Responses IDs", async (t) => {
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
	const keyless = modelCatalog();
	for (const { id } of models) assert.ok(!keyless.models.some((m) => m.provider === "openai" && m.id === id));

	process.env.OPENAI_API_KEY = "sk-synthetic-catalog-test";
	const catalog = modelCatalog();
	for (const { id, cost } of models) {
		const model = { provider: "openai", id };
		const entry = catalog.models.find((m) => m.provider === model.provider && m.id === id);
		assert.ok(entry, id);
		assert.deepEqual(entry.input, ["text", "image"]);
		assert.deepEqual(entry.supportedLevels, ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(entry.contextWindow, 272_000);
		assert.equal(entry.maxTokens, 128_000);
		assert.deepEqual(entry.cost, cost);
		assert.deepEqual(validateChatSettings({ model }), { ok: true });

		const strong = { model, thinkingLevel: "max" } as const;
		const response = await PUT(new Request("http://localhost/api/settings/models", {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strong }),
		}), { params: Promise.resolve({ section: "models" }) });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(modelCatalog().slots.strong, strong);

		const engine = piEngineForSpec({ ...model, thinkingLevel: "max" });
		assert.equal(engine.model.api, "openai-responses");
		assert.equal(engine.level, "max");
		const context = normalizeContext({
			messages: [{ role: "user", content: "Give me a question.", timestamp: 1 }],
			tools: [{ name: "ask_question", description: "Ask one study question.", parameters: Type.Object({}) }],
		});
		type WireTool = { type: string; name?: string };
		let payload: { model: string; tools?: WireTool[]; input: { type?: string; tools?: WireTool[] }[] } | undefined;
		const result = await engine.streamFn(engine.model, context, {
			onPayload: (body) => { payload = body as typeof payload; throw new Error("Captured before dispatch"); },
		}).result();
		assert.ok(payload, result.errorMessage);
		assert.equal(payload.model, id);
		const declared = payload.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? []);
		assert.ok([...payload.tools ?? [], ...declared].some((tool) => tool.type === "function" && tool.name === "ask_question"));
	}
});

test("Pi-supplied GPT-6.2 entries take precedence and the full catalog retains classifiers", () => {
	const provider = openaiProvider();
	const classifier = provider.getAllModels!().find((model) => isModelType(model, "classifier"));
	assert.ok(classifier);
	const template = provider.getModels()[0]!;
	const supplied = models.map(({ id }) => ({ ...template, id, name: `Upstream ${id}` }));
	for (const native of [supplied.slice(0, 1), supplied]) {
		const result = withOpenAIGpt62Models({
			...provider, getModels: () => native, getAllModels: () => [...native, classifier],
		});
		for (const catalog of [result.getModels(), result.getAllModels!()]) {
			for (const { id } of models) assert.equal(catalog.filter((m) => m.id === id).length, 1);
			for (const original of native) assert.equal(catalog.find((m) => m.id === original.id), original);
		}
		assert.ok(result.getAllModels!().includes(classifier));
	}
});
