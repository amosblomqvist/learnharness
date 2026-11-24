import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { questionCardStandIn } from "../components/question-dock.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

// Synthetic geometry seam (linkedom has no layout): every box is 100px tall
// and as wide as its inline width; the card is 1200px inside. Proves the
// answered card's arrangement and WHEN it measures — the browser check
// covers real wrapping and the match with the question card.
const dom = parseHTML("<html><body></body></html>");
let measurements = 0;
let near: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: (el: Element) => {
		// Count measuring (inside the probe), not finding the scroller.
		if (el.closest?.("[data-question-layout-probe]")) measurements++;
		return { paddingLeft: "16px", paddingRight: "16px", borderLeftWidth: "0px", borderRightWidth: "0px", overflowX: "visible", overflowY: "visible", width: (el as HTMLElement).style?.width ?? "" };
	},
	ResizeObserver: class { observe() {} disconnect() {} },
	IntersectionObserver: class {
		constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { near.push(cb); }
		observe() {}
		disconnect() {}
	},
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
	configurable: true,
	value(this: HTMLElement) { return { width: Number.parseFloat(this.style.width) || 0, height: 100 }; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
	configurable: true,
	get(this: HTMLElement) { return this.getAttribute("data-testid") === "answered-card" ? 1200 : Number.parseFloat(this.style.width) || 0; },
});

const quizInput = {
	question: "A ball is thrown straight up. At the top, what is its velocity?",
	options: [{ label: "Zero" }, { label: "$v_0$" }, { label: "$-g$" }],
	correctAnswer: "Zero",
	explanation: "Gravity.",
};
const quizQD = (): QuestionData => {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1", kind: "quiz", mode: "single-select", question: quizInput.question, options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices, explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
};

async function mount(adaptiveQuestions: boolean, toolCallId = "q1") {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const answer = buildAnswer(quizQD(), { values: ["Zero"], confidence: 70, thinking: "Gravity keeps acting." });
	await act(async () => root.render(
		<AppearanceProvider initialAppearance={{ adaptiveQuestions }} initialTheme={DEFAULT_THEME}>
			<AnsweredCard answer={answer} input={quizInput} toolCallId={toolCallId} />
		</AppearanceProvider>,
	));
	return { host, root };
}
async function comeNear() {
	await act(async () => { for (const cb of near) cb([{ isIntersecting: true }]); near = []; await new Promise((r) => setTimeout(r, 5)); });
}

test("answered card: stacked until it nears the screen, then the question card's columns at full width", async () => {
	measurements = 0; near = [];
	const { host, root } = await mount(true);
	try {
		const card = host.querySelector<HTMLElement>('[data-testid="answered-card"]')!;
		assert.equal(card.getAttribute("data-question-layout"), "stacked");
		assert.equal(measurements, 0, "nothing is measured off screen");
		await comeNear();
		assert.equal(card.getAttribute("data-question-layout"), "columns");
		const grid = card.querySelector<HTMLElement>(":scope > .grid")!;
		// Answer column = the question card's (incl. its 28px padding) less
		// that padding; the question takes the rest, 1.5rem (24px) apart.
		assert.match(grid.getAttribute("style") ?? "", /grid-template-columns:\s*minmax\(0(px)?, 1fr\) calc\(\d+px - 1\.75rem\)/);
		assert.match(grid.getAttribute("style") ?? "", /column-gap:\s*1\.5rem/);
		const [question, answers] = [...grid.children] as HTMLElement[];
		assert.ok(question!.textContent!.includes("thrown straight up"));
		assert.ok(answers!.querySelector('[data-testid="answered-confidence"]'), "confidence sits under the options");
		assert.deepEqual([...answers!.querySelectorAll("[data-option-letter]")].map((el) => el.textContent), ["A", "B", "C"], "old answer renders letters without a saved map");
		assert.match(answers!.className, /justify-center/);
		assert.equal(grid.contains(card.querySelector('[data-testid="your-thinking"]')), false, "thinking stays full width below");
		assert.equal(document.querySelector("[data-question-layout-probe]"), null, "probe removed");
	} finally { await act(async () => root.unmount()); host.remove(); }
});

test("answered card: a remount reuses its solved layout; adaptation off keeps today's card", async () => {
	measurements = 0; near = [];
	const first = await mount(true, "q2");
	await comeNear();
	await act(async () => first.root.unmount()); first.host.remove();
	const before = measurements;
	const again = await mount(true, "q2");
	await comeNear();
	assert.equal(again.host.querySelector('[data-testid="answered-card"]')!.getAttribute("data-question-layout"), "columns");
	assert.equal(measurements, before, "no second measurement");
	await act(async () => again.root.unmount()); again.host.remove();

	measurements = 0; near = [];
	const off = await mount(false, "q3");
	try {
		await comeNear();
		const card = off.host.querySelector('[data-testid="answered-card"]')!;
		assert.equal(card.getAttribute("data-question-layout"), "stacked");
		assert.equal(card.querySelector(":scope > .grid"), null);
		assert.equal(measurements, 0);
	} finally { await act(async () => off.root.unmount()); off.host.remove(); }
});

test("the question card stand-in mirrors the pending card: options, I don't know, confidence", () => {
	const live = (html: string) => { const el = document.createElement("div"); el.innerHTML = html; return el; };
	const quiz = questionCardStandIn(document as unknown as Document, {
		label: "Prediction", kind: "quiz", multiSelect: false,
		question: live("<p>Q</p>"), context: null, options: [live("<p>A</p>"), live("<p>B</p>")],
	});
	assert.equal(quiz.question.textContent, "PredictionQ");
	const rows = quiz.options.firstElementChild!.children;
	assert.equal(rows.length, 3, "two options + I don't know");
	assert.match(rows[2]!.className, /border-dashed/);
	for (const row of rows) {
		assert.match(row.className, /items-center/);
		assert.doesNotMatch(row.firstElementChild!.className, /mt-0\.5/);
	}
	assert.ok(quiz.confidence?.textContent?.includes("Confidence"));

	const ask = questionCardStandIn(document as unknown as Document, {
		label: "Question", kind: "ask", multiSelect: true,
		question: live("<p>Q</p>"), context: live("<p>ctx</p>"), options: [live("<p>A</p>")],
	});
	assert.equal(ask.question.textContent, "Question · select all that applyQctx");
	assert.equal(ask.options.firstElementChild!.children.length, 2, "option + the empty Other field");
	assert.equal(ask.confidence, null);
});
