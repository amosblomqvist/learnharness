/**
 * Tests for the settings record's core layer (settings-storage wave,
 * 2026-09-19): the delta schema's sanitizer (core/settings.ts) — strict
 * known-field validation with graceful degradation, unknown-key
 * preservation (forward-compat: a newer record must survive an older
 * app), and the factory defaults. The store/adapter tests live in
 * settings-store.test.ts; resolution in settings-resolution.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CURRENT_SETTINGS_VERSION,
	FACTORY_SETTINGS,
	BACKGROUND_MODEL_ROLES,
	isHexColor,
	sanitizeUserSettings,
} from "../src/core/settings.ts";

describe("FACTORY_SETTINGS (the compiled factory layer)", () => {
	it("pins the owner-decided defaults", () => {
		assert.equal(CURRENT_SETTINGS_VERSION, 1);
		assert.deepEqual(FACTORY_SETTINGS.general, { autoUpdate: true });
		// wave 7 collapse: the master switch ONLY + the extraction-UX
		// redesign's chunk budget (2026-09-24); doubled to 8192 with the
		// digest-aware redesign (2026-09-30), then HALVED BACK to 4096
		// with the message anchors (owner, 2026-10-13)
		assert.deepEqual(FACTORY_SETTINGS.graph, { enabled: true, rendering: true, extractionChunkTokens: 4096 });
		const a = FACTORY_SETTINGS.appearance;
		assert.equal(a.mode, "dark");
		assert.equal(a.background, null); // the mode's own default, not a factory hex
		assert.equal(a.fontFamily, null); // Source Sans 3
		assert.equal(a.proseFontSize, 16);
		assert.equal(a.sessionNameSerif, true);
		assert.equal(a.mdRendering.headingWeight, 900);
		assert.equal(a.mdRendering.boldColor, null); // white
		assert.equal(a.mdRendering.italicColor, null);
	});

	it("has NO factory model pin — chat defaults and role overrides start absent", () => {
		assert.equal("chat" in FACTORY_SETTINGS, false);
		assert.equal("agent" in FACTORY_SETTINGS, false);
	});
});

describe("isHexColor", () => {
	it("accepts #rgb and #rrggbb (case-insensitive), rejects everything else", () => {
		for (const good of ["#fff", "#FFF", "#141414", "#8B5CF6"]) assert.equal(isHexColor(good), true, good);
		for (const bad of ["fff", "#ffff", "#gggggg", "141414", "#12345", "", "white"]) {
			assert.equal(isHexColor(bad), false, bad);
		}
	});
});

describe("sanitizeUserSettings", () => {
	it("round-trips a fully valid record field-for-field", () => {
		const record = {
			version: 1,
			general: { autoUpdate: false },
			agent: {
				models: {
					researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" },
					visualMaker: { thinkingLevel: "max" },
				},
				tools: { research: false, quiz: true },
				prompts: { "system-prompt.md": true, "teacher/20-teaching.md": false },
				search: { engine: "brave" },
			},
			models: {
				strong: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" },
				cheap: { thinkingLevel: "medium" },
			},
			appearance: {
				mode: "light",
				background: "#ffffff",
				fontFamily: "Some Font",
				proseFontSize: 18,
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null },
			},
			graph: { enabled: false },
		};
		assert.deepEqual(sanitizeUserSettings(record), record);
	});

	it("null and non-objects → null (first-boot semantics), never throws", () => {
		assert.equal(sanitizeUserSettings(null), null);
		assert.equal(sanitizeUserSettings("junk"), null);
		assert.equal(sanitizeUserSettings([1, 2]), null);
	});

	it("absent version defaults to CURRENT; unknown keys ride along VERBATIM", () => {
		const out = sanitizeUserSettings({ futureSection: { knob: 3 }, general: { autoUpdate: true } });
		assert.ok(out);
		assert.equal(out.version, CURRENT_SETTINGS_VERSION);
		assert.deepEqual((out as Record<string, unknown>).futureSection, { knob: 3 });
		assert.deepEqual(out.general, { autoUpdate: true });
	});

	it("wrong-typed fields DROP (resolve to factory), never crash", () => {
		const out = sanitizeUserSettings({
			general: { autoUpdate: "yes" },
			agent: { tools: { research: "no" }, prompts: { "system-prompt.md": 1 }, models: { researcher: "fast" } },
			appearance: { mode: "sepia", sessionNameSerif: "true" },
			graph: { enabled: 0 },
		});
		assert.ok(out);
		assert.deepEqual(out.general, {});
		assert.deepEqual(out.agent, {});
		assert.deepEqual(out.appearance, {});
		assert.deepEqual(out.graph, {});

		// extractionChunkTokens (extraction-UX redesign, 2026-09-24):
		// clamp-never-reject — a finite positive value survives (fractions
		// floor), below-floor values clamp UP to the cost floor, junk drops
		// (the factory default resolves at read time).
		const budget = sanitizeUserSettings({ version: 1, graph: { enabled: true, extractionChunkTokens: 2048 } });
		assert.deepEqual(budget?.graph, { enabled: true, extractionChunkTokens: 2048 });
		const fraction = sanitizeUserSettings({ version: 1, graph: { extractionChunkTokens: 1024.9 } });
		assert.equal(fraction?.graph?.extractionChunkTokens, 1024, "fractions floor to whole tokens");
		const tiny = sanitizeUserSettings({ version: 1, graph: { extractionChunkTokens: 10 } });
		assert.equal(tiny?.graph?.extractionChunkTokens, 500, "below the floor clamps UP — penny-batches are a cost bug, not a preference");
		for (const junk of [0, -1000, NaN, Infinity, "4096", null, true]) {
			const dropped = sanitizeUserSettings({ version: 1, graph: { extractionChunkTokens: junk } });
			assert.equal(dropped?.graph?.extractionChunkTokens, undefined, `junk ${String(junk)} drops`);
		}
	});

	it("out-of-range numbers CLAMP (proseFontSize, headingWeight)", () => {
		const out = sanitizeUserSettings({
			appearance: { proseFontSize: 99, mdRendering: { headingWeight: 999 } },
		});
		assert.ok(out);
		assert.equal(out.appearance?.proseFontSize, 24);
		assert.equal(out.appearance?.mdRendering?.headingWeight, 900);
		const low = sanitizeUserSettings({ appearance: { proseFontSize: 4, mdRendering: { headingWeight: 5 } } });
		assert.ok(low);
		assert.equal(low.appearance?.proseFontSize, 12);
		assert.equal(low.appearance?.mdRendering?.headingWeight, 100);
	});

	it("invalid colors become null (the factory default), valid ones pass", () => {
		const out = sanitizeUserSettings({
			appearance: { background: "blue", mdRendering: { boldColor: "#f00", italicColor: 42 } },
		});
		assert.ok(out);
		assert.equal(out.appearance?.background, null);
		assert.equal(out.appearance?.mdRendering?.boldColor, "#f00");
		assert.equal(out.appearance?.mdRendering?.italicColor, null);
	});

	it("empty strings/whitespace fontFamily → null (Source Sans 3); wrong-type → null too (the default)", () => {
		for (const bad of ["", "   ", 12, { name: "x" }]) {
			const out = sanitizeUserSettings({ appearance: { fontFamily: bad } });
			assert.ok(out);
			assert.equal(out.appearance?.fontFamily, null, JSON.stringify(bad));
		}
	});

	it("agent roles: unknown roles drop, known roles keep only well-formed overrides", () => {
		const out = sanitizeUserSettings({
			agent: {
				models: {
					teacher: { thinkingLevel: "low" }, // NOT a background role — drops
					researcher: { model: { provider: "openrouter", id: "x/y" } },
					extractor: { model: { provider: 3, id: "x/y" }, thinkingLevel: "high" }, // bad model, keeps thinking
					auditor: { thinkingLevel: "banana" }, // invalid level → empty override drops
				},
			},
		});
		assert.ok(out);
		const models = out.agent?.models ?? {};
		assert.equal("teacher" in models, false);
		assert.deepEqual(models.researcher, { model: { provider: "openrouter", id: "x/y" } });
		assert.deepEqual(models.extractor, { thinkingLevel: "high" });
		assert.equal("auditor" in models, false);
	});

	it("search engine pin survives; unknown engine ids drop (auto-detect resumes) — search wave, 2026-09-20", () => {
		const good = sanitizeUserSettings({ version: 1, agent: { search: { engine: "tavily" } } });
		assert.deepEqual(good?.agent?.search, { engine: "tavily" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { search: { engine: "ollama" } } })?.agent?.search, { engine: "ollama" });
		const bad = sanitizeUserSettings({ version: 1, agent: { search: { engine: "google" } } });
		assert.equal(bad?.agent?.search, undefined);
		const notObject = sanitizeUserSettings({ version: 1, agent: { search: "tavily" } });
		assert.equal(notObject?.agent?.search, undefined);
	});

	it("graphTools subsection: boolean survives; bad shapes drop (default ON resumes) — wave 7, 2026-09-23", () => {
		const on = sanitizeUserSettings({ version: 1, agent: { graphTools: { enabled: true } } });
		assert.deepEqual(on?.agent?.graphTools, { enabled: true });
		const off = sanitizeUserSettings({ version: 1, agent: { graphTools: { enabled: false } } });
		assert.deepEqual(off?.agent?.graphTools, { enabled: false });
		const bare = sanitizeUserSettings({ version: 1, agent: { graphTools: {} } });
		assert.deepEqual(bare?.agent?.graphTools, {});
		const badShape = sanitizeUserSettings({ version: 1, agent: { graphTools: "on" } });
		assert.equal(badShape?.agent?.graphTools, undefined);
		const badEnabled = sanitizeUserSettings({ version: 1, agent: { graphTools: { enabled: "yes" } } });
		assert.equal(badEnabled?.agent?.graphTools, undefined);
	});

	it("partial maps: booleans survive, non-boolean entries drop individually", () => {
		const out = sanitizeUserSettings({ agent: { tools: { quiz: false, demo: true, visual: "x" } } });
		assert.ok(out);
		assert.deepEqual(out.agent?.tools, { quiz: false, demo: true });
	});

	it("BACKGROUND_MODEL_ROLES matches the five background roles (practice trio deleted 2026-10-04)", () => {
		assert.deepEqual([...BACKGROUND_MODEL_ROLES], [
			"researcher",
			"demoBuilder",
			"visualMaker",
			"extractor",
			"auditor",
		]);
	});
});
