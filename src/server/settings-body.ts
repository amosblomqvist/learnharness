/**
 * The shared settings-PUT body parsers — one seam per settings surface.
 * Extracted verbatim from the per-chat route (default-settings wave,
 * 2026-09-18): identical parse, identical errors. The section parsers
 * (settings-storage wave, 2026-09-19) follow the same house rules.
 *
 * Replace-whole semantics: the client sends the complete desired SECTION;
 * absent fields are absent overrides ({} clears everything). No merges, so
 * a stale client can never resurrect a cleared override. Unknown body keys
 * are dropped (same tolerance as parseSettingsBody) — unknown DISK keys are
 * a different concern and are preserved by the sanitizer (core/settings.ts).
 */

import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHexColor, type ChatSettings } from "../core";
import { COLOR_OVERRIDE_KEYS, isThemeId, type AppearanceColorOverrides, type ColorOverrideKey } from "../core/themes.ts";
import type {
	AgentSettings,
	AppearanceSettings,
	BackgroundModelRole,
	CompactionSettings,
	CustomModelOverride,
	GeneralSettings,
	DictationSettings,
	GraphSettings,
	ModelsSettings,
	ModelSlot,
	RoleModelOverride,
} from "../core/settings.ts";
import { BACKGROUND_MODEL_ROLES, CACHE_RETENTIONS, COMPACTION_THRESHOLD_FLOOR, CUSTOM_MODEL_PIN_FLOOR, EXTRACTION_CHUNK_TOKENS_FLOOR, isTranscriptMaxWidth, MODEL_SLOTS, TRANSCRIPT_WIDTH_MAX_REM, TRANSCRIPT_WIDTH_MIN_REM } from "../core/settings.ts";
import { WRITABLE_TOOL_KEYS } from "../core/pending.ts";
import { isSearchEngineId, SEARCH_ENGINES } from "../core/search.ts";
import { isDictationLanguage } from "../core/dictation.ts";
import { parseFileAccessSettings } from "../core/file-access.ts";
import { isUiLanguage, tr } from "../core/i18n.ts";

/** Parsed-or-rejected — `ok: false` carries the 400's error message. */
export type SettingsBodyResult<T> =
	| { ok: true; settings: T }
	| { ok: false; error: string };

export function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	}
	const raw = body as {
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
	};
	const settings: ChatSettings = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof raw.model.provider !== "string" ||
			typeof raw.model.id !== "string"
		) {
			return { ok: false, error: tr("model 必须是 {provider, id}", "model must be {provider, id}") };
		}
		settings.model = { provider: raw.model.provider, id: raw.model.id };
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: tr("thinkingLevel 必须是字符串", "thinkingLevel must be a string") };
		}
		settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	// Wave 7 killed the graph-context injection (owner: zero configuration
	// beyond chat models — the prober reads its map through tools now); its
	// budget dial is gone with it. A stale client sending the old key has
	// it silently dropped here (forward-compatible, like any unknown key).
	return { ok: true, settings };
}

// ─── Section parsers (settings-storage wave, 2026-09-19) ────────────────────
// One parser per settings.json section; the route maps the URL section to
// its parser via SETTINGS_SECTIONS below. Same discipline as
// parseSettingsBody: strict on every known field (a bad type/shape is a
// 400, never a silent clamp/drop), unknown keys dropped.

function asRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

/** general: { autoUpdate?: boolean; language?: "zh" | "en" } */
export function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const settings: GeneralSettings = {};
	if (raw.autoUpdate !== undefined) {
		if (typeof raw.autoUpdate !== "boolean") {
			return { ok: false, error: tr("autoUpdate 必须是布尔值", "autoUpdate must be a boolean") };
		}
		settings.autoUpdate = raw.autoUpdate;
	}
	if (raw.language !== undefined) {
		if (!isUiLanguage(raw.language)) return { ok: false, error: tr("language 必须是 \"zh\" 或 \"en\"", "language must be \"zh\" or \"en\"") };
		settings.language = raw.language;
	}
	return { ok: true, settings };
}

/** claudeCode: explicit app-wide opt-in. Empty section resets to off. */
export function parseClaudeCodeSettingsBody(body: unknown): SettingsBodyResult<{ enabled?: boolean }> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	if (raw.enabled === undefined) return { ok: true, settings: {} };
	if (typeof raw.enabled !== "boolean") return { ok: false, error: tr("enabled 必须是布尔值", "enabled must be a boolean") };
	return { ok: true, settings: { enabled: raw.enabled } };
}

