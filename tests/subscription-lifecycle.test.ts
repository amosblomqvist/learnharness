import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubscriptionStore } from "../src/store/subscription-credentials.ts";
import { createSubscriptionService } from "../src/server/subscription.ts";

test("a fresh instance is disconnected and refuses execution without contacting a supplier", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-subscription-life-"));
	try {
		const service = createSubscriptionService(createSubscriptionStore(directory));
		assert.deepEqual(await service.status(), { state: "disconnected" });
		await assert.rejects(service.assertAvailable(), { code: "subscription_needs_login" });
		assert.deepEqual(await service.status(), { state: "disconnected" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("device authorization persists through reconstruction and disconnect keeps the instance disconnected", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-subscription-device-"));
	const originalFetch = globalThis.fetch;
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-example" } })).toString("base64url")}.signature`;
	const calls: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "private-device-id", user_code: "ABCD-EFGH", interval: 0 });
		if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "private-code", code_verifier: "private-verifier" });
		if (url.endsWith("/oauth/token")) return Response.json({ access_token: token, refresh_token: "private-refresh", expires_in: 3600 });
		throw new Error("Unexpected supplier request");
	};
	try {
		const service = createSubscriptionService(createSubscriptionStore(directory));
		const started = await service.start("device_code");
		assert.equal(started.state, "authorizing");
		await service.finished(started.attempt!.id);
		assert.equal((await service.status()).state, "connected");
		assert.doesNotMatch(JSON.stringify(await service.status()), /private-refresh|private-device-id|private-verifier|signature/);
		const reconstructed = createSubscriptionService(createSubscriptionStore(directory));
		assert.equal((await reconstructed.status()).state, "connected");
		await assert.rejects(reconstructed.start("device_code"), { code: "subscription_conflict" });
		await reconstructed.disconnect();
		assert.deepEqual(await service.status(), { state: "disconnected" });
		await assert.rejects(service.assertAvailable(), { code: "subscription_needs_login" });
		assert.equal(calls.length, 3);
	} finally {
		globalThis.fetch = originalFetch;
		await rm(directory, { recursive: true, force: true });
	}
});
