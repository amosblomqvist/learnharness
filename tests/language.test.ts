import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageDirective, withLanguage } from "../src/agent/language.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("output language", () => {
	it("defaults to pt-BR and resolves explicit choices", () => {
		assert.equal(FACTORY_SETTINGS.general.language, "pt-BR");
		assert.equal(resolveSettings(null).general.language, "pt-BR");
		const rec = sanitizeUserSettings({ version: 1, general: { language: "en" } })!;
		assert.equal(resolveSettings(rec).general.language, "en");
	});

	it("sanitizer drops an unknown language", () => {
		const rec = sanitizeUserSettings({ version: 1, general: { language: "fr" } })!;
		assert.equal(rec.general?.language, undefined);
	});

	it("PUT parser rejects an unknown language", () => {
		assert.equal(parseGeneralSettingsBody({ language: "fr" }).ok, false);
		assert.deepEqual(parseGeneralSettingsBody({ language: "pt-BR" }), { ok: true, settings: { language: "pt-BR" } });
	});

	it("directive: pt-BR appends, en is a no-op", () => {
		assert.equal(languageDirective("en"), "");
		assert.equal(withLanguage("x", "en"), "x");
		assert.ok(withLanguage("x", "pt-BR").includes("Brazilian Portuguese"));
	});

	it("composition ends with the directive only when asked", () => {
		const plain = composeInstructions("teacher");
		assert.equal(composeInstructions("teacher", {}, "en"), plain);
		assert.ok(composeInstructions("teacher", {}, "pt-BR").endsWith(languageDirective("pt-BR")));
	});
});