/** agent.models: only the six known background roles; each override's
 *  fields mirror ChatSettings (model pair + independent thinkingLevel). */
function parseRoleOverride(value: unknown, role: string): { ok: true; override: RoleModelOverride } | { ok: false; error: string } {
	const raw = asRecord(value);
	if (!raw) return { ok: false, error: tr(`${role} 必须是对象`, `${role} must be an object`) };
	const override: RoleModelOverride = {};
	if (raw.model !== undefined) {
		if (
			typeof raw.model !== "object" ||
			raw.model === null ||
			typeof (raw.model as Record<string, unknown>).provider !== "string" ||
			typeof (raw.model as Record<string, unknown>).id !== "string"
		) {
			return { ok: false, error: tr(`${role}.model 必须是 {provider, id}`, `${role}.model must be {provider, id}`) };
		}
		override.model = {
			provider: (raw.model as { provider: string }).provider,
			id: (raw.model as { id: string }).id,
		};
	}
	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel !== "string") {
			return { ok: false, error: tr(`${role}.thinkingLevel 必须是字符串`, `${role}.thinkingLevel must be a string`) };
		}
		override.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
	}
	return { ok: true, override };
}

/** A boolean map (tools / prompts switches): every value must be boolean. */
function parseBooleanMap(value: unknown, field: string): { map?: Record<string, boolean>; error?: string } {
	if (value === undefined) return {};
	const raw = asRecord(value);
	if (!raw) return { error: tr(`${field} 必须是对象`, `${field} must be an object`) };
	const out: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "boolean") return { error: tr(`${field}.${key} 必须是布尔值`, `${field}.${key} must be a boolean`) };
		out[key] = entry;
	}
	return { map: out };
}

/** agent: { workerRequestConcurrency?, models?, tools?, prompts? } — model/thinking validity against
 *  the catalog is checked by the route (validateChatSettings discipline);
 *  prompt switch-on membership is checked by the route (needs the store). */
export function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const settings: AgentSettings = {};
	if (raw.workerRequestConcurrency !== undefined) {
		if (typeof raw.workerRequestConcurrency !== "number" || !Number.isSafeInteger(raw.workerRequestConcurrency) || raw.workerRequestConcurrency <= 0) {
			return { ok: false, error: tr("workerRequestConcurrency 必须是可安全表示的正整数", "workerRequestConcurrency must be a positive, safely representable whole number") };
		}
		settings.workerRequestConcurrency = raw.workerRequestConcurrency;
	}
	if (raw.models !== undefined) {
		const models = asRecord(raw.models);
		if (!models) return { ok: false, error: tr("models 必须是对象", "models must be an object") };
		const known = BACKGROUND_MODEL_ROLES as readonly string[];
		const parsed: NonNullable<AgentSettings["models"]> = {};
		for (const [role, value] of Object.entries(models)) {
			if (!known.includes(role)) {
				return { ok: false, error: tr(`未知角色“${role}”（支持：${known.join(", ")}）`, `unknown role "${role}" (supported: ${known.join(", ")})`) };
			}
			const override = parseRoleOverride(value, role);
			if (!override.ok) return { ok: false, error: override.error };
			if (Object.keys(override.override).length) parsed[role as BackgroundModelRole] = override.override;
		}
		if (Object.keys(parsed).length) settings.models = parsed;
	}
	const tools = parseBooleanMap(raw.tools, "tools");
	if (tools.error) return { ok: false, error: tools.error };
	if (tools.map) {
		// Unknown tool keys are rejected at WRITE time (user decision
		// 2026-09-19): the delta is inert while unread, but once the bridge
		// honors it a persisted bogus key would drift. The writable set is
		// the job tools + the quizzing-mechanics switch (explain, owner
		// 2026-09-27). The read-side sanitizer stays lenient for
		// forward-compat.
		const supported = WRITABLE_TOOL_KEYS as readonly string[];
		for (const key of Object.keys(tools.map)) {
			if (!supported.includes(key)) {
				return { ok: false, error: tr(`未知工具“${key}”（支持：${supported.join(", ")}）`, `unknown tool "${key}" (supported: ${supported.join(", ")})`) };
			}
		}
		settings.tools = tools.map;
	}
	const prompts = parseBooleanMap(raw.prompts, "prompts");
	if (prompts.error) return { ok: false, error: prompts.error };
	if (prompts.map) settings.prompts = prompts.map;
	if (raw.search !== undefined) {
		const search = asRecord(raw.search);
		if (!search) return { ok: false, error: tr("search 必须是对象", "search must be an object") };
		if (search.engine !== undefined) {
			if (!isSearchEngineId(search.engine)) {
				return { ok: false, error: tr(`search.engine 必须是 ${SEARCH_ENGINES.map((engine) => `"${engine.id}"`).join(", ")} 之一`, `search.engine must be ${SEARCH_ENGINES.map((engine) => `"${engine.id}"`).join(", ")}`) };
			}
			settings.search = { engine: search.engine };
		}
	}
	// Prober graph tools (wave 7, owner ruling 2026-09-23): an agent-section
	// subsection, not a tool-toggles key — the mechanism is agent capability
	// (tool registration), the subject is the graph. Strict write side:
	// object shape only; `enabled` boolean when present. Absent = ON.
	if (raw.graphTools !== undefined) {
		const graphTools = asRecord(raw.graphTools);
		if (!graphTools) return { ok: false, error: tr("graphTools 必须是对象", "graphTools must be an object") };
		if (graphTools.enabled !== undefined && typeof graphTools.enabled !== "boolean") {
			return { ok: false, error: tr("graphTools.enabled 必须是布尔值", "graphTools.enabled must be a boolean") };
		}
		settings.graphTools = graphTools.enabled === undefined ? {} : { enabled: graphTools.enabled };
	}
	if (raw.fileAccess !== undefined) {
		const parsed = parseFileAccessSettings(raw.fileAccess);
		if (!parsed.ok) return parsed;
		if (parsed.settings.folders.some((folder) => folder !== "~" && !folder.startsWith("~/") && !path.isAbsolute(folder))) {
			return { ok: false, error: tr("fileAccess.folders 必须是服务器文件系统上的绝对路径（或以 ~/ 开头）", "fileAccess.folders must be absolute on the server filesystem (or start with ~/)") };
		}
		settings.fileAccess = parsed.settings;
	}
	return { ok: true, settings };
}

