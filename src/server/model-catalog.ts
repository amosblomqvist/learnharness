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
 *
 * Live OpenRouter supplement (new-model wave, 2026-11-17): pi-ai ships a
 * GENERATED OpenRouter snapshot, so models released after that generation
 * are absent until the app upgrades pi-ai. When the key is present this
 * module also fetches OpenRouter's live `GET /models`, adds only ids the
 * shipped snapshot does not carry (curated rows always win), and
 * re-registers the provider in piModels() so the picker, settings
 * validation, and engine resolution all see them. Cached and best-effort:
 * a failed or slow refresh leaves the shipped catalog untouched.
 */

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openRouterCost, type OpenRouterModel } from "@earendil-works/pi-ai/providers/openrouter-api";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { piModels } from "../agent/models.ts";
import { customProviderAvailable } from "./custom-provider.ts";
import { chatGPTConnected, chatGPTModel, chatGPTModels, refreshChatGPTModels } from "../agent/chatgpt-bridge.ts";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionModel, nativeSubscriptionModels, refreshSubscriptionModels } from "../agent/subscription-bridge.ts";

export async function refreshConnectionCatalog(provider?: string): Promise<void> {
	await Promise.all([
		!provider || provider === "chatgpt" ? refreshChatGPTModels(piModels().getModels("openai").filter((m): m is Model<"openai-responses"> => m.api === "openai-responses")) : Promise.resolve(),
		!provider || nativeSubscriptionId(provider) ? refreshSubscriptionModels() : Promise.resolve(),
		!provider || provider === OPENROUTER_PROVIDER_ID ? refreshOpenRouterCatalog() : Promise.resolve(),
	]);
}

// ─── live OpenRouter catalog supplement ──────────────────────────────────────
// pi-ai's OpenRouter rows are generated from `GET /models` at release time
// (dist/providers/data/openrouter.json). A model released after that snapshot
// is invisible to the picker, and pi-ai's own refresh hook only FILTERS the
// shipped rows by `/models/user` — it never adds one. This supplement closes
// that gap for the one provider whose catalog moves fastest.

const OPENROUTER_PROVIDER_ID = "openrouter";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** The chat endpoint; rows that do not serve it are image/classifier-only. */
const OPENROUTER_CHAT_ENDPOINT = "/api/v1/chat/completions";
const OPENROUTER_MODELS_TIMEOUT_MS = 10_000;
/** New models are not urgent; one fetch per half hour is plenty. */
const OPENROUTER_MODELS_TTL_MS = 30 * 60_000;
/** pi's generated rows use 4096 when OpenRouter omits a completion cap. */
const OPENROUTER_FALLBACK_MAX_TOKENS = 4096;
const OPENROUTER_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type OpenRouterEffort = (typeof OPENROUTER_THINKING_LEVELS)[number];

/** The extra fields of an OpenRouter row that pi's generator consumes. */
interface OpenRouterCatalogRow extends OpenRouterModel {
	name?: string;
	architecture?: { input_modalities?: readonly string[]; output_modalities?: readonly string[] };
	reasoning?: { mandatory?: boolean; supported_efforts?: readonly string[] };
	supported_parameters?: readonly string[];
	endpoints?: readonly string[];
}

let liveOpenRouterRows: readonly OpenRouterCatalogRow[] = [];
let appliedLiveOpenRouterRows: readonly OpenRouterCatalogRow[] | undefined;
let openRouterFetchedAt = 0;
let openRouterRefresh: Promise<void> | undefined;

/** Project one live row to a pi-ai chat model, or undefined when the row is
 *  not chat-callable (image/classifier rows) or has no usable context. The
 *  mapping mirrors pi's generated rows: the OpenRouter thinking format maps
 *  efforts one-to-one, `off` is only offered when reasoning is optional, and
 *  prices reuse pi's own $/token → $/1M conversion (tiers included). */
export function openRouterModelFromApi(row: OpenRouterCatalogRow): Model<"openai-completions"> | undefined {
	if (!row.id || !(row.endpoints ?? []).includes(OPENROUTER_CHAT_ENDPOINT)) return undefined;
	if (!(row.architecture?.output_modalities ?? ["text"]).includes("text")) return undefined;
	const contextWindow = row.top_provider?.context_length || row.context_length || 0;
	if (!contextWindow) return undefined;
	const efforts = new Set(
		(row.reasoning?.supported_efforts ?? []).filter(
			(effort): effort is OpenRouterEffort => (OPENROUTER_THINKING_LEVELS as readonly string[]).includes(effort),
		),
	);
	const reasoning = efforts.size > 0 || (row.supported_parameters ?? []).some((param) => param === "reasoning" || param === "reasoning_effort");
	const input: ("text" | "image")[] = (row.architecture?.input_modalities ?? []).includes("image") ? ["text", "image"] : ["text"];
	return {
		type: "chat",
		id: row.id,
		name: row.name?.trim() || row.id,
		api: "openai-completions",
		provider: OPENROUTER_PROVIDER_ID,
		baseUrl: OPENROUTER_BASE_URL,
		reasoning,
		// Known efforts get pi's full map; models that only advertise reasoning
		// without effort metadata keep the provider defaults (map omitted), the
		// same shape pi's generator emits.
		...(efforts.size > 0
			? {
					thinkingLevelMap: {
						off: row.reasoning?.mandatory === false ? "none" : null,
						minimal: efforts.has("minimal") ? "minimal" : null,
						low: efforts.has("low") ? "low" : null,
						medium: efforts.has("medium") ? "medium" : null,
						high: efforts.has("high") ? "high" : null,
						xhigh: efforts.has("xhigh") ? "xhigh" : null,
						max: efforts.has("max") ? "max" : null,
					},
				}
			: {}),
		input,
		cost: openRouterCost(row.pricing),
		contextWindow,
		maxTokens: row.top_provider?.max_completion_tokens || OPENROUTER_FALLBACK_MAX_TOKENS,
	};
}

