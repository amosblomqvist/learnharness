import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

for (const name of ["XAI_API_KEY", "OPENROUTER_API_KEY", "LH_IGNORE_ENV_KEYS"]) {
	delete process.env[name];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-xai-oauth-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

const { providerKeyPresent, saveKey, xaiSignedIn } = await import("../src/server/keys.ts");
const { credentialStore } = await import("../src/store/credentials.ts");
const { authStore } = await import("../src/store/auth.ts");
const { piModels, settleXaiProviderMessage } = await import("../src/agent/models.ts");
const { xaiSignIn } = await import("../src/server/xai-sign-in.ts");
const { XAI_SIGN_IN_LABEL, xaiSignInLine } = await import("../src/core/xai-sign-in.ts");
const { hasProviderKey } = await import("../components/setup-cta.tsx");
const { GET, POST } = await import("../app/api/xai/sign-in/route.ts");
const keysRoute = await import("../app/api/keys/route.ts");

const CRED = path.join(TMP, "credentials.json");
const originalFetch = globalThis.fetch;
let deviceCalls = 0;
let tokenMode: "pending" | "denied" = "pending";

function oauth(refresh = "test-refresh-token") {
	return {
		type: "oauth" as const,
		access: "test-access-token",
		refresh,
		expires: Date.now() + 60 * 60 * 1000,
	};
}

function secretKeys(value: unknown, found: Set<string>): void {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		found.add(key);
		secretKeys(child, found);
	}
}

