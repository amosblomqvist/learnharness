/**
 * Spanish in the settings surfaces — sections render Spanish inside an es
 * LocaleProvider and English without one, and the copy the helpers build
 * from parts (update status, key-shape refusals, connection notices) lands
 * on a dictionary key instead of falling back to English.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { genericProviderKeyGuard, translate, validateKeyShape, type TranslationVars } from "../src/core/index.ts";
import { LocaleProvider } from "../components/locale.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { GraphSection } from "../components/settings/appearance-section.tsx";
import { updateStatusText } from "../components/settings/update-settings.tsx";
import { keyErrorText, keyStatusLine } from "../components/settings/keys-section.tsx";
import { chatGPTNotice } from "../components/settings/chatgpt-connection.tsx";
import { subscriptionDisconnectCopy, subscriptionNotice } from "../components/settings/subscription-connections.tsx";

const es = (text: string, vars?: TranslationVars) => translate("es", text, vars);

describe("settings sections in Spanish", () => {
	it("renders the Keyboard section in Spanish inside an es provider and in English without one", () => {
		const spanish = renderToStaticMarkup(<LocaleProvider locale="es"><KeyboardSection /></LocaleProvider>);
		assert.ok(spanish.includes("Abrir la configuración"), "action labels translate at render");
		assert.ok(spanish.includes("Restablecer todo a los valores predeterminados"));
		assert.ok(spanish.includes("Fijo: forma parte de esta pantalla"));
		const english = renderToStaticMarkup(<KeyboardSection />);
		assert.ok(english.includes("Open settings"));
		assert.ok(english.includes("Reset all to defaults"));
		assert.ok(!english.includes("Restablecer"));
	});

	it("renders the Graph section in Spanish and keeps its English test ids", () => {
		const spanish = renderToStaticMarkup(<LocaleProvider locale="es"><GraphSection graph={undefined} onSectionChange={() => {}} /></LocaleProvider>);
		assert.ok(spanish.includes("Extracción"));
		assert.ok(spanish.includes("Desactivado = el grafo deja de crecer"));
		assert.ok(spanish.includes('data-testid="graph-row-enabled"'));
		const english = renderToStaticMarkup(<GraphSection graph={undefined} onSectionChange={() => {}} />);
		assert.ok(english.includes("Off = the graph stops growing"));
	});
});

describe("composed settings copy finds its Spanish key", () => {
	it("translates every update status line", () => {
		const state = (status: "checking" | "downloading" | "up-to-date" | "downloaded" | "error", version: string | null = null) => ({ status, version, revision: 0 });
		assert.equal(updateStatusText(state("downloaded", "0.3.8"), es), "La versión 0.3.8 está lista. Se instalará al salir de la aplicación.");
		assert.equal(updateStatusText(state("downloaded"), es), "Hay una actualización lista. Se instalará al salir de la aplicación.");
		assert.equal(updateStatusText(state("downloading", "0.3.8"), es), "Descargando la versión 0.3.8…");
		assert.equal(updateStatusText(state("error"), es), "No se pudo comprobar si hay actualizaciones. Inténtalo más tarde.");
	});

	it("translates the server's key-shape refusals with their id and length", () => {
		const refusals = [
			validateKeyShape("TAVILY_API_KEY", "nope"),
			validateKeyShape("TAVILY_API_KEY", "tvly-short"),
			validateKeyShape("BRAVE_API_KEY", "short"),
			genericProviderKeyGuard("OPENAI_API_KEY", "short"),
		];
		for (const refusal of refusals) {
			assert.equal(refusal.ok, false);
			const error = (refusal as { error: string }).error;
			assert.equal(keyErrorText(error, (text, vars) => translate("en", text, vars)), error, "English stays verbatim");
			assert.notEqual(keyErrorText(error, es), error, `untranslated: ${error}`);
		}
		assert.equal(keyErrorText("OPENAI_API_KEY must be at least 12 characters with no whitespace", es), "OPENAI_API_KEY debe tener al menos 12 caracteres y ningún espacio en blanco");
		assert.equal(keyStatusLine({ id: "X", info: null, present: false, masked: null, source: "none", shadowedByEnv: false }, es), "sin configurar");
	});

	it("translates both variants of the connection notices", () => {
		for (const web of [false, true]) {
			assert.notEqual(chatGPTNotice(web, es), chatGPTNotice(web), `ChatGPT notice web=${web}`);
			assert.ok(subscriptionNotice("Claude", web, es).startsWith("Tus prompts"), `subscription notice web=${web}`);
			assert.ok(subscriptionDisconnectCopy("Claude", web, es).startsWith("¿Desconectar Claude de LearnHarness?"), `disconnect copy web=${web}`);
		}
	});
});
