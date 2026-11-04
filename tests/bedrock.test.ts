import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, normalizeContext } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { BEDROCK_AUTH_ENV_VARS, BEDROCK_PROVIDER, bedrockConfigured } from "../src/core/bedrock.ts";

const dir = mkdtempSync(join(tmpdir(), "lh-bedrock-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = join(dir, "auth.json");
for (const name of BEDROCK_AUTH_ENV_VARS) delete process.env[name];
delete process.env.LH_IGNORE_ENV_KEYS;
const { saveKey, deleteKey, providerKeyPresent, providerKeyList, initAuthEnv, keyStatuses } = await import("../src/server/keys.ts");
const { modelCatalog, catalogContextLimits, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const cases: [string, Record<string, string>, boolean][] = [
	["unconfigured", {}, false],
	["region alone", { AWS_REGION: "us-east-1" }, false],
	["incomplete access key", { AWS_ACCESS_KEY_ID: "test-id" }, false],
	["incomplete secret", { AWS_SECRET_ACCESS_KEY: "test-secret" }, false],
	["session token alone", { AWS_SESSION_TOKEN: "test-token" }, false],
	["empty profile", { AWS_PROFILE: "" }, false],
	["profile", { AWS_PROFILE: "test-profile" }, true],
	["default profile", { AWS_PROFILE: "default" }, true],
	["access keys", { AWS_ACCESS_KEY_ID: "test-id", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-session" }, true],
	["bearer", { AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-token" }, true],
	["ECS relative", { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/test" }, true],
	["ECS full", { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/credentials" }, true],
	["web identity", { AWS_WEB_IDENTITY_TOKEN_FILE: "/test/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test" }, true],
];

describe("Bedrock configuration matches native Pi authentication", () => {
	for (const [name, env, expected] of cases) it(name, async () => {
		const models = createModels({ authContext: { env: async (key) => env[key], fileExists: async () => false } });
		models.setProvider(amazonBedrockProvider());
		assert.equal(bedrockConfigured(env), expected);
		assert.equal(Boolean(await models.getAuth(BEDROCK_PROVIDER.id)), expected);
	});
});

describe("Bedrock setup, catalog and request admission", () => {
	it("offers the bearer credential in the existing provider form", () => {
		assert.deepEqual(providerKeyList().find((p) => p.id === BEDROCK_PROVIDER.id), BEDROCK_PROVIDER);
		assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === BEDROCK_PROVIDER.id), false);
	});

	it("saving and deleting a bearer key immediately updates admission and model selection", () => {
		const token = "test-bedrock-bearer-credential";
		const saved = saveKey(BEDROCK_PROVIDER.envVar, token);
		assert.equal(saved.ok, true);
		assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), true);
		assert.ok(modelCatalog().models.some((m) => m.provider === BEDROCK_PROVIDER.id));
		assert.ok(!JSON.stringify(keyStatuses()).includes(token));
		assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, token);
		deleteKey(BEDROCK_PROVIDER.envVar);
		assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
		assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === BEDROCK_PROVIDER.id), false);
	});

	it("AWS profile users can pick native models for every slot with pricing, limits and thinking metadata", () => {
		process.env.AWS_PROFILE = "fixture-profile";
		try {
			const catalog = modelCatalog();
			assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), true);
			assert.equal(catalog.providers.find((p) => p.id === BEDROCK_PROVIDER.id)?.keyPresent, true);
			const model = catalog.models.find((m) => m.provider === BEDROCK_PROVIDER.id && m.input.includes("image"));
			assert.ok(model);
			assert.ok(model.contextWindow && model.contextWindow > 0);
			assert.ok(model.cost);
			assert.ok(model.supportedLevels.length);
			const pin = { model: { provider: model.provider, id: model.id } };
			assert.deepEqual(validateModelsSettings({ strong: pin, cheap: pin, vision: pin }), { ok: true });
			assert.equal(catalogContextLimits().get(`${model.provider}:${model.id}`), model.contextWindow);
			delete process.env.AWS_PROFILE;
			assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), false);
			assert.equal(catalogContextLimits().has(`${model.provider}:${model.id}`), false);
		} finally { delete process.env.AWS_PROFILE; }
	});

	it("production engine reaches native Converse serialization with AWS profile auth and tool/image context", async () => {
		process.env.AWS_PROFILE = "fixture-profile";
		try {
			const model = piModels().getModels(BEDROCK_PROVIDER.id).find((m) => m.id === "us.anthropic.claude-haiku-4-5-20251001-v1:0");
			assert.ok(model);
			const engine = piEngineForSpec({ provider: model.provider, id: model.id, thinkingLevel: "off" });
			let reached = 0;
			const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{
				role: "user",
				content: [{ type: "text", text: "Describe this image." }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
				timestamp: 0,
			}], tools: [{ name: "answer", description: "Answer the question", parameters: { type: "object", properties: { text: { type: "string" } } } }] }), {
				onPayload(payload) {
					const body = payload as { modelId: string; messages: { content: { image?: unknown }[] }[]; toolConfig: unknown };
					assert.equal(body.modelId, model.id);
					assert.ok(body.messages[0]?.content.some((part) => part.image));
					assert.ok(body.toolConfig);
					reached++;
					throw new Error("BEDROCK_OFFLINE_STOP_BEFORE_NETWORK");
				},
			}).result();
			assert.equal(reached, 1);
			assert.equal(result.errorMessage, "BEDROCK_OFFLINE_STOP_BEFORE_NETWORK");
		} finally { delete process.env.AWS_PROFILE; }
	});

	it("fresh-user mode suppresses every ambient AWS auth path but accepts a newly saved bearer token", () => {
		for (const name of BEDROCK_AUTH_ENV_VARS) process.env[name] = "fixture";
		process.env.LH_IGNORE_ENV_KEYS = "1";
		try {
			assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), false);
			initAuthEnv();
			for (const name of BEDROCK_AUTH_ENV_VARS) assert.equal(process.env[name], undefined, name);
			assert.equal(saveKey(BEDROCK_PROVIDER.envVar, "test-fresh-bedrock-bearer").ok, true);
			assert.equal(providerKeyPresent(BEDROCK_PROVIDER.id), true);
			deleteKey(BEDROCK_PROVIDER.envVar);
		} finally { delete process.env.LH_IGNORE_ENV_KEYS; }
	});
});
