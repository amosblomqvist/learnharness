import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { validateCustomBaseUrl, validateCustomProviderDefinition, validateCustomApiKey } from "../src/core/custom-provider-validation.ts";
import { createCustomProviderStore } from "../src/store/custom-providers.ts";
import { createCustomProviderService, customProvidersHandlers } from "../src/server/custom-providers.ts";

const SECRET = "sk-test-SECRET-123456";
const model = { id: "m1", name: "M1", contextWindow: 8000, maxTokens: 1000, input: ["text" as const], reasoning: false };
const def = (o: Record<string, unknown> = {}) => ({ id: "custom-a", name: "A", baseUrl: "https://api.example.com/v1", api: "openai-completions", keyless: false, models: [model], ...o });

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-"));
}
function fakeCreds() {
	const m = new Map<string, Credential>();
	return {
		m,
		has: (id: string) => m.has(id),
		peek: (id: string) => m.get(id),
		modify: async (id: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>) => {
			const n = await fn(m.get(id));
			if (n) m.set(id, n);
			return m.get(id);
		},
		delete: async (id: string) => void m.delete(id),
		read: async () => undefined,
		list: async () => [],
	};
}
function setup() {
	const dir = tmpDir();
	const store = createCustomProviderStore(path.join(dir, "data", "custom-providers.json"));
	const creds = fakeCreds();
	const svc = createCustomProviderService({ store, credentials: creds as never });
	return { dir, store, creds, svc };
}

describe("base URL validation", () => {
	const ok = (u: string) => assert.equal(validateCustomBaseUrl(u).ok, true, u);
	const bad = (u: string) => assert.equal(validateCustomBaseUrl(u).ok, false, u);
	it("accepts https remote and explicit loopback http", () => {
		ok("https://api.example.com/v1/");
		ok("http://localhost:11434/v1");
		ok("http://127.0.0.1:8080");
		ok("http://[::1]:8080/v1");
		assert.equal((validateCustomBaseUrl("https://api.example.com/v1/") as { value: string }).value, "https://api.example.com/v1");
	});
	it("rejects scheme, userinfo, query, fragment", () => {
		for (const u of ["ftp://a.com", "file:///etc/passwd", "https://u:p@a.com", "https://u@a.com", "https://a.com/?x=1", "https://a.com?", "https://a.com/#f", "https://a.com#", "", "a.com", "https://"]) bad(u);
	});
	it("requires https for remote hosts", () => {
		bad("http://api.example.com");
		bad("http://10.0.0.5");
	});
	it("blocks metadata and link-local, including mapped IPv6", () => {
		for (const u of ["https://169.254.169.254", "http://169.254.169.254", "https://169.254.1.1/x", "https://100.100.100.200", "https://metadata.google.internal", "https://[fe80::1]", "https://[fd00:ec2::254]", "https://[::ffff:169.254.169.254]", "https://[::ffff:a9fe:a9fe]", "http://[::ffff:127.0.0.1]", "https://[::127.0.0.1]"]) bad(u);
	});
	it("rejects ambiguous loopback spellings", () => {
		for (const u of ["http://127.1", "http://0x7f.0.0.1", "http://2130706433", "http://0177.0.0.1", "http://localhost.", "http://0.0.0.0", "http://[::]", "http://[0:0:0:0:0:0:0:1]", "http://127.0.0.1.", "http://foo.localhost"]) bad(u);
	});
});

