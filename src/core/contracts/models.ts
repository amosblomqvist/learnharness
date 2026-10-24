/**
 * Model-catalog contracts (model-control wave, 2026-09-12) — the client-safe
 * shapes of GET /api/models and PUT /api/chats/[id]/settings responses.
 * Pure types; the server projection lives in src/server/model-catalog.ts
 * (which OWNS these shapes — the contract is defined here only so client
 * components never import from the server band).
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BackgroundModelRole, ModelSlotName } from "../settings.ts";

/** One picker row: everything the UI shows about a model, projected from
 *  pi-ai's catalog. Costs are USD per 1M tokens (the same catalog, the same
 *  units as Pi's server-side pricing calculator). */
export interface ModelCatalogEntry {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** The thinking levels this model actually accepts (pi's
	 * thinkingLevelMap — e.g. GLM-5.3-flash: low|high|max). The thinking
	 * picker lists exactly these; anything else is a lie. */
	supportedLevels: ThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** The conversation agents' resolved default (BYOK, owner 2026-09-22): the
 *  chat's model override over the STRONG slot — one controller, so one
 *  default. thinkingLevel is optional: unset resolves from the baked
 *  DEFAULT_THINKING_ORDER at engine build. */
export interface CatalogDefaults {
	model: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

/** One background role's RESOLVED pin (BYOK, owner 2026-09-22): what that
 *  role actually runs today — role override → tier slot → NOTHING. NULL
 *  = the role's chain is empty (the per-need gates refuse its work); the
 *  settings UI shows "not configured" from it. */
export type RolePins = Record<
	BackgroundModelRole,
	{ model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null
>;

/** One slot tier's RESOLVED pin (BYOK, owner 2026-09-22): NULL = the tier
 *  holds no model. The settings UI captions each slot row with it and the
 *  picker pre-fills from it. */
export type SlotPins = Record<
	ModelSlotName,
	{ model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null
>;

/** GET /api/models response. */
export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	/** The conversation agents' resolved default — NULL when the
	 *  conversation chain is empty (no factory floor; the turn gate
	 *  refuses with 503 models_not_configured). */
	defaults: CatalogDefaults | null;
	/** The six background roles' resolved pins (same resolution the agent
	 *  factories use — src/server/stores.ts effectiveSettings); NULL per
	 *  role = chain empty. */
	rolePins: RolePins;
	/** The three slot tiers' resolved pins: role override → slot at tier
	 *  granularity; effectiveSettings().models verbatim, NULL per unset
	 *  tier. */
	slots: SlotPins;
	/** Providers with a PRESENT key, and which env var gates each — the
	 *  model slots wave's federation surface (2026-09-20): the picker lists
	 *  models from these providers' pi-ai catalogs only. Keyless providers
	 *  are simply absent (the Keys page is the discovery surface, same
	 *  discipline as the search engines). */
	providers: CatalogProvider[];
}

/** One row of the providers surface. */
export interface CatalogProvider {
	id: string;
	/** The env var whose presence federates this provider in. */
	envVar: string;
	/** Whether that var is currently present (env or auth file). */
	keyPresent: boolean;
}