/** Merge live rows into the shipped chat catalog, adding only unknown ids:
 *  curated pi-ai metadata and prices for known models always win.
 *  `knownIds` covers shipped rows of OTHER types too (an image-generation
 *  id must not gain a chat twin); it defaults to the chat base's ids. */
export function mergeOpenRouterCatalog(
	base: readonly Model<Api>[],
	rows: readonly OpenRouterCatalogRow[],
	knownIds: ReadonlySet<string> = new Set(base.map((model) => model.id)),
): Model<Api>[] {
	const seen = new Set(knownIds);
	const merged = [...base];
	for (const row of rows) {
		const model = openRouterModelFromApi(row);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		merged.push(model);
	}
	return merged;
}

/** Re-register the OpenRouter provider with the shipped rows plus any live
 *  additions. The wrapper keeps pi-ai's auth, APIs, OAuth, and catalog rows;
 *  it only widens the two model getters. */
function applyLiveOpenRouterCatalog(): void {
	if (liveOpenRouterRows.length === 0 || appliedLiveOpenRouterRows === liveOpenRouterRows) return;
	appliedLiveOpenRouterRows = liveOpenRouterRows;
	const base = openrouterProvider();
	const baseChat = base.getModels();
	const baseAll = base.getAllModels?.() ?? baseChat;
	// A shipped id may already exist as another type (image-generation rows
	// also advertise the chat endpoint); never mint a chat twin for it.
	const mergedChat = mergeOpenRouterCatalog(baseChat, liveOpenRouterRows, new Set(baseAll.map((model) => model.id)));
	if (mergedChat.length === baseChat.length) return;
	const mergedAll = [...baseAll, ...mergedChat.slice(baseChat.length)];
	const provider: Provider<Api> = {
		...base,
		getModels: () => mergedChat,
		getAllModels: () => mergedAll,
	};
	piModels().setProvider(provider);
}

/** Fetch and validate OpenRouter's live model list. Throws on transport,
 *  HTTP, and shape failures; the caller degrades to the shipped catalog. */
async function fetchOpenRouterCatalog(signal: AbortSignal): Promise<OpenRouterCatalogRow[]> {
	const key = keyValue("OPENROUTER_API_KEY");
	if (!key) return [];
	const response = await fetch(OPENROUTER_MODELS_URL, {
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`OpenRouter model list request failed: ${response.status}`);
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		throw new Error("Invalid OpenRouter model list response");
	}
	return body.data.filter(
		(row): row is OpenRouterCatalogRow => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string",
	);
}

/** Refresh the live OpenRouter rows (TTL-cached unless `force`). Best-effort:
 *  a failed refresh keeps the last good rows, and never fails the request.
 *  Exported so the settings surface (and focused tests) can force one. */
export async function refreshOpenRouterCatalog(options: { force?: boolean } = {}): Promise<void> {
	if (!keyValue("OPENROUTER_API_KEY")) return;
	if (!options.force && Date.now() - openRouterFetchedAt < OPENROUTER_MODELS_TTL_MS) {
		applyLiveOpenRouterCatalog();
		return;
	}
	openRouterRefresh ??= (async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), OPENROUTER_MODELS_TIMEOUT_MS);
		try {
			liveOpenRouterRows = await fetchOpenRouterCatalog(controller.signal);
		} catch {
			// Enhancement, not a dependency: keep the shipped/last-good catalog.
		} finally {
			clearTimeout(timer);
			// Failures also age out, so an offline app does not refetch per request.
			openRouterFetchedAt = Date.now();
			openRouterRefresh = undefined;
		}
		applyLiveOpenRouterCatalog();
	})();
	await openRouterRefresh;
}
function connectionModel(provider: string, id: string): Model<Api> | undefined {
	if (provider === CLAUDE_CODE_PROVIDER && !claudeCodeAvailable()) return undefined;
	return provider === "chatgpt" ? chatGPTModel(id) : nativeSubscriptionId(provider) ? nativeSubscriptionModel(provider, id) : piModels().getModel(provider, id);
}
function connectionProviderIds(): string[] { return [...piModels().getProviders().map((p) => p.id), "chatgpt", ...NATIVE_SUBSCRIPTIONS.map((p) => p.logicalId)]; }
import { settingsStore } from "../store/settings.ts";
import { effectiveSettings } from "./stores.ts";
import { keyValue } from "./keys.ts";
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
import { AUTH_PROVIDER_KEYS, CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { claudeCodeAvailable } from "./claude-code-config.ts";
import { CLAUDE_CODE_PROVIDER } from "../agent/claude-code/constants.ts";
import {
	BACKGROUND_MODEL_ROLES,
	MODEL_SLOTS,
	customProviderUsable,
	type BackgroundModelRole,
	type ModelSlotName,
	type ModelsSettings,
} from "../core/settings.ts";

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
					...(slot.cacheRetention !== undefined ? { cacheRetention: slot.cacheRetention } : {}),
				}
			: null;
	}
	return pins;
}

