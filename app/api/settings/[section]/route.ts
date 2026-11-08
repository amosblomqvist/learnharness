/**
 * PUT /api/settings/[section] — section-scoped record writes
 * (settings-storage wave, 2026-09-19). One PUT replaces ONE section
 * replace-whole (absent fields = absent overrides — the house settings
 * discipline, same as the per-chat and defaults routes); sections are
 * independent, so partial writes can never clobber each other.
 *
 *   section ∈ general | chat | agent | appearance | graph | compaction | models | dictation
 *   Body: the complete desired section object. Parse + validate strictly
 *   (server/settings-body.ts): a bad shape/type is a 400 carrying the
 *   supported list where one exists. The chat and models sections
 *   additionally pass the catalog gate (validateChatSettings /
 *   validateModelsSettings — unknown provider/model = 400, except unchanged
 *   model-slot selections may remain saved while unavailable). Thinking
 *   levels never reject a write (owner, interlude 2026-09-22): a pinned
 *   level CLAMPS to the named model's nearest supported level and the
 *   clamped level is stored, as in the defaults route.
 * Prompt text and history use their dedicated routes and data store.
 *
 * The static siblings (defaults, prompts) take precedence over this
 * dynamic segment — Next resolves static routes first, so "prompts" never
 * lands here.
 */

import type { ChatSettings, ModelsSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	clampChatLevel,
	clampModelsLevels,
	effectiveSettings,
	fileAccessConfigurationError,
	readSettingsRecord,
	validateChatSettings,
	validateModelsSettings,
	writeSettingsRecord,
	type SettingsBodyResult,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** One parser, result type erased to the common envelope. */
type AnySectionParser = (body: unknown) => SettingsBodyResult<unknown>;

export async function PUT(request: Request, ctx: { params: Promise<{ section: string }> }) {
	const { section } = await ctx.params;
	const parser = (SETTINGS_SECTIONS as Record<string, AnySectionParser>)[section];
	if (!parser) {
		return Response.json(
			{ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) },
			{ status: 404 },
		);
	}
	const body = await request.json().catch(() => null);
	const parsed = parser(body);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}
	// Compare against the same record that this whole-section write replaces.
	const record = readSettingsRecord() ?? { version: 1 };

	// Section-specific cross-validation (against the catalog / the prompt
	// store) — the parsers only see shapes.
	if (section === "chat") {
		const verdict = validateChatSettings(parsed.settings as ChatSettings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	// New/replaced slot models pass the catalog gate. Unchanged saved model
	// references may survive disconnect, including thinking-preference edits,
	// so each unavailable slot can be repaired independently of the others.
	if (section === "models") {
		const verdict = validateModelsSettings(parsed.settings as ModelsSettings, record.models);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}

	// Clamp-on-write (owner ruling, interlude 2026-09-22): a model swap
	// with a pinned thinking level NEVER errors — the pin clamps to the
	// new model's nearest supported level (pi's nearest-clamp, the same
	// translation piEngineForSpec applies at runtime) and the clamped
	// value is what lands in the record. The chat section's bare levels
	// clamp against the record's resolved strong slot (the chain's
	// fallback); the models section's slots each carry their own model.
	const sectionOut =
		section === "chat"
			? clampChatLevel(parsed.settings as ChatSettings, effectiveSettings().models.strong)
			: section === "models"
				? clampModelsLevels(parsed.settings as ModelsSettings)
				: parsed.settings;

	// Read-modify-write ONE section of the record; everything else rides
	// along untouched (other sections, unknown keys — sanitize preserves).
	const next = { ...record, [section]: sectionOut };
	const stored = writeSettingsRecord(next);
	const fileAccessError = fileAccessConfigurationError();
	return Response.json({ settings: stored, ...(fileAccessError ? { fileAccessError } : {}) });
}
