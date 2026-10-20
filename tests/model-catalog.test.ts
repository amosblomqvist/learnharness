import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	catalogContextLimits,
	catalogDefaultsFor,
	catalogProviders,
	catalogRolePins,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	modelCatalog,
	roleModelCapabilityError,
	roleNeedsImageInput,
	rolePinsFor,
	toModelDto,
	validateAgentModelsSettings,
	validateChatSettings,
	validateModelsSettings,
} from "../src/server/model-catalog.ts";
import type { EffectiveSlot } from "../src/core/settings-resolution.ts";
import type { SettingsValidation } from "../src/server/model-catalog.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { readSettings } from "../src/store/settings.ts";
import { effectiveSettings } from "../src/server/stores.ts";

// The model-control wave (2026-09-12): pi-ai owns the registry — these pins
// hold our projection + validation honest against the shipped catalog, and
// pin pi's per-model thinking truth so a pi-ai upgrade can't silently change
// what we send. BYOK wave (2026-09-22): no factory pins — unset surfaces
// are NULL/undefined, never phantom defaults.

// The picker federates only providers with a PRESENT key (model slots
// wave, 2026-09-20): pin openrouter's env key so its full catalog
// federates in tests regardless of the developer shell's exports.
process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";

/** The catalog's glm entry — the old factory pin's model, still the
 *  best-known thinking-truth specimen (low|high|max). */
function glmModel() {
	const glm = piModels().getModel("openrouter", "z-ai/glm-5.3-flash");
	assert.ok(glm, "glm-5.3-flash in catalog");
	return glm!;
}

/** Another reasoning specimen with a different supported set. */
function qwenModel() {
	const qwen = piModels().getModel("openrouter", "qwen/qwen3.8-max-0902");
	assert.ok(qwen, "qwen3.8-max in catalog");
	return qwen!;
}

