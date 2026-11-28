import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptRows, estimateTranscriptRow } from "../components/transcript-rows.ts";
import { findTranscriptMatches, markdownSearchRuns, partSearchSources, transcriptSearchIndex, type TranscriptSearchCache } from "../components/transcript-search.ts";
import { projectView, type LhViewMessage } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StickToBottom } from "use-stick-to-bottom";
import { VirtualTranscript } from "../components/virtual-transcript.tsx";
import { transcriptJumpWindow, transcriptJumpRestoreOffset, transcriptJumpTravel } from "../components/transcript-jump.ts";
import { transcriptReadingAnchor, transcriptWindow } from "../components/transcript-window.ts";
import { parseHTML } from "linkedom";
import { transcriptScrollbarOffset } from "../components/transcript-scrollbar.ts";
(globalThis as Record<string, unknown>).React = React;

test("the reading anchor uses actual visible content and skips rows showing only their trailing gap", () => {
	const { document } = parseHTML('<div id="scroll"><div id="rows"><div id="above"></div><div id="gap" style="padding-bottom: 16px"></div><div id="reading"></div><div id="below"></div></div></div>');
	const root = document.getElementById("rows")!, scroll = document.getElementById("scroll")!;
	const box = (top: number, bottom: number) => ({ top, bottom, height: bottom - top }) as DOMRect;
	scroll.getBoundingClientRect = () => box(100, 500);
	document.getElementById("above")!.getBoundingClientRect = () => box(-600, 80);
	document.getElementById("gap")!.getBoundingClientRect = () => box(80, 112);
	document.getElementById("reading")!.getBoundingClientRect = () => box(112, 600);
	document.getElementById("below")!.getBoundingClientRect = () => box(600, 1000);
	assert.equal(transcriptReadingAnchor(root, scroll)?.id, "reading");
	assert.equal(transcriptReadingAnchor(root, null), null);
	assert.equal(transcriptReadingAnchor(null, scroll), null);
	root.replaceChildren(document.getElementById("below")!);
	assert.equal(transcriptReadingAnchor(root, scroll), null);
});

test("a held scrollbar keeps its native track while measured history grows or shrinks", () => {
	assert.equal(transcriptScrollbarOffset(500, 1000, 1400), 700);
	assert.equal(transcriptScrollbarOffset(500, 1000, 800), 400);
	assert.equal(transcriptScrollbarOffset(1000, 1000, 1400), 1400);
	assert.equal(transcriptScrollbarOffset(0, 1000, 1400), 0);
	assert.equal(transcriptScrollbarOffset(1100, 1000, 1400), 1400);
	assert.equal(transcriptScrollbarOffset(-50, 1000, 1400), 0);
	assert.equal(transcriptScrollbarOffset(0, 0, 0), 0);
});

test("a long bottom jump joins buffered source and destination windows without rendering the middle", () => {
	const positions = Array.from({ length: 1000 }, (_, index) => ({ index, start: index * 100, end: (index + 1) * 100 }));
	const window = transcriptJumpWindow(positions.slice(0, 8), 0, 500, 99500, positions.length, index => positions[index]!.start);
	assert.deepEqual(window, { sourceStart: 0, sourceEnd: 7, tailStart: 992 });
	const shift = positions[window!.tailStart]!.start - positions[window!.sourceEnd]!.end;
	// The destination has the same screen position before and after restoring
	// the omitted middle's coordinates, so completion cannot visibly jump.
	assert.equal(positions[992]!.start - shift - (99500 - shift), positions[992]!.start - 99500);
	assert.equal(transcriptJumpRestoreOffset(300, positions[992]!.start, shift), 300);
	assert.equal(transcriptJumpRestoreOffset(900, positions[992]!.start, shift), 99300);
});

test("nearby bottom jumps keep the normal animation when buffered windows overlap", () => {
	const positions = Array.from({ length: 20 }, (_, index) => ({ index, start: index * 100, end: (index + 1) * 100 }));
	assert.equal(transcriptJumpWindow(positions.slice(7), 1000, 500, 1500, positions.length, index => positions[index]!.start), null);
	assert.equal(transcriptJumpWindow([], 0, 500, 0, 0, () => 0), null);
});

test("the native scrollbar can traverse the history while the visible jump remains short", () => {
	const travel = [200, 5100, 10000].map(top => transcriptJumpTravel(top, 200, 10000, 8000));
	assert.deepEqual(travel, [0, 4000, 8000]);
	assert.equal(transcriptJumpTravel(-100, 200, 10000, 8000), 0);
	assert.equal(transcriptJumpTravel(11000, 200, 10000, 8000), 8000);
	assert.equal(transcriptJumpRestoreOffset(5100 - travel[1]!, 9000, 8000), 9100);
});

test("manual scrolling buffers screen heights around short rows without mounting unbounded history", () => {
	const positions = Array.from({ length: 10000 }, (_, index) => ({ start: index * 100, end: (index + 1) * 100 }));
	const indexes = transcriptWindow({ startIndex: 50, endIndex: 54, overscan: 3, count: 10000 }, positions, 500);
	assert.equal(indexes[0], 40);
	assert.equal(indexes.at(-1), 64);
	const tiny = positions.map((_, index) => ({ start: index, end: index + 1 }));
	assert.equal(transcriptWindow({ startIndex: 50, endIndex: 54, overscan: 3, count: 10000 }, tiny, 500).length, 53);
	assert.deepEqual(transcriptWindow({ startIndex: 0, endIndex: 1, overscan: 3, count: 2 }, positions.slice(0, 2), 500), [0, 1]);
});

