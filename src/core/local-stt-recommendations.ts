/**
 * Model recommendations, accuracy grades and the speed meter for the on-device
 * dictation list. Ported from pi-voice src/recommendations.ts and
 * catalog/recommendations.json (MIT, Copyright (c) 2026 Earendil Works
 * contributors): https://github.com/earendil-works/pi-voice
 *
 * Browser-safe. The benchmark figures were measured by pi-voice's authors on
 * their rig; the Settings list shows them as a guide, not a prediction.
 */
import recommendationData from "./local-stt-recommendations.json" with { type: "json" };
import {
	displayLanguage,
	languageIdentity as recommendationLanguage,
	modelMatchesLanguage as modelMatchesRecommendationLanguage,
	rankCatalogModels,
	type CatalogModel,
} from "./local-stt-catalog.ts";
import { undetectablePreferences } from "./local-stt-language-policy.ts";

export type MachineTier = "accelerated" | "cpu";

export type RecommendationRole = "best" | "fast" | "accurate";

export type RecommendationStatus =
	| "eligible"
	| "experimental"
	| "unsupported"
	| "unbenchmarked";

export type ModelRecommendation = {
	model: CatalogModel;
	roles: RecommendationRole[];
	status: RecommendationStatus;
	/** The chosen language this model handles worst. */
	worstLanguage?: string;
	/** Usable, but close enough to the floor that the list says so. */
	nearFloor?: boolean;
};

type AccuracyCell = {
	error: number;
	ciLower?: number;
};
type RecommendationModelData = {
	accuracy: Record<string, AccuracyCell>;
	performance: Partial<Record<MachineTier, number>>;
};
/**
 * The picks in plain words. Wait is the seconds after a dictation of
 * `dictationSeconds`, on the benchmark GPU unless said otherwise. When
 * several languages were chosen, automatic switching is preferred, but a
 * usable manual model beats an automatic model over the error floor. Quality
 * is a hard constraint whenever any model stays under
 * `maxLanguageErrorPercent` on every chosen language. The overall pick has
 * the lowest error plus wait penalty, where the first `freeWaitSeconds` cost
 * nothing and each second beyond costs `waitWeight` points; its
 * `overallMaxWaitSeconds` limit relaxes before quality does. The fast pick is
 * judged on the benchmark CPU: the most accurate usable model within
 * `fastCpuMaxWaitSeconds`, else the quickest usable model. The most accurate
 * pick has the lowest error among usable models within
 * `accurateMaxWaitSeconds`, else the most accurate usable model. When no
 * usable model exists, the closest model carries every role. It remains
 * experimental below `experimentalMaxErrorPercent`, or when its lower
 * confidence bound reaches that cutoff; otherwise it is unsupported. A pick
 * that is usable but reaches `noteMinErrorPercent` on some chosen language is
 * still recommended, with the shortfall named rather than left to be
 * discovered: the usable band spans most of an order of magnitude, so silence
 * across all of it would say the same thing about very different models.
 */
type Methodology = {
	dictationSeconds: number;
	freeWaitSeconds: number;
	waitWeight: number;
	overallMaxWaitSeconds: number;
	maxLanguageErrorPercent: number;
	noteMinErrorPercent: number;
	experimentalMaxErrorPercent: number;
	fastCpuMaxWaitSeconds: number;
	accurateMaxWaitSeconds: number;
};
type RecommendationData = {
	methodology: Methodology;
	models: Record<string, RecommendationModelData>;
};

const DATA: RecommendationData = recommendationData;

export type AccuracyLetter = "A" | "B" | "C" | "D" | "F";

export type AccuracyGrade = {
	letter: AccuracyLetter;
	/** The letter with its modifier, e.g. "A-" or "B+"; D and F carry none. */
	label: string;
};

/** Display bands are independent of recommendation eligibility policy. */
const ACCURACY_CEILINGS = { A: 5, B: 10, C: 20, D: 30 } as const;
/** Each sub-grade step multiplies the measured error by this. */
const SUB_GRADE_STEP = Math.cbrt(2);

