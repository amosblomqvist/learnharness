/**
 * The model catalog's server surface (model-control wave, 2026-09-12;
 * federated since the model-slots wave, 2026-09-20): pi-ai's catalog for
 * every KEYED provider, projected to client-safe DTOs for the picker (GET
 * /api/models), plus the validation gate for settings writes (PUT
 * /api/settings/* — the per-chat settings PUT is retired from the UI;
 * legacy records' per-chat overrides still resolve server-side).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Federation: `getModels()` is called per keyed provider (federated, the
 * model-slots wave), so a provider appears in the picker exactly when its
 * key is present — piModels() in src/agent/models.ts owns the provider
 * set; nothing here changes.
 */

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { piModels, type ResolvedModelSpec } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { SUBSCRIPTION_PROVIDER } from "../core/subscription.ts";
import { effectiveSettings } from "./stores.ts";
import { keyValue, providerAuthorization } from "./keys.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type {
	CatalogDefaults,
	CatalogProvider,
	ModelCatalogEntry,
	ModelCatalogResponse,
	RolePins,
	SlotPins,
} from "../core/contracts/models.ts";
import type { EffectiveModelSpec, EffectiveSlot } from "../core/settings-resolution.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import {
	BACKGROUND_MODEL_ROLES,
	MODEL_SLOTS,
	type AgentSettings,
	type BackgroundModelRole,
	type ModelSlotName,
	type ModelsSettings,
} from "../core/settings.ts";
import type { ModelRole } from "../../config.ts";

/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;

/**
 * The conversation agents' resolved default (pure form — the strong slot
 * in, CatalogDefaults out; `catalogDefaults()` below is the fs wrapper).
 * PER-SESSION MODELS (owner, 2026-09-28): every session owns its model +
 * thinking level from birth, stamped verbatim from the strong slot — the
 * STRONG SLOT IS THE NEW-SESSION DEFAULT, and the resolve-time fallback
 * for legacy settings-less records. BYOK (owner, 2026-09-22): there is no
 * factory floor — when the strong slot names no model, the default is
 * NULL and the turn gate refuses with the 503 models_not_configured
 * envelope. An unset thinkingLevel resolves from DEFAULT_THINKING_ORDER at
 * engine build (reported as absent here).
 */
export function catalogDefaultsFor(
	strong: EffectiveSlot | null,
): CatalogDefaults | null {
	const model = strong ? { provider: strong.provider, id: strong.id } : undefined;
	if (!model) return null;
	const level = strong?.thinkingLevel;
	return {
		model,
		...(level !== undefined ? { thinkingLevel: level } : {}),
	};
}

/** The conversation agents' resolved default — what a settings-less chat
 *  runs: the strong slot, i.e. the birth-default for new sessions. */
export function catalogDefaults(): CatalogDefaults | null {
	return catalogDefaultsFor(effectiveSettings().models.strong);
}

/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this).
 *  BYOK (owner, 2026-09-22): an empty chain projects to NULL — the caption
 *  honestly shows "not configured", never a phantom default. */
