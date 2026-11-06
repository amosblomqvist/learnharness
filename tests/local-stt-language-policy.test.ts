/**
 * What a local take does about language: ported from pi-voice's language-detection
 * tests, minus its transcription-service harness (the audio side is tested with the runtime).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG_MODELS, LANGUAGE_DETECTION_MODEL, getCatalogModel } from "../src/core/local-stt-catalog.ts";
import {
	autoLanguagePolicy,
	detectorLanguageCode,
	languageForModel,
	localLanguagePolicy,
	missingDetectorWarning,
	pickDetectedLanguage,
	requiresLanguageDetector,
	undetectablePreferences,
	type DetectPolicy,
	type LanguageIdentification,
} from "../src/core/local-stt-language-policy.ts";

// Multilingual without native detection, so Auto relies on the shared detector.
const canary = getCatalogModel("canary-180m-flash")!;
const fun = getCatalogModel("Fun-ASR-MLT-Nano-2512")!;
const whisper = getCatalogModel("whisper-small")!;

describe("which models need the detector", () => {
	it("is true for multilingual models without native detection only", () => {
		assert.equal(canary.capabilities.languageDetection, false);
		assert.equal(requiresLanguageDetector(canary), true);
		assert.equal(requiresLanguageDetector(whisper), false, "Whisper detects natively");
		const english = CATALOG_MODELS.find((model) => model.languages.length === 1)!;
		assert.equal(requiresLanguageDetector(english), false, "one language has nothing to detect");
	});

	it("maps preferred languages onto the detector's own labels, aliases included", () => {
		assert.ok(LANGUAGE_DETECTION_MODEL.languages.includes("iw"));
		assert.equal(detectorLanguageCode("he"), "iw");
		assert.equal(detectorLanguageCode("en-GB"), "en");
		assert.equal(detectorLanguageCode("zz"), undefined);
	});
});

describe("Auto", () => {
	it("is native for models with detection, whatever the preferences", () => {
		assert.deepEqual(autoLanguagePolicy(whisper, []), { kind: "native" });
		assert.deepEqual(autoLanguagePolicy(whisper, ["en"]), { kind: "native" });
	});

	it("detects among two or more detectable preferred languages", () => {
		assert.deepEqual(autoLanguagePolicy(canary, ["en", "de"]), {
			kind: "detect", languages: ["en", "de"], allowed: ["en", "de"],
		});
	});

	it("is unsupported with one preferred language, or with one the detector cannot identify", () => {
		assert.deepEqual(autoLanguagePolicy(canary, ["en"]), { kind: "unsupported" });
		assert.deepEqual(autoLanguagePolicy(canary, []), { kind: "unsupported" });
		// Fun-ASR supports Irish, but the detector can't identify it.
		assert.equal(undetectablePreferences(fun, ["zh", "en", "ga"]).join(), "ga");
		assert.deepEqual(autoLanguagePolicy(fun, ["zh", "en", "ga"]), { kind: "unsupported" });
		assert.equal(autoLanguagePolicy(fun, ["zh", "en"]).kind, "detect");
		assert.deepEqual(undetectablePreferences(whisper, ["ga"]), []);
	});

	it("ignores preferred languages the model does not support, and repeats", () => {
		const policy = autoLanguagePolicy(canary, ["en", "xx", "en-GB", "de"]) as DetectPolicy;
		assert.deepEqual(policy.languages, ["en", "de"]);
	});
});

describe("the policy a take runs with", () => {
	it("fixes an explicit language and resolves auto per model", () => {
		assert.deepEqual(localLanguagePolicy("canary-180m-flash", "de", ["en"]), { kind: "fixed", language: "de" });
		assert.equal(localLanguagePolicy("canary-180m-flash", "auto", ["en", "de"]).kind, "detect");
		assert.equal(localLanguagePolicy("whisper-small", "auto", ["en"]).kind, "native");
		assert.equal(localLanguagePolicy("not-a-model", "auto", ["en"]).kind, "unsupported");
	});

	it("gives way to a fixed language once the preferences cannot support Auto", () => {
		assert.equal(languageForModel("auto", canary, ["en", "de"]), "auto");
		assert.equal(languageForModel("auto", canary, ["en"]), "en");
		assert.equal(languageForModel("auto", fun, ["zh", "en", "ga"]), "zh");
		assert.equal(languageForModel("auto", whisper, []), "auto");
	});

	it("keeps an exact model language, else falls back to a safe one", () => {
		assert.equal(languageForModel("de", canary, ["en"]), "de");
		assert.equal(languageForModel("xx", canary, ["en", "de"]), "auto");
		assert.equal(languageForModel("xx", canary, ["en"]), "en");
		assert.equal(languageForModel(undefined, canary, ["fr"]), "fr");
		assert.equal(languageForModel(3, canary, ["xx"]), canary.languages[0]);
	});
});

describe("reading the detector", () => {
	const policy: DetectPolicy = { kind: "detect", languages: ["en", "de"], allowed: ["en", "de"] };
	const result = (code: string | null, first = 0.9, second = 0.1): LanguageIdentification => ({
		code, allowedMass: 0.95,
		candidates: [{ code: code ?? "en", p: first }, { code: code === "en" ? "de" : "en", p: second }],
	});

	it("takes the top candidate", () => {
		assert.equal(pickDetectedLanguage(policy, result("de")).language, "de");
		assert.equal(pickDetectedLanguage(policy, result("en")).warning, undefined);
	});

	it("falls back to the first preferred language, with a warning, when nothing usable came back", () => {
		for (const bad of [result(null), result("fr"), { ...result("de"), candidates: [] }, result("de", Number.NaN, 0.1)]) {
			const picked = pickDetectedLanguage(policy, bad);
			assert.equal(picked.language, "en");
			assert.match(picked.warning ?? "", /Couldn't detect the language. Transcribed as English/);
		}
	});

	it("marks a close call as uncertain in its summary but still uses it", () => {
		const picked = pickDetectedLanguage(policy, result("de", 0.55, 0.45));
		assert.equal(picked.language, "de");
		assert.match(picked.summary, /uncertain/);
	});

	it("says what to do when the detector is not downloaded", () => {
		assert.match(missingDetectorWarning("en"), /detector isn't downloaded. Transcribed as English/);
	});
});