/** A hex-or-null color field (appearance colors): null = default. */
function parseHexOrNull(value: unknown, field: string): { color?: string | null; error?: string } {
	if (value === null) return { color: null };
	if (typeof value !== "string" || !isHexColor(value)) {
		return { error: tr(`${field} 必须是 #十六进制颜色或 null`, `${field} must be a #hex color or null`) };
	}
	return { color: value };
}

/** appearance: { theme?, background?, colors?, fontFamily?,
 *  proseFontSize?, codeLigatures?, sessionNameSerif?, compactSessionList?, mdRendering? } —
 *  `theme` is shape-checked here (slug); whether it EXISTS is the route's check. */
export function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const settings: AppearanceSettings = {};
	if (raw.theme !== undefined) {
		if (!isThemeId(raw.theme)) return { ok: false, error: tr("theme 必须是主题 ID（小写 slug）", "theme must be a theme id (lowercase slug)") };
		settings.theme = raw.theme;
	}
	if (raw.background !== undefined) {
		const parsed = parseHexOrNull(raw.background, "background");
		if (parsed.error) return { ok: false, error: parsed.error };
		settings.background = parsed.color ?? null;
	}
	if (raw.colors !== undefined) {
		const colors = asRecord(raw.colors);
		if (!colors) return { ok: false, error: tr("colors 必须是对象", "colors must be an object") };
		const out: AppearanceColorOverrides = {};
		for (const [key, value] of Object.entries(colors)) {
			if (!(COLOR_OVERRIDE_KEYS as readonly string[]).includes(key)) {
				return { ok: false, error: tr(`未知颜色“${key}”（支持：${COLOR_OVERRIDE_KEYS.join(", ")}）`, `unknown color "${key}" (supported: ${COLOR_OVERRIDE_KEYS.join(", ")})`) };
			}
			const parsed = parseHexOrNull(value, `colors.${key}`);
			if (parsed.error) return { ok: false, error: parsed.error };
			out[key as ColorOverrideKey] = parsed.color ?? null;
		}
		settings.colors = out;
	}
	if (raw.fontFamily !== undefined) {
		if (raw.fontFamily !== null && (typeof raw.fontFamily !== "string" || !raw.fontFamily.trim())) {
			return { ok: false, error: tr("fontFamily 必须是非空字符串或 null", "fontFamily must be a non-empty string or null") };
		}
		settings.fontFamily = raw.fontFamily as string | null;
	}
	if (raw.proseFontSize !== undefined) {
		if (
			typeof raw.proseFontSize !== "number" ||
			!Number.isInteger(raw.proseFontSize) ||
			raw.proseFontSize < 12 ||
			raw.proseFontSize > 24
		) {
			return { ok: false, error: tr("proseFontSize 必须是 12 到 24 之间的整数", "proseFontSize must be an integer between 12 and 24") };
		}
		settings.proseFontSize = raw.proseFontSize;
	}
	if (raw.codeLigatures !== undefined) {
		if (typeof raw.codeLigatures !== "boolean") {
			return { ok: false, error: tr("codeLigatures 必须是布尔值", "codeLigatures must be a boolean") };
		}
		settings.codeLigatures = raw.codeLigatures;
	}
	if (raw.sessionNameSerif !== undefined) {
		if (typeof raw.sessionNameSerif !== "boolean") {
			return { ok: false, error: tr("sessionNameSerif 必须是布尔值", "sessionNameSerif must be a boolean") };
		}
		settings.sessionNameSerif = raw.sessionNameSerif;
	}
	if (raw.compactSessionList !== undefined) {
		if (typeof raw.compactSessionList !== "boolean") {
			return { ok: false, error: tr("compactSessionList 必须是布尔值", "compactSessionList must be a boolean") };
		}
		settings.compactSessionList = raw.compactSessionList;
	}
	if (raw.transcriptMaxWidth !== undefined) {
		if (!isTranscriptMaxWidth(raw.transcriptMaxWidth)) {
			return {
				ok: false,
				error: tr(`transcriptMaxWidth 必须是 ${TRANSCRIPT_WIDTH_MIN_REM} 到 ${TRANSCRIPT_WIDTH_MAX_REM} 之间的偶数（rem）；省略则为全宽`, `transcriptMaxWidth must be an even integer between ${TRANSCRIPT_WIDTH_MIN_REM} and ${TRANSCRIPT_WIDTH_MAX_REM} (rem); omit it for Full`),
			};
		}
		settings.transcriptMaxWidth = raw.transcriptMaxWidth;
	}
	if (raw.adaptiveQuestions !== undefined) {
		if (typeof raw.adaptiveQuestions !== "boolean") {
			return { ok: false, error: tr("adaptiveQuestions 必须是布尔值", "adaptiveQuestions must be a boolean") };
		}
		settings.adaptiveQuestions = raw.adaptiveQuestions;
	}
	if (raw.mdRendering !== undefined) {
		const md = asRecord(raw.mdRendering);
		if (!md) return { ok: false, error: tr("mdRendering 必须是对象", "mdRendering must be an object") };
		const rendering: NonNullable<AppearanceSettings["mdRendering"]> = {};
		if (md.headingWeight !== undefined) {
			if (
				typeof md.headingWeight !== "number" ||
				!Number.isInteger(md.headingWeight) ||
				md.headingWeight < 100 ||
				md.headingWeight > 900
			) {
				return { ok: false, error: tr("mdRendering.headingWeight 必须是 100 到 900 之间的整数", "mdRendering.headingWeight must be an integer between 100 and 900") };
			}
			rendering.headingWeight = md.headingWeight;
		}
		if (md.boldColor !== undefined) {
			const parsed = parseHexOrNull(md.boldColor, "mdRendering.boldColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.boldColor = parsed.color ?? null;
		}
		if (md.italicColor !== undefined) {
			const parsed = parseHexOrNull(md.italicColor, "mdRendering.italicColor");
			if (parsed.error) return { ok: false, error: parsed.error };
			rendering.italicColor = parsed.color ?? null;
		}
		if (Object.keys(rendering).length) settings.mdRendering = rendering;
	}
	return { ok: true, settings };
}