describe("the model catalog projection", () => {
	it("serves the keyed providers' catalogs with the picker's DTO shape", () => {
		const { models, defaults, providers, slots } = modelCatalog();
		// 0.85.1 ships 366 OpenRouter models — the exact count is pi's, but
		// the shape and the config models' presence are ours to pin.
		assert.ok(models.length > 300, `expected a full catalog, got ${models.length}`);
		for (const m of models.slice(0, 25)) {
			assert.equal(typeof m.id, "string");
			assert.equal(typeof m.name, "string");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(typeof m.cost.input === "number" && typeof m.cost.output === "number");
			assert.ok(m.contextWindow > 0);
		}
		const glm = models.find((m) => m.id === "z-ai/glm-5.3-flash");
		assert.ok(glm, "glm-5.3-flash in catalog");
		assert.deepEqual(glm!.supportedLevels, ["low", "high", "max"]);
		assert.deepEqual(glm!.input, ["text", "image"]);
		// pi's current glm price (pi 1.0.2 catalog refresh: cacheRead
		// corrected 0.05 → 0.03; input/output unchanged since 0.87.1)
		assert.deepEqual(glm!.cost, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		// model slots wave: the providers surface + the resolved slot pins
		const openrouter = providers.find((p) => p.id === "openrouter");
		assert.ok(openrouter && openrouter.keyPresent, "openrouter federated (key pinned above)");
		assert.ok(providers.some((p) => !p.keyPresent), "keyless providers listed for discovery");
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);
		// a keyless API-key provider's models never reach the picker
		// (subscription sources are a KNOWN keyless row — pinned below)
		const keyless = providers.filter((p) => !p.keyPresent && p.authorization === "api_key").map((p) => p.id);
		for (const id of keyless) {
			assert.ok(!models.some((m) => m.provider === id), `keyless ${id} must not federate`);
		}
		// BYOK: the payload carries ONLY what the machine's record actually
		// says — never a phantom id. data/settings.json belongs to
		// settings-store.test.ts (the one-fs-owner discipline), so READ the
		// resolved truth here instead of pinning it: on a scratch worktree
		// the record is empty (defaults/slots NULL), on the owner's machine
		// configured slots must surface exactly as configured.
		const record = readSettings();
		const strong = effectiveSettings().models.strong;
		if (strong) {
			assert.ok(defaults, "a configured strong slot yields a default");
			assert.deepEqual(defaults!.model, { provider: strong.provider, id: strong.id });
		} else {
			assert.equal(defaults, null);
		}
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("defaults: the strong slot verbatim; null when unset (BYOK, per-session models 2026-09-28)", () => {
		assert.equal(catalogDefaultsFor(null), null);
		const strong = { provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(strong);
		assert.deepEqual(d, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" });
		// No level stored → the model alone reports (the level resolves at
		// engine build from DEFAULT_THINKING_ORDER).
		const bare = catalogDefaultsFor({ provider: "openrouter", id: "qwen/qwen3.8-flash" });
		assert.deepEqual(bare, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } });
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = glmModel();
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, raw.contextWindow);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
			agent: { models: { researcher: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.deepEqual(pins.auditor, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }); // level unset
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});

	it("catalogRolePins matches the same resolution the engine wiring uses", () => {
		const pins = catalogRolePins();
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.ok(pins[role] === null || typeof pins[role]!.model.id === "string");
		}
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots projects the record's tiers — NULL only where a tier holds no model", () => {
		// machine-aware (one-fs-owner: READ the record, never pin it)
		const record = readSettings();
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("catalogProviders reads keys env-wins, fresh per call", () => {
		const before = catalogProviders().find((p) => p.id === "zai");
		assert.equal(before?.keyPresent, false);
		const saved = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "test-zai-key-1234567890";
		try {
			assert.equal(catalogProviders().find((p) => p.id === "zai")?.keyPresent, true);
		} finally {
			if (saved === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = saved;
		}
	});
});

describe("the subscription source (source-aware catalog, issue #8)", () => {
	it("lists openai-codex as a subscription provider — no fictitious env var, keyPresent is not an auth fact", () => {
		const codex = catalogProviders().find((p) => p.id === "openai-codex");
		assert.ok(codex, "codex row is in the providers surface");
		assert.deepEqual(codex, {
			id: "openai-codex",
			envVar: null,
			keyPresent: false,
			authorization: "subscription",
		});
		// API-key rows keep the ordinary default (absent reads as api_key)
		for (const row of catalogProviders()) {
			if (row.id !== "openai-codex") assert.notEqual(row.authorization, "subscription", row.id);
		}
	});

	it("federates the known codex models with a static authorization_required state", () => {
		const { models } = modelCatalog();
		const codex = models.filter((m) => m.provider === "openai-codex");
		assert.ok(codex.length > 0, "known codex candidates stay visible while disconnected");
		for (const m of codex) {
			// Structural metadata only — the catalog is synchronous and never
			// claims the account is connected (status is its own endpoint).
			assert.equal(m.authorization, "subscription", m.id);
			assert.equal(m.availability, "authorization_required", m.id);
		}
		const luna = codex.find((m) => m.id === "gpt-6-luna");
		assert.ok(luna, "gpt-6-luna is a known codex candidate");
		assert.deepEqual(luna!.input, ["text", "image"]);
		// api-key rows carry no subscription metadata at all
		const glm = models.find((m) => m.provider === "openrouter")!;
		assert.equal(glm.authorization, undefined);
		assert.equal(glm.availability, undefined);
	});

	it("context limits include the chosen codex model (compaction denominator)", () => {
		assert.equal(catalogContextLimits().get("openai-codex:gpt-6-luna"), 272000);
	});

	it("structural settings writes accept a codex model without a live account grant", () => {
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openai-codex", id: "gpt-6-luna" } } }).ok,
			true,
		);
		assert.equal(
			validateChatSettings({ model: { provider: "openai-codex", id: "gpt-6-luna" } }).ok,
			true,
		);
	});

	it("the vision slot requires a REAL image-capable model (pi's input capabilities)", () => {
		const textOnly = validateModelsSettings({
			vision: { model: { provider: "openai-codex", id: "gpt-5.3-codex-spark" } },
		});
		assert.equal(textOnly.ok, false, "a text-only model cannot fill the vision slot");
		assert.equal(
			validateModelsSettings({ vision: { model: { provider: "openai-codex", id: "gpt-6-luna" } } }).ok,
			true,
		);
	});
});

describe("the models-section validation gate", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok,
			false,
		);
		assert.equal(
			validateModelsSettings({ vision: { model: { provider: "openrouter", id: "nope/nope" } } }).ok,
			false,
		);
	});

	it("thinking levels never reject a slot write (owner, interlude 2026-09-22)", () => {
		// clamp, never reject: the model swap with a pinned level JUST
		// WORKS — validation accepts ANY level; the WRITE clamps to the
		// new model's nearest supported and stores the clamped result.
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" } }),
			{ ok: true },
		);
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "xhigh" } }),
			{ ok: true },
		);
	});

	it("clampModelsLevels: the slot's own model translates the pin (the owner's exact case)", () => {
		// Claude Fable 5.1 xhigh → GLM 5.3 flash: the pin clamps to glm's
		// nearest supported (low|high|max) and the CLAMPED value is stored.
		const glm = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "xhigh" as const };
		assert.deepEqual(clampModelsLevels({ strong: glm }), {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "max" },
		});
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "minimal" as const } }).strong, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "low",
		});
		// glm cannot disable thinking: off clamps UP to low
		assert.equal(
			clampModelsLevels({ strong: { ...glm, thinkingLevel: "off" as const } }).strong?.thinkingLevel,
			"low",
		);
		// a supported level passes through untouched
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "high" as const } }).strong, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
		});
		// a slot with no level rides as-is (client populates on fresh
		// picks per DEFAULT_THINKING_ORDER — the server never invents one)
		assert.deepEqual(clampModelsLevels({ strong: { model: glm.model } }), {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
		});
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});
});

