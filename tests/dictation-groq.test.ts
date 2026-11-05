import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	DEFAULT_DICTATION_PROVIDER, DEFAULT_GROQ_WHISPER_MODEL, DICTATION_LANGUAGES, DICTATION_PROVIDERS, GROQ_MAX_BODY_BYTES,
	GROQ_MAX_RECORDING_SECONDS, GROQ_WHISPER_MODELS,
	dictationSettingsBody, isDictationProvider, isGroqWhisperModel, whisperLanguage,
} from "../src/core/dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { MAX_IMPORT_BODY_BYTES } from "../lib/notes-import-limits.ts";

describe("Groq dictation provider and models", () => {
	it("Deepgram stays the default engine; turbo is the default Whisper model", () => {
		assert.deepEqual([...DICTATION_PROVIDERS], ["deepgram", "groq"]);
		assert.equal(DEFAULT_DICTATION_PROVIDER, "deepgram");
		assert.equal(DEFAULT_GROQ_WHISPER_MODEL, "whisper-large-v3-turbo");
		assert.deepEqual(GROQ_WHISPER_MODELS.map((m) => m.id), ["whisper-large-v3-turbo", "whisper-large-v3"]);
	});

	it("guards accept exactly the known ids", () => {
		assert.equal(isDictationProvider("groq"), true);
		assert.equal(isDictationProvider("deepgram"), true);
		for (const value of ["Groq", "openai", "", null, undefined, 1, {}]) assert.equal(isDictationProvider(value), false, String(value));
		assert.equal(isGroqWhisperModel("whisper-large-v3"), true);
		assert.equal(isGroqWhisperModel("whisper-large-v3-turbo"), true);
		for (const value of ["whisper-1", "distil-whisper-large-v3-en", "nova-3", "", null, 3]) assert.equal(isGroqWhisperModel(value), false, String(value));
	});

	it("a dictation is capped at 20 minutes, and the body limit stays under Next's proxy buffer", () => {
		assert.equal(GROQ_MAX_RECORDING_SECONDS, 1200);
		// next.config.ts sets proxyClientMaxBodySize to MAX_IMPORT_BODY_BYTES; a larger
		// request would reach the route truncated and fail as an unreadable upload.
		assert.ok(GROQ_MAX_BODY_BYTES <= MAX_IMPORT_BODY_BYTES);
	});
});

describe("dictation language to Whisper language", () => {
	it("maps base languages and collapses regional variants", () => {
		const expected: Record<string, string> = {
			en: "en", "en-US": "en", "en-GB": "en", "en-AU": "en", pl: "pl", "pt-BR": "pt", "pt-PT": "pt", "fr-CA": "fr",
			"es-419": "es", "de-CH": "de", "nl-BE": "nl", "ar-EG": "ar", "ko-KR": "ko", "th-TH": "th", "sv-SE": "sv",
			zh: "zh", "zh-CN": "zh", "zh-Hans": "zh", "zh-TW": "zh", "zh-Hant": "zh", no: "no", he: "he", tl: "tl",
		};
		for (const [code, whisper] of Object.entries(expected)) {
			assert.equal(whisperLanguage(code as Parameters<typeof whisperLanguage>[0]), whisper, code);
		}
	});

	it("Cantonese uses Groq's yue; Deepgram's multilingual mode omits the language", () => {
		assert.equal(whisperLanguage("zh-HK"), "yue");
		assert.equal(whisperLanguage("multi"), undefined);
	});

	it("every offered language except 'multi' maps to a code Groq accepts", () => {
		for (const { code } of DICTATION_LANGUAGES) {
			const mapped = whisperLanguage(code);
			if (code === "multi") assert.equal(mapped, undefined);
			else assert.match(mapped ?? "", /^[a-z]{2,3}$/, `${code} must map to a Whisper code`);
		}
	});
});