/** graph: the collapsed section { enabled? } (wave 7, owner ruling
 *  2026-09-23): the master switch ONLY — the embedding/clustering/labeling
 *  rungs and the BYOK embeddingModel died with the provider embedder
 *  (clustering is the free birth-session partition, labels are session
 *  names). Old-shape keys in a body are ignored, not rejected. */
export function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	// Wave 7 collapse (owner ruling 2026-09-23) + the extraction-UX
	// redesign (2026-09-24): the section is the master switch and the
	// chunk budget. PUT is replace-whole — a body like {enabled: true} IS
	// the whole section (extractionChunkTokens absent = factory default at
	// resolution); the dead rungs' keys in old records are unread (the
	// sanitizer drops them; see sanitizeGraph).
	const settings: GraphSettings = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return { ok: false, error: tr("enabled 必须是布尔值", "enabled must be a boolean") };
		settings.enabled = raw.enabled;
	}
	if (raw.rendering !== undefined) {
		if (typeof raw.rendering !== "boolean") return { ok: false, error: tr("rendering 必须是布尔值", "rendering must be a boolean") };
		settings.rendering = raw.rendering;
	}
	if (raw.extractionChunkTokens !== undefined) {
		if (typeof raw.extractionChunkTokens !== "number" || !Number.isFinite(raw.extractionChunkTokens)) {
			return { ok: false, error: tr("extractionChunkTokens 必须是数字", "extractionChunkTokens must be a number") };
		}
		const floored = Math.floor(raw.extractionChunkTokens);
		if (floored < EXTRACTION_CHUNK_TOKENS_FLOOR) {
			// the floor's rationale lives on GraphSettings.extractionChunkTokens:
			// every run pays the graph-carrying prompt overhead — penny-batches
			// cost more per extracted token than the content is worth.
			return {
				ok: false,
				error: tr(`extractionChunkTokens 不能小于 ${EXTRACTION_CHUNK_TOKENS_FLOOR}（批次过小会浪费每次运行的图谱开销）`, `extractionChunkTokens must be at least ${EXTRACTION_CHUNK_TOKENS_FLOOR} (smaller batches waste the per-run graph overhead)`),
			};
		}
		settings.extractionChunkTokens = floored;
	}
	return { ok: true, settings };
}

