/**
 * Tests for the settings STORE (settings-storage wave, 2026-09-19):
 * src/store/settings.ts — the record's fs adapter. Uses a fresh isolated
 * HOME/data/auth before importing any store or config; never touches the
 * repo's data or shares a recovery/store directory with another process.
 *
 * (The legacy default-settings.json fold and the chat-section facade died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot server-side.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, afterEach, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-settings-store-"));
process.env.HOME = path.join(directory, "home");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");

after(() => fs.rmSync(directory, { recursive: true, force: true }));

afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

describe("the settings store", () => {
	it("persists worker concurrency, drops invalid disk values, and resets to 8 when unset", () => {
		writeSettings({ version: 1, agent: { workerRequestConcurrency: 29, tools: { research: false } } });
		assert.deepEqual(readSettings()?.agent, { workerRequestConcurrency: 29, tools: { research: false } });
		assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).agent.workerRequestConcurrency, 29);
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, agent: { workerRequestConcurrency: 1.5, tools: { research: false } } }));
		assert.deepEqual(readSettings()?.agent, { tools: { research: false } });
		assert.equal(resolveSettings(readSettings()).agent.workerRequestConcurrency, 8);
		writeSettings({ version: 1, agent: { tools: { research: false } } });
		assert.equal("workerRequestConcurrency" in JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).agent, false);
		assert.equal(resolveSettings(readSettings()).agent.workerRequestConcurrency, 8);
	});

	it("reads null on first boot (no record)", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("a chat section on disk is IGNORED — the field died with per-session models (owner, 2026-09-28)", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		// A fossil `chat` section (the old default-settings record) must not
		// resurrect through the sanitizer — the key is simply gone.
		fs.writeFileSync(
			SETTINGS_FILE,
			JSON.stringify({
				version: 1,
				chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
				graph: { enabled: true },
			}),
			"utf-8",
		);
		const out = readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true }); // siblings survive
	});

	it("corrupt settings.json → null (first-boot semantics), never throws", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, "{not json", "utf-8");
		assert.equal(readSettings(), null);
	});
});
