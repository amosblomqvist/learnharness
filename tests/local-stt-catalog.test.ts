/**
 * The on-device model catalog, recommendations and display helpers (ported from
 * pi-voice's catalog, languages, recommendations and model-ratings tests).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import benchmark from "../src/core/local-stt-recommendations.json" with { type: "json" };
import {
	CATALOG_MODELS,
	LANGUAGE_DETECTION_MODEL,
	canonicalLanguage,
	catalogModelSearchText,
	catalogModelUrl,
	displayLanguage,
	formatBinarySize,
	getCatalogModel,
	getDownloadableModel,
	isCatalogLanguage,
	isCatalogModelId,
	isDownloadableModelId,
	languageIdentity,
	modelMatchesLanguage,
	rankCatalogModels,
	resolveModelLanguage,
} from "../src/core/local-stt-catalog.ts";
import {
	ACCURACY_GRADE_HELP,
	accuracyGrade,
	benchmarkModels,
	getPreferredRecommendationLanguages,
	languageAccuracyGrade,
	modelWaitSeconds,
	recommendModels,
	speedMeterLevel,
} from "../src/core/local-stt-recommendations.ts";

const ALL_ROLES = ["accurate", "best", "fast"];
/** The measured error of the language a pick handles worst. */
const worstError = (pick: { model: { id: string }; worstLanguage?: string }) =>
	(benchmark.models as Record<string, { accuracy: Record<string, { error: number }> }>)[pick.model.id]!.accuracy[pick.worstLanguage!]!.error;
const languages = [...new Set(CATALOG_MODELS.flatMap((model) => model.languages.map(languageIdentity)))];