describe("dictation settings body for the PUT", () => {
	it("a default-engine record stays exactly { language }", () => {
		assert.deepEqual(dictationSettingsBody({ language: "pl" }), { language: "pl" });
		assert.deepEqual(dictationSettingsBody({ language: "pl", provider: "deepgram", groqModel: "whisper-large-v3-turbo" }), { language: "pl" });
	});

	it("non-default choices are kept; the whole section is always described", () => {
		assert.deepEqual(dictationSettingsBody({ language: "en", provider: "groq" }), { language: "en", provider: "groq" });
		assert.deepEqual(dictationSettingsBody({ language: "en", provider: "groq", groqModel: "whisper-large-v3" }), {
			language: "en", provider: "groq", groqModel: "whisper-large-v3",
		});
		assert.deepEqual(dictationSettingsBody({ language: "en", provider: "deepgram", groqModel: "whisper-large-v3" }), {
			language: "en", groqModel: "whisper-large-v3",
		});
	});
});

describe("dictation provider settings: sanitize, resolve, parse", () => {
	it("old records without the new fields load and resolve to Deepgram + turbo, and resolve fills only the missing pieces", () => {
		for (const record of [null, { version: 1 }, { version: 1, dictation: {} }, { version: 1, dictation: { language: "pl" } }]) {
			const effective = resolveSettings(record as never).dictation;
			assert.equal(effective.provider, "deepgram");
			assert.equal(effective.groqModel, "whisper-large-v3-turbo");
		}
		assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { language: "pl" } })?.dictation, { language: "pl" });
		assert.equal(resolveSettings({ version: 1, dictation: { language: "pl" } }).dictation.language, "pl");
		assert.deepEqual(resolveSettings({ version: 1, dictation: { provider: "groq" } }).dictation, {
			language: "en", provider: "groq", groqModel: "whisper-large-v3-turbo",
		});
		assert.deepEqual(resolveSettings({ version: 1, dictation: { language: "de", provider: "groq", groqModel: "whisper-large-v3" } }).dictation, {
			language: "de", provider: "groq", groqModel: "whisper-large-v3",
		});
	});

	it("sanitize keeps valid provider/model next to language and drops invalid values independently", () => {
		const keep = sanitizeUserSettings({ version: 1, dictation: { language: "fr", provider: "groq", groqModel: "whisper-large-v3" } });
		assert.deepEqual(keep?.dictation, { language: "fr", provider: "groq", groqModel: "whisper-large-v3" });
		const mixed = sanitizeUserSettings({ version: 1, dictation: { language: "xx", provider: "groq", groqModel: "nope" } });
		assert.deepEqual(mixed?.dictation, { provider: "groq" });
		for (const dictation of [null, [], "groq", 3, { provider: "elevenlabs" }, { groqModel: 3 }]) {
			assert.deepEqual(sanitizeUserSettings({ version: 1, dictation })?.dictation, {}, JSON.stringify(dictation));
		}
	});

	it("the section parser validates provider and model strictly and accepts the old language-only body", () => {
		assert.deepEqual(parseDictationSettingsBody({ language: "multi" }), { ok: true, settings: { language: "multi" } });
		assert.deepEqual(parseDictationSettingsBody({ provider: "groq" }), { ok: true, settings: { provider: "groq" } });
		assert.deepEqual(
			parseDictationSettingsBody({ language: "pl", provider: "groq", groqModel: "whisper-large-v3" }),
			{ ok: true, settings: { language: "pl", provider: "groq", groqModel: "whisper-large-v3" } },
		);
		const bad = [
			{ provider: "elevenlabs" }, { provider: null }, { provider: 1 }, { provider: "Groq" },
			{ groqModel: "whisper-1" }, { groqModel: null }, { groqModel: 3 }, { language: "xx", provider: "groq" },
		];
		for (const body of bad) assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-groq-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route persists provider and model with the language, and a language-only PUT resets them (whole-section replace)", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false } });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await put({ language: "pl", provider: "groq", groqModel: "whisper-large-v3" })).status, 200);
	assert.deepEqual(readSettings(), {
		version: 1, dictation: { language: "pl", provider: "groq", groqModel: "whisper-large-v3" }, general: { autoUpdate: false },
	});
	assert.equal((await put({ language: "pl", provider: "whisper" })).status, 400);
	assert.equal((await put({ language: "pl", groqModel: "whisper-1" })).status, 400);
	assert.equal(readSettings()?.dictation?.provider, "groq", "a rejected PUT writes nothing");
	assert.equal((await put({ language: "pl" })).status, 200);
	assert.deepEqual(readSettings()?.dictation, { language: "pl" });
});