export function rolePinsFor(
	models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>,
): RolePins {
	const pins = {} as RolePins;
	for (const role of BACKGROUND_MODEL_ROLES) {
		const spec = models[role];
		pins[role] = spec
			? {
					model: { provider: spec.provider, id: spec.id },
					...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/** The background roles' RESOLVED pins: the user's agent-models
 *  override → tier slot → nothing — the same resolution the agent wiring
 *  uses (src/server/stores.ts effectiveSettings), so the caption can
 *  never drift from what actually runs. */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/** The three slot tiers' RESOLVED pins — effectiveSettings().models
 *  verbatim: the same resolution the engine wiring uses, so the Models
 *  settings page's captions cannot drift from what actually runs. NULL
 *  per tier that holds no model. */
export function catalogSlots(): SlotPins {
	const slots = effectiveSettings().models;
	const pins = {} as SlotPins;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot: EffectiveSlot | null = slots[name];
		pins[name] = slot
			? {
					model: { provider: slot.provider, id: slot.id },
					...(slot.thinkingLevel !== undefined ? { thinkingLevel: slot.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker.
 *
 *  SUBSCRIPTION SOURCE (issue #8): the supplier subscription provider is a
 *  KNOWN row with no env key at all — envVar null (never a fictitious
 *  name), keyPresent false (presence is not an authorization fact here),
 *  authorization "subscription". Its availability is reported by the
 *  subscription status surface, never inferred from this row. */
export function catalogProviders(): CatalogProvider[] {
	const rows: CatalogProvider[] = AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: keyValue(p.envVar) !== undefined,
		authorization: "api_key",
	}));
	rows.push({
		id: SUBSCRIPTION_PROVIDER,
		envVar: null,
		keyPresent: false,
		authorization: "subscription",
	});
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** The providers whose key is present — the picker federates exactly
 *  these (a keyless API-key provider's models are unreachable by design;
 *  the Keys page is the discovery surface, same discipline as search). */
function keyedProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
}

/** Subscription-source providers are federated even while disconnected:
 *  their models are KNOWN candidates (authorization_required), so a saved
 *  pin survives a disconnect and the picker never hides it. */
function subscriptionProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => providerAuthorization(p.id) === "subscription").map((p) => p.id));
}

/** The providers the picker federates: present API keys ∪ subscription
 *  sources (same set the context-limits index reads). */
function federatedProviderIds(): Set<string> {
	return new Set([...keyedProviderIds(), ...subscriptionProviderIds()]);
}

/** Project one catalog model to the client DTO. `subscription` stamps the
 *  static source metadata (authorization + authorization_required); the
 *  live grant state is the subscription status surface's business. */
export function toModelDto(model: Model<Api>, subscription = false): ModelDto {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(subscription ? { authorization: "subscription" as const, availability: "authorization_required" as const } : {}),
	};
}

/** The live-limits index (context-meter amendment, owner 2026-09-23):
 *  provider:id → contextWindow from pi's catalog, over the SAME keyed
 *  providers the picker federates. The one source for every context
 *  meter's denominator — the stats-bar join holds /api/models' copy,
 *  and the activity feed (observability.ts) resolves job limits
 *  server-side through this. No hardcoded fallback exists anywhere:
 *  a model missing here reads limit-null (usage-only, honest render). */
export function catalogContextLimits(): Map<string, number> {
	const federated = federatedProviderIds();
	const index = new Map<string, number>();
	for (const provider of piModels().getProviders()) {
		if (!federated.has(provider.id)) continue;
		for (const model of piModels().getModels(provider.id)) {
			index.set(`${provider.id}:${model.id}`, model.contextWindow);
		}
	}
	return index;
}

/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
export function modelCatalog(): ModelCatalogResponse {
	const federated = federatedProviderIds();
	const subscription = subscriptionProviderIds();
	const models = piModels()
		.getProviders()
		.filter((p) => federated.has(p.id))
		.flatMap((p) => piModels().getModels(p.id).map((m) => toModelDto(m, subscription.has(p.id))))
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
	return {
		models,
		defaults: catalogDefaults(),
		rolePins: catalogRolePins(),
		slots: catalogSlots(),
		providers: catalogProviders(),
	};
}

/** One validated outcome for a settings write. */
export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string; supported?: ThinkingLevel[] };

/** Validate a picker write against the catalog (the settings route's gate).
 *  `settings` is replace-whole: absent fields mean "config default".
 *  - model: provider must be configured, id must exist in its catalog.
 *  - thinkingLevel: must be in the resolved model's supported list —
 *    the model the picker writes against (settings.model, else config's
 *    prober/teacher pin; one controller, so the two specs share it). */
export function validateChatSettings(settings: ChatSettings): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (settings.model) {
		const { provider, id } = settings.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!piModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	// BYOK interlude (owner, 2026-09-22): thinking levels NEVER reject a
	// write — a model swap with a pinned level JUST WORKS. The WRITE clamps
	// the pin to the new model's nearest supported level (clampChatLevel
	// below, applied by the routes) and stores the clamped result; a bare
	// level with no model anywhere rides unchecked and clamps against
	// whatever the chain later holds at engine build.
	return { ok: true };
}