describe("the settings validation gate", () => {
	it("thinking levels never reject a chat write (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(
			validateChatSettings({ model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" }),
			{ ok: true },
		);
		assert.deepEqual(validateChatSettings({ thinkingLevel: "xhigh" }), { ok: true });
	});

	it("clampChatLevel: the body's model, else the strong slot, translates the pin", () => {
		const glm = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
		const strong: EffectiveSlot = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
		// the body's own model wins
		assert.deepEqual(
			clampChatLevel({ model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: "xhigh" as const }, strong),
			{ model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: clampThinkingLevel(qwenModel(), "xhigh") },
		);
		// no body model → the record's strong slot is the fallback
		assert.equal(clampChatLevel({ thinkingLevel: "xhigh" as const }, strong).thinkingLevel, "max");
		// no model anywhere → rides unchecked (runtime clamps; the turn
		// gate refuses the model-less chat anyway)
		assert.deepEqual(clampChatLevel({ thinkingLevel: "minimal" as const }, null), { thinkingLevel: "minimal" });
		// no pinned level → untouched
		assert.deepEqual(clampChatLevel({ model: { ...glm } }, strong), { model: { ...glm } });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "openrouter", id: "nope/nope" } }).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});
});

describe("pi thinking truth (pinned against pi-ai upgrades)", () => {
	it("glm-5.3-flash: low|high|max; anything else clamps to the nearest", () => {
		const glm = glmModel();
		assert.deepEqual(getSupportedThinkingLevels(glm), ["low", "high", "max"]);
		assert.equal(clampThinkingLevel(glm, "minimal"), "low");
		assert.equal(clampThinkingLevel(glm, "off"), "low", "GLM cannot disable thinking (map: off → null)");
		assert.equal(clampThinkingLevel(glm, "xhigh"), "max");
		assert.equal(clampThinkingLevel(glm, "high"), "high");
	});

	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "openrouter", id: "qwen/qwen3.8-flash", thinkingLevel: "high" });
		assert.equal(over.model.id, "qwen/qwen3.8-flash");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER (owner, 2026-09-22)", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		// glm supports low|high|max → first supported in the order is "low"
		const glm = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		assert.equal(glm.level, "low");
		// explicit levels never consult the order — pi clamps nearest
		assert.equal(piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "max" }).level, "max");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = piModels()
			.getProviders()
			.flatMap((p) => piModels().getModels(p.id))
			.find((m) => !m.reasoning);
		if (flat) {
			const engine = piEngineForSpec({ provider: flat.provider, id: flat.id });
			assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
			assert.equal(engine.level, "off");
		}
	});

	it("the legacy piEngineFor role entry point throws honestly (BYOK: no pins)", async () => {
		const { piEngineFor } = await import("../src/agent/models.ts");
		assert.throws(() => piEngineFor("prober"), /no configured model for role "prober"/);
	});
});

