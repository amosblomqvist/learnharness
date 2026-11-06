/**
 * The pure rules behind Settings → Dictation → Local: which models to list and in
 * what order, what each row says about a model, and which transcription languages
 * a model offers. No React and no fetch, so the tests can pin them directly.
 *
 * Adapted from pi-voice src/model-picker.ts, src/model-cells.ts and
 * src/recommendation-picker.ts (MIT, Copyright (c) 2026 Earendil Works contributors):
 * https://github.com/earendil-works/pi-voice. The terminal tables became rows, the
 * search is the same "every word must appear" match, and the picks and their
 * caveats keep pi-voice's wording where it still reads well in a settings dialog.
 */
import {
	ACCURACY_GRADE_HELP, CATALOG_MODELS, LOCAL_AUTO_LANGUAGE, SPEED_METER_STEPS,
	autoLanguagePolicy, benchmarkModels, canonicalLanguage, catalogModelSearchText, displayLanguage,
	getPreferredRecommendationLanguages, isChineseLanguage, languageAccuracyGrade, languageIdentity,
	modelMatchesLanguage, modelWaitSeconds, rankCatalogModels, recommendModels, requiresLanguageDetector,
	speedMeterLevel, undetectablePreferences,
	type AccuracyLetter, type CatalogModel, type MachineTier, type ModelBenchmark, type ModelRecommendation,
	type RecommendationRole, type RecommendationStatus,
} from "@/src/core";

export const ROLE_LABELS: Record<RecommendationRole, string> = { best: "Best", fast: "Fast", accurate: "Accurate" };

/** The languages the picker offers: those the benchmark can recommend for, English
 * first. A language already chosen stays listed (and removable) even if it is not. */
const BASE_LANGUAGE_CHOICES = getPreferredRecommendationLanguages(CATALOG_MODELS);
export function preferredLanguageChoices(selected: readonly string[]): string[] {
	return [...new Set([...BASE_LANGUAGE_CHOICES, ...selected.map(languageIdentity)])];
}

