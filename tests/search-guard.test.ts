import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEARCH_ENGINES, isSearchEngineId } from "../src/core/search.ts";

// The read/write guards use this membership check for a persisted preference.
// search.test.ts covers resolution and adapters; this pins the guard itself.
describe("isSearchEngineId", () => {
	it("accepts exactly the ids in the catalog", () => {
		for (const engine of SEARCH_ENGINES) assert.equal(isSearchEngineId(engine.id), true, engine.id);
	});

	it("refuses unknown or non-string values without throwing", () => {
		for (const value of ["tavily2", "TAVILY", "", null, undefined, 0, {}, ["tavily"]]) {
			assert.equal(isSearchEngineId(value), false, String(value));
		}
	});

	it("keeps the documented automatic preference order and env-var wiring", () => {
		assert.deepEqual(SEARCH_ENGINES.map((e) => e.id), ["tavily", "brave", "exa", "firecrawl", "ollama"]);
		for (const engine of SEARCH_ENGINES) assert.equal(engine.envVar.endsWith("_API_KEY"), true, engine.id);
	});
});