function assertNoSecrets(value: unknown): void {
	const found = new Set<string>();
	secretKeys(value, found);
	assert.equal(found.has("access"), false);
	assert.equal(found.has("refresh"), false);
	assert.equal(found.has("device_code"), false);
	const json = JSON.stringify(value);
	assert.equal(json.includes("test-access-token"), false);
	assert.equal(json.includes("test-refresh-token"), false);
	assert.equal(json.includes("device-secret"), false);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	init?.signal?.throwIfAborted();
	const url = String(input);
	if (url.includes("auth.x.ai/oauth2/device/code")) {
		deviceCalls += 1;
		return Response.json({
			device_code: "device-secret",
			user_code: "WORD-CODE",
			verification_uri: "https://auth.x.ai/device",
			expires_in: 600,
			interval: 1,
		});
	}
	if (url.includes("auth.x.ai/oauth2/token")) {
		if (tokenMode === "denied") return Response.json({ error: "access_denied" }, { status: 400 });
		return Response.json({ error: "authorization_pending" }, { status: 400 });
	}
	throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

after(async () => {
	tokenMode = "pending";
	await xaiSignIn({ type: "cancel" }).catch(() => {});
	await xaiSignIn({ type: "sign-out" }).catch(() => {});
	globalThis.fetch = originalFetch;
	delete process.env.XAI_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("xAI OAuth credentials", () => {
	it("pins the sign-in label to pi-ai", () => {
		const xai = piModels().getProviders().find((provider) => provider.id === "xai");
		assert.equal(XAI_SIGN_IN_LABEL, xai?.auth.oauth?.loginLabel);
		assert.equal(xaiSignInLine({ phase: "signed-out" }), null);
		assert.equal(
			xaiSignInLine({ phase: "signed-in", notice: { kind: "refresh-failed" } }),
			"xAI sign-in could not be refreshed. Sign in again, or sign out to use an API key.",
		);
	});

	it("an oauth-only file makes xAI present while XAI_API_KEY is absent", async () => {
		assert.equal(process.env.XAI_API_KEY, undefined);
		await credentialStore.modify("xai", async () => oauth());
		assert.equal(providerKeyPresent("xai"), true);
		assert.equal(xaiSignedIn(), true);
		const auth = await piModels().getAuth("xai");
		assert.equal(auth?.source, "OAuth");
		await credentialStore.delete("xai");
		assert.equal(providerKeyPresent("xai"), false);
		assert.equal(xaiSignedIn(), false);
	});

	it("auth.json writes drop non-strings and do not touch credentials.json", async () => {
		await credentialStore.modify("xai", async () => oauth());
		const before = fs.readFileSync(CRED);
		fs.writeFileSync(AUTH, JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-abcdefghij", BAD: 1, FUTURE: { access: "nope" } }));
		const vars = authStore.authVars();
		assert.equal(vars.BAD, undefined);
		assert.equal("FUTURE" in vars, false);
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-abcdefghij");
		assert.equal(fs.readFileSync(CRED).equals(before), true);
		await credentialStore.delete("xai");
	});

	it("undefined modify keeps the refresh token, and abort during the write still finishes", async () => {
		await credentialStore.modify("xai", async () => oauth("refresh-kept"));
		const kept = await credentialStore.modify("xai", async () => undefined);
		assert.equal(kept?.type === "oauth" && kept.refresh, "refresh-kept");
		const signal = new AbortController();
		const written = await credentialStore.modify(
			"xai",
			async () => {
				signal.abort();
				await new Promise((resolve) => setTimeout(resolve, 20));
				return oauth("refresh-rotated");
			},
			{ signal: signal.signal },
		);
		assert.equal(written?.type === "oauth" && written.refresh, "refresh-rotated");
		const skipped = new AbortController();
		skipped.abort();
		await assert.rejects(credentialStore.modify("xai", async () => oauth("should-not-land"), { signal: skipped.signal }));
		const still = await credentialStore.read("xai");
		assert.equal(still?.type === "oauth" && still.refresh, "refresh-rotated");
		await credentialStore.delete("xai");
	});

	it("an unreadable file is not signed in, and start replaces it", async () => {
		fs.writeFileSync(CRED, "{", { mode: 0o600 });
		assert.equal(credentialStore.facts("xai").health, "unreadable");
		assert.equal(credentialStore.facts("xai").oauth, false);
		assert.equal(await credentialStore.read("xai"), undefined);
		assert.equal(providerKeyPresent("xai"), false);
		const bytes = fs.readFileSync(CRED);
		await assert.rejects(credentialStore.modify("xai", async () => oauth()));
		assert.equal(fs.readFileSync(CRED).equals(bytes), true);
		deviceCalls = 0;
		const view = await xaiSignIn({ type: "start" });
		assert.equal(view.phase, "pending");
		assert.equal(credentialStore.facts("xai").health, "ready");
		assert.equal(fs.existsSync(CRED), false);
		await xaiSignIn({ type: "cancel" });
	});

	it("status JSON has no token fields", async () => {
		const view = await xaiSignIn({ type: "status" });
		assertNoSecrets(view);
		const res = await GET();
		assert.equal(res.status, 200);
		assertNoSecrets(await res.json());
		const keys = await keysRoute.GET();
		const body = await keys.json();
		assert.equal(typeof body.xaiSignedIn, "boolean");
		assertNoSecrets(body);
	});

	it("hasProviderKey treats xaiSignedIn as a provider key", () => {
		assert.equal(hasProviderKey([], undefined, true), true);
		assert.equal(hasProviderKey([], [], false), false);
	});

	it("a second start during pending returns the same code and does not request another", async () => {
		deviceCalls = 0;
		tokenMode = "pending";
		const first = await xaiSignIn({ type: "start" });
		assert.equal(first.phase, "pending");
		if (first.phase !== "pending") return;
		const second = await xaiSignIn({ type: "start" });
		assert.equal(second.phase, "pending");
		if (second.phase !== "pending") return;
		assert.equal(second.userCode, first.userCode);
		assert.equal(deviceCalls, 1);
		assertNoSecrets(second);
		await xaiSignIn({ type: "cancel" });
	});

	it("a denied re-auth keeps the stored credential", async () => {
		await credentialStore.modify("xai", async () => oauth("refresh-stays"));
		tokenMode = "denied";
		deviceCalls = 0;
		const pending = await xaiSignIn({ type: "start" });
		assert.equal(pending.phase, "pending");
		let view = await xaiSignIn({ type: "status" });
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			view = await xaiSignIn({ type: "status" });
			if (view.phase === "signed-in" && view.notice?.kind === "reauth-denied") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(view.phase, "signed-in");
		if (view.phase === "signed-in") assert.equal(view.notice?.kind, "reauth-denied");
		const still = await credentialStore.read("xai");
		assert.equal(still?.type === "oauth" && still.refresh, "refresh-stays");
		tokenMode = "pending";
		await xaiSignIn({ type: "sign-out" });
	});

	it("sign-out leaves XAI_API_KEY in place", async () => {
		const saved = saveKey("XAI_API_KEY", "sk-test-xai-key-1234");
		assert.equal(saved.ok, true);
		await credentialStore.modify("xai", async () => oauth());
		assert.equal(xaiSignedIn(), true);
		const view = await xaiSignIn({ type: "sign-out" });
		assert.equal(view.phase, "signed-out");
		assert.equal(authStore.authVars().XAI_API_KEY, "sk-test-xai-key-1234");
		assert.equal(xaiSignedIn(), false);
		assert.equal(providerKeyPresent("xai"), true);
	});

	it("a refresh failure rewrites only that sentence and a later success clears it", async () => {
		await credentialStore.modify("xai", async () => oauth());
		const failed = { provider: "xai", stopReason: "error", errorMessage: "OAuth refresh failed for xai" };
		settleXaiProviderMessage(failed);
		assert.equal(failed.errorMessage, xaiSignInLine({ phase: "signed-in", notice: { kind: "refresh-failed" } }));
		const other = { provider: "xai", stopReason: "error", errorMessage: "Provider is not configured: xai" };
		settleXaiProviderMessage(other);
		assert.equal(other.errorMessage, "Provider is not configured: xai");
		let view = await xaiSignIn({ type: "status" });
		assert.equal(view.phase, "signed-in");
		if (view.phase === "signed-in") assert.equal(view.notice?.kind, "refresh-failed");
		settleXaiProviderMessage({ provider: "xai", stopReason: "stop" });
		view = await xaiSignIn({ type: "status" });
		assert.equal(view.phase, "signed-in");
		if (view.phase === "signed-in") assert.equal(view.notice?.kind, "key-unused");
		await xaiSignIn({ type: "sign-out" });
	});

	it("POST rejects a non-JSON body and an unknown command", async () => {
		const bad = await POST(new Request("http://localhost/api/xai/sign-in", { method: "POST", body: "nope" }));
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { error: "body must be JSON" });
		const unknown = await POST(
			new Request("http://localhost/api/xai/sign-in", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "nope" }),
			}),
		);
		assert.equal(unknown.status, 400);
		assert.deepEqual(await unknown.json(), { error: "body must be {type: start, cancel, or sign-out}" });
	});
});
