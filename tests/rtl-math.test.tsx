import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";
import { QuestionPreview } from "../components/question-preview.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { PathInput } from "../components/path-input.tsx";
import { FilePathChip } from "../components/file-path-chip.tsx";
import { LatexGlyph } from "../components/latex-glyph.tsx";
import { detectTextDirection, type QuestionAnswerData } from "../src/core/index.ts";

const dom = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;
const renderMd = (text: string) =>
	dom(renderToStaticMarkup(<MessageResponse mode="static">{text}</MessageResponse>));
const renderTool = (text: string) =>
	dom(renderToStaticMarkup(<ToolContentResponse mode="static">{text}</ToolContentResponse>));

test("detectTextDirection identifies RTL, LTR, alert-prefixed RTL, and neutral strings", () => {
	assert.equal(detectTextDirection("سلام دنیا"), "rtl");
	assert.equal(detectTextDirection("مرحبا بالعالم"), "rtl");
	assert.equal(detectTextDirection("שלום עולם"), "rtl");
	assert.equal(detectTextDirection("1234 — مقدار خروجی"), "rtl");
	assert.equal(detectTextDirection("۱۲۳۴ مقدار خروجی"), "rtl");
	assert.equal(detectTextDirection("[!IMPORTANT]\nاین یک نکته مهم است."), "rtl");
	assert.equal(detectTextDirection("[!NOTE] نکته فارسی"), "rtl");
	assert.equal(detectTextDirection("Hello world"), "ltr");
	assert.equal(detectTextDirection("[!IMPORTANT]\nEnglish callout"), "ltr");
	assert.equal(detectTextDirection("123 + 456 = 579"), null);
	assert.equal(detectTextDirection("   "), null);
});

test("Persian prose with inline and display math isolates KaTeX as LTR while keeping blocks dir=auto", () => {
	const md = [
		"مقدار $x + 1 = 2$، و همچنین ($y = \\frac{1}{2}$) درست است.",
		"",
		"$f(x) = x^2$ یعنی تابع درجه دوم است.",
		"",
		"$$",
		"\\int_0^1 x^2\\,dx = \\frac{1}{3}",
		"$$",
	].join("\n");
	const doc = renderMd(md);

	const paragraphs = [...doc.querySelectorAll("p")];
	assert.ok(paragraphs.length >= 2);
	for (const p of paragraphs) {
		assert.equal(p.getAttribute("dir"), "auto");
	}

	const katexNodes = [...doc.querySelectorAll(".katex")];
	assert.ok(katexNodes.length >= 4);
	for (const katex of katexNodes) {
		assert.equal(katex.getAttribute("dir"), "ltr");
	}

	const displayWrapper = doc.querySelector('[data-testid="md-math"]');
	assert.ok(displayWrapper);
	assert.equal(displayWrapper.getAttribute("dir"), "ltr");
	const displaySpan = doc.querySelector(".katex-display");
	assert.ok(displaySpan);
	assert.equal(displaySpan.getAttribute("dir"), "ltr");

	// Punctuation glue wraps touching punctuation without overriding direction.
	const glued = [...doc.querySelectorAll(".lh-nobreak")];
	assert.ok(glued.length >= 2);
	for (const span of glued) {
		assert.equal(span.getAttribute("dir"), null);
		const innerKatex = span.querySelector(".katex");
		assert.ok(innerKatex);
		assert.equal(innerKatex.getAttribute("dir"), "ltr");
	}
});

test("RTL lists, blockquotes, callouts, and tables resolve container dir=rtl even when starting with math or code", () => {
	const md = [
		"- $x = 1$ مقدار اول است",
		"- `foo()` مقدار دوم است",
		"",
		"> نقل‌قول فارسی با فرمول $a^2 + b^2 = c^2$",
		"",
		"> [!IMPORTANT]",
		"> $E = mc^2$ رابطه هم‌ارزی جرم و انرژی است.",
		"",
		"| متغیر | مقدار |",
		"| --- | --- |",
		"| $x$ | ۵ |",
	].join("\n");
	const doc = renderMd(md);

	const ul = doc.querySelector("ul");
	assert.ok(ul);
	assert.equal(ul.getAttribute("dir"), "rtl");
	const items = [...doc.querySelectorAll("li")];
	assert.equal(items.length, 2);
	for (const li of items) assert.equal(li.getAttribute("dir"), "auto");

	const inlineCode = doc.querySelector('[data-streamdown="inline-code"]');
	assert.ok(inlineCode);
	assert.equal(inlineCode.getAttribute("dir"), "ltr");

	const quote = doc.querySelector('blockquote[data-streamdown="blockquote"]');
	assert.ok(quote);
	assert.equal(quote.getAttribute("dir"), "rtl");
	assert.ok(quote.className.includes("border-s-4"));
	assert.ok(quote.className.includes("ps-4"));

	const callout = doc.querySelector('[data-testid="md-callout"]');
	assert.ok(callout);
	assert.equal(callout.getAttribute("dir"), "rtl");

	const table = doc.querySelector('table[data-streamdown="table"]');
	assert.ok(table);
	assert.equal(table.getAttribute("dir"), "rtl");
	for (const cell of doc.querySelectorAll("th, td")) {
		assert.equal(cell.getAttribute("dir"), "auto");
	}
});

