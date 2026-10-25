import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { protectedStore } = require("../electron/protected-store.cjs");
const { fileStore: chatGPTStore, createChatGPT, SCOPES } = require("../electron/chatgpt.cjs");
const { fileStore: subscriptionStore } = require("../electron/subscription-store.cjs");
const { syntheticSafeStorage: secure } = require("./fixtures/synthetic-safe-storage.cjs");
const chatState = () => ({ version: 1, hostId: "urn:uuid:synthetic", activeId: "account", allowBackgroundUse: false, registrations: [{ id: "account", clientId: "oaiapp_synthetic", issuer: "https://auth.openai.com", subject: "synthetic-subject", tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: "synthetic-id", expiresAt: Date.now() + 3600000, scopes: SCOPES } }] });
const nativeState = () => ({ version: 1, allowBackgroundUse: false, connectionId: "fa975600-7881-4e52-ae0a-6da2990d4aef", credential: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000 } });

for (const provider of ["chatgpt", "github-copilot", "xai"]) test(`${provider}: same-profile conversion, protected restart and replacement preserve identity/consent`, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-protected-"));
	const file = path.join(directory, "credentials.json");
	const store = () => provider === "chatgpt" ? chatGPTStore(file, secure) : subscriptionStore(file, provider, undefined, secure);
	const state = provider === "chatgpt" ? chatState() : nativeState();
	try {
		await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
		assert.deepEqual(await store().read(), state);
		const bytes = await fs.readFile(file, "utf8");
		assert.equal(JSON.parse(bytes).format, "learnharness.safeStorage");
		assert.doesNotMatch(bytes, /synthetic-access|synthetic-refresh|synthetic-id|synthetic-subject/);
		assert.deepEqual(await store().read(), state);
		const next = structuredClone(state); next.allowBackgroundUse = true;
		const tokens = "registrations" in next ? next.registrations[0]?.tokens : next.credential;
		assert(tokens);
		if ("refreshToken" in tokens) tokens.refreshToken = "synthetic-rotated"; else tokens.refresh = "synthetic-rotated";
		await store().write(next);
		assert.deepEqual(await store().read(), next);
		assert.doesNotMatch(await fs.readFile(file, "utf8"), /synthetic-rotated/);
		assert.deepEqual(await fs.readdir(directory), ["credentials.json"]);
		if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("unavailable/basic_text/unknown secure backend never converts or overwrites plaintext", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-protected-deny-")), file = path.join(directory, "credentials.json");
	const bytes = JSON.stringify(chatState());
	try {
		await fs.writeFile(file, bytes, { mode: 0o600 });
		for (const backend of [{ ...secure, isEncryptionAvailable: () => false }, { ...secure, getSelectedStorageBackend: () => "basic_text" }, { ...secure, getSelectedStorageBackend: () => "unknown" }]) {
			const store = protectedStore(file, { safeStorage: backend, platform: "linux", kind: "chatgpt", validate: (state: any) => assert.equal(state.version, 1) });
			await assert.rejects(store.read(), /^Error: storage$/); await assert.rejects(store.write(chatState()), /^Error: storage$/);
			assert.equal(await fs.readFile(file, "utf8"), bytes);
		}
		assert.deepEqual(await fs.readdir(directory), ["credentials.json"]);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("ciphertext tampering and cross-provider replacement fail closed without rewriting evidence", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-protected-corrupt-")), file = path.join(directory, "credentials.json");
	try {
		await subscriptionStore(file, "xai", undefined, secure).write(nativeState());
		const bytes = await fs.readFile(file, "utf8");
		await assert.rejects(subscriptionStore(file, "github-copilot", undefined, secure).read(), /^Error: storage$/);
		assert.equal(await fs.readFile(file, "utf8"), bytes);
		const envelope = JSON.parse(bytes), cipher = Buffer.from(envelope.encrypted, "base64");
		const last = cipher.at(-1); assert(last !== undefined); cipher[cipher.length - 1] = last ^ 1;
		const corrupt = JSON.stringify({ ...envelope, encrypted: cipher.toString("base64") }); await fs.writeFile(file, corrupt, { mode: 0o600 });
		await assert.rejects(subscriptionStore(file, "xai", undefined, secure).read(), /^Error: storage$/);
		assert.equal(await fs.readFile(file, "utf8"), corrupt);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("conversion failure preserves the original file and removes only its synthetic temporary file", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-protected-atomic-")), file = path.join(directory, "credentials.json");
	const bytes = JSON.stringify(nativeState());
	try {
		await fs.writeFile(file, bytes, { mode: 0o600 });
		const io = { ...fs, rename: async () => { throw new Error("synthetic private I/O details"); } };
		await assert.rejects(subscriptionStore(file, "xai", io, secure).read(), /^Error: storage$/);
		assert.equal(await fs.readFile(file, "utf8"), bytes);
		assert.deepEqual(await fs.readdir(directory), ["credentials.json"]);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("backend loss invalidates the restored ChatGPT connection without a provider request", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-protected-loss-")), file = path.join(directory, "credentials.json");
	let available = true;
	const backend = { ...secure, isEncryptionAvailable: () => available };
	let service;
	try {
		await chatGPTStore(file, backend).write(chatState());
		const bytes = await fs.readFile(file, "utf8");
		service = createChatGPT({ store: chatGPTStore(file, backend), openExternal: () => assert.fail("no browser"), fetch: () => assert.fail("no provider") });
		assert.equal((await service.status()).accounts[0].connected, true);
		available = false;
		assert.equal((await service.status()).accounts[0].connected, false);
		await assert.rejects(service.login(), /^Error: storage$/);
		assert.equal(await fs.readFile(file, "utf8"), bytes);
	} finally { service?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
