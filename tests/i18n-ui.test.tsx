/**
 * The UI i18n layer: translate() over the per-language dictionaries
 * (English is the source of truth), the dictionaries' completeness, and
 * the provider — components render the provider's language, and English
 * when no provider is mounted.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_LANGUAGES, DICTIONARIES, translate } from "../src/core/i18n.ts";
import { I18nProvider } from "../components/i18n.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translate", () => {
	it("returns the language's copy", () => {
		assert.equal(translate("es", "settings.title"), "Ajustes");
		assert.equal(translate("en", "settings.title"), "Settings");
	});

	it("interpolates {name} placeholders", () => {
		assert.equal(translate("en", "common.errorIn", { section: "general", error: "boom" }), "general: boom");
	});
});

describe("dictionaries", () => {
	const english = DICTIONARIES.en;
	for (const { id } of APP_LANGUAGES) {
		it(`${id}: exactly the English keys, no empty copy, same placeholders`, () => {
			const dict = DICTIONARIES[id];
			assert.deepEqual(Object.keys(dict).sort(), Object.keys(english).sort());
			for (const [key, value] of Object.entries(dict)) {
				assert.ok(value.trim().length > 0, `${id} ${key} is empty`);
				assert.deepEqual(placeholders(value), placeholders(english[key as keyof typeof english]), `${id} ${key}`);
			}
		});
	}
});

describe("I18nProvider", () => {
	it("components render the provider's language", () => {
		const html = renderToStaticMarkup(
			<I18nProvider initialLanguage="es">
				<SettingsDialogBody onClose={() => {}} />
			</I18nProvider>,
		);
		assert.ok(html.includes(">Ajustes<"));
		assert.ok(html.includes("Cargando ajustes…"));
		assert.ok(html.includes('aria-label="Cerrar ajustes"'));
	});

	it("without a provider, components render English", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes(">Settings<"));
		assert.ok(html.includes("Loading settings…"));
	});
});
