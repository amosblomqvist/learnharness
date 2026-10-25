/**
 * The Ollama provider (local-models wave, owner 2026-10-25): the pure
 * listing rules, the /api/tags + /api/show discovery against a fake
 * server, the keys seam (URL normalized + shown in full, key optional),
 * the catalog/gating surfaces, Local pricing, and one streamed turn
 * through pi-ai's OpenAI-compatible client to pin what we send.
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the imports (the keys
 * seam is module-load bound). No real Ollama is contacted.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

for (const name of ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"]) delete process.env[name];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ollama-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { ollamaModel, showContextLength, fetchOllamaModels } = await import("../src/agent/ollama.ts");
const { normalizeOllamaUrl, OLLAMA_DEFAULT_URL } = await import("../src/core/auth-keys.ts");
const { saveKey, deleteKey, keyStatuses, providerKeyPresent } = await import("../src/server/keys.ts");
const { catalogProviders, modelCatalog, refreshOllamaCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { normalizeContext } = await import("@earendil-works/pi-ai");
const { callCost } = await import("../src/server/pricing.ts");
const { classifyKeys, keyStatusLine } = await import("../components/settings/keys-section.tsx");

/** The fake server's answers + what it saw. */
interface Seen { path: string; auth?: string; body?: Record<string, unknown> }
const seen: Seen[] = [];
let server: http.Server;
let baseUrl = "";

const TAGS = {
	models: [
		// Ollama ≥ 0.31: facts on the tag itself.
		{ name: "gemma4:31b-cloud", capabilities: ["completion", "tools", "vision", "thinking"], details: { context_length: 262144 } },
		// Older server: no facts on the tag → /api/show fills them.
		{ name: "qwen3:8b", details: {} },
		// No tool calls → never listed.
		{ name: "embed-only", capabilities: ["embedding"], details: { context_length: 8192 } },
		// Tools, but below the compaction floor → never listed.
		{ name: "tiny:1b", capabilities: ["completion", "tools"], details: { context_length: 4096 } },
	],
};

function sse(res: http.ServerResponse, chunks: unknown[]) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.end("data: [DONE]\n\n");
}

before(async () => {
	server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => (raw += d));
		req.on("end", () => {
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
			seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
			res.setHeader("content-type", "application/json");
			if (req.url === "/api/tags") return res.end(JSON.stringify(TAGS));
			if (req.url === "/api/show") {
				return res.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 40960 } }));
			}
			if (req.url === "/v1/chat/completions") {
				const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "gemma4:31b" };
				return sse(res, [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "391" }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ ...base, choices: [], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } },
				]);
			}
			res.statusCode = 404;
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server.close();
	for (const name of ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"]) delete process.env[name];
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the listing rules (pure)", () => {
	it("maps a tool-capable model: /v1 base, zero cost, vision input, Ollama's effort ladder", () => {
		const m = ollamaModel("http://h:11434", { name: "gemma4:31b-cloud", capabilities: ["tools", "vision", "thinking"], contextLength: 262144 })!;
		assert.equal(m.provider, "ollama");
		assert.equal(m.api, "openai-completions");
		assert.equal(m.baseUrl, "http://h:11434/v1");
		assert.deepEqual(m.input, ["text", "image"]);
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(m.contextWindow, 262144);
		assert.equal(m.reasoning, true);
		assert.deepEqual(m.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: "medium", high: "high" });
		assert.deepEqual(m.compat, { supportsDeveloperRole: false, supportsReasoningEffort: true });
	});

	it("a non-thinking model has no effort ladder", () => {
		const m = ollamaModel("http://h", { name: "x", capabilities: ["tools"], contextLength: 65536 })!;
		assert.equal(m.reasoning, false);
		assert.equal(m.thinkingLevelMap, undefined);
		assert.deepEqual(m.input, ["text"]);
	});

	it("excludes models without tool calls, without a reported context, or below the floor", () => {
		assert.equal(ollamaModel("http://h", { name: "a", capabilities: ["completion"], contextLength: 65536 }), null);
		assert.equal(ollamaModel("http://h", { name: "b", capabilities: ["tools"] }), null);
		assert.equal(ollamaModel("http://h", { name: "c", capabilities: ["tools"], contextLength: 4096 }), null);
	});

	it("reads the context length out of /api/show's model_info", () => {
		assert.equal(showContextLength({ "general.architecture": "llama", "llama.context_length": 131072 }), 131072);
		assert.equal(showContextLength({}), undefined);
		assert.equal(showContextLength(undefined), undefined);
	});
});