/**
 * A compact benchmark comparison, not a prediction of editing effort. A–C
 * modifiers use proportional changes in error. Keep ACCURACY_GRADE_HELP in
 * sync when changing display bands.
 */
export function accuracyGrade(errorPercent: number): AccuracyGrade {
	if (errorPercent >= ACCURACY_CEILINGS.D) return { letter: "F", label: "F" };
	if (errorPercent >= ACCURACY_CEILINGS.C) return { letter: "D", label: "D" };
	const letters: [AccuracyLetter, number][] = [
		["A", ACCURACY_CEILINGS.A],
		["B", ACCURACY_CEILINGS.B],
		["C", ACCURACY_CEILINGS.C],
	];
	const [letter, ceiling] = letters.find(([, limit]) => errorPercent < limit)!;
	const modifier = errorPercent < ceiling / SUB_GRADE_STEP ** 2
		? "+"
		: errorPercent < ceiling / SUB_GRADE_STEP
			? ""
			: "-";
	return { letter, label: `${letter}${modifier}` };
}

/** What each grade means, for a legend (from pi-voice's model-ratings-help.md). */
export const ACCURACY_GRADE_HELP: Readonly<Record<AccuracyLetter, string>> = {
	A: "Very few mistakes.",
	B: "Some mistakes.",
	C: "Frequent mistakes. Some details may get lost.",
	D: "Many mistakes. Expect to check or repeat yourself.",
	F: "Often unclear.",
};

/** Processing time for the display's reference recording on the benchmark tier. */
export function modelWaitSeconds(
	model: CatalogModel,
	tier: MachineTier = "accelerated",
): number | undefined {
	const xrt = DATA.models[model.id]?.performance[tier];
	return xrt ? BENCHMARK_DICTATION_SECONDS / xrt : undefined;
}

// Display-only reference and bands; changing recommendation wait budgets must
// not silently redefine the meter. SPEED_METER_HELP explains it to the reader.
const BENCHMARK_DICTATION_SECONDS = 30;
const SPEED_CUTOFF_SECONDS = [1.5, 3, 5, 10, 20] as const;
export const SPEED_METER_STEPS = SPEED_CUTOFF_SECONDS.length;
/** The reader's key to the speed bars (from pi-voice's model-ratings-help.md). */
export const SPEED_METER_HELP =
	`The speed bars show how long it took to transcribe ${BENCHMARK_DICTATION_SECONDS} seconds of audio on a 2020 laptop ` +
	"(Lenovo T14s, 4750U CPU/GPU). Your machine may be faster or slower.";
/** Seconds to transcribe the benchmark clip for each count of filled bars, from five down to none. */
export const SPEED_METER_BANDS = ["under 1.5 s", "1.5 to 3 s", "3 to 5 s", "5 to 10 s", "10 to 20 s", "20 s or more"] as const;

export function speedMeterLevel(processingSeconds: number): number {
	return SPEED_CUTOFF_SECONDS.filter((cutoff) => processingSeconds < cutoff).length;
}

/**
 * The model's grade for one language, or undefined when the benchmark has
 * no measurement for it (whether or not the model claims the language).
 */
export function languageAccuracyGrade(
	model: CatalogModel,
	language: string,
): AccuracyGrade | undefined {
	const cell = DATA.models[model.id]?.accuracy[recommendationLanguage(language)];
	return cell ? accuracyGrade(cell.error) : undefined;
}

type ScoredModel = {
	model: CatalogModel;
	/** Geometric mean of the per-language error, in percent. */
	error: number;
	/** The chosen language this model handles worst, and its error in percent. */
	worstLanguage: string;
	worstError: number;
	/** Lower confidence bound for that error, when the benchmark provides one. */
	worstCiLower: number | undefined;
	/** Seconds after the dictation on the benchmark GPU. */
	waitSeconds: number;
	/** The same on the benchmark CPU, when measured. */
	cpuWaitSeconds: number | undefined;
	/** Needs the language set by hand for this set of languages. */
	manual: boolean;
	score: number;
};