test("English lists, blockquotes, and tables stay default LTR", () => {
	const md = [
		"- First item $x = 1$",
		"",
		"> English quote",
		"",
		"> [!IMPORTANT]",
		"> English callout",
		"",
		"| Col | Val |",
		"| --- | --- |",
		"| $x$ | 1 |",
	].join("\n");
	const doc = renderMd(md);

	assert.equal(doc.querySelector("ul")?.getAttribute("dir"), null);
	assert.equal(doc.querySelector("blockquote")?.getAttribute("dir"), null);
	assert.equal(doc.querySelector('[data-testid="md-callout"]')?.getAttribute("dir"), null);
	assert.equal(doc.querySelector("table")?.getAttribute("dir"), null);
	assert.equal(doc.querySelector(".katex")?.getAttribute("dir"), "ltr");
});

test("ReasoningContent, ToolContentResponse, QuestionPreview, and LatexGlyph isolate math as LTR", () => {
	const reasoningDoc = dom(renderToStaticMarkup(
		<Reasoning defaultOpen>
			<ReasoningContent>{"بررسی معادله $a + b = c$ در این مرحله"}</ReasoningContent>
		</Reasoning>,
	));
	assert.equal(reasoningDoc.querySelector("p")?.getAttribute("dir"), "auto");
	assert.equal(reasoningDoc.querySelector(".katex")?.getAttribute("dir"), "ltr");

	const toolDoc = renderTool("حاصل $\\frac{1}{2} + \\frac{1}{3}$ چیست؟");
	assert.equal(toolDoc.querySelector("p")?.getAttribute("dir"), "auto");
	assert.equal(toolDoc.querySelector(".katex")?.getAttribute("dir"), "ltr");

	const previewDoc = dom(renderToStaticMarkup(
		<QuestionPreview>{"مقدار $x^2$ و `y` چیست؟"}</QuestionPreview>,
	));
	assert.equal(previewDoc.querySelector("[data-preview-cut]")?.getAttribute("dir"), "auto");
	assert.equal(previewDoc.querySelector(".katex")?.getAttribute("dir"), "ltr");
	assert.equal(previewDoc.querySelector('[data-streamdown="inline-code"]')?.getAttribute("dir"), "ltr");

	const glyphDoc = dom(renderToStaticMarkup(<LatexGlyph cmd="\implies" testid="glyph" />));
	assert.equal(glyphDoc.querySelector('[data-testid="glyph"]')?.getAttribute("dir"), "ltr");
});

test("QuestionDock, AnsweredCard, PathInput, and FilePathChip emit expected bidi attributes", () => {
	const dockDoc = dom(renderToStaticMarkup(
		<QuestionDock
			toolName="quiz"
			toolCallId="q_rtl"
			input={{
				type: "check",
				nodeId: "n1",
				question: "مقدار $x^2$ برای $x = 3$ چقدر است؟",
				options: [
					{ label: "$9$", value: "a" },
					{ label: "$6$", value: "b" },
				],
				correctAnswer: "a",
				explanation: "چون $3^2 = 9$ است.",
			}}
			expanded
			onExpand={() => {}}
			onSubmit={() => {}}
		/>,
	));
	const dockRadios = [...dockDoc.querySelectorAll('[role="radio"]')];
	assert.ok(dockRadios.length >= 2);
	assert.ok(dockRadios[0]!.className.includes("text-start"));
	for (const katex of dockDoc.querySelectorAll(".katex")) {
		assert.equal(katex.getAttribute("dir"), "ltr");
	}
	assert.equal(dockDoc.querySelector('[role="textbox"]')?.getAttribute("dir"), "auto");

	const answer: QuestionAnswerData = {
		kind: "explain",
		questionText: "رابطه $F = ma$ را توضیح دهید.",
		answers: [],
		dontKnow: false,
		answeredAt: "synthetic",
		text: "نیرو برابر حاصل‌ضرب جرم در شتاب است.",
		committed: "نیرو برابر $F = ma$ است.",
	};
	const answeredDoc = dom(renderToStaticMarkup(<AnsweredCard answer={answer} />));
	assert.equal(answeredDoc.querySelector(".katex")?.getAttribute("dir"), "ltr");
	const learnerAnswer = [...answeredDoc.querySelectorAll("div[dir='auto']")].find((el) =>
		el.textContent?.includes("نیرو برابر حاصل‌ضرب"),
	);
	assert.ok(learnerAnswer);

	const inputDoc = dom(renderToStaticMarkup(
		<PathInput value="سلام" onValueChange={() => {}} placeholder="Type…" />,
	));
	assert.equal(inputDoc.querySelector('[role="textbox"]')?.getAttribute("dir"), "auto");

	const chipDoc = dom(renderToStaticMarkup(<FilePathChip path="/tmp/notes.pdf" />));
	assert.equal(chipDoc.querySelector('[role="img"]')?.getAttribute("dir"), "ltr");
});

test("globals.css enforces LTR bidi isolation for KaTeX/code and logical list/table spacing", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.katex,\s*\.katex-display,\s*\[data-streamdown="inline-code"\]\s*\{[^}]*direction:\s*ltr;[^}]*unicode-bidi:\s*isolate;/s);
	assert.match(css, /padding-inline-start:\s*1\.5rem;/);
	assert.match(css, /border-inline-start:\s*1px solid var\(--border\);/);
	assert.match(css, /\[data-streamdown="table"\][^{]*\{[^}]*text-align:\s*start;/s);
	assert.match(css, /\[dir="rtl"\]\[data-testid="md-callout"\]\s*\{[^}]*margin-left:\s*auto;/s);
});
