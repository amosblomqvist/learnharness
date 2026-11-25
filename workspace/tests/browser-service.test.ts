/**
 * Wave E stage 3 (owner 2026-10-10): demos run in the app's own Chromium
 * via a --browser-service helper (main.cjs boots a hidden window with a CDP
 * port), system Chrome as fallback. These pin the pure halves of that
 * chain: the handshake line parser and the spawn-env sanitizer. The live
 * chain (spawn → connect → pages() → run) is exercised on dev machines,
 * not in the suite.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserServiceSpawnEnv, parseBrowserServiceLine } from "../src/agent/subagents/headless.ts";

describe("browser-service helper (pure halves)", () => {
	it("parses the handshake line into a port", () => {
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 54321"), 54321);
	});

	it("rejects non-handshake lines", () => {
		assert.equal(parseBrowserServiceLine("DevTools listening on ws://127.0.0.1:57983/devtools/browser/x"), null);
		assert.equal(parseBrowserServiceLine(""), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 0"), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 99999"), null);
	});

	it("spawn env strips ELECTRON_RUN_AS_NODE — the helper must be a full app", () => {
		const env = browserServiceSpawnEnv({
			ELECTRON_RUN_AS_NODE: "1",
			LH_DEV_URL: "http://localhost:3000",
			PATH: "/usr/bin",
		});
		assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
		assert.equal("LH_DEV_URL" in env, false);
		assert.equal(env.PATH, "/usr/bin");
	});

	it("spawn env never mutates the caller's env object", () => {
		const original = { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" };
		browserServiceSpawnEnv(original);
		assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(original.KEEP, "yes");
	});
});
