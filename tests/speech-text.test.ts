/**
 * Markdown → speech chunks (core/speech-text.ts, ElevenLabs voice slice 6):
 * what the teacher's markdown SOUNDS like. Pinned as fixture tables, markdown
 * in and chunks out: prose flattened to plain sentences, one spoken marker per
 * skipped block, inline math read as words, no markdown symbol ever spoken,
 * chunk sizes (short first) and order.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownToSpeechChunks } from "../src/core/speech-text.ts";

/** The whole speech, chunks joined — for tests that don't care where chunks split. */
const speech = (markdown: string) => markdownToSpeechChunks(markdown).join(" ");

describe("prose", () => {
	const cases: Array<[string, string, string]> = [
		["plain paragraph", "Entropy measures disorder.", "Entropy measures disorder."],
		["heading becomes a sentence", "## Why it matters\n\nBecause.", "Why it matters. Because."],
		["heading keeps its own punctuation", "# Ready?\n\nYes.", "Ready? Yes."],
		["bullets become sentences", "- first idea\n- second idea", "first idea. second idea."],
		["numbered list", "1. open it\n2) close it", "open it. close it."],
		["nested list items", "- outer\n  - inner", "outer. inner."],
		["task list checkboxes are dropped", "- [x] done\n- [ ] todo", "done. todo."],
		["emphasis and strong", "This is **very** *important* and ~~wrong~~ and __bold__.", "This is very important and wrong and bold."],
		["inline code reads its content", "Call `foo()` now.", "Call foo() now."],
		["link reads its label only", "See [the docs](https://example.com/a_b) for more.", "See the docs for more."],
		["image reads its alt text", "![a graph of x](img.png) here", "a graph of x here"],
		["blockquote marker is dropped", "> wise words\n> continue", "wise words continue"],
		["horizontal rule vanishes", "before\n\n---\n\nafter", "before after"],
		["soft line breaks join", "one\ntwo", "one two"],
		["backslash escapes read literally", "Costs 5 \\* 3.", "Costs 5 * 3."],
		["html tags are dropped", "a <b>bold</b> move", "a bold move"],
	];
	for (const [name, markdown, expected] of cases) {
		it(name, () => assert.equal(speech(markdown), expected));
	}

	it("empty or whitespace-only markdown has nothing to say", () => {
		assert.deepEqual(markdownToSpeechChunks(""), []);
		assert.deepEqual(markdownToSpeechChunks("  \n\n "), []);
	});
});

