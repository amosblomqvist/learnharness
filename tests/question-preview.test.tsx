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

// These controlled boxes test the measurement/cutoff lifecycle, not typography.
// Real KaTeX geometry/centering/card-height comparisons require the browser check.
async function withGeometry(run: (fixture: {
	host: HTMLElement;
	render: (source: string) => Promise<void>;
	metrics: { budget: number; tall: number };
	resize: () => void;
	fontsLoaded: () => void;
}) => Promise<void>, initialBudget = 20) {
	const { window, document } = parseHTML("<html><body></body></html>");
	const callbacks = new Set<() => void>();
	class Observer {
		constructor(private callback: () => void) {}
		observe() { callbacks.add(this.callback); }
		disconnect() { callbacks.delete(this.callback); }
	}
	const globals = { window, document, ResizeObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	const prototype = window.HTMLElement.prototype;
	const previousRect = Object.getOwnPropertyDescriptor(prototype, "getBoundingClientRect");
	const metrics = { budget: initialBudget, tall: 40 };
	Object.defineProperty(prototype, "getBoundingClientRect", { configurable: true, value(this: HTMLElement) {
		let height = 0;
		if (this.hasAttribute("data-question-preview")) height = metrics.budget;
		else if (this.matches(".katex, .katex-error")) height = this.querySelector("annotation")?.textContent?.includes("\\begin") ? metrics.tall : 12;
		return { x: 0, y: 0, top: 0, left: 0, width: 280, height, right: 280, bottom: height };
	} });
	const fonts = document.createElement("div");
	Object.defineProperty(document, "fonts", { value: fonts });
	Object.assign(globalThis, globals);
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		await run({
			host, metrics,
			render: async (source) => { await act(async () => root.render(<QuestionPreview>{source}</QuestionPreview>)); },
			resize: () => { for (const callback of callbacks) callback(); },
			fontsLoaded: () => { fonts.dispatchEvent(new window.Event("loadingdone")); },
		});
	} finally {
		await act(async () => root.unmount()); host.remove();
		if (previousRect) Object.defineProperty(prototype, "getBoundingClientRect", previousRect);
		else Reflect.deleteProperty(prototype, "getBoundingClientRect");
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
		assert.equal(callbacks.size, 0, "resize observers are disconnected");
	}
}

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

	it("reserves a fixed slot and centers natural-size math without the overflow-hidden baseline shift", () => {
		const document = preview("Plain text and $x$ and `code`.");
		const slot = document.querySelector("[data-question-preview]")!;
		assert.ok(slot.classList.contains("h-[1.6em]"));
		assert.equal(slot.getAttribute("data-ready"), "false", "SSR does not expose unmeasured, potentially cropped math");
		const renderer = document.querySelector(".lh-prose")!;
		for (const css of ["absolute", "top-1/2", "-translate-y-1/2", "[&_.katex]:align-middle", "[&_.katex]:leading-[0]!"]) assert.ok(renderer.classList.contains(css));
		for (const css of ["inline-block", "align-middle", "leading-none"]) assert.ok(document.querySelector("code")!.classList.contains(css), "padded inline code also fits the slot");
	});

	it("cuts before a measured over-tall inline formula, including inside formatting, and resets for a new question", async () => {
		await withGeometry(async ({ host, render }) => {
			const source = String.raw`Keep $x$ and **before $\begin{pmatrix}a&b\\c&d\end{pmatrix}$ AFTER_TALL** then $z$.`;
			await render(source);
			assert.deepEqual(annotations(host), ["x"]);
			assert.ok(host.textContent.includes("before"));
			assert.ok(!host.textContent.includes("AFTER_TALL"));
			assert.equal(host.querySelector("[data-ready]")?.getAttribute("data-ready"), "true");
			await render("New $y$ with $z$ and AFTER_SMALL.");
			assert.deepEqual(annotations(host), ["y", "z"]);
			assert.ok(host.textContent.includes("AFTER_SMALL"));
			await render(String.raw`$\begin{matrix}a\\b\end{matrix}$ AFTER_FIRST_TALL`);
			assert.equal(host.textContent, "", "a first tall formula leaves the fixed teaser slot empty, without new copy");
			assert.ok(source.includes("AFTER_TALL"), "the source, unlike its presentation, is unchanged");
		});
	});

	it("counts KaTeX error fallbacks before the tall formula so cutoff indexes remain aligned", async () => {
		await withGeometry(async ({ host, render }) => {
			await render(String.raw`Before $\frac{$ then $\begin{matrix}a\\b\end{matrix}$ AFTER_TALL`);
			assert.equal(host.querySelectorAll(".katex-error").length, 1);
			assert.ok(host.textContent.includes("frac"));
			assert.ok(!host.textContent.includes("AFTER_TALL"));
			assert.equal(host.querySelectorAll(".katex").length, 0);
		});
	});

	it("remeasures the full prefix on size/font changes, restoring content when it fits and cutting it again when it does not", async () => {
		await withGeometry(async ({ host, render, metrics, resize, fontsLoaded }) => {
			await render(String.raw`Before $\begin{matrix}a\\b\end{matrix}$ AFTER_TALL and $z$.`);
			assert.ok(!host.textContent.includes("AFTER_TALL"));
			await act(async () => { metrics.budget = 50; resize(); });
			assert.equal(annotations(host).length, 2);
			assert.ok(host.textContent.includes("AFTER_TALL"));
			await act(async () => { metrics.budget = 20; resize(); });
			assert.equal(annotations(host).length, 0);
			await act(async () => { metrics.tall = 15; fontsLoaded(); });
			assert.equal(annotations(host).length, 2);
			await act(async () => { metrics.tall = 40; fontsLoaded(); });
			assert.equal(annotations(host).length, 0);
		});
	});

	it("waits for layout when mounted in a hidden dock, then measures when it gains size", async () => {
		await withGeometry(async ({ host, render, metrics, resize }) => {
			await render(String.raw`Before $\begin{matrix}a\\b\end{matrix}$ AFTER_TALL`);
			assert.equal(host.querySelector("[data-ready]")?.getAttribute("data-ready"), "false");
			await act(async () => { metrics.budget = 20; resize(); });
			assert.equal(host.querySelector("[data-ready]")?.getAttribute("data-ready"), "true");
			assert.ok(!host.textContent.includes("AFTER_TALL"));
		}, 0);
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
