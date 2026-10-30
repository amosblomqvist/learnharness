/**
 * StudyTimeBody static render (docs/designs/study-time.md): the pure body of
 * the Study time overlay — explanation, empty states, titles, grid.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudySummary } from "../src/core";
import { StudyTimeBody } from "../components/study-time-overlay.tsx";

const MIN = 60_000;

function summary(over: Partial<StudySummary> = {}): StudySummary {
	const days: StudySummary["grid"]["days"] = [];
	for (let i = 0; i < 364; i++) {
		const d = new Date(Date.UTC(2025, 10, 3 + i));
		days.push({ date: d.toISOString().slice(0, 10), ms: i === 363 ? 60 * MIN : 0, level: i === 363 ? 4 : 0 });
	}
	return {
		cards: { todayMs: 25 * MIN, weekMs: 108 * MIN, totalMs: 30 * 60 * MIN },
		range: {
			key: "week",
			perChat: [
				{ chatId: "c1", ms: 90 * MIN },
				{ chatId: "gone", ms: 18 * MIN },
			],
			hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 65 * MIN : 0)),
		},
		grid: { weekStart: "monday", days },
		idleMinutes: 5,
		...over,
	};
}

const render = (props: Partial<React.ComponentProps<typeof StudyTimeBody>> = {}) =>
	renderToStaticMarkup(
		<StudyTimeBody
			summary={summary()}
			titles={new Map([["c1", "Linear algebra"]])}
			range="week"
			onRange={() => {}}
			state="ready"
			{...props}
		/>,
	);

describe("StudyTimeBody", () => {
	it("shows the title and the explanation line with N", () => {
		const html = render();
		assert.ok(html.includes("Study time"));
		assert.ok(html.includes("Pauses after 5 minutes without input."));
	});

	it('renders N as "1 minute" when it is 1', () => {
		const html = render({ summary: summary({ idleMinutes: 1 }) });
		assert.ok(html.includes("Pauses after 1 minute without input."));
	});

	it("cards use hours-and-minutes formatting", () => {
		const html = render();
		assert.ok(html.includes("25m"));
		assert.ok(html.includes("1h 48m"));
		assert.ok(html.includes("30h 0m"));
	});

	it("joins titles by chat id; a missing id reads as deleted chat", () => {
		const html = render();
		assert.ok(html.includes("Linear algebra"));
		assert.ok(html.includes("deleted chat"));
		assert.ok(!html.includes(">c1<"));
	});

	it("empty state replaces cards and charts when nothing was ever recorded", () => {
		const html = render({ summary: summary({ cards: { todayMs: 0, weekMs: 0, totalMs: 0 } }) });
		assert.ok(html.includes("No study time yet. Time spent in a chat appears here after you leave the chat, switch windows, or go 5 minutes without input."));
		assert.ok(!html.includes("study-card-"));
		assert.ok(!html.includes("study-grid"));
	});

	it("an empty range shows the period text but keeps cards and grid", () => {
		const html = render({ summary: summary({ range: { key: "last7", perChat: [], hours: new Array(24).fill(0) } }), range: "last7" });
		assert.equal(html.split("No study time in this period.").length - 1, 2, "per-chat and histogram");
		assert.ok(html.includes("study-card-today"));
		assert.ok(html.includes('data-testid="study-grid"'));
	});

	it("range switch marks the selected range", () => {
		const html = render({ range: "last30" });
		assert.ok(/data-testid="study-range-last30"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="study-range-last30"/.test(html));
		for (const label of ["This week", "This month", "Last 7 days", "Last 30 days", "All time"]) assert.ok(html.includes(label), label);
	});

	it("histogram has 24 bars titled with the hour span and duration", () => {
		const html = render();
		assert.equal(html.split('data-testid="study-hour-bar"').length - 1, 24);
		assert.ok(html.includes("14:00–15:00 · 1h 5m"));
	});

	it("grid renders one cell per day with its level; level 0 uses the muted token", () => {
		const html = render();
		assert.equal(html.split('data-testid="study-grid-cell"').length - 1, 364);
		assert.equal(html.split('data-level="4"').length - 1, 1);
		assert.ok(html.includes("var(--muted)"));
		assert.ok(html.includes("1h 0m"), "a cell title carries the duration");
	});

	it("loading and error states", () => {
		assert.ok(render({ summary: null, state: "loading" }).includes("Loading…"));
		const err = render({ summary: null, state: "error" });
		assert.ok(err.includes("Could not load study time."));
		assert.ok(!err.includes("Loading…"));
		const reloading = render({ state: "loading" });
		assert.ok(reloading.includes("opacity-50"), "previous summary stays, dimmed");
	});
});