/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker. */
export function catalogProviders(): CatalogProvider[] {
	piModels();
	return AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: keyValue(p.envVar) !== undefined,
	})).concat([
		{ id: "chatgpt", envVar: "", keyPresent: chatGPTConnected() },
		{ id: CLAUDE_CODE_PROVIDER, envVar: "", keyPresent: claudeCodeAvailable() },
		...NATIVE_SUBSCRIPTIONS.map((p) => ({ id: p.logicalId, envVar: "", keyPresent: nativeSubscriptionConnected(p.providerId) })),
		// The custom endpoint: a row only when usable (base URL set). keyPresent
		// reflects usability, not key presence (keyless local servers are allowed).
		...(customProviderUsable(effectiveSettings().customProvider)
			? [{ id: CUSTOM_PROVIDER.id, envVar: CUSTOM_PROVIDER.envVar, keyPresent: customProviderAvailable() }]
			: []),
	]).sort((a, b) => a.id.localeCompare(b.id));
}

/** The providers whose key is present — the picker federates exactly
 *  these (a keyless provider's models are unreachable by design; the
 *  Keys page is the discovery surface, same discipline as search). */
function keyedProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
}

/** Project one catalog model to the client DTO. */
export function toModelDto(model: Model<Api>): ModelDto {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost: model.provider === CLAUDE_CODE_PROVIDER || model.provider === CUSTOM_PROVIDER.id ? null : {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.provider === CLAUDE_CODE_PROVIDER ? null : model.contextWindow,
		maxTokens: model.provider === CLAUDE_CODE_PROVIDER ? null : model.maxTokens,
	};
}

/** The live-limits index (context-meter amendment, owner 2026-09-23):
 *  provider:id → contextWindow from pi's catalog, over the SAME keyed
 *  providers the picker federates. Native CLI aliases are excluded:
 *  only a session-specific CLI report can provide their denominator.
 *  For other models the stats-bar join holds /api/models' copy,
 *  and the activity feed (observability.ts) resolves job limits
 *  server-side through this. No hardcoded fallback exists anywhere:
 *  a model missing here reads limit-null (usage-only, honest render). */
export function catalogContextLimits(): Map<string, number> {
	const keyed = keyedProviderIds();
	const index = new Map<string, number>();
	for (const provider of piModels().getProviders()) {
		if (!keyed.has(provider.id) || provider.id === CLAUDE_CODE_PROVIDER) continue;
		for (const model of piModels().getModels(provider.id)) {
			index.set(`${provider.id}:${model.id}`, model.contextWindow);
		}
	}
	for (const model of [...chatGPTModels(), ...nativeSubscriptionModels()]) index.set(`${model.provider}:${model.id}`, model.contextWindow);
	return index;
}

/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
export function modelCatalog(): ModelCatalogResponse {
	const keyed = keyedProviderIds();
	const models = piModels()
		.getProviders()
		.filter((p) => keyed.has(p.id))
		.flatMap((p) => piModels().getModels(p.id))
		.map(toModelDto)
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)))
		.concat([...chatGPTModels(), ...nativeSubscriptionModels()].map(toModelDto));
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
	const providers = connectionProviderIds();
	if (settings.model) {
		const { provider, id } = settings.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!connectionModel(provider, id)) {
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

/** Validate introduced/replaced model selections, not unchanged saved pins.
 * A disconnected subscription loses its available catalog, but its stored
 * selections must not prevent repairing another slot or editing thinking.
 * Only the SAME slot's provider+id can pass through; runtime admission stays
 * separate. Callers without a stored section retain strict catalog checking. */
export function validateModelsSettings(settings: ModelsSettings, stored?: ModelsSettings): SettingsValidation {
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot) continue;
		const previous = stored?.[name]?.model;
		if (slot.model && previous && slot.model.provider === previous.provider && slot.model.id === previous.id) continue;
		const verdict = validateSlotSpec(name, slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function validateSlotSpec(name: ModelSlotName, slot: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }): SettingsValidation {
	const providers = connectionProviderIds();
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!connectionModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
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

/** Clamp one level against one model. Preserve the preference when metadata
 *  is unavailable for an unchanged saved pin; runtime clamps after reconnect. */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = connectionModel(provider, id);
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
						...slot,
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
