/**
 * THE USER SETTINGS RECORD's shape + sanitizer (settings-storage wave,
 * 2026-09-19): one versioned, DELTA-shaped record at the data-dir seam
 * (config.SETTINGS_FILE) holding every non-secret product preference.
 *
 * DELTA SEMANTICS (owner decision, 2026-09-19): the record stores EXPLICIT
 * user choices only — ABSENT keys resolve to the factory defaults compiled
 * into this module (FACTORY_SETTINGS). MODELS are the exception (owner,
 * 2026-09-22 — BYOK all the way down): no factory pins exist, so an absent
 * model key resolves to EMPTY and the per-need gates refuse honestly. A
 * software update that ADDS a knob (new
 * tool, new role, new appearance field) therefore needs no migration: old
 * records simply lack the new keys. `version` is a PRIVATE schema counter
 * for BREAKING shape changes only (field renamed / meaning changed) —
 * unrelated to the app release version. Migrations live in the adapter
 * (src/store/settings.ts), not here.
 *
 * Sanitizer contract (mirrors render-settings.ts discipline): whatever
 * arrives from disk or the network passes through sanitizeUserSettings
 * before use — never trusted raw. Strict on known fields, PRESERVES
 * unknown keys verbatim (a newer record must never be destroyed by an
 * older app reading it). Invalid known values degrade gracefully:
 * out-of-range numbers CLAMP, wrong-typed/invalid fields DROP (resolve to
 * factory default), never throw.
 *
 * Browser-safe: pure logic + types only, no node imports. The resolved
 * (fully concrete) view lives in settings-resolution.ts.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
import { CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";
import { isDictationLanguage, type DictationLanguage } from "./dictation.ts";

/** The schema version this code understands. Bump ONLY for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;

/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair (prober/teacher) stays out — chat-controlled via
 *  the strong slot (one controller, the model picker). Tests pin the set. */
export const BACKGROUND_MODEL_ROLES = [
	"researcher",
	"demoBuilder",
	"visualMaker",
	"extractor",
	"auditor",
] as const;

export type BackgroundModelRole = (typeof BACKGROUND_MODEL_ROLES)[number];

/** A per-role model/thinking override — every field independent (absent
 *  field = that aspect falls back to config.ts's pin for the role). */
