/**
 * UI languages — the English-keyed translate(), the Spanish dictionary's
 * integrity, the general.language setting end to end, the locale provider,
 * and the agent's conditional language rule.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	CURRENT_SETTINGS_VERSION,
	FACTORY_SETTINGS,
	resolveSettings,
	sanitizeUserSettings,
	translate,
} from "../src/core/index.ts";
import { ES, ES_PARTS } from "../src/core/i18n/es/index.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { LocaleProvider, useT } from "../components/locale.tsx";
import { composeInstructions, withLanguageRule } from "../src/agent/teacher-agent.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translate", () => {
	it("returns English unchanged and translates known Spanish keys", () => {
		assert.equal(translate("en", "Language"), "Language");
		assert.equal(translate("es", "Language"), "Idioma");
	});

	it("falls back to the English text for a string the dictionary lacks", () => {
		assert.equal(translate("es", "No such string in any dictionary"), "No such string in any dictionary");
	});

	it("fills {name} placeholders and leaves unknown ones in place", () => {
		assert.equal(translate("en", "{n} of {total}", { n: 2 }), "2 of {total}");
	});
});

describe("Spanish dictionary", () => {
	it("translates every key to a non-empty string with the same placeholders", () => {
		for (const [english, spanish] of Object.entries(ES)) {
			assert.ok(spanish.trim(), `empty translation for ${JSON.stringify(english)}`);
			assert.deepEqual(placeholders(spanish), placeholders(english), `placeholders differ for ${JSON.stringify(english)}`);
		}
	});

	it("translates a key shared by two UI areas the same way", () => {
		const seen = new Map<string, { part: string; spanish: string }>();
		for (const [part, dictionary] of Object.entries(ES_PARTS)) {
			for (const [english, spanish] of Object.entries(dictionary)) {
				const first = seen.get(english);
				if (first) assert.equal(spanish, first.spanish, `${JSON.stringify(english)}: ${first.part} vs ${part}`);
				else seen.set(english, { part, spanish });
			}
		}
	});
});

describe("general.language setting", () => {
	it("defaults to English", () => {
		assert.equal(FACTORY_SETTINGS.general.language, "en");
		assert.equal(resolveSettings(null).general.language, "en");
	});

	it("keeps a supported language and drops anything else on read", () => {
		const read = (language: unknown) =>
			resolveSettings(sanitizeUserSettings({ version: CURRENT_SETTINGS_VERSION, general: { language } })).general.language;
		assert.equal(read("es"), "es");
		assert.equal(read("fr"), "en");
		assert.equal(read(7), "en");
	});

	it("accepts a supported language on write and rejects an unknown one", () => {
		assert.deepEqual(parseGeneralSettingsBody({ language: "es" }), { ok: true, settings: { language: "es" } });
		assert.deepEqual(parseGeneralSettingsBody({ language: "fr" }), { ok: false, error: "language must be one of: en, es" });
	});
});

describe("LocaleProvider", () => {
	function Probe() {
		const t = useT();
		return <span>{t("Language")}</span>;
	}

	it("renders English outside a provider and Spanish inside an es provider", () => {
		assert.equal(renderToStaticMarkup(<Probe />), "<span>Language</span>");
		assert.equal(renderToStaticMarkup(<LocaleProvider locale="es"><Probe /></LocaleProvider>), "<span>Idioma</span>");
	});
});

describe("agent language rule", () => {
	it("leaves the English prompt byte-identical", () => {
		const prompt = composeInstructions("teacher");
		assert.equal(withLanguageRule(prompt), prompt);
		assert.equal(withLanguageRule(prompt, "en"), prompt);
	});

	it("appends the Spanish rule after the composed prompt", () => {
		const prompt = composeInstructions("teacher");
		const spanish = withLanguageRule(prompt, "es");
		assert.ok(spanish.startsWith(`${prompt}\n\n---\n\n## Language\n\n`));
		assert.match(spanish, /Write every learner-facing word in Spanish/);
	});
});
