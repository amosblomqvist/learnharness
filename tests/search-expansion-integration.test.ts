import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { SEARCH_ENGINES, type SearchEngineId } from "../src/core/search.ts";

// Real settings/auth composition with fake keys and an injected transport only.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-search-expansion-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const KEYED_ENGINES = SEARCH_ENGINES.flatMap((engine) => engine.envVar ? [engine] : []);
const SEARCH_KEYS = [...KEYED_ENGINES.map(({ envVar }) => envVar), "OPENAI_API_KEY"];
for (const envVar of SEARCH_KEYS) delete process.env[envVar];
const { saveKey, deleteKey, keyStatuses } = await import("../src/server/keys.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const { searchStatus, searchProvider } = await import("../src/server/search.ts");
const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = async () => { throw new Error("unexpected external request"); };
	for (const envVar of SEARCH_KEYS) deleteKey(envVar);
	writeSettings({ version: 1 });
});
after(() => {
	globalThis.fetch = realFetch;
	for (const envVar of SEARCH_KEYS) delete process.env[envVar];
	fs.rmSync(dir, { recursive: true, force: true });
});

const engines = [
	{ id: "exa", envVar: "EXA_API_KEY", url: "https://api.exa.ai/search", header: "x-api-key", prefix: "", payload: { results: [] } },
	{ id: "firecrawl", envVar: "FIRECRAWL_API_KEY", url: "https://api.firecrawl.dev/v2/search", header: "authorization", prefix: "Bearer ", payload: { success: true, data: { web: [] } } },
	{ id: "ollama", envVar: "OLLAMA_API_KEY", url: "https://ollama.com/api/web_search", header: "authorization", prefix: "Bearer ", payload: { results: [] } },
] as const;

for (const { id, envVar, url, header, prefix, payload } of engines) {
	it(`${id}: saving, rotating, env override, pinning and deleting use the live shared composition`, async () => {
		const fake = id === "firecrawl" ? "fc-fake-key-1234567890" : `${id}-fake-key-1234567890`;
		assert.equal(searchStatus().available, false);
		assert.equal(saveKey(envVar, fake).ok, true);
		assert.equal(keyStatuses().find((row) => row.id === envVar)?.present, true);
		assert.equal(searchStatus().engine, id, "key alone activates Automatic search");
		let expectedKey = fake;
		let calls = 0;
		globalThis.fetch = async (input, init) => {
			calls++;
			assert.equal(String(input), url);
			assert.equal((init?.headers as Record<string, string>)[header], `${prefix}${expectedKey}`);
			return Response.json(payload);
		};
		const search = async () => {
			assert.equal(searchProvider()?.id, id);
			assert.deepEqual(await searchProvider()!.search("evidence", 1), []);
			assert.ok(!JSON.stringify(searchStatus()).includes(fake), "status never carries key material");
		};
		await search();
		expectedKey = `${fake}-rotated`;
		assert.equal(saveKey(envVar, expectedKey).ok, true);
		await search();
		process.env[envVar] = expectedKey = `${fake}-environment`;
		await search();
		delete process.env[envVar];
		expectedKey = `${fake}-rotated`;
		await search();
		writeSettings({ version: 1, agent: { search: { engine: id } } });
		assert.equal(readSettings()?.agent?.search?.engine, id);
		assert.match(searchStatus().reason, /chosen/);
		assert.equal(saveKey("TAVILY_API_KEY", "tvly-fake-key-1234567890").ok, true);
		await search();
		deleteKey(envVar);
		assert.equal(searchStatus().available, false, "a missing explicit pin never falls back to keyed Tavily");
		assert.equal(searchProvider(), null);
		assert.ok(searchStatus().reason.includes(envVar));
		assert.equal(keyStatuses().find((row) => row.id === envVar)?.present, false);
		writeSettings({ version: 1 });
		assert.equal(searchStatus().engine, "tavily", "clearing the pin restores Automatic selection");
		assert.equal(calls, 5);
	});
}

it("all five saved keys follow the approved Automatic order as keys are removed", () => {
	for (const { id, envVar } of KEYED_ENGINES) {
		const fake = id === "tavily" ? "tvly-fake-key-1234567890" : id === "firecrawl" ? "fc-fake-key-1234567890" : `${id}-fake-key-1234567890`;
		assert.equal(saveKey(envVar, fake).ok, true);
	}
	for (const { id, envVar } of KEYED_ENGINES) {
		assert.equal(searchStatus().engine, id);
		assert.equal(searchProvider()?.id, id);
		deleteKey(envVar);
	}
	assert.equal(searchStatus().available, false);
	assert.equal(searchProvider(), null);
});

it("a configured later engine does not become a network-error fallback", async () => {
	assert.equal(saveKey("EXA_API_KEY", "exa-fake-key-1234567890").ok, true);
	assert.equal(saveKey("OLLAMA_API_KEY", "ollama-fake-key-1234567890").ok, true);
	const urls: string[] = [];
	globalThis.fetch = async (input) => { urls.push(String(input)); return new Response("quota", { status: 429 }); };
	assert.equal(searchStatus().engine, "exa" satisfies SearchEngineId);
	await assert.rejects(searchProvider()!.search("q", 5), /Exa search API 429/);
	assert.deepEqual(urls, ["https://api.exa.ai/search"]);
});

it("OpenAI search follows the researcher's model and runs only when chosen", () => {
	const researcher = (provider: string, engine?: SearchEngineId) =>
		writeSettings({ version: 1, agent: { ...(engine ? { search: { engine } } : {}), models: { researcher: { model: { provider, id: "scratch-model" } } } } });

	researcher("anthropic", "openai");
	assert.deepEqual(searchStatus(), { available: false, engine: null, reason: 'search engine is set to "openai" but the researcher model does not use an OpenAI API key or a ChatGPT connection', keyless: { openai: "unsupported" } });

	researcher("openrouter", "openai");
	assert.equal(searchStatus().keyless.openai, "unsupported", "an OpenAI model reached through another provider cannot run it");

	researcher("openai", "openai");
	assert.equal(searchStatus().reason, 'search engine is set to "openai" but the OpenAI API key is missing');
	assert.equal(searchStatus().keyless.openai, "blocked");
	assert.equal(searchProvider(), null);

	assert.equal(saveKey("OPENAI_API_KEY", "sk-fake-key-1234567890").ok, true);
	assert.deepEqual(searchStatus(), { available: true, engine: "openai", reason: "search engine: openai (chosen)", keyless: { openai: "ready" } });
	assert.equal(searchProvider()?.id, "openai");

	researcher("openai");
	assert.equal(searchStatus().available, false, "ready is not chosen: Automatic never picks it");
	assert.equal(searchStatus().keyless.openai, "ready");
	assert.equal(searchProvider(), null);

	assert.equal(saveKey("EXA_API_KEY", "exa-fake-key-1234567890").ok, true);
	researcher("openai", "openai");
	assert.equal(searchProvider()?.id, "openai", "the choice wins over a keyed engine");

	researcher("chatgpt", "openai");
	assert.equal(searchStatus().reason, 'search engine is set to "openai" but no ChatGPT account is connected');
	assert.equal(searchProvider(), null, "a ChatGPT researcher never borrows the API key, and never falls back to Exa");
});