describe("definition validation", () => {
	it("accepts a full definition and normalizes", () => {
		const r = validateCustomProviderDefinition(def({ models: [{ ...model, input: ["text", "image"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] }));
		assert.equal(r.ok, true);
	});
	it("rejects bad ids, apis, models, unknown fields", () => {
		for (const o of [{ id: "openai" }, { id: "custom-" }, { id: "custom-A" }, { id: "custom--a" }, { api: "bogus" }, { keyless: "yes" }, { keyless: undefined }, { models: [] }, { models: [model, model] }, { models: [{ ...model, contextWindow: 0 }] }, { models: [{ ...model, maxTokens: -1 }] }, { models: [{ ...model, contextWindow: 1.5 }] }, { models: [{ ...model, input: [] }] }, { models: [{ ...model, input: ["audio"] }] }, { models: [{ ...model, reasoning: "no" }] }, { models: [{ ...model, cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }] }, { models: [{ ...model, cost: { input: 1 } }] }, { headers: { a: "b" } }, { name: "" }, { name: "a\nb" }])
			assert.equal(validateCustomProviderDefinition(def(o)).ok, false, JSON.stringify(o));
		assert.equal(validateCustomProviderDefinition(null).ok, false);
	});
	it("bounds API keys without echoing them", () => {
		assert.equal(validateCustomApiKey("x".repeat(4097)).ok, false);
		assert.equal(validateCustomApiKey("a\nb").ok, false);
		assert.equal(validateCustomApiKey("  ").ok, false);
		assert.equal(validateCustomApiKey(5).ok, false);
		const r = validateCustomApiKey(SECRET + "\nx");
		assert.equal(r.ok, false);
		assert.ok(!JSON.stringify(r).includes(SECRET));
	});
});

describe("store", () => {
	it("round-trips with private permissions and upsert/remove", () => {
		const { dir, store } = setup();
		assert.deepEqual(store.read(), []);
		store.save(def() as never);
		store.save(def({ name: "B" }) as never);
		assert.equal(store.read().length, 1);
		assert.equal(store.read()[0]?.name, "B");
		assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
		assert.equal(store.remove("custom-a"), true);
		assert.equal(store.remove("custom-a"), false);
		assert.deepEqual(fs.readdirSync(path.join(dir, "data")), ["custom-providers.json"]);
	});
	it("refuses to overwrite corrupt, foreign or symlink files", () => {
		const { dir, store } = setup();
		fs.mkdirSync(path.join(dir, "data"), { recursive: true });
		fs.writeFileSync(store.file, "not json");
		assert.throws(() => store.save(def() as never));
		assert.throws(() => store.read());
		assert.deepEqual(store.readTolerant(), []);
		assert.equal(fs.readFileSync(store.file, "utf-8"), "not json");
		fs.writeFileSync(store.file, JSON.stringify({ version: 2, x: 1 }));
		assert.throws(() => store.save(def() as never));
		const target = path.join(dir, "target.json");
		fs.writeFileSync(target, JSON.stringify({ version: 1, providers: [def()] }));
		fs.rmSync(store.file);
		fs.symlinkSync(target, store.file);
		assert.throws(() => store.save(def({ name: "Z" }) as never));
		assert.throws(() => store.read());
		assert.deepEqual(store.readTolerant(), []);
		assert.equal(JSON.parse(fs.readFileSync(target, "utf-8")).providers[0].name, "A");
	});
	it("tolerant read skips invalid entries; strict write refuses", () => {
		const { dir, store } = setup();
		fs.mkdirSync(path.join(dir, "data"), { recursive: true });
		fs.writeFileSync(store.file, JSON.stringify({ version: 1, providers: [def(), { id: "bad" }] }));
		assert.equal(store.readTolerant().length, 1);
		assert.throws(() => store.save(def({ id: "custom-b" }) as never));
	});
});

describe("service CRUD and key ownership", () => {
	it("requires a key or explicit keyless for new providers", async () => {
		const { svc, creds } = setup();
		await assert.rejects(svc.put(def()), /apiKey is required/);
		creds.m.set("custom-a", { type: "api_key", key: "orphan", env: { LH_CUSTOM_PROVIDER_BASE_URL: "https://api.example.com/v1", LH_CUSTOM_PROVIDER_API: "openai-completions" } });
		await assert.rejects(svc.put(def()), /apiKey is required/);
		const s = await svc.put(def(), SECRET);
		assert.equal(s.keyPresent, true);
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, SECRET);
	});
	it("never returns or persists the key", async () => {
		const { svc, store } = setup();
		const s = await svc.put(def(), SECRET);
		assert.ok(!JSON.stringify(s).includes(SECRET));
		assert.ok(!JSON.stringify(svc.list()).includes(SECRET));
		assert.ok(!fs.readFileSync(store.file, "utf-8").includes(SECRET));
		await assert.rejects(svc.put(def({ baseUrl: "ftp://x" }), SECRET), (e: Error) => !e.message.includes(SECRET));
	});
	it("keeps the key on same-endpoint update with omitted key", async () => {
		const { svc, creds } = setup();
		await svc.put(def(), SECRET);
		const s = await svc.put(def({ name: "Renamed", baseUrl: "https://api.example.com/v1/", models: [{ ...model, id: "m2" }] }));
		assert.equal(s.keyPresent, true);
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, SECRET);
	});
	it("requires a new key or keyless when baseUrl changes", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		await assert.rejects(svc.put(def({ baseUrl: "https://evil.example.net/v1" })), /new apiKey/);
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, SECRET);
		assert.equal(store.read()[0]?.baseUrl, "https://api.example.com/v1");
		const s = await svc.put(def({ baseUrl: "https://other.example.com/v1" }), "new-key-1");
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, "new-key-1");
		assert.equal(s.baseUrl, "https://other.example.com/v1");
	});
	it("requires a new key or keyless when the dialect changes", async () => {
		const { svc, creds } = setup();
		await svc.put(def(), SECRET);
		await assert.rejects(svc.put(def({ api: "anthropic-messages" })), /new apiKey/);
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, SECRET);
		await svc.put(def({ api: "anthropic-messages" }), "k2-abc");
		assert.equal((creds.m.get("custom-a") as { key: string } | undefined)?.key, "k2-abc");
	});
	it("endpoint change to keyless clears the old key", async () => {
		const { svc, creds } = setup();
		await svc.put(def(), SECRET);
		const s = await svc.put(def({ baseUrl: "http://localhost:1234/v1", keyless: true }));
		assert.equal(s.keyPresent, false);
		assert.equal(creds.m.has("custom-a"), false);
	});
	it("keyless with apiKey is rejected; keyless to keyed needs a key", async () => {
		const { svc } = setup();
		await assert.rejects(svc.put(def({ keyless: true, baseUrl: "http://localhost:1/v1" }), SECRET), /keyless/);
		await svc.put(def({ keyless: true, baseUrl: "http://localhost:1/v1" }));
		await assert.rejects(svc.put(def({ baseUrl: "http://localhost:1/v1" })), /apiKey/);
	});
	it("failed credential write leaves metadata unchanged", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		creds.modify = async () => {
			throw new Error("boom " + "new-key-9");
		};
		await assert.rejects(svc.put(def({ baseUrl: "https://x.example.com" }), "new-key-9"), (e: Error) => !e.message.includes("new-key-9"));
		assert.equal(store.read()[0]?.baseUrl, "https://api.example.com/v1");
	});
	it("delete removes metadata and key (keyless too); missing is 404", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		await svc.remove("custom-a");
		assert.equal(creds.m.size, 0);
		assert.deepEqual(store.read(), []);
		await assert.rejects(svc.remove("custom-a"), /not found/);
		await assert.rejects(svc.remove("openai"), /invalid/);
		creds.m.set("custom-b", { type: "api_key", key: "stale" });
		await svc.put(def({ id: "custom-b", keyless: true, baseUrl: "http://localhost:1" }));
		await svc.remove("custom-b");
		assert.equal(creds.m.has("custom-b"), false);
	});
	it("does not touch other providers' keys", async () => {
		const { svc, creds } = setup();
		creds.m.set("anthropic", { type: "api_key", key: "keep" });
		await svc.put(def(), SECRET);
		await svc.remove("custom-a");
		assert.equal(creds.m.has("anthropic"), true);
	});
});

