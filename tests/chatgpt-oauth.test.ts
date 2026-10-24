import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import {
	CHATGPT_PROVIDER_ID,
	ChatGPTBrokerCredentialStore,
} from "../src/agent/chatgpt-broker.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { modelCatalog, validateModelsSettings } from "../src/server/model-catalog.ts";

const require = createRequire(import.meta.url);
const { createEncryptedCredentialStore } = require("../electron/chatgpt-oauth.cjs") as {
	createEncryptedCredentialStore: (
		filePath: string,
		safeStorage: {
			isEncryptionAvailable(): boolean;
			encryptString(value: string): Buffer;
			decryptString(value: Buffer): string;
		},
	) => {
		read(providerId: string): Promise<Record<string, unknown> | undefined>;
		list(): Promise<Array<{ providerId: string; type: string }>>;
		modify(
			providerId: string,
			fn: (current: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>,
		): Promise<Record<string, unknown> | undefined>;
		delete(providerId: string): Promise<void>;
	};
};

const originalBrokerUrl = process.env.LH_CHATGPT_BROKER_URL;
const originalBrokerSecret = process.env.LH_CHATGPT_BROKER_SECRET;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
	if (originalBrokerUrl === undefined) delete process.env.LH_CHATGPT_BROKER_URL;
	else process.env.LH_CHATGPT_BROKER_URL = originalBrokerUrl;
	if (originalBrokerSecret === undefined) delete process.env.LH_CHATGPT_BROKER_SECRET;
	else process.env.LH_CHATGPT_BROKER_SECRET = originalBrokerSecret;
	if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenAIKey;
	globalThis.fetch = originalFetch;
});

describe("ChatGPT OAuth provider alias", () => {
	it("adds a separate ChatGPT catalog without replacing OpenAI API-key models", () => {
		process.env.LH_CHATGPT_BROKER_URL = "http://127.0.0.1:12345";
		process.env.LH_CHATGPT_BROKER_SECRET = "test-secret";
		process.env.OPENAI_API_KEY = "sk-test";

		const catalog = modelCatalog({ chatGPTConnected: true });
		const openAI = catalog.models.filter((model) => model.provider === "openai");
		const chatGPT = catalog.models.filter((model) => model.provider === CHATGPT_PROVIDER_ID);

		assert.ok(openAI.length > 0);
		assert.deepEqual(chatGPT.map((model) => model.id), openAI.map((model) => model.id));
		assert.equal(catalog.providers.find((provider) => provider.id === CHATGPT_PROVIDER_ID)?.keyPresent, true);
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: CHATGPT_PROVIDER_ID, id: chatGPT[0]!.id } } }),
			{ ok: true },
		);

		const engine = piEngineForSpec({ provider: CHATGPT_PROVIDER_ID, id: chatGPT[0]!.id });
		assert.equal(engine.model.provider, "openai");
	});

	it("projects broker tokens as OAuth credentials without persisting them in Next", async () => {
		process.env.LH_CHATGPT_BROKER_URL = "http://127.0.0.1:12345";
		process.env.LH_CHATGPT_BROKER_SECRET = "test-secret";
		globalThis.fetch = async (_input, init) => {
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
			return Response.json({ accessToken: "oauth-access-token", expires: Date.now() + 3_600_000 });
		};

		const credential = await new ChatGPTBrokerCredentialStore().read("openai");
		assert.equal(credential?.type, "oauth");
		assert.equal(credential && "access" in credential ? credential.access : undefined, "oauth-access-token");
	});
});

describe("Electron ChatGPT credential storage", () => {
	it("encrypts the persisted credential and can read it after restart", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-chatgpt-"));
		const file = path.join(directory, "chatgpt-oauth.enc.json");
		const key = crypto.randomBytes(32);
		const safeStorage = {
			isEncryptionAvailable: () => true,
			encryptString(value: string) {
				const iv = crypto.randomBytes(12);
				const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
				const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
				return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
			},
			decryptString(value: Buffer) {
				const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
				decipher.setAuthTag(value.subarray(12, 28));
				return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
			},
		};

		try {
			const first = createEncryptedCredentialStore(file, safeStorage);
			await first.modify("openai", async () => ({
				type: "oauth",
				access: "secret-access-token",
				refresh: "secret-refresh-token",
				expires: Date.now() + 3_600_000,
			}));

			const raw = await fs.readFile(file, "utf8");
			assert.doesNotMatch(raw, /secret-access-token|secret-refresh-token/);

			const restarted = createEncryptedCredentialStore(file, safeStorage);
			assert.equal((await restarted.read("openai"))?.type, "oauth");
			assert.deepEqual(await restarted.list(), [{ providerId: "openai", type: "oauth" }]);
			await restarted.delete("openai");
			assert.equal(await restarted.read("openai"), undefined);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
