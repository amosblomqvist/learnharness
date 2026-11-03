import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

// An isolated store and fake key ensure this exercises the real composition
// without reading the developer's settings or calling a paid provider.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exa-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
for (const name of ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]) delete process.env[name];

const { saveKey, keyStatuses } = await import("../src/server/keys.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { searchStatus, searchProvider } = await import("../src/server/search.ts");
const realFetch = globalThis.fetch;

after(() => {
	globalThis.fetch = realFetch;
	delete process.env.EXA_API_KEY;
	fs.rmSync(dir, { recursive: true, force: true });
});

it("a saved Exa key activates search, and a saved pin reaches the adapter", async () => {
	const saved = saveKey("EXA_API_KEY", "exa-fake-test-key-123456");
	assert.equal(saved.ok, true);
	assert.equal(searchStatus().engine, "exa");
	assert.equal(keyStatuses().find((row) => row.id === "EXA_API_KEY")?.present, true);
	writeSettings({ version: 1, agent: { search: { engine: "exa" } } });
	assert.equal(searchStatus().engine, "exa");
	assert.match(searchStatus().reason, /chosen/);
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "https://api.exa.ai/search");
		assert.equal((init?.headers as Record<string, string>)["x-api-key"], "exa-fake-test-key-123456");
		return new Response(JSON.stringify({ results: [{ title: "Example", url: "https://example.org", highlights: ["Evidence"] }] }));
	};
	const provider = searchProvider();
	assert.equal(provider?.id, "exa");
	assert.deepEqual(await provider!.search("evidence", 1), [{ title: "Example", url: "https://example.org", snippet: "Evidence" }]);
});