describe("URLs are spoken as their host name (owner decision, 2026-10-29)", () => {
	const cases: Array<[string, string, string]> = [
		["a bare URL", "Read https://en.wikipedia.org/wiki/Entropy now.", "Read en.wikipedia.org now."],
		["a bare URL ending the sentence keeps the sentence's period", "See https://en.wikipedia.org/wiki/Entropy.", "See en.wikipedia.org."],
		["trailing comma and parenthesis are not part of the URL", "(see https://example.com/a/b), then go", "(see example.com), then go"],
		["a bare URL in bold", "Try **https://example.com/x**!", "Try example.com!"],
		["query, fragment, port and credentials never speak", "Open http://me@host.example:8080/p?q=1&r=2#frag today", "Open host.example today"],
		["underscores in the path are not emphasis", "Go to https://example.com/a_b_c/d_e now", "Go to example.com now"],
		["a URL with no path", "Visit https://example.com for more", "Visit example.com for more"],
		["an autolink", "Source: <https://en.wikipedia.org/wiki/Entropy>.", "Source: en.wikipedia.org."],
		["a link with a label still reads the label", "See [the docs](https://example.com/a_b) for more.", "See the docs for more."],
		["a link whose label is itself a URL reads the host", "[https://example.com/a/b](https://example.com/a/b)", "example.com"],
		["two URLs", "https://a.example/x and https://b.example/y", "a.example and b.example"],
		["a URL in a list item", "- https://example.com/one", "example.com."],
	];
	for (const [name, markdown, expected] of cases) {
		it(name, () => assert.equal(speech(markdown), expected));
	}

	it("no URL punctuation reaches the speech", () => {
		const out = speech("A https://x.example/a/b?c=d&e=f#g and <https://y.example/p> and [l](https://z.example/q).");
		assert.doesNotMatch(out, /[:/?#=&<>]|https?/);
	});
});

describe("skipped blocks become exactly one marker each", () => {
	const cases: Array<[string, string, string]> = [
		["fenced code", "Run this:\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\nDone.", "Run this: Code shown on screen. Done."],
		["tilde fence", "~~~py\nprint(1)\n~~~", "Code shown on screen."],
		["mermaid", "```mermaid\ngraph TD\n  A-->B\n```", "Diagram shown on screen."],
		["unclosed fence swallows the rest", "Before\n\n```js\nlet a", "Before Code shown on screen."],
		["table", "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", "Table shown on screen."],
		["table without outer pipes", "a | b\n--|--\n1 | 2", "Table shown on screen."],
		["dollar display math", "So:\n\n$$\nE = mc^2\n$$\n\nThat is all.", "So: Equation shown on screen. That is all."],
		["bracket display math", "\\[ \\int_0^1 x\\,dx \\]", "Equation shown on screen."],
		["two blocks in a row", "```js\na\n```\n\n```js\nb\n```", "Code shown on screen. Code shown on screen."],
	];
	for (const [name, markdown, expected] of cases) {
		it(name, () => assert.equal(speech(markdown), expected));
	}

	it("a pipe in ordinary prose is not a table", () => {
		assert.equal(speech("Use a | b for or."), "Use a | b for or.");
	});
});

describe("inline math", () => {
	const cases: Array<[string, string, string]> = [
		["squared", "Take $x^2$ now.", "Take x squared now."],
		["cubed", "Take $x^3$ now.", "Take x cubed now."],
		["to the n", "Take $x^n$ now.", "Take x to the n now."],
		["braced exponent", "Take $x^{10}$ now.", "Take x to the 10 now."],
		["slash fraction", "Take $a/b$ now.", "Take a over b now."],
		["frac", "Take $\\frac{a}{b}$ now.", "Take a over b now."],
		["subscript", "Take $x_i$ now.", "Take x sub i now."],
		["braced subscript", "Take $x_{ij}$ now.", "Take x sub ij now."],
		["sqrt", "Take $\\sqrt{x}$ now.", "Take square root of x now."],
		["paren delimiters", "Take \\(x^2\\) now.", "Take x squared now."],
		["several forms in one span", "Is $x^2 + y_i$ ok?", "Is x squared + y sub i ok?"],
		["unknown source loses backslashes and braces", "Take $\\alpha + \\beta$ now.", "Take alpha + beta now."],
		["leftover braces vanish", "Take ${a+b}$ now.", "Take a+b now."],
	];
	for (const [name, markdown, expected] of cases) {
		it(name, () => assert.equal(speech(markdown), expected));
	}
});

describe("no markdown symbol is ever spoken", () => {
	it("a kitchen-sink reply speaks none of the markup characters", () => {
		const markdown = [
			"# Title",
			"",
			"Some **bold**, *italic*, ~~gone~~, `code`, a [link](http://x.y) and ![img](a.png).",
			"",
			"> quote",
			"",
			"- [ ] task",
			"- item with $x^2$ and $\\alpha_{ij}$",
			"",
			"| a | b |",
			"|---|---|",
			"| 1 | 2 |",
			"",
			"```mermaid",
			"graph TD; A-->B",
			"```",
			"",
			"$$ x = \\frac{1}{2} $$",
			"",
			"---",
		].join("\n");
		const out = speech(markdown);
		for (const symbol of ["*", "#", "`", "|", "[", "]", "$", "\\", "{", "}", "~", ">", "^", "_", "-->"]) {
			assert.equal(out.includes(symbol), false, `spoke ${JSON.stringify(symbol)} in: ${out}`);
		}
	});
});

describe("chunking", () => {
	const sentence = (n: number) => `Sentence number ${n} is about this long and says little.`;
	const paragraph = (count: number, offset = 0) =>
		Array.from({ length: count }, (_, i) => sentence(offset + i)).join(" ");

	it("a short reply is one chunk", () => {
		assert.deepEqual(markdownToSpeechChunks("Hello there.\n\nGeneral Kenobi."), ["Hello there. General Kenobi."]);
	});

	it("the first chunk is short, later chunks are bounded, order is preserved", () => {
		const markdown = [paragraph(40), paragraph(40, 40)].join("\n\n");
		const chunks = markdownToSpeechChunks(markdown);
		assert(chunks.length > 3);
		assert(chunks[0]!.length <= 200, `first chunk is ${chunks[0]!.length}`);
		for (const chunk of chunks) assert(chunk.length <= 1000, `chunk is ${chunk.length}`);
		// Nothing lost, nothing reordered: the chunks re-join to the sentences in order.
		const spoken = chunks.join(" ").match(/Sentence number (\d+)/g)!.map((s) => Number(s.replace(/\D/g, "")));
		assert.deepEqual(spoken, Array.from({ length: 80 }, (_, i) => i));
	});

	it("chunks break at sentence ends, never mid-sentence", () => {
		const chunks = markdownToSpeechChunks(paragraph(40));
		for (const chunk of chunks) assert(chunk.endsWith("little."), chunk);
	});

	it("paragraphs pack into a chunk while they fit", () => {
		const chunks = markdownToSpeechChunks(["Alpha beta.", "Gamma delta.", "Epsilon."].join("\n\n"));
		assert.deepEqual(chunks, ["Alpha beta. Gamma delta. Epsilon."]);
	});

	it("a single sentence longer than the limit is split at words", () => {
		const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + ".";
		const chunks = markdownToSpeechChunks(long);
		assert(chunks[0]!.length <= 200);
		for (const chunk of chunks) assert(chunk.length <= 1000);
		assert.equal(chunks.join(" "), long);
	});
});
