import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cloud-account-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_CONVEX_URL = "https://test-sync.convex.cloud";
delete process.env.LH_DESKTOP_SERVER;
let identity = "alice";
const fetchBefore = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	if (!String(input).startsWith("https://test-sync.convex.cloud/api/")) throw new Error("Unexpected external request in isolated test.");
	const body = JSON.parse(String(init?.body)) as { path: string };
	const tokens = { accessToken: "test-access-token", refreshToken: "test-refresh-token", refreshTokenExpiresAt: Date.now() + 60000, userId: identity };
	const values: Record<string, unknown> = {
		"auth:startSignInWithGoogle": { redirect: "https://accounts.google.com/o/oauth2/v2/auth?state=public", state: "server-private-state" },
		"auth:completeSignInWithGoogle": { status: "complete", tokens },
		"auth:refreshSession": { kind: "rotated", tokens },
		"auth:signOut": null, "users:current": { id: identity, name: identity, email: `${identity}@example.com` },
		"threads:list": { page: [], isDone: true, continueCursor: "" },
	};
	if (!Object.hasOwn(values, body.path)) throw new Error(`Unexpected Convex operation: ${body.path}`);
	return Response.json({ status: "success", value: values[body.path] });
};
const { cloudControl, cloudDeployment, cloudSyncStatus, completeCloudSignIn } = await import("../src/server/cloud-sync.ts");
const { cloudControlsResponse } = await import("../src/server/cloud-http.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { isSensitivePath } = await import("../src/agent/tools/fs-shared.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
after(() => { globalThis.fetch = fetchBefore; fs.rmSync(root, { recursive: true, force: true }); });
async function idle() {
	for (let count = 0; count < 100; count++) {
		if (!cloudSyncStatus().syncing) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	throw new Error("Sync operation did not settle.");
}
async function signIn(user: string) {
	identity = user; await idle();
	await cloudControl("signIn", "http://localhost:3000");
	const state = (globalThis as typeof globalThis & { __lhCloudSync: { pending: { id: string } } }).__lhCloudSync;
	const url = new URL(`http://localhost:3000/labs/google/callback?attempt=${state.pending.id}&convexAuthCode=one-use-code`);
	await completeCloudSignIn(url); await idle(); return url;
}
it("offers the shared deployment on a fresh install while keeping sync off until enabled", () => {
	const customDeployment = process.env.LH_CONVEX_URL!;
	delete process.env.LH_CONVEX_URL;
	try {
		assert.equal(cloudDeployment(), "https://watchful-jackal-487.ap-southeast-2.convex.cloud");
		const fresh = cloudSyncStatus();
		assert.equal(fresh.configured, true);
		assert.equal(fresh.enabled, false);
		assert.equal(fresh.user, null);
	} finally {
		process.env.LH_CONVEX_URL = customDeployment;
	}
	assert.equal(cloudDeployment(), customDeployment);
});
it("keeps auth optional, defaults off, validates controls, and isolates sign-out and account switching", async () => {
	assert.equal(cloudSyncStatus().enabled, false);
	assert.equal(cloudSyncStatus().user, null);
	assert.deepEqual(sanitizeUserSettings({ version: 1, labs: { threadSync: "true" } })?.labs, {});
	await assert.rejects(cloudControl("signIn", "http://localhost:3000"), /Enable Google/);
	const hostile = await cloudControlsResponse(new Request("http://localhost:3000/api/labs/cloud", {
		method: "POST", headers: { origin: "https://elsewhere.example", "x-learnharness-cloud": "1", "Content-Type": "application/json" }, body: JSON.stringify({ op: "enable", enabled: true }),
	}));
	assert.equal(hostile.status, 403); assert.equal(cloudSyncStatus().enabled, false);
	await cloudControl("enable", "http://localhost:3000", true); await idle();
	const callback = await signIn("alice");
	const aliceThread = chatStore.createChat("Alice-only thread");
	await assert.rejects(completeCloudSignIn(callback), /expired/);
	const publicState = JSON.stringify(cloudSyncStatus());
	assert(!publicState.includes("test-access-token")); assert(!publicState.includes("test-refresh-token")); assert(!publicState.includes("server-private-state"));
	const credentials = path.join(root, "learnharness-cloud-credentials.json");
	assert(isSensitivePath(credentials)); assert(isSensitivePath(`${credentials}.tmp-12345678-1234-4234-8234-123456789abc`));
	await cloudControl("signOut", "http://localhost:3000"); await idle();
	assert.equal(chatStore.getChat(aliceThread.id), null); assert.equal(fs.existsSync(credentials), false);
	await signIn("bob"); assert.equal(chatStore.getChat(aliceThread.id), null);
	await cloudControl("signOut", "http://localhost:3000"); await idle();
	await signIn("alice"); assert.equal(chatStore.getChat(aliceThread.id)?.title, "Alice-only thread");
	await cloudControl("enable", "http://localhost:3000", false); await idle();
	assert.equal(cloudSyncStatus().profile, "local"); assert.equal(cloudSyncStatus().user, null);
});