describe("endpoint binding and serialization", () => {
	it("stores binding env with every replacement", async () => {
		const { svc, creds } = setup();
		await svc.put(def(), SECRET);
		assert.deepEqual((creds.m.get("custom-a") as { env: unknown }).env, { LH_CUSTOM_PROVIDER_BASE_URL: "https://api.example.com/v1", LH_CUSTOM_PROVIDER_API: "openai-completions" });
		await svc.put(def({ baseUrl: "https://b.example.com" }), "k-two-2");
		assert.equal((creds.m.get("custom-a") as { env: Record<string, string> }).env.LH_CUSTOM_PROVIDER_BASE_URL, "https://b.example.com");
	});
	it("omitted key needs a matching binding; unbound or mismatched keys are not adopted", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		creds.m.set("custom-a", { type: "api_key", key: SECRET });
		await assert.rejects(svc.put(def({ name: "N" })), /bound to this endpoint/);
		assert.equal(svc.list()[0]?.keyPresent, false);
		creds.m.set("custom-a", { type: "api_key", key: SECRET, env: { LH_CUSTOM_PROVIDER_BASE_URL: "https://evil.example.net", LH_CUSTOM_PROVIDER_API: "openai-completions" } });
		await assert.rejects(svc.put(def({ name: "N" })), /bound to this endpoint/);
		assert.equal(store.read()[0]?.name, "A");
	});
	it("a key write that lands before a failed metadata write stays bound to the old endpoint data", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		const orig = store.save;
		store.save = () => {
			throw new Error("disk");
		};
		await assert.rejects(svc.put(def({ baseUrl: "https://b.example.com" }), "k-two-2"));
		store.save = orig;
		assert.equal(store.read()[0]?.baseUrl, "https://api.example.com/v1");
		// stored key is bound to b.example.com, so it does not satisfy the saved definition
		assert.equal(svc.list()[0]?.keyPresent, false);
		await assert.rejects(svc.put(def({ name: "N" })), /bound to this endpoint/);
	});
	it("serializes concurrent operations on the same provider", async () => {
		const { svc, creds, store } = setup();
		await svc.put(def(), SECRET);
		await Promise.allSettled([
			svc.put(def({ baseUrl: "https://b.example.com" }), "key-bbb"),
			svc.put(def({ baseUrl: "https://c.example.com" }), "key-ccc"),
			svc.remove("custom-a"),
			svc.put(def({ baseUrl: "https://d.example.com" }), "key-ddd"),
		]);
		const meta = store.read()[0];
		const c = creds.m.get("custom-a") as { key: string; env: Record<string, string> } | undefined;
		assert.equal(meta?.baseUrl, "https://d.example.com");
		assert.equal(c?.key, "key-ddd");
		assert.equal(c?.env.LH_CUSTOM_PROVIDER_BASE_URL, meta?.baseUrl);
	});
});

