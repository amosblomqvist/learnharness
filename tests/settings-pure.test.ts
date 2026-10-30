/**
 * The settings wave's pure layers (thin settings wave): the appearance →
 * CSS-variable mapping (the section must actually DO something), the
 * dark-curve background derivation, the agent section's compose helpers
 * (the replace-whole PUT discipline), and the keyboard overrides map.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearanceVars, derivedPalette, resolveAppearance, staleVarNames } from "../components/settings/appearance.tsx";
import {
	PROMPT_IN_USE_HINT,
	composePromptSwitch,
	composeSearchEngine,
	composeSlotModel,
	composeTool,
	composeQuizMechanics,
	sectionedSegments,
} from "../components/settings/agent-section.tsx";
import { nextOverrides } from "../components/settings/keyboard-section.tsx";
import { classifyKeys, keyStatusLine, type ProviderKeyInfo } from "../components/settings/keys-section.tsx";
import type { AgentSettings, AuthKeyStatus, ModelsSettings } from "../src/core";
import { slotsConfigured } from "../src/core";
import { setupStage } from "../components/setup-dialog.tsx";

describe("resolveAppearance — delta over factory", () => {
	it("absent everything = the factory view", () => {
		const a = resolveAppearance(undefined);
		assert.equal(a.mode, "dark");
		assert.equal(a.background, null);
		assert.equal(a.fontFamily, null);
		assert.equal(a.proseFontSize, 16);
		assert.equal(a.sessionNameSerif, true);
		assert.deepEqual(a.mdRendering, { headingWeight: 900, boldColor: null, italicColor: null });
	});

	it("explicit deltas win field-by-field", () => {
		const a = resolveAppearance({ proseFontSize: 20, fontFamily: "Iowan Old Style" });
		assert.equal(a.proseFontSize, 20);
		assert.equal(a.fontFamily, "Iowan Old Style");
		assert.equal(a.background, null);
	});
});

describe("derivedPalette — the dark curve keeps today's relationships", () => {
	it("the factory background reproduces today's palette EXACTLY", () => {
		assert.deepEqual(derivedPalette("#141414"), {
			"--background": "#141414",
			"--card": "#1c1c1c",
			"--popover": "#1c1c1c",
			"--secondary": "#1c1c1c",
			"--muted": "#1c1c1c",
			"--accent": "#2a2a2a",
			"--border": "#434343",
			"--input": "#434343",
			"--primary-foreground": "#141414",
		});
	});

	it("an off-factory background shifts every surface with it (clamped at 255)", () => {
		const p = derivedPalette("#f0f0f0");
		assert.equal(p["--background"], "#f0f0f0");
		assert.equal(p["--card"], "#f8f8f8"); // 240 + 8 per channel
		assert.equal(p["--border"], "#ffffff", "240 + 47 clamps to 255 on every channel");
	});

	it("3-digit hex expands", () => {
		assert.equal(derivedPalette("#abc")["--card"], "#b2c3d4"); // aa bb cc each +8
	});
});

describe("appearanceVars — the mapping the provider applies", () => {
	it("factory appearance: only the always-applied tokens move", () => {
		const vars = appearanceVars(resolveAppearance(undefined));
		assert.equal(vars["--lh-prose-size"], "16px");
		assert.equal(vars["--lh-heading-weight"], "900");
		assert.equal(vars["--font-prose"], undefined, "no font override at factory");
		assert.equal(vars["--font-title"], undefined, "CMU stays");
		assert.equal(vars["--background"], undefined, "factory palette untouched");
		assert.equal(vars["--lh-ink-strong"], undefined, "default ink");
	});

	it("full delta: every knob lands on its token", () => {
		const vars = appearanceVars(
			resolveAppearance({
				background: "#101820",
				fontFamily: "Georgia",
				proseFontSize: 18,
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
			}),
		);
		assert.equal(vars["--background"], "#101820");
		assert.equal(vars["--card"], "#182028", "raised +8 per channel: 10→18, 18→20, 20→28");
		assert.equal(vars["--font-prose"], `"Georgia", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`);
		assert.equal(vars["--lh-prose-size"], "18px");
		assert.equal(vars["--font-title"], "var(--font-prose)", "serif off → titles follow the prose font");
		assert.equal(vars["--lh-heading-weight"], "700");
		assert.equal(vars["--lh-ink-strong"], "#ff0000");
		assert.equal(vars["--lh-ink-italic"], "#00ff00");
	});

	it("sessionNameSerif false alone: titles move, nothing else does", () => {
		const vars = appearanceVars(resolveAppearance({ sessionNameSerif: false }));
		assert.equal(vars["--font-title"], "var(--font-prose)");
		assert.equal(Object.keys(vars).length, 3, "prose-size, heading-weight, font-title only");
	});
});

describe("staleVarNames — the removal half of application (owner repro: resets never reverted)", () => {
	it("a full delta applied, then factory: every delta-only name goes stale", () => {
		const fullDelta = appearanceVars(
			resolveAppearance({
				background: "#101820",
				fontFamily: "Georgia",
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
			}),
		);
		const applied = Object.keys(fullDelta);
		const factory = appearanceVars(resolveAppearance(undefined));
		const stale = staleVarNames(applied, factory);
		assert.ok(stale.includes("--background"));
		assert.ok(stale.includes("--font-prose"));
		assert.ok(stale.includes("--font-title"), "serif toggle back ON must clear the title override");
		assert.ok(stale.includes("--lh-ink-strong"));
		assert.ok(stale.includes("--lh-ink-italic"));
		assert.ok(!stale.includes("--lh-prose-size"), "always-applied tokens never go stale");
		assert.ok(!stale.includes("--lh-heading-weight"), "always-applied tokens never go stale");
	});

	it("an empty background commit (null = factory) frees the palette vars", () => {
		const withBg = appearanceVars(resolveAppearance({ background: "#101010" }));
		const emptied = appearanceVars(resolveAppearance({ background: null }));
		const stale = staleVarNames(Object.keys(withBg), emptied);
		assert.ok(stale.includes("--background"));
		assert.ok(stale.includes("--card"), "the derived palette follows the background out");
		assert.equal(emptied["--background"], undefined);
	});

	it("no previous applications → nothing stale", () => {
		assert.deepEqual(staleVarNames([], appearanceVars(resolveAppearance(undefined))), []);
	});
});

describe("agent section compose helpers — the replace-whole PUT body", () => {
	it("composeTool carries the rest of the section verbatim", () => {
		const before = { tools: { demo: false }, prompts: { "system-prompt.md": true } };
		const after = composeTool(before, "visual", false);
		assert.deepEqual(after.tools, { demo: false, visual: false });
		assert.deepEqual(after.prompts, { "system-prompt.md": true }, "prompts untouched");
	});

	it("composeSlotModel: empty+empty REMOVES the slot (absent = factory pin)", () => {
		const after = composeSlotModel(
			{ strong: { model: { provider: "openrouter", id: "x" } }, cheap: {} },
			"strong",
			"",
			"",
			"",
		);
		assert.equal(after.strong, undefined, "slot dropped");
		assert.deepEqual(after.cheap, {}, "sibling untouched");
	});

	it("composeSlotModel: model alone, thinking alone, and both — provider rides the swap (federation)", () => {
		assert.deepEqual(composeSlotModel(undefined, "strong", "zai", "glm-4.7-flash", "").strong, {
			model: { provider: "zai", id: "glm-4.7-flash" },
		});
		assert.deepEqual(composeSlotModel(undefined, "cheap", "", "", "low").cheap, { thinkingLevel: "low" });
		assert.deepEqual(composeSlotModel(undefined, "vision", "openai", "gpt-5.2", "high").vision, {
			model: { provider: "openai", id: "gpt-5.2" },
			thinkingLevel: "high",
		});
	});

	it("composeSlotModel: per-field independence — clearing the model keeps the thinking pin", () => {
		const prev: ModelsSettings = { strong: { model: { provider: "zai", id: "glm-4.7-flash" }, thinkingLevel: "high" } };
		const after = composeSlotModel(prev, "strong", "", "", "high");
		assert.deepEqual(after.strong, { model: { provider: "zai", id: "glm-4.7-flash" }, thinkingLevel: "high" }, "model carried, thinking kept");
		// clearing thinking keeps the model
		const after2 = composeSlotModel(prev, "strong", "zai", "glm-4.7-flash", "");
		assert.deepEqual(after2.strong, { model: { provider: "zai", id: "glm-4.7-flash" } }, "thinking dropped, model kept");
	});

	it("composeSearchEngine: null REMOVES the pin (auto-activation's resting state)", () => {
		const withPin: AgentSettings = { search: { engine: "tavily" } };
		const cleared = composeSearchEngine(withPin, null);
		assert.equal(cleared.search, undefined);
		// no pin to begin with → carried verbatim
		assert.deepEqual(composeSearchEngine({ tools: { demo: true } }, null).tools, { demo: true });
	});

	it("composeSearchEngine: the explicit preference writes agent.search.engine", () => {
		assert.deepEqual(composeSearchEngine(undefined, "brave").search, { engine: "brave" });
	});

	it("composePromptSwitch: on = explicit true, off = key REMOVED (absent = off)", () => {
		assert.deepEqual(composePromptSwitch({ prompts: { a: true } }, "b", true).prompts, { a: true, b: true });
		assert.deepEqual(composePromptSwitch({ prompts: { a: true, b: true } }, "b", false).prompts, { a: true });
	});
});

describe("nextOverrides — the rebind persistence map", () => {
	it("a rebind sets the action's override, keeping the others", () => {
		const next = nextOverrides({ "toggle-sidebar": "mod+b" }, "open-settings", "mod+shift+s");
		assert.deepEqual(next, { "toggle-sidebar": "mod+b", "open-settings": "mod+shift+s" });
	});

	it("null = reset that action to its default (key removed)", () => {
		const next = nextOverrides({ "toggle-sidebar": "mod+b", find: "mod+f" }, "toggle-sidebar", null);
		assert.deepEqual(next, { find: "mod+f" });
	});
});

describe("classifyKeys — the Keys section's two-group projection", () => {
	const synth = (id: string, present = false): AuthKeyStatus => ({
		id,
		info: null,
		present,
		masked: present ? `…${id.slice(-4)} (32 chars)` : null,
		source: present ? "file" : "none",
		shadowedByEnv: false,
	});
	const providers: ProviderKeyInfo[] = [
		{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
		{ id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
		{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	];

	it("OpenRouter is UN-pinned (wave-5 owner ruling): no row when absent, a row when stored", () => {
		const none = classifyKeys([], providers);
		assert.equal(none.providerRows.length, 0); // nothing synthesized
		assert.ok(none.addable.some((p) => p.id === "openrouter")); // it's just an Add option
		const stored = classifyKeys([synth("OPENROUTER_API_KEY", true)], providers);
		assert.equal(stored.providerRows.length, 1);
		assert.equal(stored.providerRows[0]!.id, "OPENROUTER_API_KEY");
		assert.ok(!stored.addable.some((p) => p.id === "openrouter"));
	});

	it("stored provider keys land in providerRows; the Add dropdown drops them", () => {
		const out = classifyKeys([synth("GROQ_API_KEY", true)], providers);
		assert.equal(out.providerRows.length, 1);
		assert.equal(out.providerRows[0]!.id, "GROQ_API_KEY");
		// the Add dropdown no longer offers groq
		assert.ok(!out.addable.some((p) => p.id === "groq"));
		assert.ok(out.addable.some((p) => p.id === "deepseek"));
	});

	it("curated tool ids always render (synthesized when absent)", () => {
		const out = classifyKeys([synth("DEEPGRAM_API_KEY", true)], undefined);
		assert.deepEqual(out.toolRows.map((r) => r.id), [
			"DEEPGRAM_API_KEY",
			"TAVILY_API_KEY",
			"BRAVE_API_KEY",
		]);
		assert.ok(out.toolRows[0]!.present);
		assert.ok(!out.toolRows[1]!.present);
	});

	it("unknown file vars surface read-only, out of the provider rows", () => {
		const out = classifyKeys([synth("PLANS_LOGIN_TOKEN", true)], providers);
		assert.equal(out.unknownRows.length, 1);
		assert.equal(out.providerRows.length, 0);
	});

	it("providers seam absent = addable empty, nothing crashes", () => {
		const out = classifyKeys([], undefined);
		assert.deepEqual(out.addable, []);
	});
});

describe("keyStatusLine — the minimal at-a-glance state", () => {
	it("present file key: tail + chars, no source suffix", () => {
		assert.equal(
			keyStatusLine({ id: "X", info: null, present: true, masked: "…ab12 (64 chars)", source: "file", shadowedByEnv: false }),
			"…ab12 · 64",
		);
	});

	it("env-owned key carries the 'env' marker (the row renders read-only)", () => {
		assert.equal(
			keyStatusLine({ id: "X", info: null, present: true, masked: "…ca10 (73 chars)", source: "env", shadowedByEnv: false }),
			"…ca10 · 73 · env",
		);
	});

	it("absent key reads 'not set'", () => {
		assert.equal(keyStatusLine({ id: "X", info: null, present: false, masked: null, source: "none", shadowedByEnv: false }), "not set");
	});
});

describe("first-run gate — slotsConfigured + setupStage (model-slots wave)", () => {
	it("slotsConfigured: all three slot models required — thinking levels are optional", () => {
		assert.equal(slotsConfigured(undefined), false, "no record = unconfigured");
		assert.equal(slotsConfigured({}), false, "empty models section");
		assert.equal(
			slotsConfigured({
				strong: { model: { provider: "zai", id: "glm-5.3-flash" } },
				cheap: { model: { provider: "zai", id: "glm-4.7-flash" } },
			}),
			false,
			"vision missing",
		);
		assert.equal(
			slotsConfigured({
				strong: { model: { provider: "zai", id: "glm-5.3-flash" } },
				cheap: { model: { provider: "zai", id: "glm-4.7-flash" } },
				vision: { model: { provider: "openai", id: "gpt-5.2" } },
			}),
			true,
			"all three picked",
		);
		// a thinking-only pin does NOT configure the slot
		assert.equal(
			slotsConfigured({ strong: { thinkingLevel: "low" }, cheap: { thinkingLevel: "low" }, vision: { thinkingLevel: "low" } }),
			false,
			"thinking pins are not models",
		);
	});

	it("setupStage: keys before models (owner's dependency ordering)", () => {
		assert.equal(setupStage(null), "loading", "unknown catalog must not claim keys are missing");
		assert.equal(setupStage([]), "keys", "no providers = keys");
		assert.equal(setupStage([{ id: "zai", keyPresent: false }]), "keys", "provider present but keyless");
		assert.equal(setupStage([{ id: "zai", keyPresent: false }, { id: "openai", keyPresent: true }]), "pickers", "one keyed provider widens the pickers");
	});
});

describe("sectionedSegments — the prompts overhaul (2026-09-26)", () => {
	// The server contract: BOTH per-agent lists include the shared
	// segments (same paths) — the view must list them ONCE.
	const view = {
		prober: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "prober/10-probe-doctrine.md", sourceText: "p1", overrideText: null, enabled: false, shared: false },
		],
		teacher: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "teacher/05-method.md", sourceText: "t1", overrideText: null, enabled: false, shared: false },
			{ path: "teacher/10-planning.md", sourceText: "t2", overrideText: null, enabled: false, shared: false },
		],
	};

	it("the owner's ruled order: Teacher, Prober, Shared — Shared last", () => {
		const ids = sectionedSegments(view).map((s) => s.id);
		assert.deepEqual(ids, ["teacher", "prober", "shared"]);
	});

	it("shared chunks appear exactly ONCE across all sections (no duplication)", () => {
		const all = sectionedSegments(view).flatMap((s) => s.segments.map((seg) => seg.path));
		assert.equal(all.filter((p) => p === "system-prompt.md").length, 1);
		assert.equal(all.filter((p) => p === "shared/10-personality.md").length, 1);
		// every path unique — no chunk listed twice
		assert.equal(new Set(all).size, all.length);
	});

	it("the Shared section holds the shared chunks in assembly order; the agents' sections hold their own", () => {
		const [teacher, prober, shared] = sectionedSegments(view);
		assert.ok(teacher && prober && shared, "all three sections present");
		assert.deepEqual(teacher.segments.map((s) => s.path), ["teacher/05-method.md", "teacher/10-planning.md"]);
		assert.deepEqual(prober.segments.map((s) => s.path), ["prober/10-probe-doctrine.md"]);
		// assembly order: the base file first, then the shared fragments
		assert.deepEqual(shared.segments.map((s) => s.path), ["system-prompt.md", "shared/10-personality.md"]);
		// the Shared header carries the one hint that earns its place
		assert.equal(shared.hint, "Used by both agents");
		assert.equal(teacher.hint, undefined);
	});

	it("the indicator copy is pinned — it states WHICH VERSION IS IN USE (refined 2026-09-26)", () => {
		assert.equal(PROMPT_IN_USE_HINT, "Your version is in use");
	});
});

// ─── the quizzing-mechanics segmented control (owner 2026-09-27) ───────────

describe("composeQuizMechanics (the segmented control's write)", () => {
	it("free recall writes explain:true; multiple choice writes explain:false — nothing else moves", () => {
		const before: AgentSettings = { tools: { research: false }, prompts: { teacher: true } } as AgentSettings;
		const free = composeQuizMechanics(before, "free");
		assert.equal(free.tools?.explain, true);
		const choice = composeQuizMechanics(before, "choice");
		assert.equal(choice.tools?.explain, false);
		for (const after of [free, choice]) {
			assert.equal(after.tools?.research, false, "the research toggle carries verbatim");
			assert.deepEqual(after.prompts, before.prompts, "the prompts map carries verbatim");
		}
	});
});
