import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mathRanges, quoteLineStarts } from "../components/notes-markdown";

const r = (t: string) => mathRanges(t).map(({ tex, display }) => [tex, display]);

describe("notes markdown ranges", () => {
	it("inline and display", () => {
		assert.deepEqual(r("see $A^\\tau$ and $$\nY=f(x)\n$$"), [["A^\\tau", false], ["Y=f(x)", true]]);
		assert.deepEqual(mathRanges("x $a$")[0], { from: 2, to: 5, tex: "a", display: false });
	});
	it("leaves half-typed and money text alone", () => {
		assert.deepEqual(r("costs $5 and $10"), []);
		assert.deepEqual(r("lone $ sign\nnext $b$"), [["b", false]]);
		assert.deepEqual(r("\\$x$ and $y$"), [["y", false]]);
		assert.deepEqual(r("open $$ never closed\n$c$"), [["c", false]]);
		assert.deepEqual(r("$$  $$"), []);
	});
	it("multi-line display math inside a quote drops the continuation markers", () => {
		const quoted = "> $$\\begin{aligned}\n> a &= b \\\\\n> c &= d\n> \\end{aligned}$$";
		assert.deepEqual(r(quoted), [["\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}", true]]);
		assert.deepEqual(r("> $$\n> Y=f(x)\n> $$"), [["Y=f(x)", true]]);
		const plain = "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}";
		assert.deepEqual(r(`$$${plain}$$`), [[plain, true]], "unquoted multi-line math is unchanged");
		assert.deepEqual(r("$$\\begin{aligned}\n> a &= b\n\\end{aligned}$$"), [["\\begin{aligned}\n> a &= b\n\\end{aligned}", true]], "outside a quote nothing is stripped");
	});
	it("quote lines", () => assert.deepEqual(quoteLineStarts("> a\nb\n   > c\n    > d"), [0, 6]));
});
