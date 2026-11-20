import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	chunkPoint, rawRangeFor, readSourceText, selectorFromBoundaries, sourceElements,
} from "../components/selection-text.ts";

function viewport(html: string) {
	const { document } = parseHTML(`<html><body><div id="v">${html}</div></body></html>`);
	return document.getElementById("v")!;
}

const transcript = `
<div data-source-message-id="m1"><p>alpha <b>beta</b></p><p>gamma</p></div>
<button>Copy</button>
<div data-source-message-id="m2"><p>other</p></div>
<div data-source-message-id="m1"><p>delta<span aria-hidden="true">x</span></p><ul><li>one</li><li>two</li></ul></div>`;

describe("readSourceText", () => {
	it("joins one message's text parts in DOM order with single line breaks", () => {
		const v = viewport(transcript);
		const { text } = readSourceText(sourceElements(v, "m1"));
		assert.equal(text, "alpha beta\ngamma\ndelta\none\ntwo");
	});

	it("reads KaTeX as its TeX source, display math with double dollars", () => {
		const v = viewport(`<div data-source-message-id="m"><p>so <span class="katex"><span class="katex-mathml"><math><semantics><mrow/><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span> grows</p><span class="katex-display"><span class="katex"><annotation encoding="application/x-tex">\\int f</annotation></span></span></div>`);
		const { text, chunks } = readSourceText(sourceElements(v, "m"));
		assert.equal(text, "so $x^2$ grows\n$$\\int f$$");
		assert.equal(chunks.filter((c) => c.atomic).length, 2);
	});

	it("ignores whitespace-only text between block elements", () => {
		const v = viewport(`<div data-source-message-id="m"><ol>\n<li>one</li>\n<li>two</li>\n</ol>\n<p>three</p></div>`);
		assert.equal(readSourceText(sourceElements(v, "m")).text, "one\ntwo\nthree");
	});

	it("skips formulas without a TeX annotation", () => {
		const v = viewport(`<div data-source-message-id="m"><p>a <span class="katex"><span>?</span></span> b</p></div>`);
		assert.equal(readSourceText(sourceElements(v, "m")).text, "a  b");
	});
});

describe("selectorFromBoundaries", () => {
	it("builds a selector from text-node boundaries", () => {
		const v = viewport(transcript);
		const { text, chunks } = readSourceText(sourceElements(v, "m1"));
		const beta = chunks.find((c) => c.node.textContent === "beta")!;
		const gamma = chunks.find((c) => c.node.textContent === "gamma")!;
		const s = selectorFromBoundaries(text, chunks, { node: beta.node, offset: 1 }, { node: gamma.node, offset: 3 })!;
		assert.equal(s.text, "eta\ngam");
		assert.equal(s.prefix, "alpha b");
	});

	it("widens a boundary inside a formula to the whole formula", () => {
		const v = viewport(`<div data-source-message-id="m"><p>so <span class="katex"><annotation encoding="application/x-tex">x^2</annotation><span class="katex-html" aria-hidden="true">x2</span></span> grows</p></div>`);
		const { text, chunks } = readSourceText(sourceElements(v, "m"));
		const so = chunks[0]!;
		const inner = v.querySelector(".katex-html")!.firstChild!;
		assert.equal(selectorFromBoundaries(text, chunks, { node: so.node, offset: 0 }, { node: inner, offset: 1 })!.text, "so $x^2$");
	});

	it("returns null for whitespace-only selections and foreign nodes", () => {
		const v = viewport(transcript);
		const { text, chunks } = readSourceText(sourceElements(v, "m1"));
		const alpha = chunks[0]!;
		assert.equal(selectorFromBoundaries(text, chunks, { node: alpha.node, offset: 5 }, { node: alpha.node, offset: 6 }), null);
		const other = v.querySelector('[data-source-message-id="m2"] p')!.firstChild!;
		assert.equal(selectorFromBoundaries(text, chunks, { node: alpha.node, offset: 0 }, { node: other, offset: 2 }), null);
	});
});

describe("rawRangeFor / chunkPoint", () => {
	it("maps a selector back to raw offsets and DOM points, across whitespace changes", () => {
		const v = viewport(`<div data-source-message-id="m"><p>alpha   beta</p><p>gamma</p></div>`);
		const { text, chunks } = readSourceText(sourceElements(v, "m"));
		const range = rawRangeFor(text, { text: "beta gamma", start: 6, end: 16, prefix: "alpha ", suffix: "" })!;
		assert.equal(text.slice(range.start, range.end), "beta\ngamma");
		const start = chunkPoint(chunks, range.start, "start")!;
		assert.equal(start.node.textContent, "alpha   beta");
		assert.equal(start.offset, 8);
		const end = chunkPoint(chunks, range.end, "end")!;
		assert.equal(end.node.textContent, "gamma");
		assert.equal(end.offset, 5);
	});

	it("returns null when the quote is gone", () => {
		assert.equal(rawRangeFor("nothing here", { text: "beta", start: 0, end: 4, prefix: "", suffix: "" }), null);
	});
});
