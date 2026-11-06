import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ConcludeCard } from "../components/practice-cards.tsx";
import { renderWithInteractionLayers } from "./interaction-layer-render.tsx";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import type { ArtifactPartProps } from "../src/core";

const badgeSelector = '[data-slot="status-badge"]';
const baseClasses = ["rounded", "px-1.5", "py-0.5", "font-ui", "text-xs", "font-medium", "uppercase", "tracking-wide"];

function badgeFrom(html: string) {
	const { document } = parseHTML(html);
	const badges = document.querySelectorAll<HTMLElement>(badgeSelector);
	assert.equal(badges.length, 1, "one shared badge");
	return badges[0]!;
}

function assertAppearance(badge: HTMLElement, text: string, color?: string) {
	assert.equal(badge.tagName, "SPAN");
	assert.equal(badge.textContent, text);
	for (const token of baseClasses) assert.ok(badge.classList.contains(token), token);
	if (color === undefined) {
		assert.ok(badge.classList.contains("bg-muted"));
		assert.ok(badge.classList.contains("text-muted-foreground"));
		assert.equal(badge.hasAttribute("style"), false);
	} else {
		assert.equal(badge.style.color, color);
		assert.equal(badge.style.backgroundColor, `color-mix(in oklab, ${color} 15%, transparent)`);
		assert.equal(badge.classList.contains("bg-muted"), false);
		assert.equal(badge.classList.contains("text-muted-foreground"), false);
	}
}

// Dynamic loading lets the native/source regression pins run during the RED
// phase too, before the shared component exists.
it("StatusBadge renders arbitrary text literally, without markdown, HTML, icons or interactive/live semantics", async () => {
	const { StatusBadge } = await import("../components/ui/status-badge.tsx");
	const text = '<img src=x onerror="alert(1)"> **literal** $x^2$ & ready';
	const html = renderToStaticMarkup(<StatusBadge text={text} />);
	const badge = badgeFrom(html);
	assert.equal(badge.textContent, text);
	assert.equal(badge.children.length, 0);
	assert.equal(badge.tagName, "SPAN");
	assert.match(html, /&lt;img/);
	for (const attribute of ["role", "aria-live", "tabindex", "onclick", "color", "text"]) {
		assert.equal(badge.hasAttribute(attribute), false, attribute);
	}
});

it("StatusBadge has self-contained native typography and shape with neutral omitted color", async () => {
	const { StatusBadge } = await import("../components/ui/status-badge.tsx");
	assertAppearance(badgeFrom(renderToStaticMarkup(<StatusBadge text="Waiting" />)), "Waiting");
});

it("StatusBadge uses the supplied CSS color and exact 15% oklab background, safely during SSR", async () => {
	const { StatusBadge } = await import("../components/ui/status-badge.tsx");
	assert.equal(typeof window, "undefined", "the component needs no browser color API");
	for (const color of ["rebeccapurple", "#123456", "rgb(10 20 30 / 70%)", "var(--color-green-500)"]) {
		assertAppearance(badgeFrom(renderToStaticMarkup(<StatusBadge text="Custom" color={color} />)), "Custom", color);
	}
});

for (const file of ["answered-card.tsx", "practice-cards.tsx"]) {
	it(`${file} adopts the shared StatusBadge instead of duplicating chip markup`, () => {
		const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
		assert.match(source, /import \{ StatusBadge \} from "@\/components\/ui\/status-badge"/);
		assert.match(source, /<StatusBadge\b/);
		assert.doesNotMatch(source, /bg-(?:green|red|amber)-500\/15/);
	});
}

function question(kind: QuestionData["kind"] = "quiz"): QuestionData {
	return {
		id: "badge-question",
		kind,
		question: "Which answer?",
		mode: kind === "explain" ? "text" : "single-select",
		options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
		correctIndices: [1],
		createdAt: "2026-11-06T00:00:00.000Z",
	};
}

const quizBadges: Array<[string, Parameters<typeof buildAnswer>[1], string | undefined]> = [
	["correct", { values: ["a"] }, "var(--color-green-500)"],
	["incorrect", { values: ["b"] }, "var(--color-red-500)"],
	["didn't know", { dontKnow: true }, undefined],
];
for (const [label, submission, color] of quizBadges) {
	it(`AnsweredCard preserves the ${label} badge label and color`, () => {
		const answer = buildAnswer(question(), submission);
		assertAppearance(badgeFrom(renderToStaticMarkup(<AnsweredCard answer={answer} />)), label, color);
	});
}

for (const kind of ["ask", "explain"] as const) {
	it(`AnsweredCard keeps ${kind} answers free of verdict badges`, () => {
		const answer = buildAnswer(question(kind), { text: "An answer", values: ["a"] });
		const { document } = parseHTML(renderToStaticMarkup(<AnsweredCard answer={answer} />));
		assert.equal(document.querySelector(badgeSelector), null);
	});
}

it("AnsweredCard keeps dismissed questions as a skipped line without a badge", () => {
	const answer = { ...buildAnswer(question(), { dontKnow: true }), dismissed: true };
	const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
	assert.match(html, /skipped/);
	assert.equal(parseHTML(html).document.querySelector(badgeSelector), null);
});

function conclude(outcome?: string) {
	const part: ArtifactPartProps["part"] = {
		type: "tool-conclude",
		state: "output-available",
		toolCallId: "badge-conclude",
		input: { outcome, verdict: "Verdict fixture" },
		reveal: "Reveal fixture",
	};
	return renderWithInteractionLayers(<ConcludeCard part={part} />);
}

for (const [outcome, label, color] of [
	["solved", "Solved", "var(--color-green-500)"],
	["solvedWithHints", "Solved with hints", "var(--color-amber-500)"],
	["surrendered", "Surrendered", "var(--color-red-500)"],
	["movedOn", "Moved on", undefined],
] as const) {
	it(`ConcludeCard preserves the ${outcome} badge and surrounding content`, () => {
		const html = conclude(outcome);
		assertAppearance(badgeFrom(html), label, color);
		assert.match(html, /Concluded/);
		assert.match(html, /Verdict fixture/);
		assert.match(html, /Reveal fixture/);
	});
}

it("ConcludeCard preserves dismissal as one muted line without badge, verdict or reveal", () => {
	const html = conclude("dismissed");
	assert.match(html, /Problem dismissed\./);
	assert.equal(parseHTML(html).document.querySelector(badgeSelector), null);
	assert.doesNotMatch(html, /Verdict fixture|Reveal fixture|Concluded/);
});

it("ConcludeCard keeps absent and unknown outcomes free of badges", () => {
	for (const outcome of [undefined, "unknown"]) {
		assert.equal(parseHTML(conclude(outcome)).document.querySelector(badgeSelector), null);
	}
});