function scoreModels(
	models: readonly CatalogModel[],
	languages: readonly string[],
): ScoredModel[] {
	const wanted = [...new Set(languages.map(recommendationLanguage))];
	const method = DATA.methodology;
	const scored: ScoredModel[] = [];

	for (const model of models) {
		if (!wanted.every((language) => modelMatchesRecommendationLanguage(model, language))) continue;
		const data = DATA.models[model.id];
		const cells = wanted.map((language) => data?.accuracy[language]);
		const xrt = data?.performance.accelerated;
		if (!data || !xrt || cells.some((cell) => cell === undefined)) continue;
		const accuracyCells = cells as AccuracyCell[];
		const numericErrors = accuracyCells.map((cell) => cell.error);
		const error = Math.exp(
			numericErrors.reduce((sum, value) => sum + Math.log(value), 0) /
				numericErrors.length,
		);
		const waitSeconds = method.dictationSeconds / xrt;
		const cpuXrt = data.performance.cpu;
		const worstError = Math.max(...numericErrors);
		const worstIndex = numericErrors.indexOf(worstError);
		scored.push({
			model,
			error,
			worstLanguage: wanted[worstIndex]!,
			worstError,
			worstCiLower: accuracyCells[worstIndex]!.ciLower,
			waitSeconds,
			cpuWaitSeconds: cpuXrt ? method.dictationSeconds / cpuXrt : undefined,
			manual: wanted.length > 1 && undetectablePreferences(model, languages).length > 0,
			score: error + method.waitWeight * Math.max(0, waitSeconds - method.freeWaitSeconds),
		});
	}
	return scored;
}

/** A model's benchmark against a set of chosen languages, for the model list. */
export type ModelBenchmark = {
	/** Geometric mean of the per-language error, in percent. */
	error: number;
	/** Every chosen language is under the usability floor. */
	usable: boolean;
	/** Needs the language set by hand for this set of languages. */
	manual: boolean;
};

/**
 * Benchmarks for every model measured on all the chosen languages, keyed by
 * model id. Models that lack a language or a measurement are absent.
 */
export function benchmarkModels(
	models: readonly CatalogModel[],
	languages: readonly string[],
): Map<string, ModelBenchmark> {
	const floor = DATA.methodology.maxLanguageErrorPercent;
	return new Map(
		scoreModels(models, languages).map((candidate) => [
			candidate.model.id,
			{
				error: candidate.error,
				usable: candidate.worstError < floor,
				manual: candidate.manual,
			},
		]),
	);
}

function fallbackRecommendation(
	models: readonly CatalogModel[],
	languages: readonly string[],
): ModelRecommendation[] {
	const wanted = [...new Set(languages.map(recommendationLanguage))];
	const compatible = models.filter(
		(model) =>
			wanted.every((language) =>
				modelMatchesRecommendationLanguage(model, language),
			) && (wanted.length === 1 || undetectablePreferences(model, languages).length === 0),
	);
	const model = rankCatalogModels(compatible.length ? compatible : models, wanted)[0];
	return model
		? [{ model, roles: ["best", "fast", "accurate"], status: "unbenchmarked" }]
		: [];
}

function lowest<T>(items: readonly T[], key: (item: T) => number): T | undefined {
	let best: T | undefined;
	for (const item of items) {
		if (best === undefined || key(item) < key(best)) best = item;
	}
	return best;
}

/**
 * Overall, fast, and accurate picks. Every role is always assigned: when no
 * other model earns the fast or accurate role, the overall pick carries it,
 * so callers can rely on all three without special cases. The picks do not
 * depend on the machine: they are judged on the benchmark rig, and the Try
 * it step measures the real wait.
 */