/** "English, German and French" for the collapsed row; long lists are counted. */
export function summarizeLanguages(languages: readonly string[]): string {
	const names = languages.map(displayLanguage);
	if (names.length <= 3) return new Intl.ListFormat("en", { type: "conjunction" }).format(names);
	return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

// ── licences ────────────────────────────────────────────────────────────────

const LICENSE_NAMES: Readonly<Record<string, string>> = {
	"apache-2.0": "Apache 2.0",
	"cc-by-4.0": "CC-BY 4.0",
	mit: "MIT",
};

/** The licence as the learner reads it. The catalog's "other" means the card carries its
 * own terms, so the row says so and links the model's page, where they live. */
export function licenseInfo(model: Pick<CatalogModel, "license" | "repository">): { label: string; href?: string } {
	const named = LICENSE_NAMES[model.license];
	if (named) return { label: named };
	if (model.license === "other") return { label: "Custom licence", href: `https://huggingface.co/${model.repository}` };
	return { label: model.license };
}

// ── speed and accuracy ──────────────────────────────────────────────────────

/** "~1.2 s", "~7 s", "~1 min": the benchmark wait for a 30 second clip. */
export function formatWait(seconds: number): string {
	if (seconds < 10) return `~${seconds.toFixed(1)} s`;
	if (seconds < 90) return `~${Math.round(seconds)} s`;
	return `~${Math.round(seconds / 60)} min`;
}

export type GradeCell = { language: string; name: string; letter: AccuracyLetter; label: string; help: string };

export type ModelRowInfo = {
	/** One cell per preferred language that has a benchmark; none when nothing was measured. */
	grades: GradeCell[];
	/** Preferred languages the model does not transcribe, by display name. */
	missing: string[];
	/** The speed meter: filled bars out of SPEED_METER_STEPS, with the wait it stands for. */
	speed?: { level: number; steps: number; waitSeconds: number };
	/** Native detection, or the shared detector, so the learner knows Auto is a possibility. */
	autoDetect: boolean;
	/** Why Auto is off for these preferences (a language the detector cannot identify). */
	autoNotice?: string;
	/** Auto will not work for this set of languages, so the language must be fixed. */
	manual: boolean;
};

export function modelRowInfo(
	model: CatalogModel,
	languages: readonly string[],
	tier: MachineTier,
	benchmark?: ModelBenchmark,
): ModelRowInfo {
	const grades: GradeCell[] = [];
	const missing: string[] = [];
	for (const language of languages) {
		if (!modelMatchesLanguage(model, language)) { missing.push(displayLanguage(language)); continue; }
		const grade = languageAccuracyGrade(model, language);
		if (grade) grades.push({ language, name: displayLanguage(language), letter: grade.letter, label: grade.label, help: ACCURACY_GRADE_HELP[grade.letter] });
	}
	const wait = modelWaitSeconds(model, tier);
	const skipped = undetectablePreferences(model, languages).map(displayLanguage);
	return {
		grades,
		missing,
		speed: wait === undefined ? undefined : { level: speedMeterLevel(wait), steps: SPEED_METER_STEPS, waitSeconds: wait },
		autoDetect: model.capabilities.languageDetection || requiresLanguageDetector(model),
		autoNotice: skipped.length
			? `Auto detect is unavailable for your preferred languages because it can't detect ${new Intl.ListFormat("en", { type: "disjunction" }).format(skipped)}.`
			: undefined,
		manual: benchmark?.manual ?? false,
	};
}

// ── the model list ──────────────────────────────────────────────────────────

/** pi-voice's search: every word of the query must appear in the model's id, name, family or size. */
export function matchesModelSearch(model: CatalogModel, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	const text = catalogModelSearchText(model);
	return tokens.every((token) => text.includes(token));
}

export type ModelListing = {
	/** The learner's languages as identities, in order, without repeats. */
	languages: string[];
	/** How far to trust the picks: only "eligible" are plain recommendations. */
	pickStatus: RecommendationStatus;
	/** Best, Fast and Accurate; a model holding several roles appears once. Empty when there is no usable pick. */
	picks: ModelRecommendation[];
	/** Models that cover every language, most accurate first (the picks left out). */
	others: CatalogModel[];
	/** Models missing a language or its benchmark: folded away until asked for. */
	folded: CatalogModel[];
	/** Set while a query is typed: every match across the whole catalog, in list order. */
	results: CatalogModel[] | null;
	benchmarks: ReadonlyMap<string, ModelBenchmark>;
};

/** Installed models and the one in use are never folded away. */
export function buildModelListing({ preferred, installed, currentId, query }: {
	preferred: readonly string[];
	installed: ReadonlySet<string>;
	currentId: string;
	query: string;
}): ModelListing {
	const languages = [...new Set(preferred.map(languageIdentity))];
	const benchmarks = languages.length ? benchmarkModels(CATALOG_MODELS, languages) : new Map<string, ModelBenchmark>();
	const recommendations = languages.length ? recommendModels(CATALOG_MODELS, languages) : [];
	const pickStatus = recommendations[0]?.status ?? "unbenchmarked";
	// Eligible picks are recommendations; an experimental pick is shown with its caveat;
	// unsupported and unbenchmarked ones are not offered as picks at all (pi-voice sends
	// the learner to the full list instead).
	const picks = recommendations.filter((pick) => pickStatus === "eligible" ? pick.status === "eligible" : pick.status === "experimental");
	const picked = new Set(picks.map((pick) => pick.model.id));

	const error = (model: CatalogModel) => benchmarks.get(model.id)?.error ?? Number.POSITIVE_INFINITY;
	const byError = (left: CatalogModel, right: CatalogModel) => error(left) - error(right);
	const measured = CATALOG_MODELS.filter((model) => benchmarks.has(model.id));
	const usable = measured.filter((model) => benchmarks.get(model.id)!.usable).sort(byError);
	const unusable = measured.filter((model) => !benchmarks.get(model.id)!.usable).sort(byError);
	const unmeasured = rankCatalogModels(
		CATALOG_MODELS.filter((model) => !benchmarks.has(model.id)), languages, (model) => installed.has(model.id),
	);

	const keep = (model: CatalogModel) => !picked.has(model.id);
	const coversAll = (model: CatalogModel) => languages.every((language) => modelMatchesLanguage(model, language));
	const pinned = (model: CatalogModel) => installed.has(model.id) || model.id === currentId;
	const others = [...usable, ...unusable, ...unmeasured.filter(coversAll)].filter(keep);
	const rest = unmeasured.filter((model) => !coversAll(model)).filter(keep);
	const unfolded = [...others, ...rest.filter(pinned)];
	const folded = rest.filter((model) => !pinned(model));

	const trimmed = query.trim();
	const results = trimmed
		// The whole catalog, one list: the picks first, then the usual order.
		? [...picks.map((pick) => pick.model), ...unfolded, ...folded].filter((model) => matchesModelSearch(model, trimmed))
		: null;
	return { languages, pickStatus, picks, others: unfolded, folded, results, benchmarks };
}

/** The caveat shown under the heading when the picks are not a plain recommendation. */
export function pickNotice(listing: ModelListing): string | undefined {
	const names = listing.languages.map(displayLanguage).join(" + ");
	if (listing.picks.length > 0 && listing.pickStatus === "experimental") {
		const worst = listing.picks[0]!.worstLanguage;
		return `Experimental: this is the best option we found for ${names}, but it may make frequent mistakes${worst ? ` in ${displayLanguage(worst)}` : ""}.`;
	}
	if (listing.pickStatus === "unsupported") return `No model we tested is likely to give a usable transcript for ${names}. You can still browse the list.`;
	if (listing.pickStatus === "unbenchmarked") return `Model cards claim support for ${names}, but we have no accuracy measurements for it. Browse the list to pick one.`;
	return undefined;
}

/** Why a pick is worth a second look, for the rows that earn a note. */
export function pickCaveat(pick: ModelRecommendation): string | undefined {
	if (pick.status === "eligible" && pick.nearFloor && pick.worstLanguage) return `Lower accuracy in ${displayLanguage(pick.worstLanguage)}.`;
	return undefined;
}

// ── transcription language ──────────────────────────────────────────────────

export type TranscriptionChoice = { value: string; label: string };

/** Auto (only where the policy allows it) and the model's own languages, the learner's first. */
export function transcriptionChoices(model: CatalogModel, preferred: readonly string[]): {
	choices: TranscriptionChoice[];
	autoOffered: boolean;
	/** The detect policy's languages, for a hint under the row. */
	detects: string[];
} {
	const policy = autoLanguagePolicy(model, preferred);
	const wanted = new Set(preferred.map(languageIdentity));
	const codes = [...new Set(model.languages)];
	const name = (code: string) => {
		const base = canonicalLanguage(code);
		// A variant is named only where the model has several of one language (pt and pt-BR).
		return displayLanguage(codes.filter((other) => canonicalLanguage(other) === base).length > 1 ? code : base);
	};
	const languages = codes
		.map((code) => ({ value: code, label: name(code), preferred: wanted.has(languageIdentity(code)) }))
		.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
		.map(({ value, label }) => ({ value, label }));
	const autoOffered = policy.kind !== "unsupported";
	return {
		choices: [...(autoOffered ? [{ value: LOCAL_AUTO_LANGUAGE, label: "Auto detect" }] : []), ...languages],
		autoOffered,
		detects: policy.kind === "detect" ? policy.languages.map((language) => name(language)) : [],
	};
}

/** The Chinese script row is only relevant when Chinese can come out. */
export function showsChineseOutput(preferred: readonly string[], language: string): boolean {
	return preferred.some(isChineseLanguage) || (language !== LOCAL_AUTO_LANGUAGE && isChineseLanguage(language));
}
