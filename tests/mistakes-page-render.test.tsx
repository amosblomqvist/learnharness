/**
 * The Mistakes page card renders MODEL-AUTHORED Markdown through
 * ToolContentResponse. These pins exist because the old plain-text spans
 * showed raw TeX ("$25\,^\circ\text{C}$") instead of KaTeX.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MistakeCard } from "../components/mistakes-page.tsx";
import { presentMistakeAnalysis, type MistakeRecord } from "../src/core/mistakes.ts";

const record: MistakeRecord = {
	id: "chat_1:call_1",
	chatId: "chat_1",
	kind: "missed",
	origin: "quiz",
	question: "A copper coil at $20\\,^\\circ\\text{C}$ draws $3\\,\\text{A}$. Find $R$.",
	yourAnswer: "$66.9\\,^\\circ\\text{C}$",
	correctAnswer: "$70.9\\,^\\circ\\text{C}$",
	thinking: "Use $R_2 = R_1(1 + \\alpha \\Delta t)$.",
	answeredAt: "2026-11-10T10:00:00.000Z",
	createdAt: "2026-11-10T10:00:00.000Z",
	sessionTitle: "FEEX - Unit 1",
	sessionKind: "teach",
	sources: [],
	status: "ready",
	analysis: {
		errorType: "setup-error",
		topic: "temperature coefficient of resistance",
		whatYouDid: "You used $\\alpha_0$ with a resistance at $20\\,^\\circ\\text{C}$.",
		correct: "Move the coefficient first: $\\alpha_{20} = \\alpha_0/(1+\\alpha_0 t_1)$.",
		rule: "Check the reference temperature before substituting $\\alpha$.",
	},
};

function render(open: boolean) {
	return renderToStaticMarkup(
		<MistakeCard record={record} open={open} onToggle={() => {}} onDelete={() => {}} onRetry={() => {}} />,
	);
}

describe("Mistakes analysis code tokens", () => {
	it("turns regex-as-math into inline code without touching real math", () => {
		const input = String.raw`It is not knowing that $\backslash$d means a digit, $[.-]$ is a class, and $\{3\}$ is three. Real math $[1,4,9,16]$ and $\alpha_0$ stay. Code $r"\backslash d\{3\}[.-]\backslash d\{4\}"$ too.`;
		const out = presentMistakeAnalysis(input);
		assert.match(out, /`\\d` means a digit/);
		assert.match(out, /`\[\.-\]` is a class/);
		assert.match(out, /`\{3\}` is three/);
		assert.match(out, /\$\[1,4,9,16\]\$/);
		assert.match(out, /\$\\alpha_0\$/);
		assert.match(out, /`r"\\d\{3\}\[\.-\]\\d\{4\}"`/);
		assert.match(presentMistakeAnalysis("covers $123-456-7890$ and $987.654.3210$"), /`123-456-7890` and `987\.654\.3210`/);
	});
});

describe("Mistakes card Markdown and math", () => {
	it("renders the question as KaTeX, never as raw dollar-TeX, without corner-hook borders or unclipped fades", () => {
		const html = render(false);
		assert.match(html, /data-testid="mistake-card"/);
		assert.match(html, /class="katex"/);
		assert.doesNotMatch(html, /\$20\\,/, "the question's TeX is rendered, not printed");
		assert.doesNotMatch(html, /border-l-2/, "card wrapper has uniform rounded corners");
		assert.doesNotMatch(html, /bg-gradient-to-t/, "short previews are not dimmed");
	});

	it("expanded card renders answers, analysis, and the rule as Markdown/KaTeX", () => {
		const html = render(true);
		assert.match(html, /data-testid="mistake-card-body"/);
		assert.match(html, /Your answer/);
		assert.match(html, /Correct answer/);
		assert.match(html, /What happened/);
		assert.match(html, /What’s correct/);
		assert.match(html, /Remember this/);
		assert.match(html, /Your reasoning/);
		assert.match(html, /class="katex"/);
		assert.doesNotMatch(html, /\\alpha_0\$/, "the rule's TeX is rendered");
	});
});
