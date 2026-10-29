import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, mock } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-boundaries-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}), ...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}), NODE_ENV: "test", HOME: scratch, LH_DATA_DIR: scratch, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1" };
const route = await import("../app/api/custom-provider/route.ts");
const keys = await import("../src/server/keys.ts");
const { authEnvRecord } = await import("../src/core/auth-env.ts");
const { CUSTOM_PROVIDER } = await import("../src/core/auth-keys.ts");
const { authorizeFixture } = await import("./helpers/custom-provider-auth.ts");
const { readCustomAuth } = await import("../src/store/auth.ts");
const { persistCustomAuth } = await import("../src/server/custom-provider-auth.ts");
const settingsFile = path.join(scratch, "settings.json");
const seed = (cp: import("../src/core/settings.ts").CustomProviderSettings = { baseUrl: "http://old/v1", authMode: "keyless", models: [{ id: "m" }] }, key?: string) => fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, customProvider: authorizeFixture(cp, key) }));
const setFileKey = (key: string) => { const auth = readCustomAuth(); persistCustomAuth({ ...auth.binding!, fileKeyBaseUrl: auth.binding!.baseUrl }, key); };
const current = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const get = (inspect = false) => route.GET(new Request(`http://localhost/api/custom-provider${inspect ? "?authMode=apiKey" : ""}`));
function mutate(body: unknown, method = "POST", headers: Record<string, string> = {}) {
	return route.POST(new Request("http://localhost/api/custom-provider", { method, headers: { origin: "http://localhost", "content-type": "application/json", "if-match": get().headers.get("etag")!, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
let requests: { url: string; authorization: string | null }[];
beforeEach(() => {
	mock.restoreAll();
	process.env.LH_IGNORE_ENV_KEYS = "1";
	delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
	fs.writeFileSync(path.join(scratch, "auth.json"), "{}"); seed();
	requests = [];
	globalThis.fetch = async (url, options) => {
		requests.push({ url: String(url), authorization: new Headers(options?.headers).get("authorization") });
		assert.equal(options?.redirect, "manual");
		assert.ok(options?.signal instanceof AbortSignal);
		return Response.json({ data: [{ id: "m" }] });
	};
});
after(() => { mock.restoreAll(); process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(scratch, { recursive: true, force: true }); });

test("keyless probe never forwards a stored key, and clearing removes authentication", async () => {
	setFileKey("private-old");
	assert.equal((await mutate({ baseUrl: "http://new/v1", authMode: "keyless", key: "do-not-use-this" })).status, 200);
	assert.equal(requests[0]?.authorization, null);
	assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), undefined);
	assert.equal(current().customProvider.authMode, "keyless");
});
test("new keys have no arbitrary minimum; the exact probed key is stored", async () => {
	assert.equal((await mutate({ baseUrl: "http://new/v1", authMode: "apiKey", key: " k " })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer k");
	assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), "k");
	const body = await get().text(); assert.ok(!body.includes("Bearer"));
});
test("actual GET /api/keys fully redacts every custom key length and preserves other providers", async () => {
	const inventory = await import("../app/api/keys/route.ts");
	const rows = async () => (await (await inventory.GET()).json()).keys as import("../src/core/auth-keys.ts").AuthKeyStatus[];
	assert.equal(keys.saveKey("OPENAI_API_KEY", "ordinary-provider-key-abcd").ok, true);
	const ordinary = (await rows()).find(row => row.id === "OPENAI_API_KEY")!;
	assert.equal(ordinary.masked, "…abcd (26 chars)");
	try {
		for (const value of ["1", "12", "123", "1234", "synthetic-custom-secret-longer-than-four"]) {
			assert.equal((await mutate({ baseUrl: "http://new/v1", authMode: "apiKey", key: value })).status, 200);
			assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), value, "short keys still save unchanged");
			const statuses = await rows();
			const custom = statuses.find(row => row.id === CUSTOM_PROVIDER.envVar)!;
			assert.equal(custom.masked, "••••"); assert.equal(custom.present, true); assert.equal(custom.source, "file");
			assert.ok(!JSON.stringify(custom).includes(value));
			assert.deepEqual(statuses.find(row => row.id === "OPENAI_API_KEY"), ordinary);
		}
		process.env.LH_IGNORE_ENV_KEYS = "0";
		process.env[CUSTOM_PROVIDER.envVar] = "765"; authEnvRecord().realEnv.add(CUSTOM_PROVIDER.envVar);
		const custom = (await rows()).find(row => row.id === CUSTOM_PROVIDER.envVar)!;
		assert.equal(custom.masked, "••••"); assert.equal(custom.source, "env"); assert.equal(custom.present, true); assert.equal(custom.shadowedByEnv, true);
		assert.ok(!JSON.stringify(custom).includes("765"));
	} finally {
		authEnvRecord().realEnv.delete(CUSTOM_PROVIDER.envVar); delete process.env[CUSTOM_PROVIDER.envVar]; process.env.LH_IGNORE_ENV_KEYS = "1";
		keys.deleteKey("OPENAI_API_KEY");
	}
});
test("changing destination cannot silently reuse an existing credential", async () => {
	setFileKey("private-old");
	const payload = { baseUrl: "http://new/v1", authMode: "apiKey" };
	assert.equal((await mutate(payload)).status, 400); assert.equal(requests.length, 0);
	assert.equal((await mutate({ ...payload, reuseKey: true })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer private-old");
});
test("same-URL unbound development key needs existing explicit reuse consent", async () => {
	seed({ baseUrl: "http://old/v1", authMode: "apiKey", models: [{ id: "m" }] }, "legacy-key");
	const { CUSTOM_AUTH_BINDING } = await import("../src/core/custom-provider-auth.ts");
	const file = path.join(scratch, "auth.json"); const map = JSON.parse(fs.readFileSync(file, "utf8")); delete map[CUSTOM_AUTH_BINDING]; fs.writeFileSync(file, JSON.stringify(map));
	assert.equal((await get().json()).keyReuseRequired, true);
	assert.equal((await mutate({ baseUrl: "http://old/v1", authMode: "apiKey" })).status, 400); assert.equal(requests.length, 0);
	assert.equal((await mutate({ baseUrl: "http://old/v1", authMode: "apiKey", reuseKey: true })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer legacy-key"); assert.equal((await get().json()).keyReuseRequired, false);
});
test("generic custom/reserved key writes cannot bypass the atomic binding seam", async () => {
	const ordinary = await import("../app/api/keys/[id]/route.ts");
	const { CUSTOM_AUTH_BINDING } = await import("../src/core/custom-provider-auth.ts");
	const { authStore } = await import("../src/store/auth.ts");
	const before = fs.readFileSync(path.join(scratch, "auth.json"), "utf8");
	for (const id of [CUSTOM_PROVIDER.envVar, CUSTOM_AUTH_BINDING]) {
		const context = { params: Promise.resolve({ id }) };
		assert.equal((await ordinary.PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ value: "bypass" }) }), context)).status, 404);
		assert.equal((await ordinary.DELETE(new Request("http://localhost", { method: "DELETE" }), context)).status, 404);
		assert.equal(keys.saveKey(id, "bypass").ok, false); assert.throws(() => keys.deleteKey(id));
		assert.throws(() => authStore.setAuthVar(id, "bypass")); assert.throws(() => authStore.deleteAuthVar(id));
	}
	assert.equal(fs.readFileSync(path.join(scratch, "auth.json"), "utf8"), before);
	assert.ok(!keys.keyStatuses().some(row => row.id === CUSTOM_AUTH_BINDING)); assert.equal(process.env[CUSTOM_AUTH_BINDING], undefined);
});
test("same target can retain its effective key", async () => {
	seed({ baseUrl: "http://old/v1", authMode: "apiKey", models: [{ id: "m" }] }, "retained");
	assert.equal((await mutate({ baseUrl: "http://old/v1", authMode: "apiKey" })).status, 200);
	assert.equal(requests[0]?.authorization, "Bearer retained");
});
test("environment ownership is shown; consent uses the environment key in probe and inference", async () => {
	process.env.LH_IGNORE_ENV_KEYS = "0";
	process.env[CUSTOM_PROVIDER.envVar] = "environment-secret";
	authEnvRecord().realEnv.add(CUSTOM_PROVIDER.envVar);
	try {
		assert.equal((await get(true).json()).keySource, "env");
		assert.equal((await mutate({ baseUrl: "http://new/v1", authMode: "apiKey", key: "shadowed" })).status, 400);
		assert.equal((await mutate({ baseUrl: "http://new/v1", authMode: "apiKey", reuseKey: true })).status, 200);
		assert.equal(requests[0]?.authorization, "Bearer environment-secret");
		assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), "environment-secret");
		assert.ok(!(await get().text()).includes("environment-secret"));
		assert.equal((await mutate({ baseUrl: "http://other/v1", authMode: "keyless" })).status, 200);
		assert.equal(requests.at(-1)?.authorization, null);
	} finally { authEnvRecord().realEnv.delete(CUSTOM_PROVIDER.envVar); delete process.env[CUSTOM_PROVIDER.envVar]; }
});
test("cross-origin/opaque/missing-origin and non-JSON writes cannot probe or mutate", async () => {
	for (const origin of ["http://evil", "null", ""]) assert.equal((await mutate({ baseUrl: "http://new", authMode: "keyless" }, "POST", { origin })).status, 403);
	assert.equal((await mutate({}, "POST", { "content-type": "text/plain" })).status, 415);
	assert.equal((await mutate({}, "POST", { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal(requests.length, 0);
});
test("standalone internal URL uses the addressed Host origin, never forwarded origins", async () => {
	const headers = { "content-type": "application/json", "if-match": get().headers.get("etag")!, host: "127.0.0.1:3317", origin: "http://127.0.0.1:3317" };
	assert.equal((await route.DELETE(new Request("http://localhost:3317/api/custom-provider", { method: "DELETE", headers }))).status, 200);
	assert.equal((await mutate({}, "DELETE", { "x-forwarded-host": "evil", origin: "http://evil" })).status, 403);
});
test("empty DELETE streams normalize consistently without accepting malformed JSON", async () => {
	const headers = { "content-type": "application/json", "if-match": get().headers.get("etag")!, origin: "http://localhost" };
	const init: RequestInit & { duplex: "half" } = { method: "DELETE", headers, body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: "half" };
	assert.equal((await route.DELETE(new Request("http://localhost/api/custom-provider", init))).status, 200);
	assert.equal((await route.DELETE(new Request("http://localhost/api/custom-provider", { method: "DELETE", headers: { ...headers, "if-match": get().headers.get("etag")! }, body: "{" }))).status, 400);
	assert.equal((await route.POST(new Request("http://localhost/api/custom-provider", { method: "POST", headers, body: "" }))).status, 400);
});
test("desktop capability remains mandatory in desktop mode", async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "x".repeat(64);
	assert.equal((await mutate({}, "DELETE")).status, 403);
	assert.equal((await mutate(undefined, "DELETE", { origin: "null", "x-learnharness-desktop": "x".repeat(64) })).status, 200);
});
test("forbidden URL components are rejected before probing", async () => {
	for (const baseUrl of ["ftp://h", "https://user:pass@h/v1", "http://h/v1?q=secret", "http://h/v1#x", "http://h/v1?", "http://h/v1#"]) assert.equal((await mutate({ baseUrl, authMode: "keyless" })).status, 400);
	assert.equal(requests.length, 0);
});
test("redirects/auth failures/model and byte limits cannot be bypassed with typed IDs", async () => {
	for (const answer of [
		() => new Response(null, { status: 302, headers: { location: "http://other" } }),
		() => new Response("private response", { status: 401 }),
		() => new Response("private response", { status: 403 }),
		() => Response.json({ data: Array(10001).fill({ id: "m" }) }),
		() => new Response("x".repeat(8 * 1024 * 1024 + 1)),
		() => new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }),
	]) {
		globalThis.fetch = async () => answer();
		const before = current();
		const res = await mutate({ baseUrl: "http://h/v1", authMode: "keyless", manualModels: "m" });
		assert.equal(res.status, 502); assert.deepEqual(current(), before);
		assert.ok(!(await res.text()).includes("private response"));
	}
});
test("write size bounds are explicit for streamed bodies", async () => {
	assert.equal((await mutate({ baseUrl: "x".repeat(65536), authMode: "keyless" })).status, 413);
	assert.equal((await mutate({ padding: "x".repeat(65536) }, "DELETE")).status, 413);
	assert.equal(requests.length, 0);
});
test("stale save, pin edit and disconnect all return reload guidance without writing", async () => {
	const etag = get().headers.get("etag")!;
	seed({ baseUrl: "http://other/v1", authMode: "keyless", models: [{ id: "different" }] });
	const before = current();
	for (const method of ["POST", "PATCH", "DELETE"]) {
		const res = await mutate({ baseUrl: "http://h", authMode: "keyless", overrides: {} }, method, { "if-match": etag });
		assert.equal(res.status, 409); assert.match(await res.text(), /Reload/);
	}
	assert.equal(requests.length, 0); assert.deepEqual(current(), before);
});
test("after discovery preserves unrelated edits and rejects intervening custom edits", async () => {
	globalThis.fetch = async () => { fs.writeFileSync(settingsFile, JSON.stringify({ ...current(), appearance: { mode: "dark" }, claudeCode: { enabled: true } })); return Response.json({ data: [{ id: "m" }] }); };
	assert.equal((await mutate({ baseUrl: "http://h", authMode: "keyless" })).status, 200);
	assert.deepEqual(current().appearance, { mode: "dark" }); assert.equal(current().claudeCode.enabled, true);
	globalThis.fetch = async () => { seed({ baseUrl: "http://changed", authMode: "keyless", models: [] }); return Response.json({ data: [{ id: "m" }] }); };
	assert.equal((await mutate({ baseUrl: "http://h", authMode: "keyless" })).status, 409);
	assert.equal(current().customProvider.baseUrl, "http://changed");
});
test("after discovery rejects a changed effective key", async () => {
	seed({ baseUrl: "http://old/v1", authMode: "apiKey", models: [{ id: "m" }] }, "before");
	globalThis.fetch = async () => { setFileKey("rotated"); return Response.json({ data: [{ id: "m" }] }); };
	assert.equal((await mutate({ baseUrl: "http://old/v1", authMode: "apiKey" })).status, 409);
	assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), "rotated");
});
test("offline pins accept 512/1, retain support declaration, and do not probe", async () => {
	const res = await mutate({ overrides: { m: { context: 1, maxTokens: 512, reasoning: false } } }, "PATCH");
	assert.equal(res.status, 200); assert.equal(requests.length, 0);
	assert.deepEqual(current().customProvider.overrides.m, { context: 1, maxTokens: 512, reasoning: false });
});
test("settings-write failure restores previous key/config and reports failure", async () => {
	setFileKey("old-key");
	const before = current();
	const write = fs.writeFileSync;
	mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (args[0] === settingsFile) throw new Error("private-io-details"); return write(...args); });
	const res = await mutate({ baseUrl: "http://new", authMode: "apiKey", key: "new-key" });
	assert.equal(res.status, 500); assert.ok(!(await res.text()).includes("private-io-details"));
	assert.equal(keys.keyValue(CUSTOM_PROVIDER.envVar), "old-key"); assert.deepEqual(current(), before);
});
