/**
 * The graph surface in Spanish: the chrome row, the delete dialogs, the
 * context card and the coverage block render the provider's language,
 * and English when no provider is mounted.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_RENDER_SETTINGS } from "../src/core/render-settings.ts";
import { I18nProvider } from "../components/i18n.tsx";
import { GraphChromeRow } from "../components/graph-view.tsx";
import { DeleteNodeBody } from "../components/delete-node-dialog.tsx";
import { DeleteSessionBody } from "../components/delete-session-dialog.tsx";
import { GraphContextCard } from "../components/graph-context-card.tsx";
import { CoverageMenuBody } from "../components/extraction-coverage.tsx";

const chrome = (
	<GraphChromeRow
		isEmpty={false}
		query="zzz"
		onQuery={() => {}}
		noMatch
		importing={false}
		searchInputRef={{ current: null }}
		fileInputRef={{ current: null }}
		onImportFiles={() => {}}
		settings={DEFAULT_RENDER_SETTINGS}
		changeSettings={() => {}}
		onOpenChains={() => {}}
	/>
);

const nodes = [
	{ id: "a", name: "Alpha" },
	{ id: "b", name: "Beta" },
	{ id: "c", name: "Gamma" },
];

const surfaces = (
	<>
		{chrome}
		<DeleteNodeBody nodes={nodes} busy={false} failure={{ code: "extraction_running", error: "x" }} onClose={() => {}} onRun={() => {}} />
		<DeleteSessionBody chat={{ id: "c1", title: "My session" }} traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />
		<GraphContextCard data={{ propositions: [{ id: "p1", name: "A", statement: "S." }], chains: ["A ⟹ B", "B ⟹ C"] }} />
		<CoverageMenuBody
			coverage={{ totalMessages: 10, coveredCount: 9, uncoveredCount: 1, coveredTokens: 100, uncoveredTokens: 2000, running: false, lastFoldedAt: null }}
			extracting={false}
			onExtract={() => {}}
		/>
	</>
);

describe("graph surface i18n", () => {
	it("renders Spanish under the provider", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLanguage="es">{surfaces}</I18nProvider>);
		assert.ok(html.includes('placeholder="Buscar nodos…"'));
		assert.ok(html.includes("Ningún nodo coincide."));
		assert.ok(html.includes("Importar notas…"));
		assert.ok(html.includes("¿Eliminar 3 nodos?"));
		assert.ok(html.includes("Esto elimina los 3 nodos de forma permanente"));
		assert.ok(html.includes("Hay una extracción en curso"));
		assert.ok(html.includes("¿Eliminar sesión?"));
		assert.ok(html.includes('aria-label="Eliminar sesión"'));
		assert.ok(html.includes("Eliminar también sus rastros en el grafo"));
		assert.ok(html.includes(">Cancelar<"));
		assert.ok(html.includes("Contexto del grafo"));
		assert.ok(html.includes("1 proposición · 2 cadenas"));
		assert.ok(html.includes("2k tok sin cubrir"));
		assert.ok(html.includes("1 mensaje sin extraer"));
		assert.ok(html.includes(">Extraer<"));
		// User data passes through untouched.
		assert.ok(html.includes("My session"));
		assert.ok(html.includes("Alpha, Beta, Gamma"));
	});

	it("renders English without a provider", () => {
		const html = renderToStaticMarkup(surfaces);
		assert.ok(html.includes('placeholder="Search nodes…"'));
		assert.ok(html.includes("No matching nodes."));
		assert.ok(html.includes("Delete 3 nodes?"));
		assert.ok(html.includes("Delete session?"));
		assert.ok(html.includes("Graph context"));
		assert.ok(html.includes("1 proposition · 2 chains"));
		assert.ok(html.includes("2k tok uncovered"));
		assert.ok(html.includes("1 message unextracted"));
	});
});
