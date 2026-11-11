import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ToolContentResponse, MessageResponse } from "../components/ai-elements/message.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionPreview } from "../components/question-preview.tsx";
import { readContentSpans } from "../src/core/content-reader.ts";
import { repairMathForDisplay, parseQuizInput, parseAskInput, parseExplainInput, newAnswerResult,
	type QuestionAnswerData } from "../src/core/index.ts";

const body = [
	String.raw`print("\n")`,
	String.raw`path = "C:\\new\\notes"`,
	String.raw`pattern = r"\w+\s+\u0061"`,
	String.raw`quoted = "a\"b"`,
	String.raw`# $\nu$ and \begin{matrix}a&b\\c&d\end{matrix} are code, not math`,
].join("\n");
const fence = "```python\n" + body + "\n```";
const extraLayer = (source: string) => JSON.stringify(source).slice(1, -1);
const documentOf = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;

for (const [name, source] of [
	["backticks", fence],
	["tildes", "~~~python\n" + body + "\n~~~"],
	["longer close", "```python\n" + body + "\n````"],
	["four backticks with embedded triples", "````text\n```literal```\n" + body + "\n````"],
	["CRLF", fence.replace(/\n/g, "\r\n")],
	["empty block", "```text\n```"],
] as const) test(`one local encoding layer preserves the entire program: ${name}`, () => {
	const encoded = extraLayer(source);
	assert.equal(repairMathForDisplay(encoded), source);
	assert.equal(readContentSpans(encoded).map(span => span.raw).join(""), encoded);
	assert.equal(repairMathForDisplay(source), source);
	assert.equal(repairMathForDisplay(repairMathForDisplay(encoded)), source, "converges after one pass");
});

test("local fence decoding leaves native math/rows and physical prose outside it untouched", () => {
	const math = String.raw`Then $\nu+\nabla f$ and $\begin{pmatrix}a&b\\c&d\end{pmatrix}$.`;
	const before = 'Read "this" program.\n\n';
	const after = "\n\n" + math;
	assert.equal(repairMathForDisplay(before + extraLayer(fence) + after), before + fence + after);
	const framed = "Read the program.\n\n" + fence + "\n\nThen consider $\\nu$.";
	assert.equal(repairMathForDisplay(extraLayer(framed)), framed);
});

test("multiple local fences recover independently without decoding invalid neighbors", () => {
	const invalid = '```python\\nprint("\\n")\\n```';
	const source = extraLayer(fence) + "\n\n" + invalid + "\n\n" + extraLayer("~~~text\nsecond\n~~~");
	assert.equal(repairMathForDisplay(source), fence + "\n\n" + invalid + "\n\n~~~text\nsecond\n~~~");
});

test("native code and deliberate inline/outer literal examples remain byte-for-byte source", () => {
	for (const source of [fence, "    print(\"\\n\")", "Read `print(\"\\n\")`.",
		"A sample: ```` ```python\\nvalue = 42\\n``` ````.",
		"````text\n```python\\nvalue = 42\\n```\n````",
		"```text\n" + extraLayer(fence) + "\n```",
		"~~~text\\nexample\\n~~~\nactual native body\n~~~", // native outer range wins
		"> ```python\n> print(\"\\n\")\n> ```",
		"- ```python\n  print(\"\\n\")\n  ```",
		"An inline example: ```python\\nvalue = 42\\n```.",
	]) assert.equal(repairMathForDisplay(source), source);
});

test("invalid, mixed and unsupported encoding profiles stay unrepaired", () => {
	for (const source of [
		'```python\\nprint("\\n")\\n```', // unescaped JSON quotes
		"```python\\nvalue = 42\n```", // physical and encoded layout
		String.raw`~~~python\npattern = \w+\n~~~`, // invalid JSON escape
		"```python\\nvalue = 42\\n~~~", // mismatched fences
		"```python\\nvalue = 42", // incomplete
		extraLayer(extraLayer(fence)), // two extra layers are not one
	]) assert.equal(repairMathForDisplay(source), source, source);
});

test("mixed fences after encoded prose cannot fall through the general layout decoder", () => {
	const reported = "~~~python\n" + String.raw`print('\n')\n~~~`;
	assert.equal(repairMathForDisplay(String.raw`Read this.\n\n` + reported), "Read this.\n\n" + reported);
	const before = String.raw`Read this.\n\n$\nu+\nabla f$.\n\n`;
	const after = String.raw`\n\nAfter $\nu$.`;
	const recoveredBefore = "Read this.\n\n" + String.raw`$\nu+\nabla f$.` + "\n\n";
	const recoveredAfter = "\n\nAfter " + String.raw`$\nu$.`;
	for (const marker of ["```", "~~~"]) {
		for (const code of [
			marker + "python\n" + String.raw`print('\n')\n` + marker,
			marker + "python\r\n" + String.raw`print('\n')\n` + marker,
			marker + "python\r" + String.raw`print('\n')\n` + marker,
			marker + "python\\n" + String.raw`print('\n')` + "\n" + marker,
		]) {
			const source = before + code + after;
			assert.equal(readContentSpans(source).map(span => span.raw).join(""), source);
			const recovered = repairMathForDisplay(source);
			assert.equal(recovered, recoveredBefore + code + recoveredAfter);
			assert.equal(repairMathForDisplay(recovered), recovered);
		}
	}
});

