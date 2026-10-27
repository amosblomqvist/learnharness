/**
 * Graph-area UI in Spanish — the delete-node dialog and the coverage block
 * render Spanish inside an es LocaleProvider and stay English without one;
 * the notes-import helper builds its dynamic error in the caller's language.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "../src/core/index.ts";
import { LocaleProvider } from "../components/locale.tsx";
import { DeleteNodeBody } from "../components/delete-node-dialog.tsx";
import { CoverageMenuBody } from "../components/extraction-coverage.tsx";
import { postNotesImport } from "../components/notes-import.tsx";

const spanish = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="es">{node}</LocaleProvider>);

const deleteBody = (
	<DeleteNodeBody
		nodes={[{ id: "a", name: "alpha" }, { id: "b", name: "beta" }]}
		busy={false}
		failure={{ code: "not_found", error: "No such node" }}
		onClose={() => {}}
		onRun={() => {}}
	/>
);

const coverageBody = (
	<CoverageMenuBody
		coverage={{ totalMessages: 9, coveredCount: 4, uncoveredCount: 5, coveredTokens: 1000, uncoveredTokens: 2000, running: false, lastFoldedAt: null }}
		extracting={false}
		onExtract={() => {}}
	/>
);

describe("graph-area UI in Spanish", () => {
	it("renders the delete-node dialog in Spanish, server error included", () => {
		const html = spanish(deleteBody);
		assert.ok(html.includes("¿Eliminar 2 nodos?"));
		assert.ok(html.includes("Esto elimina los 2 nodos de forma permanente — no se puede deshacer."));
		assert.ok(html.includes("No existe ese nodo"));
		assert.ok(html.includes(">Cancelar</button>"));
		assert.ok(html.includes('aria-label="Eliminar nodo"'));
	});

	it("renders the delete-node dialog in English without a provider", () => {
		const html = renderToStaticMarkup(deleteBody);
		assert.ok(html.includes("Delete 2 nodes?"));
		assert.ok(html.includes("This permanently deletes all 2 nodes — this cannot be undone."));
		assert.ok(html.includes("No such node"));
		assert.ok(html.includes(">Cancel</button>"));
	});

	it("renders the coverage block in Spanish and English", () => {
		const es = spanish(coverageBody);
		assert.match(es, /2k tok sin cubrir/);
		assert.match(es, /5 mensajes sin extraer/);
		assert.match(es, />Extraer</);
		const en = renderToStaticMarkup(coverageBody);
		assert.match(en, /2k tok uncovered/);
		assert.match(en, /5 messages unextracted/);
		assert.match(en, />Extract</);
	});
});

describe("notes-import errors", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	const files = [new File(["one"], "a.md")];

	it("builds the failed-request error in the caller's language, English by default", async () => {
		globalThis.fetch = async () => Response.json({ error: "boom" }, { status: 500 });
		await assert.rejects(postNotesImport(files), {
			message: "Import request failed (HTTP 500): boom. Please retry the file.",
		});
		await assert.rejects(postNotesImport(files, (text, vars) => translate("es", text, vars)), {
			message: "La solicitud de importación falló (HTTP 500): boom. Vuelve a intentarlo con el archivo.",
		});
	});
});
