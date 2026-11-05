import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionPreview } from "../components/question-preview.tsx";
import { QuestionDockBar } from "../components/question-dock.tsx";
import { ProbeDoneCard } from "../components/artifacts/probe-done-card.tsx";

const dom = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const preview = (source: string) => dom(<QuestionPreview>{source}</QuestionPreview>);
const annotations = (root: ParentNode) => [...root.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent);

describe("collapsed question inline preview", () => {
	it("preserves inline math, code bytes, emphasis and inert link labels", () => {
		const source = String.raw`Compare $\frac{a}{b}$ and \(x_k\), **bold**, *italic*, ~~old~~, [the docs](https://example.com) and ` + '`a  b\\n $literal$`';
		const document = preview(source);
		assert.deepEqual(annotations(document), [String.raw`\frac{a}{b}`, "x_k"]);
		assert.equal(document.querySelector('code[data-streamdown="inline-code"]')?.textContent, String.raw`a  b\n $literal$`);
		assert.equal(document.querySelector("strong")?.textContent, "bold");
		assert.equal(document.querySelector("em")?.textContent, "italic");
		assert.equal(document.querySelector("del")?.textContent, "old");
		assert.equal(document.querySelector(".underline")?.textContent, "the docs");
		assert.equal(document.querySelectorAll("a, button, input, [tabindex], [href], [title], img, pre, table, .katex-display").length, 0);
	});

	it("retains reference-link labels and image alt text without navigation or media", () => {
		const document = preview("Read [**the docs**][ref] and ![an image](https://example.com/pic.png).\n\n[ref]: https://example.com");
		assert.equal(document.querySelector("strong")?.textContent, "the docs");
		assert.ok(document.body.textContent.includes("an image"));
		assert.equal(document.querySelectorAll("a, img").length, 0);
	});

	for (const [name, block] of [
		["backtick fence", "```python\nBLOCK_SENTINEL\n```"],
		["tilde fence", "~~~text\nBLOCK_SENTINEL\n~~~"],
		["indented code", "    BLOCK_SENTINEL"],
		["display math", "$$\n\\text{BLOCK_SENTINEL}\n$$"],
		["legacy display math", String.raw`\[\text{BLOCK_SENTINEL}\]`],
		["nested code", "> ```text\n> BLOCK_SENTINEL\n> ```"],
		["nested display math", "> $$\n> \\text{BLOCK_SENTINEL}\n> $$"],
	] as const) it(`stops before ${name} and never resumes after it`, () => {
		const document = preview(`Prefix $x$ and \`code\`.\n\n${block}\n\nAFTER_SENTINEL`);
		assert.ok(document.body.textContent.includes("Prefix"));
		assert.deepEqual(annotations(document), ["x"]);
		assert.ok(!document.body.textContent.includes("BLOCK_SENTINEL"));
		assert.ok(!document.body.textContent.includes("AFTER_SENTINEL"));
		assert.equal(document.querySelectorAll("pre, button, .katex-display").length, 0);
	});

	it("leaves code mentions of display delimiters literal and flattens paragraph/line breaks", () => {
		const document = preview("First `$$` and `\\[x\\]`.\nSecond **line**.  \nThird.\n\nNext paragraph with $y$.");
		assert.deepEqual(annotations(document), ["y"]);
		assert.deepEqual([...document.querySelectorAll("code")].map((node) => node.textContent), ["$$", String.raw`\[x\]`]);
		assert.match(document.body.textContent, /Third\. +Next paragraph/);
		assert.equal(document.querySelectorAll("br, p, h1, ul, pre").length, 0);
	});

	it("flattens other Markdown containers without introducing block layout or controls", () => {
		const document = preview("# Heading\n\n- [x] **first**\n- second\n\n| A | B |\n|---|---|\n| $x$ | `y` |");
		assert.match(document.body.textContent, /Heading +first +second +A +B/);
		assert.equal(document.querySelector("strong")?.textContent, "first");
		assert.deepEqual(annotations(document), ["x"]);
		assert.equal(document.querySelector("code")?.textContent, "y");
		assert.equal(document.querySelectorAll("h1, ul, li, table, input, button").length, 0);
	});

	it("has an empty teaser when the first content is a block; no new placeholder copy", () => {
		for (const source of ["$$\nx=1\n$$\n\nTAIL", "```text\ncode\n```\n\nTAIL"]) {
			assert.equal(preview(source).body.textContent, "");
		}
	});

	it("does not render raw HTML controls or unsafe link targets", () => {
		const document = preview('Before <button onclick="alert(1)">label</button> [safe label](javascript:alert) <script>alert(1)</script>');
		assert.equal(document.querySelectorAll("button, a, script, [onclick]").length, 0);
		assert.ok(document.body.textContent.includes("safe label"));
		assert.ok(!document.body.textContent.includes("[blocked]"));
	});

	it("both bar variants contain only the outer expand button", () => {
		const source = "Use [the docs](https://example.com) and `a  b`.\n\n```js\nBLOCK\n```";
		for (const variant of ["collapsed", "reveal"] as const) {
			const document = dom(<QuestionDockBar toolName="quiz" question={source} variant={variant} onExpand={() => {}} />);
			assert.equal(document.querySelectorAll("button").length, 1);
			assert.equal(document.querySelectorAll("a, [data-testid=md-copy], pre").length, 0);
			assert.ok(document.body.textContent.includes("the docs"));
			assert.ok(!document.body.textContent.includes("BLOCK"));
			assert.ok(document.body.textContent.includes(variant === "reveal" ? "Open" : "Answer"));
		}
	});

	it("each mounted preview and its styled link label invoke the same expand action", async () => {
		const document = parseHTML("<html><body></body></html>");
		const globals = { window: document.window, document: document.document, IS_REACT_ACT_ENVIRONMENT: true };
		const previous = Object.getOwnPropertyDescriptors(globalThis);
		Object.assign(globalThis, globals);
		try {
			for (const variant of ["collapsed", "reveal"] as const) {
				let expands = 0;
				const host = document.document.createElement("div"); document.document.body.append(host);
				const root = createRoot(host);
				try {
					await act(async () => root.render(<QuestionDockBar toolName="quiz" question="Read [the docs](https://example.com) and $x$." variant={variant} onExpand={() => { expands++; }} />));
					const label = host.querySelector(".underline")!;
					await act(async () => { label.dispatchEvent(new document.window.Event("click", { bubbles: true })); });
					assert.equal(expands, 1);
					await act(async () => { host.querySelector("button")!.click(); });
					assert.equal(expands, 2);
					assert.equal(host.querySelectorAll("button").length, 1);
				} finally {
					await act(async () => root.unmount()); host.remove();
				}
			}
		} finally {
			for (const key of Object.keys(globals)) {
				if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
});

describe("probe conclusion Markdown", () => {
	it("renders inline code and formatting in all assessment slots without rewriting the input", () => {
		const input = Object.freeze({ assessment: Object.freeze({
			strands: Object.freeze([Object.freeze({ strand: "**Arrays** and `map`", assessment: "Understands `$x$` and *iteration*." })]),
			summary: "Use `reduce` with $n$ terms.\n\n```js\nconst n = 1;\n```",
		}) });
		const before = JSON.stringify(input);
		const document = dom(<ProbeDoneCard part={{ state: "output-available", input, output: { ok: true } }} />);
		assert.equal(document.querySelector("strong")?.textContent, "Arrays");
		assert.equal(document.querySelector("em")?.textContent, "iteration");
		assert.deepEqual([...document.querySelectorAll('code[data-streamdown="inline-code"]')].map((node) => node.textContent), ["map", "$x$", "reduce"]);
		assert.deepEqual(annotations(document), ["n"]);
		assert.equal(document.querySelectorAll('[data-testid="md-code"]').length, 1, "the full card, unlike a preview, retains block rendering");
		assert.equal(JSON.stringify(input), before);
	});

	it("keeps retry bookkeeping plain even when it contains Markdown or math", () => {
		const document = dom(<ProbeDoneCard part={{ output: { ok: false, error: "Retry `$x$` and **literal**" } }} />);
		assert.equal(document.querySelectorAll(".katex, code, strong").length, 0);
		assert.ok(document.body.textContent.includes("`$x$`"));
	});
});
