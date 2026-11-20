import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";
import { transformMathDelimiters } from "../src/core/math-delims.ts";

const surfaces = {
	message: (source: string) => <MessageResponse>{source}</MessageResponse>,
	tool: (source: string) => <ToolContentResponse>{source}</ToolContentResponse>,
	reasoning: (source: string) => <Reasoning open><ReasoningContent>{source}</ReasoningContent></Reasoning>,
};
const documentFor = (element: React.ReactElement) =>
	parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const annotations = (root: ParentNode) => [...root.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent);

// PR266 identified the less-than + letter trigger. Test the actual streaming
// render seam, not a TeX-space workaround: valid TeX must remain byte-identical.
for (const [name, surface] of Object.entries(surfaces)) describe(`streaming math — ${name}`, () => {
	for (const [source, tex] of [
		["$a<b$", "a<b"],
		["$$a<b$$", "a<b"],
		["$$\na<b\n$$", "a<b"],
		[String.raw`\(a<b\)`, "a<b"],
		[String.raw`\[a<b\]`, "a<b"],
		["$a</b$", "a</b"],
		[String.raw`$\text{a<b}$`, String.raw`\text{a<b}`],
		[String.raw`$\verb|a<b|$`, String.raw`\verb|a<b|`],
	]) it(`retains ${JSON.stringify(source)} and subsequent prose`, () => {
		const document = documentFor(surface(`${source}\n\nTAIL`));
		assert.deepEqual(annotations(document), [tex]);
		assert.ok(document.body.textContent.includes("TAIL"));
		assert.ok(!document.body.textContent.includes("[blocked]"));
		assert.equal(document.querySelectorAll(".katex-error").length, 0);
	});

	it("retains probability brackets, both formulas, and the following question", () => {
		const source = String.raw`$F_X(2)=0.60$이라고 하자. $P[-1<X\le2]$는 얼마일까?`;
		const document = documentFor(surface(source));
		assert.deepEqual(annotations(document), ["F_X(2)=0.60", String.raw`P[-1<X\le2]`]);
		assert.ok(document.body.textContent.includes("는 얼마일까?"));
		assert.ok(!document.body.textContent.includes("[blocked]"));
	});

	it("does not discard unfinished native or legacy math and its trailing text", () => {
		for (const source of ["$a<b TAIL", "$$\na<b\nTAIL", String.raw`\(a<b TAIL`, String.raw`\[a<b TAIL`]) {
			const document = documentFor(surface(source));
			assert.ok(document.body.textContent.includes("TAIL"), source);
			assert.ok(document.body.textContent.includes("<"), source);
		}
	});

	it("leaves inline, fenced, and indented code literal", () => {
		for (const source of ["`$a<b$` TAIL", "```text\n$a<b$\n```\n\nTAIL", "    $a<b$\n\nTAIL"]) {
			const document = documentFor(surface(source));
			assert.deepEqual(annotations(document), []);
			assert.ok(document.querySelector("code")?.textContent?.includes("$a<b$"), source);
			assert.ok(document.body.textContent.includes("TAIL"), source);
		}
	});

	it("shows unfinished HTML literally but keeps complete HTML formatting", () => {
		const partial = documentFor(surface("before <b TAIL"));
		assert.equal(partial.body.textContent, "before <b TAIL");
		assert.equal(partial.querySelectorAll("b").length, 0);
		const complete = documentFor(surface("before <b>bold</b> TAIL"));
		assert.equal(complete.querySelector("b")?.textContent, "bold");
		assert.equal(complete.body.textContent, "before bold TAIL");
	});

	it("keeps the other incomplete-Markdown repairs", () => {
		const bold = documentFor(surface("**bold TAIL"));
		assert.equal(bold.querySelector("strong")?.textContent, "bold TAIL");
		const link = documentFor(surface("[partial TAIL"));
		assert.ok(link.body.textContent.includes("partial TAIL"));
		assert.ok(link.body.textContent.includes("[blocked]"), "the incomplete-link placeholder is still hardened");
	});

	it("still removes script/event attributes and blocks javascript links", () => {
		const document = documentFor(surface('before <script>alert(1)</script> <b onclick="alert(1)">bold</b> [unsafe](javascript:alert) TAIL'));
		assert.equal(document.querySelectorAll("script, [onclick]").length, 0);
		assert.ok(![...document.querySelectorAll("[href]")].some(node => node.getAttribute("href")?.startsWith("javascript:")));
		assert.ok(!document.body.textContent.includes("alert(1)"));
		assert.ok(document.body.textContent.includes("TAIL"));
		assert.ok(document.body.textContent.includes("[blocked]"));
	});
});

it("preserves native TeX source in both streaming and static modes", () => {
	const source = String.raw`$a<b$ $\text{a<b}$ $\verb|a<b|$`;
	assert.equal(transformMathDelimiters(source), source);
	const streaming = documentFor(<MessageResponse>{source}</MessageResponse>);
	const staticDocument = documentFor(<MessageResponse mode="static">{source}</MessageResponse>);
	assert.deepEqual(annotations(streaming), ["a<b", String.raw`\text{a<b}`, String.raw`\verb|a<b|`]);
	assert.deepEqual(annotations(streaming), annotations(staticDocument));
	assert.deepEqual([...streaming.querySelectorAll(".katex-html")].map(node => node.innerHTML),
		[...staticDocument.querySelectorAll(".katex-html")].map(node => node.innerHTML));
});

// Exercise successive updates on the SAME mounted components, rather than
// mistaking independent server renders for incremental streaming coverage.
it("retains less-than prefixes through mounted streaming updates on every entry point", async () => {
	const dom = parseHTML("<html><body></body></html>");
	// linkedom has no layout/animation engine; Radix's open reasoning panel
	// only needs these inert browser hooks. This test checks text, not layout.
	const globals = { window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ display: "block", animationName: "none" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) };
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	Object.assign(globalThis, globals);
	try {
		for (const [name, surface] of Object.entries(surfaces)) {
			const host = document.createElement("div"); document.body.append(host);
			const root = createRoot(host);
			try {
				for (const source of ["$a", "$a<", "$a<b", "$a<b TAIL", "$a<b$ TAIL"]) {
					await act(async () => root.render(surface(source)));
					if (source.includes("<b")) assert.ok(host.textContent?.includes("<b"), `${name}: ${source}`);
					if (source.includes("TAIL")) assert.ok(host.textContent?.includes("TAIL"), `${name}: ${source}`);
					assert.ok(!host.textContent?.includes("[blocked]"), `${name}: ${source}`);
				}
				assert.deepEqual(annotations(host), ["a<b"]);
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		}
	} finally {
		for (const key of Object.keys(globals)) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