/** models: { strong?, cheap?, vision? } — the slot tiers (model slots
 *  wave, 2026-09-20). Each slot is the same shape as a role override; a
 *  present-but-empty slot object is rejected (absent slot = unset; say
 *  what you mean). Catalog validity is checked by the route
 *  (validateChatSettings discipline). */
export function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const settings: ModelsSettings = {};
	for (const key of Object.keys(raw)) {
		const known = MODEL_SLOTS as readonly string[];
		if (!known.includes(key)) {
			return { ok: false, error: tr(`未知槽位“${key}”（支持：${known.join(", ")}）`, `unknown slot "${key}" (supported: ${known.join(", ")})`) };
		}
		const parsed = parseRoleOverride(raw[key], key);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		// BYOK (owner, 2026-09-22): a slot IS a model choice — no factory
		// floor exists, so a thinkingLevel alone can never run; every slot
		// write must carry the model (the level is an optional rider). An
		// absent slot key clears the tier (replace-whole section).
		if (!parsed.override.model) {
			return { ok: false, error: tr(`槽位“${key}”必须设置模型（仅有 thinkingLevel 无法运行 — 省略槽位即为未设置）`, `slot "${key}" must set a model (thinkingLevel alone cannot run — absent slot = unset)`) };
		}
		const slot: ModelSlot = parsed.override;
		const retention = (raw[key] as Record<string, unknown>).cacheRetention;
		if (retention !== undefined) {
			if (!CACHE_RETENTIONS.some((value) => value === retention)) {
				return { ok: false, error: tr(`${key}.cacheRetention 必须是 none、short 或 long`, `${key}.cacheRetention must be none, short, or long`) };
			}
			slot.cacheRetention = retention as ModelSlot["cacheRetention"];
		}
		settings[key as (typeof MODEL_SLOTS)[number]] = slot;
	}
	return { ok: true, settings };
}

/** compaction: opt-in reasoning accounting (boolean, default off) and the
 *  projected-token budget over which a session summarizes its own history
 *  into the compaction marker. Strict write side: a present
 *  thresholdTokens must be a number at or above the floor (the floor is
 *  anti-churn: each compaction keeps a ~20k-token recent tail, so a
 *  smaller threshold would re-summarize the tail it just wrote). Absent =
 *  factory default 150k at resolution. Replace-whole, like every
 *  section. */
