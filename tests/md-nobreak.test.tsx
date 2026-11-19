/**
 * Punctuation glue (components/md-nobreak.ts): inline code/math and the
 * punctuation touching them render inside one span.lh-nobreak, which the
 * session page keeps on one line. Static render through MessageResponse.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";

function groups(md: string) {
	const html = renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
	const { document } = parseHTML(`<div id="r">${html}</div>`);
	const root = document.getElementById("r")!;
	return {
		root,
		glued: [...root.querySelectorAll(".lh-nobreak")].map((g) => ({
			text: g.textContent,
			math: g.querySelectorAll(".katex").length,
			code: g.querySelectorAll("code").length,
		})),
	};
}

describe("punctuation glue", () => {
	it("glues trailing punctuation to inline math (rendered by KaTeX inside the group)", () => {
		const { glued, root } = groups("for a function $f$, the slope.");
		assert.equal(glued.length, 1);
		assert.equal(glued[0]!.math, 1);
		assert.ok(glued[0]!.text!.endsWith(","));
		assert.ok(root.textContent!.includes(" the slope."), "the rest of the sentence stays outside");
	});

	it("glues leading and trailing punctuation to inline code", () => {
		const { glued } = groups("call it (`foo()`). Next");
		assert.deepEqual(glued, [{ text: "(foo())." , math: 0, code: 1 }]);
	});

	it("joins spans separated only by punctuation into one group", () => {
		const { glued } = groups("pairs $a$,$b$; done");
		assert.equal(glued.length, 1);
		assert.equal(glued[0]!.math, 2);
		assert.ok(glued[0]!.text!.endsWith(";"));
	});

	it("leaves spans with no touching punctuation, letters and code blocks alone", () => {
		assert.equal(groups("a $x$ b and `y` c").glued.length, 0);
		assert.equal(groups("中文`代码`中文").glued.length, 0, "letters (CJK) never glue: the text keeps wrapping");
		assert.equal(groups("```js\nf(x),\n```").glued.length, 0);
		assert.equal(groups("$$\nx,\n$$").glued.length, 0, "display math is not inline");
	});

	it("CJK punctuation glues like Latin", () => {
		const { glued } = groups("用`map`，然后");
		assert.equal(glued.length, 1);
		assert.ok(glued[0]!.text!.endsWith("，"));
	});
});