describe("handlers", () => {
	const req = (method: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
		new Request("http://localhost/api/connections/custom", { method, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
	it("GET/PUT/DELETE shapes without leaking the key", async () => {
		const { svc } = setup();
		const h = customProvidersHandlers(async () => svc);
		const put = await h.put(req("PUT", { provider: def(), apiKey: SECRET }));
		const putText = await put.text();
		assert.equal(put.status, 200);
		assert.ok(!putText.includes(SECRET));
		assert.equal(JSON.parse(putText).provider.keyPresent, true);
		const get = await (await h.get()).json();
		assert.equal(get.providers.length, 1);
		const del = await h.delete(req("DELETE", { id: "custom-a" }));
		assert.deepEqual(await del.json(), { deleted: true });
		assert.equal((await h.delete(req("DELETE", { id: "custom-a" }))).status, 404);
	});
	it("rejects oversized, non-JSON, unknown-field and wrong content-type bodies", async () => {
		const { svc } = setup();
		const h = customProvidersHandlers(async () => svc);
		assert.equal((await h.put(req("PUT", { provider: def(), apiKey: "x".repeat(70_000) }))).status, 400);
		assert.equal((await h.put(req("PUT", "{nope"))).status, 400);
		assert.equal((await h.put(req("PUT", { provider: def(), apiKey: SECRET, extra: 1 }))).status, 400);
		assert.equal((await h.put(req("PUT", { provider: def(), apiKey: SECRET }, { "content-type": "text/plain" }))).status, 400);
		assert.equal((await h.delete(req("DELETE", { id: "custom-a", x: 1 }))).status, 400);
		assert.equal(svc.list().length, 0);
	});
});