export function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const settings: CompactionSettings = {};
	if (raw.includeReasoning !== undefined) {
		if (typeof raw.includeReasoning !== "boolean") {
			return { ok: false, error: tr("includeReasoning 必须是 true 或 false", "includeReasoning must be true or false") };
		}
		settings.includeReasoning = raw.includeReasoning;
	}
	if (raw.thresholdTokens !== undefined) {
		if (typeof raw.thresholdTokens !== "number" || !Number.isFinite(raw.thresholdTokens)) {
			return { ok: false, error: tr("thresholdTokens 必须是数字", "thresholdTokens must be a number") };
		}
		const floored = Math.floor(raw.thresholdTokens);
		if (floored < COMPACTION_THRESHOLD_FLOOR) {
			return {
				ok: false,
				error: tr(`thresholdTokens 不能小于 ${COMPACTION_THRESHOLD_FLOOR}（上下文压缩会保留约 20k token 的近期内容 — 预算过小会导致反复压缩）`, `thresholdTokens must be at least ${COMPACTION_THRESHOLD_FLOOR} (compaction keeps a ~20k-token recent tail — smaller budgets would churn it)`),
			};
		}
		settings.thresholdTokens = floored;
	}
	return { ok: true, settings };
}

/** dictation: { language?: one of Nova-3's supported language codes } */
export function parseDictationSettingsBody(body: unknown): SettingsBodyResult<DictationSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	if (raw.language === undefined) return { ok: true, settings: {} };
	if (!isDictationLanguage(raw.language)) return { ok: false, error: tr("不支持的语音听写语言", "Unsupported dictation language") };
	return { ok: true, settings: { language: raw.language } };
}

/** The custom endpoint's per-model pins (PATCH /api/custom-provider): the
 *  whole desired map, replace-whole like every section. Strict write side — a
 *  token count must be a whole number at or above the floor (the read side
 *  clamps, this rejects — the compaction discipline). `reasoning` is the
 *  tri-state capability pin, not a backend execution toggle. */
export function parseCustomModelOverridesBody(
	body: unknown,
): SettingsBodyResult<Record<string, CustomModelOverride>> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: tr("无效的 JSON 请求体", "Invalid JSON body") };
	const map = asRecord(raw.overrides);
	if (!map) return { ok: false, error: tr("overrides 必须是 { modelId: { context?, maxTokens?, reasoning? } } 形式的映射", "overrides must be a { modelId: { context?, maxTokens?, reasoning? } } map") };
	const out: Record<string, CustomModelOverride> = {};
	for (const [key, value] of Object.entries(map)) {
		const id = key.trim();
		if (!id) return { ok: false, error: tr("overrides 的键必须是非空的模型 ID", "override keys must be non-empty model ids") };
		const entry = asRecord(value);
		if (!entry) return { ok: false, error: tr(`${id} 的覆盖项必须是对象`, `override for ${id} must be an object`) };
		const pin: CustomModelOverride = {};
		for (const field of ["context", "maxTokens"] as const) {
			const v = entry[field];
			if (v === undefined) continue;
			if (typeof v !== "number" || !Number.isInteger(v) || v < CUSTOM_MODEL_PIN_FLOOR) {
				return {
					ok: false,
					error: tr(`${id} 的 ${field} 必须是不小于 ${CUSTOM_MODEL_PIN_FLOOR} 的整数 token 数`, `${field} for ${id} must be a whole number of tokens at least ${CUSTOM_MODEL_PIN_FLOOR}`),
				};
			}
			pin[field] = v;
		}
		if (entry.reasoning !== undefined) {
			if (typeof entry.reasoning !== "boolean") return { ok: false, error: tr(`${id} 的 reasoning 必须是 true 或 false`, `reasoning for ${id} must be true or false`) };
			pin.reasoning = entry.reasoning;
		}
		Object.defineProperty(out, id, { value: pin, enumerable: true, configurable: true, writable: true });
	}
	return { ok: true, settings: out };
}

/** The section→parser map for PUT /api/settings/[section]. The custom endpoint
 *  is NOT a section — it connects via POST /api/custom-provider. */
export const SETTINGS_SECTIONS = {
	general: parseGeneralSettingsBody,
	chat: parseSettingsBody,
	agent: parseAgentSettingsBody,
	appearance: parseAppearanceSettingsBody,
	graph: parseGraphSettingsBody,
	compaction: parseCompactionSettingsBody,
	models: parseModelsSettingsBody,
	dictation: parseDictationSettingsBody,
	claudeCode: parseClaudeCodeSettingsBody,
} as const;

export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;