describe("the URL write gate", () => {
	it("normalizes trailing slashes and a pasted /v1", () => {
		assert.deepEqual(normalizeOllamaUrl("  http://localhost:11434/ "), { ok: true, value: "http://localhost:11434" });
		assert.deepEqual(normalizeOllamaUrl("https://ollama.example.com/v1/"), { ok: true, value: "https://ollama.example.com" });
		assert.deepEqual(normalizeOllamaUrl("http://proxy/ollama"), { ok: true, value: "http://proxy/ollama" });
	});
	it("rejects non-URLs and non-http schemes", () => {
		assert.equal(normalizeOllamaUrl("localhost:11434").ok, false);
		assert.equal(normalizeOllamaUrl("ftp://h").ok, false);
		assert.equal(normalizeOllamaUrl("   ").ok, false);
	});
	it("pre-fills the standard local address", () => {
		assert.equal(OLLAMA_DEFAULT_URL, "http://localhost:11434");
	});
});

describe("discovery against a fake server", () => {
	it("lists from /api/tags, fills gaps from /api/show, drops the excluded", async () => {
		seen.length = 0;
		const models = await fetchOllamaModels(baseUrl, new AbortController().signal);
		assert.deepEqual(models.map((m) => [m.id, m.contextWindow, m.reasoning]), [
			["gemma4:31b-cloud", 262144, true],
			["qwen3:8b", 40960, true],
		]);
		const shows = seen.filter((s) => s.path === "/api/show");
		assert.deepEqual(shows.map((s) => s.body), [{ model: "qwen3:8b" }], "show only for the tag that lacked facts");
		assert.ok(seen.every((s) => s.auth === undefined), "no key → no bearer");
	});

	it("rejects when the server is unreachable (refresh keeps the last list)", async () => {
		await assert.rejects(fetchOllamaModels("http://127.0.0.1:1", new AbortController().signal));
	});
});

describe("off until a URL is saved", () => {
	it("no URL: no provider, not present, nothing listed", () => {
		assert.equal(providerKeyPresent("ollama"), false);
		assert.equal(catalogProviders().find((p) => p.id === "ollama")?.keyPresent, false);
		assert.equal(piModels().getProviders().some((p) => p.id === "ollama"), false);
		const rows = keyStatuses().filter((s) => s.id.startsWith("OLLAMA_"));
		assert.deepEqual(rows.map((r) => [r.id, r.present]), [["OLLAMA_BASE_URL", false], ["OLLAMA_API_KEY", false]]);
	});
});

