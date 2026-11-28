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
		for (const line of ["12 个命题", "5 条推理链", "3 个教学会话", "2 个练习会话", "4 份导入的笔记"]) {
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
		const graphBlock = html.indexOf("12 个命题");
		const sessionsBlock = html.indexOf("3 个教学会话");
		assert.ok(graphBlock !== -1 && sessionsBlock !== -1);
		assert.ok(sessionsBlock > graphBlock, "sessions come after the graph block");
		// the parting is a dedicated spacer element (h-4), not a paragraph
		assert.ok(html.includes('class="h-4"'), "one empty line between blocks");
	});

	it("singularizes: one of each reads as single, not '1 sessions'", () => {
		const html = render({ propositions: 1, chains: 1, teachSessions: 1, practiceSessions: 1, importedNotes: 1 });
		assert.ok(html.includes("1 个命题"));
		assert.ok(html.includes("1 条推理链"));
		assert.ok(html.includes("1 个教学会话"));
		assert.ok(html.includes("1 个练习会话"));
		assert.ok(html.includes("1 份导入的笔记"));
	});

	it("imported notes are a COUNT — never the file list (owner: 'the number of imported notes')", () => {
		const html = render({ importedNotes: 7 });
		assert.ok(html.includes("7 份导入的笔记"));
		assert.ok(!html.includes(".md"), "no file paths render");
		assert.ok(!html.includes("truncate"), "no truncating source rows");
	});

	it("the empty knowledge base points to sessions and path attachments, without dropping statistics", () => {
		const html = render({ propositions: 0, chains: 0, teachSessions: 0, practiceSessions: 0, importedNotes: 0 });
		assert.ok(html.includes("<p>开始一个会话，开启学习。</p>"));
		assert.ok(html.includes("点击回形针或直接拖放即可附加学习材料。</p>"));
		assert.ok(html.includes("0 个命题") && html.includes("0 份导入的笔记"));
		assert.ok(!html.includes("import notes to begin"));
	});

	it("non-empty shows no empty-state hint", () => {
		const html = render();
		assert.ok(!html.includes("开始一个会话，开启学习。"));
	});
});
