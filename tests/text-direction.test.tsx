/**
 * Bidirectional text (components/text-direction.ts): Persian/Arabic blocks
 * get dir="rtl" by word vote, code and math stay left-to-right islands, and
 * English-only markdown renders exactly as before. Static HTML via
 * react-dom/server, the render-markdown idiom (classic-JSX React shim).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { PlanBlock } from "../components/plan-block.tsx";
import { rtlDir, textDirection } from "../components/text-direction.ts";
import type { PlanBlockData } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const render = (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
/** The opening tag of the first <tag> whose text includes `text`. */
function openTag(html: string, tag: string, text: string): string {
	const at = html.indexOf(text);
	assert.ok(at >= 0, `missing ${text}`);
	const start = html.lastIndexOf(`<${tag}`, at);
	return html.slice(start, html.indexOf(">", start) + 1);
}

describe("textDirection (word vote)", () => {
	it("reads Persian that opens with an English term as right-to-left", () => {
		// dir="auto" (first strong character) gets exactly this case wrong.
		assert.equal(textDirection("React یک کتابخانه است."), "rtl");
		assert.equal(textDirection("سلام React"), "rtl");
	});

	it("keeps English with a stray Persian word left-to-right", () => {
		assert.equal(textDirection("This is a sentence with one کلمه"), "ltr");
		assert.equal(textDirection("Hello world"), "ltr");
	});

	it("does not let digits or Arabic punctuation vote", () => {
		assert.equal(textDirection("۱۲۳"), undefined);
		assert.equal(textDirection("Hello، world"), "ltr");
		assert.equal(textDirection(""), undefined);
	});

	it("does not let single-letter variables and units outvote Persian", () => {
		assert.equal(textDirection("زیرمورد: 1 N = 1 kg·m/s²"), "rtl");
		assert.equal(textDirection("یعنی F = m a"), "rtl");
	});

	it("counts words with diacritics as one right-to-left word", () => {
		assert.equal(textDirection("کِتاب"), "rtl");
	});

	it("rtlDir marks only right-to-left labels", () => {
		assert.equal(rtlDir("آموزش React"), "rtl");
		assert.equal(rtlDir("Learning React"), undefined);
		assert.equal(rtlDir(undefined), undefined);
	});
});

describe("markdown blocks", () => {
	it("marks a mixed Persian paragraph rtl and leaves inline code and math out of the vote", () => {
		const html = render("`useState()` and `useEffect()` در React دو هوک مهم هستند و $a+b$ را حساب می‌کنند.");
		assert.match(openTag(html, "p", "در React"), /dir="rtl"/);
	});

	it("leaves English-only markdown without any dir attribute", () => {
		const html = render("Plain **English** paragraph.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |");
		assert.doesNotMatch(html, /\sdir=/);
	});

	it("marks lists, items and headings by their own text", () => {
		const html = render("## عنوان فارسی\n\n- مورد اول\n- مورد دوم");
		assert.match(openTag(html, "h2", "عنوان"), /dir="rtl"/);
		assert.match(openTag(html, "ul", "مورد اول"), /dir="rtl"/);
		// Items inherit the list's direction instead of repeating it.
		assert.doesNotMatch(openTag(html, "li", "مورد اول"), /\sdir=/);
	});

	it("gives an English cell inside a Persian table its own ltr direction", () => {
		const html = render("| نام | توضیح |\n|---|---|\n| علی | یک دانشجو است |\n| Newton | English physicist |");
		assert.match(openTag(html, "table", "نام"), /dir="rtl"/);
		assert.match(openTag(html, "td", "English physicist"), /dir="ltr"/);
	});

	it("keeps the direction on key-idea callouts", () => {
		const html = render("> [!IMPORTANT]\n> این نکته مهم است و باید یادت بماند");
		assert.match(openTag(html, "div", "این نکته"), /dir="rtl"/);
	});

	it("marks right-to-left plan node labels in the SVG, and only those", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-10-31T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "قانون دوم Newton", status: "visited" },
				{ id: "b", title: "Momentum", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(openTag(html, "text", "قانون"), /direction="rtl"/);
		assert.doesNotMatch(openTag(html, "text", "Momentum"), /direction=/);
	});

	it("turns a Persian question's whole option list right-to-left, and leaves an English one alone", () => {
		const answer = (questionText: string, labels: string[]): QuestionAnswerData => ({
			kind: "ask", questionText, options: labels.map((label, i) => ({ index: i + 1, label })),
			answers: [{ index: 1, label: labels[0]!, value: "a" }], dontKnow: false, answeredAt: "synthetic",
		});
		const fa = renderToStaticMarkup(<AnsweredCard answer={answer("کدام موضوع را می‌خواهی؟", ["چرا آسمان آبی است", "p = mv"])} />);
		// The list container itself, so formula-only rows sit right as well.
		assert.match(fa, /<div dir="rtl" class="flex flex-col gap-1\.5/);
		const en = renderToStaticMarkup(<AnsweredCard answer={answer("Which topic?", ["Why the sky is blue", "Inflation"])} />);
		assert.doesNotMatch(en, /\sdir=/);
	});

	it("never marks code blocks", () => {
		const html = render("متن فارسی قبل از کد\n\n```js\nconst پیام = \"سلام دنیا\";\n```");
		assert.doesNotMatch(openTag(html, "pre", "const"), /\sdir=/);
	});
});
