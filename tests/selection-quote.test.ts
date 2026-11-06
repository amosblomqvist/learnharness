import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { enclosingFormula } from "../components/side-chat.tsx";

const { document } = parseHTML(
	`<html><body>` +
		`<p id="prose">see <span class="katex" id="inline"><span class="katex-html"><span id="i1">x</span></span></span> here</p>` +
		`<span class="katex-display" id="display"><span class="katex"><span class="katex-html"><span id="d1">var</span></span></span></span>` +
		`</body></html>`,
);
const textIn = (id: string) => document.getElementById(id)!.firstChild;

describe("enclosingFormula", () => {
	it("widens a boundary inside display math to the whole display block", () => {
		assert.equal(enclosingFormula(textIn("d1")), document.getElementById("display"));
	});
	it("widens a boundary inside inline math to its formula", () => {
		assert.equal(enclosingFormula(textIn("i1")), document.getElementById("inline"));
	});
	it("leaves boundaries outside math alone", () => {
		assert.equal(enclosingFormula(textIn("prose")), null);
		assert.equal(enclosingFormula(null), null);
	});
});
