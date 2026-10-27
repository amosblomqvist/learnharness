import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { TRANSCRIPTION_LANGUAGES, dictationUrl } from "../src/core/transcription.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { readDictationLanguage } from "../components/dictation.tsx";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("transcription language", () => {
	it("keeps old records and first boot on English without a migration", () => {
		for (const record of [null, { version: 1 }, { version: 1, general: { autoUpdate: false } }]) {
			assert.equal(resolveSettings(record).general.transcriptionLanguage, "en");
		}
	});

	it("accepts every advertised choice and preserves sibling settings", () => {
		assert.equal(new Set(TRANSCRIPTION_LANGUAGES.map(([code]) => code)).size, TRANSCRIPTION_LANGUAGES.length);
		for (const [code] of TRANSCRIPTION_LANGUAGES) {
			const parsed = parseGeneralSettingsBody({ transcriptionLanguage: code, autoUpdate: false });
			assert.ok(parsed.ok);
			const record = sanitizeUserSettings({ version: 1, general: parsed.settings });
			assert.deepEqual(record?.general, { autoUpdate: false, transcriptionLanguage: code });
			assert.equal(resolveSettings(record).general.transcriptionLanguage, code);
		}
	});

	it("rejects invalid writes, drops invalid disk values, and supports clearing", () => {
		for (const value of ["xx", "", "RU", "ru&model=nova-2", 42, null, {}, []]) {
			assert.equal(parseGeneralSettingsBody({ transcriptionLanguage: value }).ok, false);
			const record = sanitizeUserSettings({ version: 1, general: { autoUpdate: false, transcriptionLanguage: value } });
			assert.deepEqual(record?.general, { autoUpdate: false });
			assert.equal(resolveSettings(record).general.transcriptionLanguage, "en");
		}
		assert.deepEqual(parseGeneralSettingsBody({}), { ok: true, settings: {} });
	});

	it("sets the language without changing the capture or streaming parameters", () => {
		for (const language of ["en", "ru", "multi", "zh-HK"] as const) {
			const url = new URL(dictationUrl(language));
			assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
			assert.deepEqual(Object.fromEntries(url.searchParams), {
				model: "nova-3", language, encoding: "linear16", sample_rate: "16000",
				channels: "1", smart_format: "true", punctuate: "true", endpointing: "300",
			});
		}
	});

	it("re-reads saved language for each run, including first boot", async () => {
		let settings: unknown = null;
		let reads = 0;
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "/api/settings");
			assert.equal(init?.cache, "no-store");
			reads++;
			return Response.json({ settings });
		};
		assert.equal(await readDictationLanguage(), "en");
		settings = { version: 1, general: { transcriptionLanguage: "ru" } };
		assert.equal(await readDictationLanguage(), "ru");
		settings = { version: 1, general: { transcriptionLanguage: "multi" } };
		assert.equal(await readDictationLanguage(), "multi");
		assert.equal(reads, 3);
	});

	it("surfaces settings failures instead of silently transcribing in English", async () => {
		globalThis.fetch = async () => new Response("unavailable", { status: 503 });
		await assert.rejects(readDictationLanguage(), /Could not load dictation settings/);
	});
});