describe("configured: keys seam → catalog → engine", () => {
	it("saving the URL normalizes it, shows it in full, federates the provider", async () => {
		const saved = saveKey("OLLAMA_BASE_URL", `${baseUrl}/v1/`);
		assert.ok(saved.ok);
		assert.equal(process.env.OLLAMA_BASE_URL, baseUrl, "stored normalized + reflected into env");
		const row = keyStatuses().find((s) => s.id === "OLLAMA_BASE_URL")!;
		assert.equal(row.value, baseUrl);
		assert.equal(keyStatusLine(row), baseUrl);
		assert.equal(providerKeyPresent("ollama"), true, "the key stays optional");

		await refreshOllamaCatalog();
		const catalog = modelCatalog();
		assert.equal(catalog.providers.find((p) => p.id === "ollama")?.keyPresent, true);
		const ollama = catalog.models.filter((m) => m.provider === "ollama");
		assert.deepEqual(ollama.map((m) => m.id), ["gemma4:31b-cloud", "qwen3:8b"]);
		assert.deepEqual(ollama[0]?.supportedLevels, ["off", "low", "medium", "high"]);
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "ollama", id: "gemma4:31b-cloud" } } }), { ok: true });
	});

	it("a bad URL is a 400-ready error and never stored", () => {
		const bad = saveKey("OLLAMA_BASE_URL", "not a url");
		assert.equal(bad.ok, false);
		assert.equal(process.env.OLLAMA_BASE_URL, baseUrl);
	});

	it("streams a turn: system role, reasoning_effort, placeholder bearer without a key", async () => {
		seen.length = 0;
		const engine = piEngineForSpec({ provider: "ollama", id: "gemma4:31b-cloud", thinkingLevel: "high" });
		const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt: "Be terse.", messages: [{ role: "user", content: "17*23?", timestamp: 0 }] }), {});
		const message = await stream.result();
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.deepEqual(message.content.filter((b) => b.type === "text").map((b) => b.type === "text" && b.text), ["391"]);
		const call = seen.find((s) => s.path === "/v1/chat/completions")!;
		assert.equal(call.body?.model, "gemma4:31b-cloud");
		assert.equal(call.body?.reasoning_effort, "high");
		assert.equal((call.body?.messages as { role: string }[])[0]?.role, "system");
		assert.equal(call.auth, "Bearer ollama");
	});

	it("thinking off sends reasoning_effort none", async () => {
		seen.length = 0;
		const engine = piEngineForSpec({ provider: "ollama", id: "gemma4:31b-cloud", thinkingLevel: "off" });
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {}).result();
		assert.equal(seen.find((s) => s.path === "/v1/chat/completions")?.body?.reasoning_effort, "none");
	});

	it("an optional key rides as the bearer on discovery and turns", async () => {
		assert.ok(saveKey("OLLAMA_API_KEY", "ollama-cloud-key-123456").ok);
		seen.length = 0;
		await refreshOllamaCatalog();
		const engine = piEngineForSpec({ provider: "ollama", id: "qwen3:8b" });
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {}).result();
		assert.ok(seen.length >= 2);
		assert.ok(seen.every((s) => s.auth === "Bearer ollama-cloud-key-123456"), JSON.stringify(seen.map((s) => s.auth)));
		deleteKey("OLLAMA_API_KEY");
	});

	it("prices Local runs at $0, even with no list loaded", () => {
		assert.equal(callCost({ inputTokens: 1000, outputTokens: 500 }, "ollama:gemma4:31b-cloud"), 0);
		assert.equal(callCost({ inputTokens: 1000, outputTokens: 500 }, "ollama:never-pulled"), 0);
	});

	it("deleting the URL removes the provider and its models", () => {
		deleteKey("OLLAMA_BASE_URL");
		assert.equal(providerKeyPresent("ollama"), false);
		assert.equal(piModels().getProviders().some((p) => p.id === "ollama"), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === "ollama"), false);
	});
});

describe("the Local models group (pure)", () => {
	it("pulls the Ollama pair out of the provider/unknown rows, URL first, synthesized when absent", () => {
		const url = { id: "OLLAMA_BASE_URL", info: null, present: true, masked: "…1434 (22 chars)", value: OLLAMA_DEFAULT_URL, source: "file" as const, shadowedByEnv: false };
		const { ollamaRows, unknownRows, providerRows } = classifyKeys([url], []);
		assert.deepEqual(ollamaRows.map((r) => [r.id, r.present]), [["OLLAMA_BASE_URL", true], ["OLLAMA_API_KEY", false]]);
		assert.equal(unknownRows.length, 0);
		assert.equal(providerRows.length, 0);
		assert.equal(keyStatusLine(url), OLLAMA_DEFAULT_URL);
		assert.equal(keyStatusLine({ ...url, source: "env" }), `${OLLAMA_DEFAULT_URL} · env`);
	});
});
