/**
 * The app language setting: the language registry (core/i18n.ts) and the
 * general.language knob through the settings record's sanitizer, the
 * general PUT parser and resolution.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_LANGUAGES, isAppLanguage, pickLocalized } from "../src/core/i18n.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("the language registry", () => {
	it("offers English and Spanish, each labelled in its own language", () => {
		assert.deepEqual(
			APP_LANGUAGES.map((l) => [l.id, l.label]),
			[
				["en", "English"],
				["es", "Español"],
			],
		);
	});

	it("isAppLanguage accepts registry ids only", () => {
		assert.equal(isAppLanguage("es"), true);
		assert.equal(isAppLanguage("klingon"), false);
		assert.equal(isAppLanguage(3), false);
	});

	it("pickLocalized returns the language's entry, else English", () => {
		assert.equal(pickLocalized({ en: "Hello", es: "Hola" }, "es"), "Hola");
		assert.equal(pickLocalized({ en: "Hello" }, "es"), "Hello");
	});
});

describe("general.language", () => {
	it("defaults to English when the record lacks it", () => {
		assert.equal(FACTORY_SETTINGS.general.language, "en");
		assert.equal(resolveSettings(null).general.language, "en");
		assert.equal(resolveSettings({ version: 1, general: { autoUpdate: false } }).general.language, "en");
	});

	it("an explicit choice wins", () => {
		assert.equal(resolveSettings({ version: 1, general: { language: "es" } }).general.language, "es");
	});

	it("the sanitizer keeps supported languages and drops anything else", () => {
		assert.deepEqual(sanitizeUserSettings({ general: { language: "es" } })?.general, { language: "es" });
		assert.deepEqual(sanitizeUserSettings({ general: { language: "klingon" } })?.general, {});
	});

	it("the sanitizer keeps the dictation override and its pick, dropping malformed values", () => {
		assert.deepEqual(
			sanitizeUserSettings({ general: { dictationOverride: true, dictationLanguage: "fr" } })?.general,
			{ dictationOverride: true, dictationLanguage: "fr" },
		);
		assert.deepEqual(sanitizeUserSettings({ general: { dictationOverride: "yes", dictationLanguage: "klingon" } })?.general, {});
	});

	it("the general PUT accepts a supported language and rejects anything else", () => {
		const es = parseGeneralSettingsBody({ autoUpdate: true, language: "es" });
		assert.ok(es.ok);
		assert.deepEqual(es.settings, { autoUpdate: true, language: "es" });
		assert.equal(parseGeneralSettingsBody({ language: "klingon" }).ok, false);
		assert.equal(parseGeneralSettingsBody({ language: 3 }).ok, false);
	});
});
