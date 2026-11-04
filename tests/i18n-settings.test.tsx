/**
 * The settings surface in Spanish: the sections render the provider's
 * language (copy, aria labels, placeholders) while testids stay English,
 * and render English when no provider is mounted.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../components/i18n.tsx";
import { AgentSection, sectionedSegments } from "../components/settings/agent-section.tsx";
import { AppearanceSection, GraphSection } from "../components/settings/appearance-section.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { GeneralSection } from "../components/settings/settings-dialog.tsx";
import { KeysSection, keyStatusLine } from "../components/settings/keys-section.tsx";

const agent = () => <AgentSection agent={undefined} models={undefined} graph={undefined} compaction={undefined} onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} />;
const appearance = () => <AppearanceSection appearance={undefined} onSectionChange={() => {}} />;
const graph = () => <GraphSection graph={undefined} onSectionChange={() => {}} />;
const es = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider initialLanguage="es">{node}</I18nProvider>);

describe("settings sections under the Spanish provider", () => {
	it("AgentSection: groups, slot rows, tools and search read Spanish; testids stay English", () => {
		const html = es(agent());
		assert.ok(html.includes(">Modelos<"));
		assert.ok(html.includes(">Herramientas<"));
		assert.ok(html.includes("El modelo principal de tus sesiones"));
		assert.ok(html.includes(">Opción múltiple<"));
		assert.ok(html.includes("Automático"));
		assert.ok(html.includes('aria-label="Modelo Potente"'));
		assert.ok(html.includes("Cargando segmentos de instrucciones…"));
		assert.ok(html.includes('data-testid="toggle-tool-research"'), "translated aria label keeps the English testid");
		assert.ok(html.includes('data-testid="toggle-graph-tools"'));
		assert.ok(!html.includes("Multiple choice"));
	});

	it("AppearanceSection + GraphSection: labels, hints and placeholders read Spanish", () => {
		const html = es(appearance());
		assert.ok(html.includes(">Fuente de lectura<"));
		assert.ok(html.includes("Próximamente"));
		assert.ok(html.includes('placeholder="igual que el texto"'));
		assert.ok(html.includes('data-testid="toggle-session-names-serif"'));
		const g = es(graph());
		assert.ok(g.includes(">Extracción<"));
		assert.ok(g.includes('aria-label="extracción activada"'));
		assert.ok(g.includes('data-testid="toggle-extraction-enabled"'));
	});

	it("KeyboardSection: chrome and shortcut labels read Spanish", () => {
		const html = es(<KeyboardSection />);
		assert.ok(html.includes(">Reasignar<"));
		assert.ok(html.includes("Restablecer todo"));
		assert.ok(html.includes(">Buscar<"));
	});

	it("GeneralSection: the dictation override rows read Spanish", () => {
		const html = es(<GeneralSection general={{ language: "es" }} onChange={() => {}} />);
		assert.ok(html.includes("Usar otro idioma para el dictado"));
		assert.ok(html.includes("Idioma del dictado"));
		assert.ok(html.includes("Multilingüe (detección automática)"));
	});

	it("KeysSection: the SSR loading state reads Spanish", () => {
		assert.ok(es(<KeysSection />).includes("Cargando claves…"));
	});

	it("pure helpers take the language, English by default", () => {
		const unset = { id: "X", info: null, present: false, masked: null, source: "none", shadowedByEnv: false } as const;
		assert.equal(keyStatusLine(unset, "es"), "sin configurar");
		assert.equal(keyStatusLine(unset), "not set");
		const view = { prober: [], teacher: [] };
		assert.deepEqual(sectionedSegments(view, "es").map((s) => s.label), ["Profesor", "Examinador", "Compartidas"]);
		assert.deepEqual(sectionedSegments(view).map((s) => s.label), ["Teacher", "Prober", "Shared"]);
	});
});

describe("settings sections without a provider", () => {
	it("render English", () => {
		const html = renderToStaticMarkup(agent());
		assert.ok(html.includes(">Models<"));
		assert.ok(html.includes(">Multiple choice<"));
		assert.ok(html.includes('aria-label="Strong model"'));
		const a = renderToStaticMarkup(appearance());
		assert.ok(a.includes(">Reading font<"));
		assert.ok(a.includes('placeholder="same as text"'));
		assert.ok(renderToStaticMarkup(graph()).includes(">Extraction<"));
		assert.ok(renderToStaticMarkup(<KeyboardSection />).includes(">Rebind<"));
	});
});
