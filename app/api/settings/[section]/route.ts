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
 *   clamped value is stored — model swaps just work, same as the
 *   defaults route. The agent section additionally validates prompt
 *   switches — under the orphan-heal contract (interlude 2026-09-26): an
 *   ON switch with its override file present is valid as-is; an ON whose
 *   file is gone (deleted outside the app, a disk wipe, or a record from
 *   before the delete-clears-switch fix) is an ORPHAN and is healed to
 *   OFF (the key drops) inside the same write — never a 400. Invariant:
 *   a user can never get stuck unable to write settings, and switch
 *   state never contradicts file reality for long (the delete route
 *   clears the switch by construction; this is the backstop).
 *
 * The static siblings (defaults, prompts) take precedence over this
 * dynamic segment — Next resolves static routes first, so "prompts" never
 * lands here.
 */

import type { AgentSettings, ChatSettings, ModelsSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	allSegmentPaths,
	clampChatLevel,
	clampModelsLevels,
	effectiveSettings,
	promptOverrides,
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
	let agentHealed: AgentSettings | undefined;

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
	if (section === "agent") {
		// Orphan-heal (contract fix, interlude 2026-09-26): an ON switch
		// whose override file is gone (or whose segment left the source
		// tree) is healed to OFF (key dropped) inside this write — never a
		// 400. The old 400 trapped users: the record's own orphaned ON was
		// mirrored back by every write while the disabled toggle couldn't
		// reach the OFF escape hatch. An ON with a real file stays valid.
		const agent = parsed.settings as AgentSettings;
		const segments = new Set(allSegmentPaths());
		const orphans: string[] = [];
		for (const [path, on] of Object.entries(agent.prompts ?? {})) {
			if (on && (!segments.has(path) || promptOverrides.readOverride(path) === null)) orphans.push(path);
		}
		if (orphans.length > 0) {
			const prompts = { ...(agent.prompts ?? {}) };
			for (const path of orphans) delete prompts[path];
			agentHealed = { ...agent, prompts };
			console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
		}
	}

	// Clamp-on-write (owner ruling, interlude 2026-09-22): a model swap
	// with a pinned thinking level NEVER errors — the pin clamps to the
	// new model's nearest supported level (pi's nearest-clamp, the same
	// translation piEngineForSpec applies at runtime) and the clamped
	// value is what lands in the record. The chat section's bare levels
	// clamp against the record's resolved strong slot (the chain's
	// fallback); the models section's slots each carry their own model.
	// The agent section lands HEALED when orphaned prompt switches were
	// found above (the healed copy) — after every write the record and
	// file reality agree.
	const sectionOut =
		section === "chat"
			? clampChatLevel(parsed.settings as ChatSettings, effectiveSettings().models.strong)
			: section === "models"
				? clampModelsLevels(parsed.settings as ModelsSettings)
				: section === "agent" && agentHealed
					? agentHealed
					: parsed.settings;

	// Read-modify-write ONE section of the record; everything else rides
	// along untouched (other sections, unknown keys — sanitize preserves).
	const next = { ...record, [section]: sectionOut };
	writeSettingsRecord(next);
	return Response.json({ settings: next });
}