export interface RoleModelOverride {
	/** The model swap: both coordinates or neither (mirrors ChatSettings.model). */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

// ─── Model slots (model slots wave, 2026-09-20) ──────────────────────────────

/** The capability tiers a user can pin models into (owner-settled mapping):
 *  strong = prober + teacher (also the per-session default-teacher
 *  starting point); cheap = researcher, demo-builder, extractor, auditor,
; vision = visual-maker + pdf-reader. Resolution per role:
 *  ROLE OVERRIDE → slot → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** The DEFAULT thinking level for UNSET levels only (owner, 2026-09-22):
 *  a slot/override/chat that names a model but no thinking level resolves
 *  to the FIRST entry in this order that the model supports
 *  (getSupportedThinkingLevels); a non-reasoning model resolves "off"
 *  regardless (pi reports exactly ["off"]). EXPLICITLY set levels never
 *  consult this list — they clamp nearest via pi's native
 *  clampThinkingLevel on model switches.
 *
 *  Client surface (interlude, 2026-09-22): this constant lives in the CORE
 *  BARREL — the UI imports it to auto-populate a thinking level on a FRESH
 *  model pick (one source of truth, AUTH_KEYS precedent; per-model
 *  supportedLevels already reach the client via the catalog). The ordering
 *  has NO other client role: legacy unset records keep the runtime
 *  defaultThinkingLevel fallback at engine build. */
export const DEFAULT_THINKING_ORDER = [
	"medium",
	"low",
	"high",
	"minimal",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** The machine-readable NOT-CONFIGURED refusal envelope (owner, 2026-09-22):
 *  every per-need gate — the turn gate in chat-handler, a job spawn, a
 *  notes import — refuses with this exact shape. HTTP callers get 503 +
 *  this JSON; in-band consumers (the job record's error field) carry the
 *  human `error` line. `missing` names the slot TIER(S) the refused
 *  action needs and found unset. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured" as const;
export interface ModelsNotConfigured {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof MODELS_NOT_CONFIGURED_CODE;
	/** Which slot tiers the refused action needs ("strong" | "cheap" | "vision"). */
	missing: ModelSlotName[];
}
export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured {
	return {
		error: "No model configured — set up your models first",
		code: MODELS_NOT_CONFIGURED_CODE,
		missing,
	};
}

/** The refusal error text (BYOK, 2026-09-22): job/turn surfaces compose the
 *  record wording around this prefix; UI consumers detect refused work by
 *  it (info tone, not scary-error) — the envelope's home module owns the
 *  string so the writer and the matcher can never drift. */
export function isModelsRefusal(error: string | undefined): boolean {
	return !!error && error.startsWith(modelsNotConfigured([]).error);
}
/** The typed throw for in-process seams (extraction pipeline): callers
 *  catch it to skip honestly (trigger) or surface the 503 envelope
 *  (routes) instead of logging a failure. */
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** The key-presence refusal (provider-key interlude, owner, 2026-09-25):
 * a PINNED model is not enough — its provider's key must be present, or
 * the action dies mid-stream masked to a generic error. Same envelope
 * family as modelsNotConfigured: HTTP callers get 503 + this JSON;
 * in-band consumers (the job record's error field) carry the human
 * `error` line. `provider` names whose key is gone; `slots` names the
 * slot tier(s) the refused action resolves to that provider. */
export const PROVIDER_KEY_MISSING_CODE = "provider_key_missing" as const;
export interface ProviderKeyMissing {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof PROVIDER_KEY_MISSING_CODE;
	/** The provider whose key is gone, e.g. "openrouter". */
	provider: string;
	/** Which slot tiers the refused action resolves to that provider. */
	slots: ModelSlotName[];
}
/** The refusal wording's invariant tail — the matcher below keys on it
 * (the label prefix varies by provider). */
const PROVIDER_KEY_MISSING_TAIL = "key is set — add one in Settings → Keys";
const CLAUDE_CODE_UNAVAILABLE = "Claude Code is unavailable. Enable and set it up in Settings → Providers.";
export function providerKeyMissing(provider: string, slots: ModelSlotName[]): ProviderKeyMissing {
	const label = AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;
	return {
		error: provider === CLAUDE_CODE_PROVIDER ? CLAUDE_CODE_UNAVAILABLE : `No ${label} ${PROVIDER_KEY_MISSING_TAIL}`,
		code: PROVIDER_KEY_MISSING_CODE,
		provider,
		slots,
	};
}
/** The refusal error text (same discipline as isModelsRefusal): UI
 * consumers detect key-refused work by the wording (info tone, not
 * scary-error) — the envelope's home module owns the string so the
 * writer and the matcher can never drift. */
export function isProviderKeyRefusal(error: string | undefined): boolean {
	return !!error && (error.endsWith(PROVIDER_KEY_MISSING_TAIL) || error === CLAUDE_CODE_UNAVAILABLE);
}
/** The typed throw for in-process seams (extraction pipeline) — the
 * ProviderKeyMissing sibling of ModelsNotConfiguredError: callers catch
 * it to skip honestly (trigger) or surface the 503 envelope (routes). */
export class ProviderKeyMissingError extends Error {
	readonly envelope: ProviderKeyMissing;
	constructor(provider: string, slots: ModelSlotName[]) {
		const envelope = providerKeyMissing(provider, slots);
		super(envelope.error);
		this.name = "ProviderKeyMissingError";
		this.envelope = envelope;
	}
}

/** One slot's stored state. BYOK (owner, 2026-09-22): the WRITE side
 *  requires model (a level alone can never run — no factory floor); the
 *  sanitizer keeps whatever is on disk, but RESOLUTION treats a slot
 *  without a model as unset (inert level, no phantom default). */
export interface ModelSlot {
	/** The model swap: both coordinates or neither. */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

/** The `models` settings section (owner decision 2026-09-20: a dedicated
 *  section — slots are engine-level choices, not one session's). All slots
 *  optional: an absent slot means every role of its tier runs whatever the
 *  deeper tiers of the chain resolve to (per-role override → factory pin). */
export interface ModelsSettings {
	strong?: ModelSlot;
	cheap?: ModelSlot;
	vision?: ModelSlot;
}

// ─── Custom OpenAI-compatible endpoint ───────────────────────────────────────
// ONE user-configured OpenAI-compatible server (vLLM / Ollama / a proxy). It is
// one more provider in the Keys list, keyed by a base URL instead of an env var.
// NON-SECRET config only (base URL + discovered model ids); the API key is a
// secret in the auth store, never here. Registered into pi-ai as a normal
// provider (server/custom-provider.ts).

/** Budget fallbacks only; custom endpoint pricing is unknown. */
export const CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 8192;
export const CUSTOM_MODEL_DEFAULT_MAX_TOKENS = 4096;

/** Custom budgets accept every positive integer, including small output caps. */
export const CUSTOM_MODEL_PIN_FLOOR = 1;

/** One discovered custom model. `image`/`reasoning`/`context`/`maxTokens` are
 *  detected from the endpoint's /models metadata; anything it omits falls back
 *  to a default. */
export interface CustomModel {
	id: string;
	/** Accepts image input (Vision-capable). Default false (text-only). */
	image?: boolean;
	/** Accepts a reasoning effort (thinking). Default false → the only
	 *  thinking level is "off", exactly like a non-reasoning built-in. */
	reasoning?: boolean;
	/** Context window in tokens, from the endpoint. Absent → the default. */
	context?: number;
	/** Max output tokens, from the endpoint. Absent → the default. */
	maxTokens?: number;
}

/** A user pin for one custom model: it beats what the endpoint publishes
 *  (owner ruling — explicit user intent wins; a local server's number is
 *  often wrong or absent). Absent field = no pin. `reasoning` is tri-state:
 *  true declares reasoning support, false removes that declaration, absent
 *  uses discovery. This is NOT a backend execution/disable switch. */
export interface CustomModelOverride {
	context?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

/** The single custom endpoint's stored config (delta section). */
export interface CustomProviderSettings {
	/** Server-owned random authorization nonce; never a credential hash. */
	credentialBindingId?: string;
	/** Explicit authentication intent; never inferred from a saved key. */
	authMode?: "keyless" | "apiKey";
	/** Normalized base URL (see normalizeBaseUrl). Empty/absent = not configured. */
	baseUrl?: string;
	/** Models this endpoint offers: advertised ids merged with the typed
	 *  manual ones (rewritten on connect; a failed probe keeps the same
	 *  endpoint's last snapshot). */
	models?: CustomModel[];
	/** User pins keyed by model id — pure user intent, never rewritten by
	 *  discovery, pruned on connect to the ids that connect offers. */
	overrides?: Record<string, CustomModelOverride>;
	/** Model ids the user typed by hand, for an endpoint that publishes no
	 *  usable /models list. Kept apart from the snapshot so a reconnect can
	 *  re-merge them after discovery refreshes. */
	manualModels?: string[];
}

export function parseModelIds(raw: unknown): string[] {
	const items = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : [];
	const ids = items.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
	return [...new Set(ids)];
}

/** Canonical base-URL form (single source): trims, requires absolute http(s),
 *  drops trailing slashes. Returns "" for anything invalid ("not configured"). */
export function normalizeBaseUrl(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "";
	if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return "";
	return url.toString().replace(/\/+$/, "");
}

/** THE single source of "is the custom endpoint usable?": a non-empty base URL.
 *  Key presence is deliberately excluded (keyless local servers are allowed). */
export function customProviderUsable(
	cp: CustomProviderSettings | undefined,
): cp is CustomProviderSettings & { baseUrl: string } {
	return Boolean(cp?.baseUrl);
}

/** First-run gate (model-slots wave, owner 2026-09-20): the app refuses
 *  to start chats until the user has actively picked all three slots —
 *  there ARE no defaults for 33 providers; a configured app is one whose
 *  models section carries a model in every slot. Thinking levels stay
 *  optional (absent = the resolved tier's budget). */
export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

/** Which slot a role draws from (model slots wave, 2026-09-20). Includes the
 *  conversation pair and pdfReader (not BackgroundModelRoles — the slot
 *  tier spans every role; only background roles surface per-role overrides). */
export const ROLE_SLOT: Readonly<Record<ModelRole, ModelSlotName>> = {
	prober: "strong",
	teacher: "strong",
	researcher: "cheap",
	demoBuilder: "cheap",
	extractor: "cheap",
	auditor: "cheap",
	visualMaker: "vision",
	pdfReader: "vision",
};

/** General settings — app-level behavior. Version DISPLAY and plans login
 *  live outside the record (package.json / auth.json) by owner decision. */
export interface GeneralSettings {
	/** Automatic startup/24h update checks (default ON). Manual checks bypass this. */
	autoUpdate?: boolean;
}

/** One app-wide dictation preference, shared by every composer. */
export interface DictationSettings {
	language?: DictationLanguage;
}

/** Agent settings — everything about the non-conversation machinery. */
export interface AgentSettings {
	/** Background-role model/thinking overrides (absent role = config pin). */
	models?: Partial<Record<BackgroundModelRole, RoleModelOverride>>;
	/** Tool toggles keyed by tool id (absent key = enabled). User-level
	 *  only — no per-chat override (owner decision 2026-09-19). */
	tools?: Record<string, boolean>;
	/** Search-engine preference (search wave, 2026-09-20). OPTIONAL by
	 *  owner decision: setting a key auto-activates its engine — the user
	 *  never chooses an engine to make search work. An explicit choice only
	 *  pins the preference (e.g. when BOTH keys are present); the chosen
	 *  engine must still have its key, else search is honestly unavailable.
	 *  Absent + no key = unavailable (no silent fallback, no default). */
	search?: { engine?: SearchEngineId };
	/** Prober graph tools (wave 7, owner ruling 2026-09-23): read-only
	 *  knowledge-graph views for the prober agent — a session list +
	 *  per-session propositions with understanding levels. Its SUBJECT
	 *  is the graph but its MECHANISM is agent capability (tool
	 *  registration), so it lives here in its OWN subsection, not in the
	 *  tool-toggles map. Absent = enabled (the toggle discipline); the
	 *  effective gate composes graph.enabled AND this switch. */
	graphTools?: { enabled?: boolean };
	/** System-prompt override SWITCHES keyed by segment path (absent key =
	 *  off). Switch-on requires the override file to exist (enforced by the
	 *  route); the switch is explicit so users keep a file on disk but run
	 *  the source default to compare (owner decision 2026-09-19). */
	prompts?: Record<string, boolean>;
}

/** Markdown-rendering knobs — the bare-bones set (owner decision). */
export interface MdRenderingSettings {
	/** Heading font weight (100–900, default 900). CSS resolves the nearest
	 *  available weight of the chosen font — no font introspection needed. */
	headingWeight?: number;
	/** Color for **bold** spans (default #ffffff). */
	boldColor?: string | null;
	/** Color for *italic* spans (default #ffffff). */
	italicColor?: string | null;
}

/** Appearance settings — mode, colors, type, markdown emphasis. */
export interface AppearanceSettings {
	/** "dark" | "light" (default dark). */
	mode?: "dark" | "light";
	/** The one user-chosen color; everything else derives per-mode in code.
	 *  null = the mode's default background. */
	background?: string | null;
	/** The main reading font (everything that is Source Sans 3 today), by
	 *  name — user-chosen from installed fonts. null = Source Sans 3. */
	fontFamily?: string | null;
	/** Reading font size in px (12–24, default 16). Headings render as
	 *  multiples of this, so one knob scales the document coherently. */
	proseFontSize?: number;
	/** Session names in CMU Serif (default true — today's look). */
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

/** Knowledge-graph settings — a strict dependency ladder (owner decision
 *  2026-09-19): graph → embedding → clustering → labeling, each rung only
 *  meaningful when its parent is on (the UI grays dependents out; stored
 *  values persist but resolve inert). All default true. */
export interface GraphSettings {
	/** MASTER (and, since wave 7, ONLY): off = no extraction, no auditor.
	 *  The wave-7 collapse (owner ruling 2026-09-23) deleted the three
	 *  subordinate rungs — embedding/clustering/labeling — and the BYOK
	 *  embeddingModel: clustering is the free birth-session partition
	 *  derived on read (core/session-clusters.ts), labels ARE session
	 *  names, and the prober graph tools read the ledgers directly — there
	 *  is nothing left to configure. Data stays stored either way. */
	enabled?: boolean;
	/** GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
	 *  round): gates ONLY the home's main view. Off = the home shows the
	 *  chains view instead of the canvas; the ledgers, the extraction
	 *  pipeline, and every write path are untouched — this is a display
	 *  switch, not a data switch (the extraction master above is the
	 *  data switch). Default on. */
	rendering?: boolean;
	/** The chunk budget (extraction-UX redesign, owner 2026-09-24): the
	 *  transcript-token share of the extractor's context — a run fires
	 *  when a chat's UNCOVERED tokens reach it, and the run batches the
	 *  oldest uncovered messages into runs of ≤ this many tokens. It
	 *  bounds both cost and chunk size (the extractor prompt also
	 *  carries the whole graph + instructions, so a smaller budget means
	 *  more, smaller runs — each paying that fixed overhead).
	 *
	 *  FACTORY DEFAULT 4096 (owner, 2026-10-13: halved back from the
	 *  digest-era 8192 — the labeled passages + message anchors made
	 *  smaller batches worth their overhead again; the pre-setting
	 *  constant was 4096, vision-extraction-coverage.md, 2026-09-15).
	 *  Only the FACTORY moves: an explicit user value always wins.
	 *
	 *  FLOOR 500 (EXTRACTION_CHUNK_TOKENS_FLOOR, the implementer's call
	 *  per the owner's dispatch): every run pays the graph-carrying
	 *  prompt overhead out of the write channel's money — a budget below
	 *  ~500 tokens would fire penny-batches that cost more per extracted
	 *  token than the content is worth, so the sanitizer clamps and the
	 *  PUT rejects below it. NO CEILING on purpose: a large budget just
	 *  delays extraction — the user's stated cost/thoroughness tradeoff,
	 *  not a misconfiguration to police. */
	extractionChunkTokens?: number;
}

/**
 * COMPACTION (owner round 14, 2026-10-05): the context-fitting mechanic's
 * user-facing knob. One number — the trigger threshold in context tokens.
 * The effective trigger is min(this, model contextWindow − 16k reserve)
 * (owner ruling: on big models the setting rules; on small ones the
 * window rules before the provider overflows).
 *
 * FACTORY DEFAULT 150_000 (owner ruling).
 *
 * FLOOR 32_000 (implementer's call, the chunk-budget discipline): below
 * the kept tail (20k) + a summary the chat would re-compact every turn —
 * a burn, not a preference. NO CEILING: a huge threshold just means "fit
 * everything" until the window rule binds.
 */
export interface CompactionSettings {
	thresholdTokens?: number;
}

/** THE record. Every section optional (delta); unknown top-level keys are
 *  preserved verbatim by the sanitizer (forward-compat with newer records). */
export interface UserSettings {
	version: number;
	general?: GeneralSettings;
	dictation?: DictationSettings;
	/** Explicit app-wide opt-in; absent/invalid is off, including older records. */
	claudeCode?: { enabled?: boolean };
	agent?: AgentSettings;
	/** The strong/cheap/vision model slots (model slots wave, 2026-09-20). */
	models?: ModelsSettings;
	/** The custom OpenAI-compatible endpoint (non-secret config only). */
	customProvider?: CustomProviderSettings;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	compaction?: CompactionSettings;
	[key: string]: unknown;
}

/** Factory defaults for everything core can pin (owner decisions
 *  2026-09-19). NO factory models exist anywhere (owner, 2026-09-22 — BYOK
 *  all the way down): the chat section and every slot stay empty until the
 *  user picks, and the per-need gates refuse honestly; tools default on;
 *  prompts default off — hence their absence here. */
export interface FactorySettings {
	version: number;
	general: Required<GeneralSettings>;
	dictation: Required<DictationSettings>;
	appearance: {
		mode: "dark" | "light";
		background: string | null;
		fontFamily: string | null;
		proseFontSize: number;
		sessionNameSerif: boolean;
		mdRendering: {
			headingWeight: number;
			boldColor: string | null;
			italicColor: string | null;
		};
	};
	graph: Required<GraphSettings>;
	compaction: Required<CompactionSettings>;
}

export const FACTORY_SETTINGS: FactorySettings = {
	version: CURRENT_SETTINGS_VERSION,
	general: { autoUpdate: true },
	dictation: { language: "en" },
	appearance: {
		mode: "dark",
		background: null, // the dark default (#141414) lives in the mode's derivation curve
		fontFamily: null, // Source Sans 3
		proseFontSize: 16,
		sessionNameSerif: true,
		mdRendering: { headingWeight: 900, boldColor: null, italicColor: null },
	},
	graph: { enabled: true, rendering: true, extractionChunkTokens: 4096 },
	compaction: { thresholdTokens: 150_000 },
};

/** The chunk budget's validated floor (GraphSettings.extractionChunkTokens
 *  — see its doc for the penny-batch rationale; the settings PUT names this
 *  in its rejection, the sanitizer clamps to it). */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;

// ─── Sanitizer ─────────────────────────────────────────────────────────────

const PROSE_FONT_MIN = 12;
const PROSE_FONT_MAX = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** #rgb / #rrggbb (case-insensitive) — the only color format we accept. */
export function isHexColor(value: string): boolean {
	return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Coerce an arbitrary hex-or-null field: null and valid hex pass through,
 *  anything else becomes null (the factory/per-mode default). */
function sanitizeHexOrNull(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string" && isHexColor(value)) return value;
	return null;
}

const boolOrDrop = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

function sanitizeGeneral(raw: Record<string, unknown>): GeneralSettings {
	const out: GeneralSettings = {};
	const autoUpdate = boolOrDrop(raw.autoUpdate);
	if (autoUpdate !== undefined) out.autoUpdate = autoUpdate;
	return out;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function sanitizeRoleOverride(raw: unknown): RoleModelOverride | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: RoleModelOverride = {};
	if (
		typeof r.model === "object" &&
		r.model !== null &&
		!Array.isArray(r.model) &&
		typeof (r.model as Record<string, unknown>).provider === "string" &&
		typeof (r.model as Record<string, unknown>).id === "string"
	) {
		out.model = {
			provider: (r.model as { provider: string }).provider,
			id: (r.model as { id: string }).id,
		};
	}
	if (typeof r.thinkingLevel === "string" && THINKING_LEVELS.includes(r.thinkingLevel as ThinkingLevel)) {
		out.thinkingLevel = r.thinkingLevel as ThinkingLevel;
	}
	return Object.keys(out).length ? out : undefined;
}

/** The models section (model slots wave, 2026-09-20): each slot keeps
 *  only well-formed parts — the same shape rules as a role override, so a
 *  stale client can't park junk in a slot. */
function sanitizeModels(raw: Record<string, unknown>): ModelsSettings {
	const out: ModelsSettings = {};
	for (const slot of MODEL_SLOTS) {
		const cleaned = sanitizeRoleOverride(raw[slot]);
		if (cleaned) out[slot] = cleaned;
	}
	return out;
}

/** A positive integer, or undefined — keeps only meaningful token counts. */
function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** One pin, clamped up to the floor (clamp-never-reject on read). */
function sanitizeCustomModelOverride(raw: unknown): CustomModelOverride | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const out: CustomModelOverride = {};
	const context = positiveInt(rec.context);
	if (context) out.context = Math.max(CUSTOM_MODEL_PIN_FLOOR, context);
	const maxTokens = positiveInt(rec.maxTokens);
	if (maxTokens) out.maxTokens = Math.max(CUSTOM_MODEL_PIN_FLOOR, maxTokens);
	if (typeof rec.reasoning === "boolean") out.reasoning = rec.reasoning;
	return Object.keys(out).length ? out : undefined;
}

/** THE pins map + THE prune law: well-formed entries only, ids trimmed, and
 *  when `liveIds` is given every entry for a model the endpoint no longer
 *  advertises drops. POST passes the discovered ids, PATCH the stored list. */
export function sanitizeCustomModelOverrides(
	raw: unknown,
	liveIds?: Iterable<string>,
): Record<string, CustomModelOverride> {
	const out: Record<string, CustomModelOverride> = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const live = liveIds ? new Set(liveIds) : undefined;
	for (const [key, value] of Object.entries(raw)) {
		const id = key.trim();
		if (!id || (live && !live.has(id))) continue;
		const pin = sanitizeCustomModelOverride(value);
		if (pin) Object.defineProperty(out, id, { value: pin, enumerable: true, configurable: true, writable: true });
	}
	return out;
}

/** The customProvider section: normalized base URL (invalid → dropped) and
 *  discovered models (ids trimmed, dupes/empties dropped; image kept only when
 *  true; token counts only as positive ints). Clamp-never-reject. */
function sanitizeCustomProvider(raw: Record<string, unknown>): CustomProviderSettings {
	const out: CustomProviderSettings = {};
	if (typeof raw.credentialBindingId === "string" && /^[a-f0-9]{32}$/.test(raw.credentialBindingId)) out.credentialBindingId = raw.credentialBindingId;
	if (raw.authMode === "keyless" || raw.authMode === "apiKey") out.authMode = raw.authMode;
	if (typeof raw.baseUrl === "string") {
		const base = normalizeBaseUrl(raw.baseUrl);
		if (base) out.baseUrl = base;
	}
	if (Array.isArray(raw.models)) {
		const byId = new Map<string, CustomModel>();
		for (const m of raw.models) {
			if (typeof m !== "object" || m === null) continue;
			const rec = m as Record<string, unknown>;
			if (typeof rec.id !== "string") continue;
			const id = rec.id.trim();
			if (!id) continue;
			const model: CustomModel = { id };
			if (rec.image === true) model.image = true;
			if (rec.reasoning === true) model.reasoning = true;
			const context = positiveInt(rec.context);
			if (context) model.context = context;
			const maxTokens = positiveInt(rec.maxTokens);
			if (maxTokens) model.maxTokens = maxTokens;
			byId.set(id, model);
		}
		out.models = [...byId.values()];
	}
	const overrides = sanitizeCustomModelOverrides(raw.overrides);
	if (Object.keys(overrides).length) out.overrides = overrides;
	const manualModels = parseModelIds(raw.manualModels);
	if (manualModels.length) out.manualModels = manualModels;
	return out;
}

function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeAgent(raw: Record<string, unknown>): AgentSettings {
	const out: AgentSettings = {};
	if (raw.models !== null && typeof raw.models === "object" && !Array.isArray(raw.models)) {
		const models: Partial<Record<BackgroundModelRole, RoleModelOverride>> = {};
		for (const [role, override] of Object.entries(raw.models as Record<string, unknown>)) {
			if ((BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)) {
				const cleaned = sanitizeRoleOverride(override);
				if (cleaned) models[role as BackgroundModelRole] = cleaned;
			}
		}
		if (Object.keys(models).length) out.models = models;
	}
	const tools = sanitizeBooleanMap(raw.tools);
	if (tools) out.tools = tools;
	const prompts = sanitizeBooleanMap(raw.prompts);
	if (prompts) out.prompts = prompts;
	// Search preference: lenient read side (an unknown engine id drops;
	// the write side's parser is strict — a stale client can't brick the
	// record, it just loses the pin and auto-detection resumes).
	if (raw.search !== null && typeof raw.search === "object" && !Array.isArray(raw.search)) {
		const engine = (raw.search as Record<string, unknown>).engine;
		if (engine === "tavily" || engine === "brave") out.search = { engine };
	}
	// Prober graph tools (wave 7): its own agent-section subsection —
	// lenient read side (a bad shape drops the key and the default ON
	// resumes; the write side's parser is strict).
	if (raw.graphTools !== null && typeof raw.graphTools === "object" && !Array.isArray(raw.graphTools)) {
		const enabled = (raw.graphTools as Record<string, unknown>).enabled;
		if (enabled === undefined) out.graphTools = {};
		else if (typeof enabled === "boolean") out.graphTools = { enabled };
	}
	return out;
}

function sanitizeMdRendering(raw: unknown): MdRenderingSettings {
	const out: MdRenderingSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight)) {
		out.headingWeight = clamp(Math.round(r.headingWeight), 100, 900);
	}
	if (r.boldColor !== undefined) out.boldColor = sanitizeHexOrNull(r.boldColor);
	if (r.italicColor !== undefined) out.italicColor = sanitizeHexOrNull(r.italicColor);
	return out;
}

function sanitizeAppearance(raw: Record<string, unknown>): AppearanceSettings {
	const out: AppearanceSettings = {};
	if (raw.mode === "dark" || raw.mode === "light") out.mode = raw.mode;
	if (raw.background !== undefined) out.background = sanitizeHexOrNull(raw.background);
	if (raw.fontFamily !== undefined) {
		out.fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily : null;
	}
	if (typeof raw.proseFontSize === "number" && Number.isFinite(raw.proseFontSize)) {
		out.proseFontSize = clamp(Math.round(raw.proseFontSize), PROSE_FONT_MIN, PROSE_FONT_MAX);
	}
	const sessionNameSerif = boolOrDrop(raw.sessionNameSerif);
	if (sessionNameSerif !== undefined) out.sessionNameSerif = sessionNameSerif;
	if (raw.mdRendering !== undefined) out.mdRendering = sanitizeMdRendering(raw.mdRendering);
	return out;
}

function sanitizeGraph(raw: Record<string, unknown>): GraphSettings {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the master
	// switch ONLY. The dead rungs' keys (embedding/clustering/labeling/
	// embeddingModel) in existing records are simply UNREAD and DROPPED by
	// this reconstruction — the migration story: the next graph-section
	// write (PUT is replace-whole) persists the collapsed shape, and no
	// active code ever looks at the stale fields.
	//
	// extractionChunkTokens (extraction-UX redesign, 2026-09-24): the chunk
	// budget — clamp-never-reject (the bd68486 discipline): a finite
	// positive number floors to EXTRACTION_CHUNK_TOKENS_FLOOR (fractions
	// floor to integers), anything else drops to the factory default at
	// resolution. A disk record below the floor (older app, hand edit)
	// clamps UP — the floor is a cost protection, not data to honor.
	const out: GraphSettings = {};
	const enabled = boolOrDrop(raw.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const rendering = boolOrDrop(raw.rendering);
	if (rendering !== undefined) out.rendering = rendering;
	const rawTokens = raw.extractionChunkTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.extractionChunkTokens = Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

/** clamp-never-reject (the sanitizer's discipline): a finite positive
 *  number floors to COMPACTION_THRESHOLD_FLOOR, anything else drops (the
 *  factory default resolves at read time). Exported for the PUT parser's
 *  reject-with-rationale (the graph chunk-budget precedent). */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;

function sanitizeCompaction(raw: Record<string, unknown>): CompactionSettings {
	const out: CompactionSettings = {};
	const rawTokens = raw.thresholdTokens;
	if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
		out.thresholdTokens = Math.max(COMPACTION_THRESHOLD_FLOOR, Math.floor(rawTokens));
	}
	return out;
}

/**
 * Coerce arbitrary JSON (disk file, network body) into a valid delta record:
 * known fields validated strictly (invalid ones drop/clamp per module doc),
 * UNKNOWN KEYS PRESERVED VERBATIM (a newer record must survive an older
 * app). Never throws. Non-objects → null.
 */
export function sanitizeUserSettings(raw: unknown): UserSettings | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: UserSettings = {
		version: typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : CURRENT_SETTINGS_VERSION,
	};
	if (r.general !== null && typeof r.general === "object" && !Array.isArray(r.general)) {
		out.general = sanitizeGeneral(r.general as Record<string, unknown>);
	}
	if (r.dictation !== undefined) {
		const raw = r.dictation;
		out.dictation = raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
			isDictationLanguage((raw as Record<string, unknown>).language)
			? { language: (raw as DictationSettings).language }
			: {};
	}
	if (r.claudeCode !== undefined) {
		const raw = r.claudeCode;
		out.claudeCode = raw !== null && typeof raw === "object" && !Array.isArray(raw)
			&& typeof (raw as Record<string, unknown>).enabled === "boolean"
			? { enabled: (raw as { enabled: boolean }).enabled } : {};
	}
	if (r.agent !== null && typeof r.agent === "object" && !Array.isArray(r.agent)) {
		out.agent = sanitizeAgent(r.agent as Record<string, unknown>);
	}
	if (r.appearance !== null && typeof r.appearance === "object" && !Array.isArray(r.appearance)) {
		out.appearance = sanitizeAppearance(r.appearance as Record<string, unknown>);
	}
	if (r.models !== null && typeof r.models === "object" && !Array.isArray(r.models)) {
		const models = sanitizeModels(r.models as Record<string, unknown>);
		if (Object.keys(models).length) out.models = models;
	}
	if (r.customProvider !== null && typeof r.customProvider === "object" && !Array.isArray(r.customProvider)) {
		out.customProvider = sanitizeCustomProvider(r.customProvider as Record<string, unknown>);
	}
	if (r.graph !== null && typeof r.graph === "object" && !Array.isArray(r.graph)) {
		out.graph = sanitizeGraph(r.graph as Record<string, unknown>);
		if (r.compaction !== undefined && r.compaction !== null && typeof r.compaction === "object") {
			out.compaction = sanitizeCompaction(r.compaction as Record<string, unknown>);
		}
	}
	// Unknown top-level keys ride along untouched (forward-compat). One
	// known-DEAD key is stripped instead of riding: `chat` (the old
	// default-settings section) died with per-session models (owner,
	// 2026-09-28) — a fossil copy on disk must never resurrect through
	// reads (and any later write flushes it from the file for good).
	for (const [key, value] of Object.entries(r)) {
		if (key === "chat") continue;
		if (!(key in out)) out[key] = value;
	}
	return out;
}
