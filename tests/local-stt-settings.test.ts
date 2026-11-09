/**
 * The Local dictation fields of the dictation settings: factory defaults, the
 * resolved view, sanitizing a stored record, the PUT body parser and the body the
 * client writes. Deepgram and Groq records must stay exactly as they were.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { dictationSettingsBody, isDictationProvider } from "../src/core/dictation.ts";
import { defaultLocalPreferredLanguages, normalizeLocalPreferredLanguages } from "../src/core/local-stt.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

describe("defaults", () => {
	it("is a third engine that is never the default", () => {
		assert.equal(isDictationProvider("local"), true);
		assert.equal(FACTORY_SETTINGS.dictation.provider, "deepgram");
		assert.deepEqual(FACTORY_SETTINGS.dictation, {
			language: "en", provider: "deepgram", groqModel: "whisper-large-v3-turbo",
			localModel: "", localPreferredLanguages: ["en"], localLanguage: "auto", localChineseOutput: "simplified",
		});
	});

	it("preferred languages default to the dictation language, or English when no local model has it", () => {
		assert.deepEqual(defaultLocalPreferredLanguages("de"), ["de"]);
		assert.deepEqual(defaultLocalPreferredLanguages("fr-CA"), ["fr"]);
		assert.deepEqual(defaultLocalPreferredLanguages("no"), ["nb"]);
		assert.deepEqual(defaultLocalPreferredLanguages("multi"), ["en"]);
		assert.deepEqual(defaultLocalPreferredLanguages("ar-SA"), ["ar"]);
		for (const language of ["en", "pl", "zh-HK", "nl-BE"]) {
			const [first] = defaultLocalPreferredLanguages(language);
			assert.ok(first && first.length >= 2, language);
		}
	});

	it("resolves unset Local fields from the record, and follows the dictation language until set", () => {
		assert.deepEqual(resolveSettings(null).dictation, FACTORY_SETTINGS.dictation);
		const german = resolveSettings({ version: 1, dictation: { language: "de" } }).dictation;
		assert.deepEqual(german.localPreferredLanguages, ["de"]);
		assert.equal(german.localModel, "");
		const chosen = resolveSettings({
			version: 1,
			dictation: { language: "de", provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "fr"], localLanguage: "fr", localChineseOutput: "traditional" },
		}).dictation;
		assert.deepEqual(
			[chosen.provider, chosen.localModel, chosen.localPreferredLanguages, chosen.localLanguage, chosen.localChineseOutput],
			["local", "whisper-small", ["en", "fr"], "fr", "traditional"],
		);
	});
});

describe("sanitizing a stored record", () => {
	it("keeps valid Local fields and drops invalid ones", () => {
		const keep = sanitizeUserSettings({
			version: 1,
			dictation: { provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "tl", "en-GB"], localLanguage: "auto", localChineseOutput: "traditional" },
		});
		assert.deepEqual(keep?.dictation, {
			provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "fil"], localLanguage: "auto", localChineseOutput: "traditional",
		});
		const bad = sanitizeUserSettings({
			version: 1,
			dictation: { provider: "local", localModel: "retired-model", localPreferredLanguages: ["xx"], localLanguage: "klingon", localChineseOutput: "pinyin" },
		});
		assert.deepEqual(bad?.dictation, { provider: "local" });
		for (const dictation of [{ localModel: 3 }, { localPreferredLanguages: "en" }, { localPreferredLanguages: [] }, { localLanguage: 3 }, { localChineseOutput: null }]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, dictation })?.dictation, {}, JSON.stringify(dictation));
		}
	});

	it("leaves Deepgram and Groq records exactly as stored", () => {
		for (const dictation of [{ language: "pl" }, { language: "fr", provider: "groq", groqModel: "whisper-large-v3" }, {}]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, dictation })?.dictation, dictation);
		}
	});

	it("normalizes preferred languages to identities, in order, without repeats", () => {
		assert.deepEqual(normalizeLocalPreferredLanguages(["EN", "no", "nb", "de-AT", "en"]), ["en", "nb", "de"]);
		for (const bad of [[], ["xx"], "en", null, [1], undefined]) assert.equal(normalizeLocalPreferredLanguages(bad), undefined);
		assert.deepEqual(normalizeLocalPreferredLanguages(["xx", "de"]), ["de"], "unknown entries drop when others remain");
	});
});

describe("the section parser", () => {
	it("accepts valid Local fields, normalizing the language list", () => {
		assert.deepEqual(
			parseDictationSettingsBody({ provider: "local", localModel: "canary-180m-flash", localPreferredLanguages: ["en", "de"], localLanguage: "de", localChineseOutput: "simplified" }),
			{ ok: true, settings: { provider: "local", localModel: "canary-180m-flash", localPreferredLanguages: ["en", "de"], localLanguage: "de", localChineseOutput: "simplified" } },
		);
		assert.deepEqual(parseDictationSettingsBody({ localLanguage: "auto" }), { ok: true, settings: { localLanguage: "auto" } });
		assert.deepEqual(parseDictationSettingsBody({ localPreferredLanguages: ["tl", "tl-PH"] }), { ok: true, settings: { localPreferredLanguages: ["fil"] } });
	});

	it("refuses anything that is not a catalog model, a catalog language or a known script", () => {
		const bad = [
			{ localModel: "gpt-4o" }, { localModel: "voxlingua107-ecapa-q8" }, { localModel: "" }, { localModel: null }, { localModel: 3 },
			{ localPreferredLanguages: [] }, { localPreferredLanguages: ["en", "xx"] }, { localPreferredLanguages: "en" }, { localPreferredLanguages: [3] },
			{ localLanguage: "xx" }, { localLanguage: "" }, { localLanguage: null }, { localLanguage: 3 },
			{ localChineseOutput: "traditional-taiwan" }, { localChineseOutput: "" }, { localChineseOutput: 1 },
		];
		for (const body of bad) assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
	});

	it("still accepts the old bodies", () => {
		assert.deepEqual(parseDictationSettingsBody({ language: "multi" }), { ok: true, settings: { language: "multi" } });
		assert.deepEqual(parseDictationSettingsBody({ provider: "groq", groqModel: "whisper-large-v3" }), {
			ok: true, settings: { provider: "groq", groqModel: "whisper-large-v3" },
		});
	});
});

describe("the PUT body", () => {
	it("omits every default, so Deepgram and Groq records keep their old shape", () => {
		assert.deepEqual(dictationSettingsBody({ language: "pl" }), { language: "pl" });
		assert.deepEqual(
			dictationSettingsBody({
				language: "pl", provider: "deepgram", groqModel: "whisper-large-v3-turbo",
				localModel: "", localPreferredLanguages: ["pl"], localLanguage: "auto", localChineseOutput: "simplified",
			}),
			{ language: "pl" },
		);
		assert.deepEqual(dictationSettingsBody({ language: "en", provider: "groq", groqModel: "whisper-large-v3" }), {
			language: "en", provider: "groq", groqModel: "whisper-large-v3",
		});
	});

	it("keeps non-default Local choices", () => {
		assert.deepEqual(
			dictationSettingsBody({
				language: "en", provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "de"], localLanguage: "de", localChineseOutput: "traditional",
			}),
			{ language: "en", provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "de"], localLanguage: "de", localChineseOutput: "traditional" },
		);
		// A list equal to what the dictation language implies is left unset, so it keeps following it.
		assert.deepEqual(dictationSettingsBody({ language: "de", localPreferredLanguages: ["de"] }), { language: "de" });
		assert.deepEqual(dictationSettingsBody({ language: "de", localPreferredLanguages: ["en"] }), { language: "de", localPreferredLanguages: ["en"] });
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-local-stt-settings-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route persists Local choices and rejects unknown models without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1 });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await put({ language: "en", provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "de"] })).status, 200);
	assert.deepEqual(readSettings()?.dictation, { language: "en", provider: "local", localModel: "whisper-small", localPreferredLanguages: ["en", "de"] });
	assert.equal((await put({ language: "en", provider: "local", localModel: "not-a-model" })).status, 400);
	assert.equal(readSettings()?.dictation?.localModel, "whisper-small", "a rejected PUT writes nothing");
});