export function validateModelsSettings(settings: ModelsSettings): SettingsValidation {
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot) continue;
		const verdict = validateSlotSpec(name, slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

// ─── shared image-capability gate (issue #8 repair B) ────────────────────────
// The vision SLOT and the ROLE OVERRIDES are two write surfaces that feed the
// same background roles, and the role resolver is a third reader of the same
// truth. One structural check, three callers — a write-only fix would still
// let a pre-existing record (or a recovered/dispatched job) run.

/** The roles whose engines send image content parts: the visual maker
 *  authors/renders figures and the PDF reader reads rendered pages. */
const IMAGE_INPUT_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>(["visualMaker", "pdfReader"]);

export function roleNeedsImageInput(role: ModelRole): boolean {
	return IMAGE_INPUT_ROLES.has(role);
}

/** Structural catalog verdict for one provider+model pair (unknown provider
 *  / unknown model), or null when the pair exists. */
function catalogModelError(provider: string, id: string): string | null {
	const providers = piModels().getProviders().map((p) => p.id);
	if (!providers.includes(provider)) {
		return `Unknown provider "${provider}" — configured: ${providers.join(", ")}`;
	}
	if (!piModels().getModel(provider, id)) {
		return `No model "${id}" in the ${provider} catalog`;
	}
	return null;
}

/** The ONE image-capability verdict: null when the model accepts image input,
 *  otherwise the user-facing reason. `consumer` selects the wording — the
 *  vision slot keeps its historical message verbatim (other surfaces already
 *  assert it). Structural only: no key, login or entitlement is consulted. */
export function imageCapabilityError(
	provider: string,
	id: string,
	consumer: "vision slot" | ModelRole,
): string | null {
	const model = piModels().getModel(provider, id);
	if (!model || model.input.includes("image")) return null;
	const label = consumer === "vision slot" ? "vision slot" : `${consumer} role`;
	return `Model "${id}" accepts text only — the ${label} needs an image-capable model`;
}

/** The agent-section write gate: every model override must exist in the
 *  catalog and — for the image roles — accept image input. Only writable
 *  background roles are checked (pdfReader is not writable; its slot is
 *  covered by the vision gate and by the runtime role check). */
export function validateAgentModelsSettings(settings: AgentSettings): SettingsValidation {
	for (const role of BACKGROUND_MODEL_ROLES) {
		const model = settings.models?.[role]?.model;
		if (!model) continue;
		const structural = catalogModelError(model.provider, model.id);
		if (structural) return { ok: false, error: structural };
		if (!roleNeedsImageInput(role)) continue;
		const refusal = imageCapabilityError(model.provider, model.id, role);
		if (refusal) return { ok: false, error: refusal };
	}
	return { ok: true };
}

/** The ROLE-EXECUTION verdict (issue #8 repair B): a resolved spec for an
 *  image role must name an image-capable model. Called by the chat-handler's
 *  role resolver BEFORE any engine build or provider request, so a
 *  pre-existing invalid record is refused instead of executed; the refusal
 *  flows into the existing per-need "no model configured" path (never a
 *  silent fallback to a neighboring model). */
export function roleModelCapabilityError(role: ModelRole, spec: ResolvedModelSpec): string | null {
	if (!roleNeedsImageInput(role)) return null;
	const structural = catalogModelError(spec.provider, spec.id);
	if (structural) return structural;
	return imageCapabilityError(spec.provider, spec.id, role);
}

function validateSlotSpec(name: ModelSlotName, slot: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		const model = piModels().getModel(provider, id);
		if (!model) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
		// CAPABILITY gate (subscription wave, issue #8; shared since repair B):
		// the vision slot feeds visual-maker and pdf-reader, both of which send
		// image content parts. pi's real `input` capabilities are the truth — a
		// text-only model would fail mid-run, so the structural write rejects
		// it instead. This is the SAME helper the role overrides (agent
		// section) and the role-execution resolver use, so the write and the
		// runtime cannot disagree. Purely structural: it says nothing about
		// live account authorization.
		if (name === "vision") {
			const refusal = imageCapabilityError(provider, id, "vision slot");
			if (refusal) return { ok: false, error: refusal };
		}
	}
	// BYOK interlude (owner, 2026-09-22): the supported-level verdict is
	// DEAD — a slot write with a pinned level never rejects; the WRITE
	// clamps the level to the model's nearest supported (clampModelsLevels
	// below, applied by the route) and stores the clamped result.
	return { ok: true };
}

// ─── clamp-on-write (owner ruling, interlude 2026-09-22) ─────────────────────
// A model swap with a pinned thinking level must JUST WORK: the pin
// translates to the new model's nearest supported level — pi's
// clampThinkingLevel, the SAME translation piEngineForSpec applies at
// runtime — and the clamped value is what lands in the record. The
// server is the truth: the record shows the clamped level after write.

/** Clamp one level against one model (identity when the model is unknown
 *  or the level already supported — the existence gate rejects unknown
 *  models separately, so this only ever sees real ones in practice). */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = piModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/** The models-section write's level translation: every slot's pinned
 *  thinkingLevel clamps against THE SLOT'S OWN model (the parser requires
 *  a model on every slot write — owner, 2026-09-22). Pure: catalog in,
 *  clamped section out; the route applies it after validation. */
export function clampModelsLevels(settings: ModelsSettings): ModelsSettings {
	const out: ModelsSettings = {};
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot?.model) continue;
		out[name] =
			slot.thinkingLevel !== undefined
				? {
						model: slot.model,
						thinkingLevel: clampLevelFor(slot.model.provider, slot.model.id, slot.thinkingLevel),
					}
				: slot;
	}
	return out;
}

/** The chat-section write's level translation: a pinned thinkingLevel
 *  clamps against the body's own model, else the record's resolved strong
 *  slot (the conversation chain's fallback — what a settings-less chat
 *  would run). No model anywhere → rides unchecked (runtime clamps at
 *  engine build; the turn gate refuses the model-less chat anyway). */
export function clampChatLevel(settings: ChatSettings, strong: EffectiveSlot | null): ChatSettings {
	if (settings.thinkingLevel === undefined) return settings;
	const provider = settings.model?.provider ?? strong?.provider;
	const id = settings.model?.id ?? strong?.id;
	if (!provider || !id) return settings;
	return { ...settings, thinkingLevel: clampLevelFor(provider, id, settings.thinkingLevel) };
}
