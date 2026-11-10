import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ToolContentResponse } from "../components/ai-elements/message.tsx";
import { svgContentParts } from "../components/svg-content.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard } from "../components/practice-cards.tsx";

const figure = '<svg viewBox="0 0 200 80"><title>Given triangle</title><style>body{display:none}</style><path d="M10 70L100 10L190 70Z"/></svg>';
const solution = '<svg viewBox="0 0 10 10"><title>Secret solution</title><text>42</text></svg>';
const documentOf = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

test("raw and fenced SVG render as isolated images, with surrounding prose and math", () => {
	for (const source of [figure, `\`\`\`svg\n${figure}\n\`\`\``]) {
		const doc = documentOf(renderToStaticMarkup(<ToolContentResponse mode="static">{`Before $x^2$.\n\n${source}\n\nAfter.`}</ToolContentResponse>));
		assert.equal(doc.querySelectorAll("img").length, 1);
		assert.equal(doc.querySelector("img")!.getAttribute("alt"), "Given triangle");
		assert.equal(doc.querySelector("svg,style,path,script"), null);
		assert.ok(doc.querySelector(".katex"));
		assert.match(doc.body.textContent!, /Before/);
		assert.match(doc.body.textContent!, /After/);
	}
});

test("SVG source examples and incomplete figures stay Markdown; comments and nesting do not truncate figures", () => {
	for (const source of [`\`${figure}\``, `\`\`\`html\n${figure}\n\`\`\``, '<svg viewBox="0 0 10 10"><path']) {
		assert.ok(svgContentParts(source).every(part => part.kind === "markdown"));
	}
	const nested = figure.replace("<path", '<!-- </svg> --><svg><rect/></svg><path');
	assert.deepEqual(svgContentParts(nested), [{ kind: "svg", value: nested }]);
});

test("pending quiz renders question/context/choice figures without exposing the solution", () => {
	const input = { question: `Which?\n\n${figure}`, details: figure, options: [{ label: figure, value: "a" }, { label: "Other", value: "b" }], correctAnswer: "a", explanation: solution };
	const before = structuredClone(input);
	const html = renderToStaticMarkup(<QuestionDock toolName="probe" toolCallId="svg-question" input={input} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.equal(documentOf(html).querySelectorAll("img").length, 3);
	assert.ok(!html.includes("Secret") && !html.includes("42"));
	assert.deepEqual(input, before);
});

test("practice shows its figure and conclusion displays the separately committed solution figure", () => {
	const html = renderToStaticMarkup(<PracticeDock problemCallId="p" input={{ statement: figure, modelSolution: solution } as { statement: string }} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.equal(documentOf(html).querySelectorAll("img").length, 1);
	assert.ok(!html.includes("Secret"));
	const reveal = renderToStaticMarkup(<ConcludeCard part={{ type: "tool-conclude", toolCallId: "c", state: "output-available", input: { outcome: "solved" }, reveal: solution }} />);
	assert.equal(documentOf(reveal).querySelector("img")?.getAttribute("alt"), "Secret solution");
});
