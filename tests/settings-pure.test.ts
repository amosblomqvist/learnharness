/**
 * The settings wave's pure layers (thin settings wave): the appearance →
 * CSS-variable mapping (the section must actually DO something), the
 * Colors block's override compose helpers, the agent section's compose helpers
 * (the replace-whole PUT discipline), and the keyboard overrides map.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance, staleVarNames } from "../components/settings/appearance.tsx";
import { clearColorOverrides, colorOverride, composeColorOverride } from "../components/settings/appearance-section.tsx";
import { BUILTIN_THEMES, DEFAULT_THEME } from "../src/core";
import {
	PROMPT_IN_USE_HINT,
	composePromptSwitch,
	composeSearchEngine,
	composeSlotModel,
	composeTool,
	composeWorkerRequestConcurrency,
	composeQuizMechanics,
	sectionedSegments,
} from "../components/settings/agent-section.tsx";
import { applyPersonalizationPreset } from "../src/core";
import { nextOverrides } from "../components/settings/keyboard-section.tsx";
import { classifyKeys, keyStatusLine, type ProviderKeyInfo } from "../components/settings/keys-section.tsx";
import type { AgentSettings, AuthKeyStatus, ModelsSettings } from "../src/core";
import { resolveSettings, slotsConfigured } from "../src/core";
import { setupStage } from "../components/setup-dialog.tsx";

const mocha = BUILTIN_THEMES.find((t) => t.id === "catppuccin-mocha")!;

describe("resolveAppearance — delta over factory", () => {
	it("absent everything = the factory view", () => {
		const a = resolveAppearance(undefined);
		assert.equal(a.theme, "default");
		assert.equal(a.background, null);
		assert.deepEqual(a.colors, {});
		assert.equal(a.fontFamily, null);
		assert.equal(a.proseFontSize, 16);
		assert.equal(a.sessionNameSerif, true);
		assert.deepEqual(a.mdRendering, { headingWeight: 900, boldColor: null, italicColor: null });
	});

	it("explicit deltas win field-by-field", () => {
		const a = resolveAppearance({ proseFontSize: 20, fontFamily: "Iowan Old Style", theme: "rose-pine" });
		assert.equal(a.proseFontSize, 20);
		assert.equal(a.fontFamily, "Iowan Old Style");
		assert.equal(a.theme, "rose-pine");
		assert.equal(a.background, null);
	});
});

describe("appearanceVars — the mapping the provider applies", () => {
	it("factory appearance on Default: the Default palette plus the type tokens", () => {
		const vars = appearanceVars(resolveAppearance(undefined), DEFAULT_THEME);
		assert.equal(vars["--background"], "#141414");
		assert.equal(vars["--accent"], "#2a2a2a", "the hover surface keeps its hand-picked value");
		assert.equal(vars["--lh-ink-strong"], "#e6e6e6", "emphasis = text on Default");
		assert.equal(vars["--lh-prose-size"], "16px");
		assert.equal(vars["--lh-heading-weight"], "900");
		assert.equal(vars["--font-prose"], undefined, "no font override at factory");
		assert.equal(vars["--font-title"], undefined, "CMU stays");
	});

	it("JetBrains Mono renders from the bundled face when it is not installed", () => {
		const vars = appearanceVars(resolveAppearance({ fontFamily: "JetBrains Mono" }), mocha);
		assert.equal(
			vars["--font-prose"],
			`"JetBrains Mono", var(--font-jetbrains), var(--font-sans3), ui-sans-serif, system-ui, sans-serif`,
		);
	});

	it("full delta: every knob lands on its token, overrides over the theme", () => {
		const vars = appearanceVars(
			resolveAppearance({
				background: "#101820",
				colors: { warning: "#fab387" },
				fontFamily: "Georgia",
				proseFontSize: 18,
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
			}),
			mocha,
		);
		assert.equal(vars["--background"], "#101820");
		assert.equal(vars["--card"], mocha.colors.surface, "un-overridden colors stay the theme's");
		assert.equal(vars["--lh-warning"], "#fab387");
		assert.equal(vars["--font-prose"], `"Georgia", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`);
		assert.equal(vars["--lh-prose-size"], "18px");
		assert.equal(vars["--font-title"], "var(--font-prose)", "serif off → titles follow the prose font");
		assert.equal(vars["--lh-heading-weight"], "700");
		assert.equal(vars["--lh-ink-strong"], "#ff0000");
		assert.equal(vars["--lh-ink-italic"], "#00ff00");
	});

	it("sessionNameSerif false alone: only the title token changes", () => {
		const factory = appearanceVars(resolveAppearance(undefined), DEFAULT_THEME);
		assert.deepEqual(appearanceVars(resolveAppearance({ sessionNameSerif: false }), DEFAULT_THEME), {
			...factory, "--font-title": "var(--font-prose)",
		});
	});
});

describe("staleVarNames — the removal half of application (owner repro: resets never reverted)", () => {
	it("a full delta applied, then factory: the delta-only type names go stale, colors never do", () => {
		const fullDelta = appearanceVars(
			resolveAppearance({
				background: "#101820",
				fontFamily: "Georgia",
				sessionNameSerif: false,
				mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
			}),
			DEFAULT_THEME,
		);
		const factory = appearanceVars(resolveAppearance(undefined), DEFAULT_THEME);
		const stale = staleVarNames(Object.keys(fullDelta), factory);
		assert.ok(stale.includes("--font-prose"));
		assert.ok(stale.includes("--font-title"), "serif toggle back ON must clear the title override");
		assert.ok(!stale.includes("--background"), "a theme always sets every color");
		assert.equal(factory["--background"], "#141414", "an emptied background is the theme's again");
		assert.ok(!stale.includes("--lh-prose-size"), "always-applied tokens never go stale");
	});

	it("no previous applications → nothing stale", () => {
		assert.deepEqual(staleVarNames([], appearanceVars(resolveAppearance(undefined), DEFAULT_THEME)), []);
	});
});

describe("Colors block compose helpers — overrides in their two homes", () => {
	const before = {
		theme: "catppuccin-mocha",
		fontFamily: "Georgia",
		background: "#101010",
		colors: { warning: "#fab387" },
		mdRendering: { headingWeight: 700, boldColor: "#ff0000" },
	};

	it("reads each key from its home", () => {
		assert.equal(colorOverride(before, "background"), "#101010");
		assert.equal(colorOverride(before, "bold"), "#ff0000");
		assert.equal(colorOverride(before, "italic"), "");
		assert.equal(colorOverride(before, "warning"), "#fab387");
		assert.equal(colorOverride(undefined, "surface"), "");
	});

	it("writes each key to its home and carries the rest of the section", () => {
		const bold = composeColorOverride(before, "bold", "#00ff00");
		assert.deepEqual(bold.mdRendering, { headingWeight: 700, boldColor: "#00ff00" });
		assert.equal(bold.theme, "catppuccin-mocha");
		const surface = composeColorOverride(before, "surface", "#222222");
		assert.deepEqual(surface.colors, { warning: "#fab387", surface: "#222222" });
		assert.equal(surface.fontFamily, "Georgia");
	});

	it("an empty commit returns the key to the theme", () => {
		assert.deepEqual(composeColorOverride(before, "warning", "").colors, {});
		assert.equal(composeColorOverride(before, "background", "").background, null);
	});

	it("Reset all clears every color and keeps the theme and type knobs", () => {
		assert.deepEqual(clearColorOverrides(before), {
			theme: "catppuccin-mocha",
			fontFamily: "Georgia",
			mdRendering: { headingWeight: 700 },
		});
	});
});

describe("agent section compose helpers — the replace-whole PUT body", () => {
	it("worker concurrency commits exact whole values, preserving every sibling without mutation", () => {
		const before: AgentSettings = {
			workerRequestConcurrency: 3,
			models: { auditor: { thinkingLevel: "high" } }, tools: { research: false },
			prompts: { "system-prompt.md": true }, search: { engine: "brave" }, graphTools: { enabled: false },
		};
		for (const [draft, value] of [["1", 1], ["8", 8], ["8.0", 8], ["1e1", 10], ["10e-1", 1], ["10.5e1", 105], ["100000", 100000], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]] as const) {
			const next = composeWorkerRequestConcurrency(before, draft);
			assert.ok(next.ok, draft);
			assert.deepEqual(next.settings, { ...before, workerRequestConcurrency: value });
		}
		assert.equal(before.workerRequestConcurrency, 3, "input record is not mutated");
		for (const draft of ["", "   "]) {
			const reset = composeWorkerRequestConcurrency(before, draft);
			assert.ok(reset.ok);
			const { workerRequestConcurrency: _drop, ...siblings } = before;
			assert.deepEqual(reset.settings, siblings);
			assert.equal(resolveSettings({ version: 1, agent: reset.settings }).agent.workerRequestConcurrency, 8);
		}
	});

	it("worker concurrency rejects invalid drafts, including fractions rounded away by Number", () => {
		for (const draft of ["0", "-1", "1.5", "1e-1", "8.0000000000000001", "99999999999999.99999", "9007199254740992", "1e999999", "1e", "NaN", "Infinity", "hello", "0x10"]) {
			const result = composeWorkerRequestConcurrency(undefined, draft);
			assert.equal(result.ok, false, draft);
			if (!result.ok) assert.match(result.error, /positive, safely representable whole number/);
		}
	});

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
			"EXA_API_KEY",
			"FIRECRAWL_API_KEY",
			"OLLAMA_API_KEY",
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

describe("sectionedSegments — actual per-agent prompt membership", () => {
	// Each agent lists its own shared subset; the view lists their union ONCE.
	const view = {
		prober: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "prober/10-probe-doctrine.md", sourceText: "p1", overrideText: null, enabled: false, shared: false },
		],
		practice: [
			{ path: "practice/00-base.md", sourceText: "r1", overrideText: null, enabled: false, shared: false },
			{ path: "practice/10-doctrine.md", sourceText: "r2", overrideText: "practice custom", enabled: true, shared: false },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
		],
		teacher: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/20-question-tools.md", sourceText: "q", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "teacher/05-method.md", sourceText: "t1", overrideText: null, enabled: false, shared: false },
			{ path: "teacher/10-planning.md", sourceText: "t2", overrideText: null, enabled: false, shared: false },
		],
	};

	it("the approved order: Teacher, Prober, Practice, Shared — Shared last", () => {
		const ids = sectionedSegments(view).map((s) => s.id);
		assert.deepEqual(ids, ["teacher", "prober", "practice", "shared"]);
	});

	it("shared chunks appear exactly ONCE across all sections (no duplication)", () => {
		const all = sectionedSegments(view).flatMap((s) => s.segments.map((seg) => seg.path));
		assert.equal(all.filter((p) => p === "system-prompt.md").length, 1);
		assert.equal(all.filter((p) => p === "shared/10-personality.md").length, 1);
		// every path unique — no chunk listed twice
		assert.equal(new Set(all).size, all.length);
	});

	it("the Shared section holds the shared chunks in assembly order; the agents' sections hold their own", () => {
		const [teacher, prober, practice, shared] = sectionedSegments(view);
		assert.ok(teacher && prober && practice && shared, "all four sections present");
		assert.deepEqual(teacher.segments.map((s) => s.path), ["teacher/05-method.md", "teacher/10-planning.md"]);
		assert.deepEqual(prober.segments.map((s) => s.path), ["prober/10-probe-doctrine.md"]);
		// assembly order: the base file first, then the shared fragments
		assert.deepEqual(shared.segments.map((s) => s.path), ["system-prompt.md", "shared/20-question-tools.md", "shared/10-personality.md"]);
		assert.deepEqual(practice.segments.map((s) => s.path), ["practice/00-base.md", "practice/10-doctrine.md"]);
		assert.equal(practice.segments[1]!.overrideText, "practice custom");
		assert.equal(practice.segments[1]!.enabled, true);
		assert.ok(practice.segments.every((s) => s.usageHint === undefined));
	});

	it("labels each shared fragment from actual membership, independently of override state", () => {
		const shared = sectionedSegments(view).at(-1)!;
		assert.equal(shared.segments[0]!.usageHint, "Used by Teacher and Prober");
		assert.equal(shared.segments[2]!.usageHint, "Used by Teacher, Prober and Practice");
		assert.equal(shared.segments[2]!.enabled, true, "in-use state is not replaced by usage");
		// A synthetic new path/membership proves there is no duplicated allowlist.
		const fragment = { path: "shared/99-new.md", sourceText: "new", overrideText: null, enabled: false, shared: true };
		const changed = { teacher: [fragment], prober: [fragment], practice: [fragment] };
		assert.equal(sectionedSegments(changed).at(-1)!.segments[0]!.usageHint, "Used by Teacher, Prober and Practice");
		changed.practice = [];
		assert.equal(sectionedSegments(changed).at(-1)!.segments[0]!.usageHint, "Used by Teacher and Prober");
		assert.equal(sectionedSegments({ teacher: [], prober: [], practice: [fragment] }).at(-1)!.segments[0]!.usageHint, "Used by Practice");
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

describe("applyPersonalizationPreset (personalization chip helper)", () => {
	it("appends preset snippet cleanly when absent and is idempotent when already present", () => {
		const first = applyPersonalizationPreset("", "Gunakan Bahasa Indonesia.");
		assert.equal(first, "Gunakan Bahasa Indonesia.");
		const second = applyPersonalizationPreset(first, "Beri analogi praktis.");
		assert.equal(second, "Gunakan Bahasa Indonesia.\nBeri analogi praktis.");
		const duplicate = applyPersonalizationPreset(second, "Gunakan Bahasa Indonesia.");
		assert.equal(duplicate, second, "does not duplicate an already-present snippet");
	});
});