test("a mixed fence owns inner code backticks even when native inline parsing crosses its close", () => {
	const code = "~~~python\n" + String.raw`print('\n')\n` + "`literal" + String.raw`\n~~~`;
	const source = String.raw`Read this.\n\n` + code + String.raw`\n\nAfter ` + "`";
	assert.equal(repairMathForDisplay(source), "Read this.\n\n" + code + "\n\nAfter `");
});

test("unterminated fences after encoded prose keep the entire rejected code section opaque", () => {
	for (const code of [
		"```python\\nprint(\"\\n\")",
		"~~~python\n" + String.raw`print('\n')\nno closing fence`,
		"```python\\n" + String.raw`print('\n')\n$\nu$\n\nmore code`,
	]) {
		const source = String.raw`Read this.\n\n` + code;
		assert.equal(readContentSpans(source).map(span => span.raw).join(""), source);
		const recovered = repairMathForDisplay(source);
		assert.equal(recovered, "Read this.\n\n" + code);
		assert.equal(repairMathForDisplay(recovered), recovered);
	}
});

test("valid encoding is structural evidence, not a language-specific semantic proof", () => {
	// Explicit human-selected policy: single-quoted code escapes can be
	// indistinguishable from misplaced layout escapes. No language guessing.
	const ambiguous = "```python\\nprint('\\n')\\n```";
	assert.equal(repairMathForDisplay(ambiguous), "```python\nprint('\n')\n```");
});

test("only tool presentation recovers code, and teaser output agrees with native Markdown", () => {
	const native = "Read the program.\n\n" + fence + "\n\nContinue.";
	const source = extraLayer(native);
	const recovered = documentOf(<ToolContentResponse mode="static">{source}</ToolContentResponse>);
	assert.equal(recovered.querySelectorAll('[data-testid="md-code"]').length, 1);
	assert.equal(recovered.querySelectorAll(".katex").length, 0, "math-like source inside code is literal");
	const ordinary = documentOf(<MessageResponse mode="static">{source}</MessageResponse>);
	assert.equal(ordinary.querySelectorAll('[data-testid="md-code"]').length, 0);
	const preview = documentOf(<QuestionPreview>{source}</QuestionPreview>);
	const expected = documentOf(<QuestionPreview>{native}</QuestionPreview>);
	assert.equal(preview.body.textContent, expected.body.textContent);
	assert.equal(preview.querySelectorAll('[data-testid="md-code"], button, pre').length, 0);
	assert.equal(preview.querySelector('[data-preview-cut="true"]') !== null, true);
});

test("pending → exact copy → submit → saved/answered copy never changes source or identities", async () => {
	const { window, document } = parseHTML("<html><body></body></html>");
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	const copies: string[] = [];
	Object.assign(globalThis, { window, document, Element: window.Element, HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { copies.push(text); } } } });
	const question = "Read the program.\\n\\n" + extraLayer(fence);
	const input = { question, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: question };
	const before = structuredClone(input);
	assert.equal(parseQuizInput(input)!.question, question);
	assert.equal(parseAskInput({ question })!.question, question);
	assert.equal(parseExplainInput({ question, correctAnswer: "yes" })!.question, question);
	let answer: QuestionAnswerData | undefined;
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<QuestionDock toolName="probe" toolCallId="escaped_code" input={input} expanded
			dictationClaim={false} onExpand={() => {}} onSubmit={result => { answer = result; }} />));
		const copy = () => host.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!;
		assert.ok(copy());
		await act(async () => copy().click());
		assert.equal(copies[0], body + "\n", "copied program is the native Markdown code source");
		assert.equal(host.querySelectorAll(".katex").length, 0);
		const yes = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes("Yes"))!;
		await act(async () => yes.click());
		const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Submit answer"))!;
		assert.equal(submit.disabled, false);
		await act(async () => submit.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		assert.ok(answer);
		assert.equal(answer.questionText, question);
		assert.equal(answer.explanation, question);
		assert.equal(answer.answers[0]!.value, "yes");
		assert.equal(answer.correct, true);
		const saved = JSON.parse(JSON.stringify(newAnswerResult("escaped_code", "probe", answer))).details;
		const savedBefore = structuredClone(saved);
		await act(async () => root.render(<AnsweredCard answer={saved} input={input} />));
		await act(async () => copy().click());
		assert.deepEqual(copies, [body + "\n", body + "\n"]);
		assert.deepEqual(saved, savedBefore);
		assert.deepEqual(input, before);
	} finally {
		await act(async () => root.unmount()); host.remove();
		for (const key of ["window", "document", "Element", "HTMLElement", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
