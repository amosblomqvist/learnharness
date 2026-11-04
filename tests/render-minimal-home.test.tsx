/** The minimal home's KnowledgeSummary — the quiet centered summary of
 * the knowledge base (owner, 2026-10-06: "very quiet, very minimal").
 * Pure body: props in, markup out. Own-line law (same day refinement):
 * every count on its own row, NO dot separators, blocks parted by an
 * empty line, imported notes as a COUNT — never the file list. */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, it } from "node:test";
import { KnowledgeSummary } from "../components/minimal-home.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";

function render(props: Partial<Parameters<typeof KnowledgeSummary>[0]> = {}) {
	return renderToStaticMarkup(
		React.createElement(KnowledgeSummary, {
			propositions: 12,
			chains: 5,
			teachSessions: 3,
			practiceSessions: 2,
			importedNotes: 4,
			...props,
		}),
	);
}

describe("KnowledgeSummary — the quiet home summary (2026-10-06)", () => {
	it("every count on its OWN line — no dot separators (owner refinement, same day)", () => {
		const html = render();
		for (const line of ["12 propositions", "5 chains", "3 teaching sessions", "2 practice sessions", "4 imported notes"]) {
			const i = html.indexOf(line);
			assert.ok(i !== -1, `${line} renders`);
			// own-line: the count is its own text node — the char after the
			// label is a tag boundary (</p>), never " · "
			const after = html.slice(i + line.length, i + line.length + 2);
			assert.ok(after.startsWith("<"), `${line} ends its own element, not a dot-joined run`);
		}
		assert.ok(!html.includes(" · "), "no dot separators anywhere");
	});

	it("the two blocks part with an empty line — graph counts, then session counts", () => {
		const html = render();
		const graphBlock = html.indexOf("12 propositions");
		const sessionsBlock = html.indexOf("3 teaching sessions");
		assert.ok(graphBlock !== -1 && sessionsBlock !== -1);
		assert.ok(sessionsBlock > graphBlock, "sessions come after the graph block");
		// the parting is a dedicated spacer element (h-4), not a paragraph
		assert.ok(html.includes('class="h-4"'), "one empty line between blocks");
	});

	it("singularizes: one of each reads as single, not '1 sessions'", () => {
		const html = render({ propositions: 1, chains: 1, teachSessions: 1, practiceSessions: 1, importedNotes: 1 });
		assert.ok(html.includes("1 proposition"));
		assert.ok(html.includes("1 chain"));
		assert.ok(html.includes("1 teaching session"));
		assert.ok(html.includes("1 practice session"));
		assert.ok(html.includes("1 imported note"));
	});

	it("imported notes are a COUNT — never the file list (owner: 'the number of imported notes')", () => {
		const html = render({ importedNotes: 7 });
		assert.ok(html.includes("7 imported notes"));
		assert.ok(!html.includes(".md"), "no file paths render");
		assert.ok(!html.includes("truncate"), "no truncating source rows");
	});

	it("the empty knowledge base says so, quietly — import is the entry point", () => {
		const html = render({ propositions: 0, chains: 0, teachSessions: 0, practiceSessions: 0, importedNotes: 0 });
		assert.ok(html.includes("Nothing here yet"));
		assert.ok(html.includes("import notes"), "the hint names the entry point");
	});

	it("non-empty shows no empty-state hint", () => {
		const html = render();
		assert.ok(!html.includes("Nothing here yet"));
	});
});

describe("MinimalHome — the Study time entry", () => {
	it("renders the Study time button without any graph data", async () => {
		const { MinimalHome } = await import("../components/minimal-home.tsx");
		const html = renderToStaticMarkup(React.createElement(ServerEventsProvider, { children: React.createElement(MinimalHome) }));
		assert.ok(html.includes('data-testid="open-study-time"'));
		assert.ok(html.includes("Study time"));
		assert.ok(html.indexOf("open-study-time") < html.indexOf("open-chain-table"), "first in the top-right row");
	});
});