export function recommendModels(
	models: readonly CatalogModel[],
	languages: readonly string[],
): ModelRecommendation[] {
	const scored = scoreModels(models, languages);
	if (scored.length === 0) return fallbackRecommendation(models, languages);
	const method = DATA.methodology;
	const byError = (candidate: ScoredModel) => candidate.error;

	// Quality outranks both latency and automatic switching. Prefer an
	// automatic model when one clears the floor, then a usable manual model.
	// Only compare over-floor models when no usable candidate exists at all.
	const withinFloor = scored.filter(
		(candidate) => candidate.worstError < method.maxLanguageErrorPercent,
	);
	const detectingWithinFloor = withinFloor.filter((candidate) => !candidate.manual);
	const hasUsableModel = withinFloor.length > 0;
	const pool = detectingWithinFloor.length
		? detectingWithinFloor
		: hasUsableModel
			? withinFloor
			: scored;

	const withinOverallBudget = pool.filter(
		(candidate) => candidate.waitSeconds <= method.overallMaxWaitSeconds,
	);
	const overall = hasUsableModel
		? lowest(
				withinOverallBudget.length ? withinOverallBudget : pool,
				(candidate) => candidate.score,
			)!
		: lowest(pool, (candidate) => candidate.worstError + candidate.error / 1000)!;

	// Fast means the best quality inside the CPU target. If every usable model
	// misses that target, prefer the quickest usable model rather than a fast
	// model whose transcript is not useful.
	const onCpu = pool.filter(
		(candidate): candidate is ScoredModel & { cpuWaitSeconds: number } =>
			candidate.cpuWaitSeconds !== undefined,
	);
	const withinCpuBudget = onCpu.filter(
		(candidate) => candidate.cpuWaitSeconds <= method.fastCpuMaxWaitSeconds,
	);
	const fast = hasUsableModel
		? lowest(withinCpuBudget, byError) ??
			lowest(onCpu, (candidate) => candidate.cpuWaitSeconds + candidate.error / 1000) ??
			overall
		: overall;

	const accurate = hasUsableModel
		? lowest(
				pool.filter((candidate) => candidate.waitSeconds <= method.accurateMaxWaitSeconds),
				byError,
			) ?? lowest(pool, byError) ?? overall
		: overall;

	const byId = new Map<string, ModelRecommendation>();
	for (const [candidate, role] of [
		[overall, "best"],
		[fast, "fast"],
		[accurate, "accurate"],
	] as const) {
		const current = byId.get(candidate.model.id);
		if (current) current.roles.push(role);
		else {
			byId.set(candidate.model.id, {
				model: candidate.model,
				roles: [role],
				status: hasUsableModel
					? "eligible"
					: candidate.worstError < method.experimentalMaxErrorPercent ||
							(candidate.worstCiLower !== undefined && candidate.worstCiLower <= method.experimentalMaxErrorPercent)
						? "experimental"
						: "unsupported",
				worstLanguage: candidate.worstLanguage,
				nearFloor:
					candidate.worstError >= method.noteMinErrorPercent &&
					candidate.worstError < method.maxLanguageErrorPercent,
			});
		}
	}
	return [...byId.values()];
}

/**
 * Languages suitable for the recommendation-oriented preferred-language
 * list. Experimental languages remain discoverable; unsupported and
 * unbenchmarked model-card claims stay available only in model-specific
 * language controls.
 */
export function getPreferredRecommendationLanguages(
	models: readonly CatalogModel[],
): string[] {
	const languages = new Set(
		models.flatMap((model) => model.languages.map(recommendationLanguage)),
	);
	return [...languages]
		.filter((language) => {
			const status = recommendModels(models, [language])[0]?.status;
			return status === "eligible" || status === "experimental";
		})
		.sort((left, right) => {
			if (left === "en") return -1;
			if (right === "en") return 1;
			return displayLanguage(left).localeCompare(displayLanguage(right));
		});
}