test("virtual rows split long assistant groups without changing the grouped view or part indexes", () => {
	const view = projectView(Array.from({ length: 500 }, (_, index) => ({ id: `native-${index}`, role: "assistant", timestamp: index,
		content: [{ type: "text", text: `Passage ${index}` }] }) as LhMessage));
	assert.equal(view.length, 1);
	const before = structuredClone(view);
	const rows = transcriptRows(view);
	assert.equal(rows.length, 500);
	assert.equal(new Set(rows.map(row => row.key)).size, 500);
	assert.deepEqual(rows.flatMap(row => row.message.parts.slice(row.start, row.end)), view[0]!.parts);
	assert.deepEqual(rows[275]!.sourceIds, ["native-275"]);
	assert.equal(rows[275]!.messageIndex, 0);
	assert.equal(rows[275]!.gapAfter, 8);
	assert.equal(rows.at(-1)!.gapAfter, 16);
	assert.deepEqual(view, before);
});

test("all rows contribute estimated height before their DOM exists", () => {
	const rows = transcriptRows([{ id: "long", role: "assistant", parts: [{ type: "text", text: "a large paragraph ".repeat(500) }] }]);
	assert.ok(estimateTranscriptRow(rows[0]!, 400) > estimateTranscriptRow(rows[0]!, 1200));
	assert.ok(estimateTranscriptRow(rows[0]!, 1200) > 1000);
});

test("server rendering emits a bounded tail window rather than the full history", () => {
	const rows = transcriptRows(Array.from({ length: 1000 }, (_, index): LhViewMessage => ({ id: `message-${index}`, role: "assistant",
		parts: [{ type: "text", text: `Passage ${index}. `.repeat(100) }] })));
	const html = renderToStaticMarkup(React.createElement(StickToBottom, { children: React.createElement(VirtualTranscript, {
		rows, handleRef: { current: null }, children: row => React.createElement("p", {}, row.message.parts[0]?.text),
	}) }));
	assert.ok((html.match(/data-transcript-row=/g)?.length ?? 0) > 0);
	assert.ok((html.match(/data-transcript-row=/g)?.length ?? 0) < 20);
	assert.ok(html.includes("Passage 999."));
	assert.ok(!html.includes("Passage 0."));
});

test("data Find reaches unmounted rows and preserves literal matching and global occurrence order", () => {
	const rows = transcriptRows(Array.from({ length: 1000 }, (_, index): LhViewMessage => ({ id: `message-${index}`, role: "assistant",
		parts: [{ type: "text", text: index === 725 ? "Needle and **NEEDLE** [a.b](https://excluded.invalid)" : "other text" }] })));
	const index = transcriptSearchIndex(rows);
	assert.deepEqual(findTranscriptMatches(index, "needle").map(match => [match.rowIndex, match.occurrence]), [[725, 0], [725, 1]]);
	assert.equal(findTranscriptMatches(index, "a.b").length, 1);
	assert.equal(findTranscriptMatches(index, "excluded.invalid").length, 0);
	assert.deepEqual(findTranscriptMatches(index, ""), []);
});

test("Markdown search joins inline formatting, separates blocks and preserves code whitespace", () => {
	assert.deepEqual(markdownSearchRuns("the **chain** [rule](https://example.com)\n\nsecond paragraph\n\n```ts\na  b\n```"), ["the chain rule", "second paragraph", "a  b"]);
	const rows = transcriptRows([{ id: "user", role: "user", parts: [{ type: "text", text: "a  b **literal**" }] }]);
	const index = transcriptSearchIndex(rows);
	assert.equal(findTranscriptMatches(index, "a  b").length, 1);
	assert.equal(findTranscriptMatches(index, "**literal**").length, 1);
});

test("Find excludes internal payloads, hidden commitments and reasoning", () => {
	assert.deepEqual(partSearchSources({ type: "reasoning", text: "hidden" }), []);
	assert.deepEqual(partSearchSources({ type: "tool-practice_problem", input: { statement: "visible", modelSolution: "hidden" } }), ["visible"]);
	assert.deepEqual(partSearchSources({ type: "tool-plan_init", input: { secret: "hidden" } }), []);
	assert.deepEqual(partSearchSources({ type: "image", data: "base64-hidden" }), []);
	assert.deepEqual(partSearchSources({ type: "tool-quiz", state: "input-available", input: { question: "pending dock owns this" } }), []);
});

test("streaming reuses unchanged search runs without retaining old versions of the tail", () => {
	const cache: TranscriptSearchCache = new Map();
	const messages: LhViewMessage[] = [{ id: "history", role: "assistant", parts: [{ type: "text", text: "Unchanged **history**" }] },
		{ id: "tail", role: "assistant", parts: [{ type: "text", text: "Streaming" }] }];
	const first = transcriptSearchIndex(transcriptRows(messages), cache);
	for (let token = 0; token < 100; token++) {
		const changed = structuredClone(messages);
		changed[1]!.parts[0]!.text += ` ${token}`;
		const next = transcriptSearchIndex(transcriptRows(changed), cache);
		assert.equal(next[0]!.runs, first[0]!.runs);
		assert.notEqual(next[1]!.runs, first[1]!.runs);
		assert.equal(cache.size, 2);
	}
});