describe("catalog data", () => {
	it("has 29 models with unique ids, and every benchmark names a catalog model", () => {
		assert.equal(CATALOG_MODELS.length, 29);
		const ids = new Set(CATALOG_MODELS.map((model) => model.id));
		assert.equal(ids.size, CATALOG_MODELS.length);
		for (const id of Object.keys(benchmark.models)) assert.ok(ids.has(id), `stale benchmark: ${id}`);
	});

	it("every entry names a pinned file whose size and SHA-256 can be checked", () => {
		for (const model of [...CATALOG_MODELS, LANGUAGE_DETECTION_MODEL]) {
			assert.match(model.sha256, /^[0-9a-f]{64}$/, model.id);
			assert.match(model.revision, /^[0-9a-f]{40}$/, model.id);
			assert.ok(Number.isInteger(model.size) && model.size > 0, model.id);
			assert.ok(model.license.length > 0, `${model.id} shows its licence`);
		}
	});

	it("builds download URLs only from the catalog's repository, revision and filename", () => {
		const model = getCatalogModel("whisper-small")!;
		assert.equal(
			catalogModelUrl(model),
			`https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`,
		);
		assert.match(catalogModelUrl(LANGUAGE_DETECTION_MODEL), /^https:\/\/huggingface\.co\/handy-computer\//);
		assert.equal(catalogModelUrl({ ...model, filename: "a b/c.gguf" }).endsWith("/a%20b/c.gguf"), true);
	});

	it("knows which ids can be downloaded: the catalog and the detector, nothing else", () => {
		assert.equal(isCatalogModelId("whisper-small"), true);
		assert.equal(isCatalogModelId(LANGUAGE_DETECTION_MODEL.id), false);
		assert.equal(isDownloadableModelId(LANGUAGE_DETECTION_MODEL.id), true);
		assert.equal(getDownloadableModel(LANGUAGE_DETECTION_MODEL.id), LANGUAGE_DETECTION_MODEL);
		for (const bad of ["", "../etc/passwd", "whisper-small/../x", 3, null, undefined]) {
			assert.equal(isDownloadableModelId(bad), false, String(bad));
		}
	});
});

describe("languages", () => {
	it("normalizes case, regions and aliases", () => {
		assert.equal(canonicalLanguage(" TL-ph "), "tl");
		assert.equal(languageIdentity(" TL-ph "), "fil");
		assert.equal(languageIdentity("fil"), "fil");
		assert.equal(languageIdentity("no"), "nb");
		assert.equal(languageIdentity("nb"), "nb");
		assert.equal(languageIdentity("en-GB"), "en");
	});

	it("resolves a model's exact code, preferring an explicit region", () => {
		const model = { languages: ["en-US", "en-GB", "no", "tl", "zh"] };
		assert.equal(resolveModelLanguage(model, "fil"), "tl");
		assert.equal(resolveModelLanguage(model, "nb"), "no");
		assert.equal(resolveModelLanguage(model, " EN-gb "), "en-GB");
		assert.equal(resolveModelLanguage(model, "en"), "en-US");
		assert.equal(resolveModelLanguage(model, "unknown"), undefined);
	});

	it("accepts languages some catalog model transcribes, by code or identity", () => {
		for (const ok of ["en", "de", "fil", "tl", "nb", "zh", "en-US"]) assert.equal(isCatalogLanguage(ok), true, ok);
		for (const bad of ["xx", "", "auto", 3, null]) assert.equal(isCatalogLanguage(bad), false, String(bad));
	});

	it("names languages for display, with Mandarin spelled out", () => {
		assert.equal(displayLanguage("en"), "English");
		assert.equal(displayLanguage("zh"), "Mandarin (Chinese)");
		assert.equal(displayLanguage("yue"), "Cantonese");
	});
});

describe("catalog helpers", () => {
	it("ranks by preferred languages matched, then downloaded, then name", () => {
		const german = rankCatalogModels(CATALOG_MODELS, ["de"]);
		assert.equal(modelMatchesLanguage(german[0]!, "de"), true);
		const downloaded = getCatalogModel("whisper-small")!;
		const ranked = rankCatalogModels(CATALOG_MODELS.filter((m) => m.family === "whisper"), [], (m) => m.id === downloaded.id);
		assert.equal(ranked[0]!.id, downloaded.id);
	});

	it("searches ids, names, families and parameter counts, in lower case", () => {
		const model = getCatalogModel("parakeet-tdt-0.6b-v3")!;
		assert.equal(catalogModelSearchText(model), `${model.id} ${model.name} ${model.family} ${model.parameters}`.toLowerCase());
		assert.ok(catalogModelSearchText(model).includes("0.6b"));
	});

	it("formats sizes in binary units", () => {
		assert.equal(formatBinarySize(5 * 1024 * 1024), "5 MiB");
		assert.equal(formatBinarySize(1.5 * 1024 ** 3), "1.5 GiB");
		assert.equal(formatBinarySize(11 * 1024 ** 3), "11 GiB");
	});
});

describe("recommendations", () => {
	it("assigns every role, and usable models never mix with fallback alternatives", () => {
		for (const language of languages) {
			for (const wanted of [[language], ["en", language]]) {
				const picks = recommendModels(CATALOG_MODELS, wanted);
				assert.deepEqual(picks.flatMap((pick) => pick.roles).sort(), ALL_ROLES, wanted.join("+"));
				if (picks.some((pick) => pick.status === "eligible")) {
					assert.ok(picks.every((pick) => pick.status === "eligible"));
					assert.ok(picks.every((pick) => worstError(pick) < benchmark.methodology.maxLanguageErrorPercent));
				} else {
					assert.equal(picks.length, 1, "fallbacks carry all roles");
				}
			}
		}
	});

	it("gives identical recommendations for language aliases", () => {
		for (const [alias, canonical] of [["tl", "fil"], ["no", "nb"]] as const) {
			assert.deepEqual(recommendModels(CATALOG_MODELS, ["en", alias]), recommendModels(CATALOG_MODELS, ["en", canonical]));
		}
	});

	it("labels fallbacks and offers a language only when it is eligible or experimental", () => {
		const models: Record<string, { accuracy: Record<string, { ciLower?: number }> }> = benchmark.models;
		const preferred = new Set(getPreferredRecommendationLanguages(CATALOG_MODELS));
		for (const language of languages) {
			const pick = recommendModels(CATALOG_MODELS, [language])[0]!;
			if (pick.worstLanguage === undefined) assert.equal(pick.status, "unbenchmarked");
			else if (worstError(pick) >= benchmark.methodology.maxLanguageErrorPercent) {
				const lower = models[pick.model.id]?.accuracy[pick.worstLanguage]?.ciLower;
				const max = benchmark.methodology.experimentalMaxErrorPercent;
				const experimental = worstError(pick) < max || (lower !== undefined && lower <= max);
				assert.equal(pick.status, experimental ? "experimental" : "unsupported");
			}
			assert.equal(preferred.has(language), ["eligible", "experimental"].includes(pick.status));
		}
		const unmeasured = { ...CATALOG_MODELS[0]!, id: "unmeasured" };
		assert.equal(recommendModels([unmeasured], ["en"])[0]?.status, "unbenchmarked");
		assert.deepEqual(recommendModels([], ["en"]), []);
	});

	it("lists English first among the preferred-language choices", () => {
		const choices = getPreferredRecommendationLanguages(CATALOG_MODELS);
		assert.equal(choices[0], "en");
		assert.ok(choices.length > 10);
	});

	it("benchmarks models on every chosen language", () => {
		const marks = benchmarkModels(CATALOG_MODELS, ["en"]);
		assert.ok(marks.size > 5);
		assert.ok([...marks.values()].some((mark) => mark.usable));
	});
});

describe("grades and the speed meter", () => {
	it("changes letters and modifiers at the documented proportional boundaries", () => {
		const step = Math.cbrt(2);
		const boundaries: [number, string, string][] = [
			[5 / step ** 2, "A+", "A"], [5 / step, "A", "A-"], [5, "A-", "B+"],
			[10 / step ** 2, "B+", "B"], [10 / step, "B", "B-"], [10, "B-", "C+"],
			[20 / step ** 2, "C+", "C"], [20 / step, "C", "C-"], [20, "C-", "D"], [30, "D", "F"],
		];
		assert.equal(accuracyGrade(0).label, "A+");
		for (const [boundary, below, at] of boundaries) {
			assert.equal(accuracyGrade(boundary - 1e-8).label, below);
			assert.equal(accuracyGrade(boundary).label, at);
		}
		assert.equal(accuracyGrade(150).label, "F");
		assert.equal(languageAccuracyGrade({ ...CATALOG_MODELS[0]!, id: "unmeasured" }, "en"), undefined);
		assert.deepEqual(Object.keys(ACCURACY_GRADE_HELP), ["A", "B", "C", "D", "F"]);
	});

	it("distinguishes all six speed levels and unmeasured speed", () => {
		assert.equal(speedMeterLevel(0), 5);
		for (const [index, boundary] of [1.5, 3, 5, 10, 20].entries()) {
			assert.equal(speedMeterLevel(boundary - 1e-8), 5 - index);
			assert.equal(speedMeterLevel(boundary), 4 - index);
		}
		assert.equal(speedMeterLevel(100), 0);
		assert.equal(modelWaitSeconds({ ...CATALOG_MODELS[0]!, id: "unmeasured" }), undefined);
		assert.ok(modelWaitSeconds(getCatalogModel("whisper-small")!, "cpu")! > 0);
	});
});
