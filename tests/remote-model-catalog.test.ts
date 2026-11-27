import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
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

const baseten = {
	...row, id: "test-baseten-wire", provider: "baseten", api: "openai-completions", baseUrl: "https://inference.baseten.co/v1",
	compat: {
		thinkingFormat: "baseten", chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
		maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: false,
	},
};
const xai = {
	...row, id: "test-xai-wire", provider: "xai", baseUrl: "https://api.x.ai/v1",
	compat: { supportsLongCacheRetention: false, supportsReasoningEffort: true },
	inputLimits: { maxRequestBytes: 20_000_000, images: { maxPerRequest: 10, resize: { maxWidth: 1600, maxHeight: 1700, maxBytes: 2_000_000, jpegQuality: 85 } } },
};

function startupModels(snapshotPath: string) {
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		let fetches = 0;
		globalThis.fetch = () => { fetches++; throw new Error("startup must not fetch"); };
		const { initializeModelCatalog } = await import("./src/server/remote-model-catalog.ts");
		const { piModels } = await import("./src/agent/models.ts");
		initializeModelCatalog();
		const coordinates = ${JSON.stringify([row, baseten, xai].map(({ provider, id }) => [provider, id]))};
		const models = coordinates.map(([provider, id]) => piModels().getModel(provider, id));
		if (fetches) throw new Error("startup attempted to fetch");
		console.log(JSON.stringify(models));
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
		{ ...row, id: "bad-kind", type: "image" },
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
		...[
			{ provider: "chatgpt" }, { cost: { ...row.cost, input: -1 } }, { maxTokens: 0 },
			{ input: ["audio"] }, { thinkingLevelMap: { high: {} } }, { compat: { supportsLongCacheRetention: "no" } },
			{ inputLimits: { images: { resize: { maxWidth: 20_000 } } } }, { samplingParams: { arbitrary: "unsupported" } },
		].map((overrides) => () => Response.json([{ ...row, ...overrides, id: "bad-eligible" }])),
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
	assert.equal(startupModels(scratch)[0]?.name, row.name);
});

test("wire behavior survives validated refresh and offline restore; mixed shard failure is atomic", async (t) => {
	delete process.env.OPENAI_API_KEY;
	process.env.BASETEN_API_KEY = "synthetic-baseten-key";
	process.env.XAI_API_KEY = "synthetic-xai-key";
	const shards = new Map<string, unknown[]>([
		["baseten", [baseten]], ["xai", [{ ...xai, compat: { ...xai.compat, openRouterRouting: { only: ["ignored"] } } }]],
	]);
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: URL) => {
		assert.equal(url.origin, "https://pi.dev");
		const provider = url.pathname.split("/").at(-1)!;
		requests.push(provider);
		assert.ok(shards.has(provider));
		return Response.json(shards.get(provider));
	});
	assert.equal(await refreshModelCatalog(), "updated");
	assert.deepEqual(requests.sort(), ["baseten", "xai"]);
	const good = fs.readFileSync(snapshot, "utf-8");
	const live = [baseten, xai].map(({ provider, id }) => piModels().getModel(provider, id));
	const [, restoredBaseten, restoredXai] = startupModels(scratch);
	assert.deepEqual(restoredBaseten.compat, baseten.compat);
	assert.deepEqual(restoredXai.compat, xai.compat);
	assert.deepEqual(restoredXai.inputLimits, xai.inputLimits);

	// A legitimate new xAI row must not become selectable if another keyed
	// shard contains an eligible row requiring an unknown Baseten template.
	shards.set("baseten", [{ ...baseten, id: "test-unreviewed-template", compat: { ...baseten.compat, chatTemplateArgs: { unreviewed: true } } }]);
	shards.set("xai", [{ ...xai, id: "test-xai-pending" }]);
	requests.length = 0;
	await assert.rejects(refreshModelCatalog(), /Unsupported pi.dev model template/);
	assert.deepEqual(requests.sort(), ["baseten", "xai"]);
	assert.equal(fs.readFileSync(snapshot, "utf-8"), good);
	assert.deepEqual([baseten, xai].map(({ provider, id }) => piModels().getModel(provider, id)), live);
	assert.equal(piModels().getModel("xai", "test-xai-pending"), undefined);

	for (const { provider, id, baseUrl } of [baseten, xai]) {
		const engine = piEngineForSpec({ provider, id, thinkingLevel: "high" }, true, undefined, () => "long");
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const result = await engine.streamFn(engine.model, normalizeContext({
			systemPrompt: "Synthetic review fixture.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		}), {
			maxTokens: 1234, sessionId: "synthetic-session",
			fetch: async (input, init) => {
				requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				const chunk = { id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
				return new Response(provider === "baseten" ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` : "data: [DONE]\n\n", {
					headers: { "content-type": "text/event-stream" },
				});
			},
		}).result();
		assert.equal(requests.length, 1, result.errorMessage);
		const { url, body } = requests[0]!;
		assert.equal(url, `${baseUrl}/${provider === "baseten" ? "chat/completions" : "responses"}`);
		assert.equal(body.model, id);
		if (provider === "baseten") {
			assert.deepEqual(body.chat_template_args, { enable_thinking: true });
			assert.equal(body.reasoning_effort, "high");
			assert.equal(body.max_tokens, 1234);
			assert.equal(body.max_completion_tokens, undefined);
			assert.equal((body.messages as { role: string }[])[0]?.role, "system");
			assert.equal(body.stream_options, undefined);
		} else {
			assert.equal(body.prompt_cache_retention, undefined);
			assert.equal(body.prompt_cache_options, undefined);
			assert.deepEqual(engine.model.inputLimits, xai.inputLimits);
		}
	}

	fs.writeFileSync(snapshot, "invalid json");
	assert.deepEqual(startupModels(scratch), [null, null, null]);
});