// Issue #8 repair B: the agent section's model OVERRIDES are a second write
// surface that feeds the same vision roles the vision slot feeds — the
// capability gate must live in ONE structural helper shared by the write and
// the role-execution resolver (a write-only fix would leave pre-existing
// records bypassing it).
describe("the agent-section model-override capability gate", () => {
	const spark = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
	const luna = { provider: "openai-codex", id: "gpt-6-luna" };

	it("rejects a text-only model in a writable image role (visualMaker)", () => {
		const verdict = validateAgentModelsSettings({ models: { visualMaker: { model: spark } } });
		assert.equal(verdict.ok, false, "a text-only model cannot fill an image role");
		if (!verdict.ok) {
			assert.match(verdict.error, /gpt-5\.3-codex-spark/);
			assert.match(verdict.error, /text only/);
			assert.match(verdict.error, /image-capable/);
		}
	});

	it("accepts an image-capable model in the same role", () => {
		assert.equal(validateAgentModelsSettings({ models: { visualMaker: { model: luna } } }).ok, true);
	});

	it("does NOT ban text-only models outside the image roles", () => {
		assert.equal(validateAgentModelsSettings({ models: { researcher: { model: spark } } }).ok, true);
		assert.equal(validateAgentModelsSettings({ models: { extractor: { model: spark } } }).ok, true);
		assert.equal(validateAgentModelsSettings({ models: { auditor: { model: spark } } }).ok, true);
	});

	it("still requires the model to exist in the catalog (structural, no key/entitlement)", () => {
		const missing = validateAgentModelsSettings({
			models: { visualMaker: { model: { provider: "openrouter", id: "nope/nope" } } },
		});
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.match(missing.error, /No model "nope\/nope" in the openrouter catalog/);
		// A bare thinkingLevel names no model — nothing to check structurally.
		assert.equal(validateAgentModelsSettings({ models: { visualMaker: { thinkingLevel: "high" } } }).ok, true);
	});

	it("names exactly the roles whose engines send image content", () => {
		assert.equal(roleNeedsImageInput("visualMaker"), true);
		assert.equal(roleNeedsImageInput("pdfReader"), true);
		assert.equal(roleNeedsImageInput("researcher"), false);
		assert.equal(roleNeedsImageInput("teacher"), false);
	});

	it("the runtime gate refuses a text-only RESOLVED spec for an image role only", () => {
		assert.equal(roleModelCapabilityError("researcher", spark), null);
		assert.equal(roleModelCapabilityError("visualMaker", luna), null);
		const refusal = roleModelCapabilityError("visualMaker", spark);
		assert.ok(refusal, "a text-only visualMaker spec must be refused");
		assert.match(refusal, /text only/);
		assert.match(refusal, /image-capable/);
		assert.ok(roleModelCapabilityError("pdfReader", spark));
	});
});