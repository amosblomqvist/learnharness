import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-manual-catalog-"));
const snapshot = path.join(scratch, "model-catalog.json");
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { initializeModelCatalog, refreshModelCatalog } = await import("../src/server/remote-model-catalog.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const row = {
	id: "test-new-vision", name: "Test vision", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"], reasoning: true, thinkingLevelMap: { minimal: null, high: "high" },
	cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 120_000, maxTokens: 12_000,
};

function startupModel(snapshotPath: string) {
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		globalThis.fetch = () => { throw new Error("startup must not fetch"); };
		const { initializeModelCatalog } = await import("./src/server/remote-model-catalog.ts");
		const { piModels } = await import("./src/agent/models.ts");
		initializeModelCatalog();
		const model = piModels().getModel("openai", "test-new-vision");
		console.log(JSON.stringify(model?.name ?? null));
	`], { env: { ...process.env, LH_DATA_DIR: snapshotPath }, encoding: "utf-8", timeout: 15_000 });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("manual catalog refresh extends picker and engine, keeps routes and survives failure/restart", async (t) => {
	const pending: (() => Response | Promise<Response>)[] = [];
	const requests: string[] = [];
	const fetchMock = t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
		requests.push(input.href);
		assert.equal(input.origin, "https://pi.dev");
		assert.equal(input.search, "?types=chat");
		assert.equal(init.redirect, "error");
		assert.equal(init.cache, "no-store");
		assert.equal(init.credentials, "omit");
		assert.deepEqual([...new Headers(init.headers)], [["accept", "application/json"]]);
		assert.ok(init.signal && !init.signal.aborted);
		const next = pending.shift();
		assert.ok(next, "unexpected network request");
		return next();
	});
	initializeModelCatalog();
	assert.equal(await refreshModelCatalog(), "no-providers");
	assert.equal(fetchMock.mock.callCount(), 0);
	assert.equal(fs.existsSync(snapshot), false);

	process.env.OPENAI_API_KEY = "synthetic-openai-test-key";
	process.env.RADIUS_API_KEY = "synthetic-radius-test-key";
	process.env.TYPESAFE_API_KEY = "synthetic-typesafe-test-key";
	const collection = piModels(); // In use before the refresh publishes.
	const bundled = collection.getModels("openai")[0]!;
	writeSettings({ version: 1, models: { strong: { model: { provider: "openai", id: bundled.id } } } });
	const settings = readSettings();
	modelCatalog();
	assert.equal(fetchMock.mock.callCount(), 0);

	pending.push(() => Response.json({ models: [
		{ ...row, headers: { Authorization: "never-retain", Host: "unexpected.invalid" } },
		{ ...row, id: bundled.id, name: "do-not-replace-bundled" },
		{ ...row, id: "bad-host", baseUrl: "https://unexpected.invalid/v1" },
		{ ...row, id: "bad-path", baseUrl: `${row.baseUrl}/other` },
		{ ...row, id: "bad-api", api: "anthropic-messages" },
		{ ...row, id: "bad-provider", provider: "chatgpt" },
		{ ...row, id: "bad-kind", type: "image" },
		{ ...row, id: "bad-cost", cost: { ...row.cost, input: -1 } },
		{ ...row, id: "bad-limit", maxTokens: 0 },
		{ ...row, id: "bad-input", input: ["audio"] },
		{ ...row, id: "bad-thinking-map", thinkingLevelMap: { high: {} } },
	] }));
	const first = refreshModelCatalog();
	assert.equal(refreshModelCatalog(), first);
	assert.equal(await first, "updated");
	assert.deepEqual(requests, ["https://pi.dev/api/models/providers/openai?types=chat"]);
	const models = modelCatalog().models.filter((model) => model.provider === "openai");
	assert.equal(models.length, collection.getModels("openai").length);
	assert.equal(models.find((m) => m.id === row.id)?.input.includes("image"), true);
	assert.equal(collection.getModel("openai", bundled.id), bundled);
	assert.equal(collection.getModels("openai").filter((m) => m.id.startsWith("bad-")).length, 0);
	const model = piEngineForSpec({ provider: "openai", id: row.id }).model;
	assert.equal(model.baseUrl, row.baseUrl);
	assert.equal(model.headers, undefined);
	assert.equal(model.thinkingLevelMap?.minimal, null);
	assert.deepEqual(validateModelsSettings({ vision: { model: { provider: "openai", id: row.id } } }), { ok: true });
	assert.deepEqual(readSettings(), settings);
	const good = fs.readFileSync(snapshot, "utf-8");
	assert.ok(!good.includes("never-retain") && !good.includes("synthetic-openai"));

	for (const fail of [
		() => new Response(null, { status: 503 }),
		() => Response.json({ notModels: 1 }),
		() => new Response("x".repeat(2 * 1024 * 1024 + 1)),
	]) {
		pending.push(fail);
		await assert.rejects(refreshModelCatalog());
		assert.equal(fs.readFileSync(snapshot, "utf-8"), good);
		assert.equal(collection.getModel("openai", row.id), model);
	}
	pending.push(() => new Response(null, { status: 404 }));
	assert.equal(await refreshModelCatalog(), "unchanged");
	pending.push(() => Response.json([{ ...row, id: "test-second-vision" }]));
	assert.equal(await refreshModelCatalog(), "updated");
	assert.ok(collection.getModel("openai", row.id), "omissions must not invalidate a pin");
	assert.equal(startupModel(scratch), row.name);

	fs.writeFileSync(snapshot, "invalid json");
	assert.equal(startupModel(scratch), null);
});
