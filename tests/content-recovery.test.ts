import assert from "node:assert/strict";
import { test } from "node:test";
import { repairMathForDisplay, restoreMathEscapes, transformMathDelimiters } from "../src/core/math-delims.ts";

const math = String.raw;
test("document paragraphs and display framing recover without interpreting n-commands as newlines", () => {
	const source = math`First.\n\nSecond: $\nabla f\neq0$.\n\n$$\n\frac{1}{2}\n$$`;
	assert.equal(repairMathForDisplay(source), "First.\n\nSecond: " + math`$\nabla f\neq0$.` + "\n\n$$\n" + math`\frac{1}{2}` + "\n$$");
});
test("literal document escapes fused to unknown math commands use document context", () => {
	const source = math`Jacobian:\n\n$$\nJ=\begin{pmatrix}1&2\\3&4\end{pmatrix}\n$$`;
	assert.equal(repairMathForDisplay(source), "Jacobian:\n\n$$\n" + math`J=\begin{pmatrix}1&2\\3&4\end{pmatrix}` + "\n$$");
});
test("encoded environment profiles decode row separators by their factor, not to one slash", () => {
	for (const [source, expected] of [
		[math`$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$`, math`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`],
		[math`$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$`, math`$\begin{pmatrix}1&2\\3&4\end{pmatrix}$`],
		[math`$\\begin{pmatrix}a&b\\\\\\nabla f&d\\end{pmatrix}$`, math`$\begin{pmatrix}a&b\\\nabla f&d\end{pmatrix}$`],
		[math`$\\substack{a\\\\beta}$`, math`$\substack{a\\beta}$`],
	] as const) {
		assert.equal(repairMathForDisplay(source), expected);
		assert.equal(repairMathForDisplay(expected), expected);
	}
});
test("native substack rows and literal document escapes in genuine comments remain literal", () => {
	const source = math`$\substack{a\\beta}$`;
	assert.equal(repairMathForDisplay(source), source);
	const comment = "$x % " + math`literal \n\n` + "\ny$";
	assert.equal(repairMathForDisplay(comment), comment);
});
test("inline lost prefixes recover only known full commands; display newlines remain whitespace", () => {
	assert.equal(repairMathForDisplay("$\nabla f$"), math`$\nabla f$`);
	assert.equal(repairMathForDisplay("$x+\ny$"), "$x+\ny$");
	assert.equal(repairMathForDisplay("$x+\nu$"), math`$x+\nu$`); // approved typical-inline-authoring policy
	assert.equal(repairMathForDisplay("$$\nabla f\n$$"), "$$\nabla f\n$$"); // display source whitespace
});
test("physical display newlines and genuine row breaks/comments survive", () => {
	const source = "$$\n" + math`\begin{aligned}a&=b\\% row comment` + "\nc&=d\end{aligned}\n$$";
	assert.equal(repairMathForDisplay(source), source);
});
test("proper nu survives every context, including fields with document escapes", () => {
	for (const source of [math`$\nu$`, "$$\n" + math`\nu` + "\n$$", math`$\nabla f+\nu+\neq$`]) {
		assert.equal(repairMathForDisplay(source), source);
	}
	assert.equal(repairMathForDisplay(math`First.\n\n$\nu$`), "First.\n\n" + math`$\nu$`);
	assert.equal(repairMathForDisplay("$$\nu\n$$"), "$$\nu\n$$"); // LF + variable u in display
});
test("tabs recover known commands including to, not arbitrary whitespace", () => {
	assert.equal(repairMathForDisplay("$$\nx\t+\ty\n$$"), "$$\nx\t+\ty\n$$");
	assert.equal(repairMathForDisplay("$a\to b$"), math`$a\to b$`);
	assert.equal(repairMathForDisplay("$$\na\to b\n$$"), "$$\n" + math`a\to b` + "\n$$");
	assert.equal(repairMathForDisplay("$$\r\nx+1\r\n$$"), "$$\r\nx+1\r\n$$");
});
test("Markdown containers protect literal code and do not swallow following content", () => {
	for (const source of [
		"> ~~~text\n> " + math`$\\alpha$ \n\n` + "\n> ~~~",
		"> > ~~~text\n> > " + math`$\\alpha$` + "\n> > ~~~",
		"- ~~~text\n  " + math`$\\alpha$` + "\n  ~~~",
		"> ~~~text\n> " + math`$\\alpha$` + "\n\n~~~text\n" + math`$\\beta$` + "\n~~~",
	]) {
		assert.equal(repairMathForDisplay(source), source);
		assert.equal(transformMathDelimiters(source), source);
		assert.equal(repairMathForDisplay(source + "\n\n" + math`$\\gamma$`), source + "\n\n" + math`$\gamma$`);
	}
});
test("numeric percentages recover, including percentages inside text groups", () => {
	for (const [source, expected] of [
		[math`$60\\%$`, math`$60\%$`],
		[math`$50\\%+10\\%=60\\%$`, math`$50\%+10\%=60\%$`],
		[math`$\text{ (50\\%)}$`, math`$\text{ (50\%)}$`],
	] as const) assert.equal(repairMathForDisplay(source), expected);
});
test("numeric row breaks followed by genuine comments are not percentage escapes", () => {
	const source = "$60\\\\% explanation of this row\nx$";
	assert.equal(repairMathForDisplay(source), source);
	const ambiguous = math`$x\\%$`;
	assert.equal(repairMathForDisplay(ambiguous), ambiguous);
});
test("inline and fenced code retain all bytes, including legacy delimiters and actual control characters", () => {
	const code = "```text\n\\(x\nabla\\)\n\\n\\n\n```\n" + "`" + math`\n\n $60\\%$ \(x\)` + "`";
	assert.equal(repairMathForDisplay(code), code);
	assert.equal(restoreMathEscapes(code), code);
});
test("math matching cannot consume a blank paragraph or a code span", () => {
	const source = "Price $5.\n\nThen $x$ and `code` remains.";
	assert.equal(repairMathForDisplay(source), source);
	assert.equal(repairMathForDisplay("$not `code` math$"), "$not `code` math$");
});
test("Windows paths and correctly written n-commands are not document escapes", () => {
	const source = math`Path C:\new\notes; symbols $\nu+\ni+\neq+\nabla f$.\n\nNext paragraph.`;
	assert.equal(repairMathForDisplay(source), math`Path C:\new\notes; symbols $\nu+\ni+\neq+\nabla f$.` + "\n\nNext paragraph.");
});
test("declared n-prefixed macros are commands, not document escapes", () => {
	const source = math`$\newcommand{\nThing}{x}\nThing$.\n\nNext.`;
	assert.equal(repairMathForDisplay(source), math`$\newcommand{\nThing}{x}\nThing$.` + "\n\nNext.");
});
test("partial recovery cannot turn otherwise parseable TeX into a missing-argument error", () => {
	const source = math`$x\\frac{a}$`;
	assert.equal(repairMathForDisplay(source), source);
});
test("legacy compatibility and recovery share code barriers, including tilde and indentation", () => {
	for (const source of ["    " + math`\(x\) \n\n`, "\\[\n~~~tex\n" + math`\n\n \(x\)` + "\n\\]\n~~~"]) {
		assert.equal(repairMathForDisplay(source), source);
		assert.equal(transformMathDelimiters(source), source);
	}
	const comment = "$60% " + math`\n\n` + "\nx$";
	assert.equal(repairMathForDisplay(comment), comment);
});
test("recovery converges after one pass, including multiple debris characters", () => {
	for (const source of ["$\forall x,\theta+\to$", math`First.\n\n$$\nJ=\\frac{1}{2}+60\\%\n$$`,
		math`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`, "```text\n\\(\nabla\\)\n```", "$\nabla f$",
	]) {
		const once = repairMathForDisplay(source);
		assert.equal(repairMathForDisplay(once), once);
	}
});
