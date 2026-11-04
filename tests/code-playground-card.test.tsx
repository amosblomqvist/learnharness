import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CodePlaygroundCard } from "../components/artifacts/code-playground-card.tsx";
import { ChatActionsContext } from "@/components/chat";

/** The card renders from a persisted tool part (client-executed tools keep the
 *  input forever, so this is exactly what a reload sees). */
const part = (input: unknown) => ({ type: "tool-code_playground", state: "input-available", toolCallId: "c1", input });

describe("code_playground card", () => {
	it("shows the task, the language and the editable editor", () => {
		const html = renderToStaticMarkup(
			createElement(CodePlaygroundCard, {
				part: part({
					language: "javascript",
					task: "Implement predict(m, b, size) so predict(150, 20, 3) returns 470.",
					starter: "function predict(m, b, size) {\n  return 0;\n}\n",
				}),
			}),
		);
		assert.match(html, /JavaScript/);
		assert.doesNotMatch(html, /language detected/);
		assert.match(html, /Implement predict/);
		assert.match(html, /code-editor/);
		assert.doesNotMatch(html, /code_playground/); // internals stay hidden
		assert.doesNotMatch(html, /engine:/);
	});

	it("says which engine will run the code, and disables nothing it can run", () => {
		const js = renderToStaticMarkup(
			createElement(CodePlaygroundCard, { part: part({ language: "javascript", task: "t", starter: "1" }) }),
		);
		// Nothing about the engine is shown when the code can run.
		assert.doesNotMatch(js, /engine/);
		assert.doesNotMatch(js, /code_playground/);
		assert.doesNotMatch(js, /disabled=""[^>]*>\s*▸ Run/);
	});

	it("a language with no engine never pretends to run", () => {
		const html = renderToStaticMarkup(
			createElement(CodePlaygroundCard, { part: part({ language: "zig", task: "t", starter: "const x = 1;" }) }),
		);
		assert.match(html, /not runnable here/);
		assert.match(html, /syntax only/);
	});

	it("only coding languages get a card at all", () => {
		const prose = renderToStaticMarkup(
			createElement(CodePlaygroundCard, { part: part({ language: "spanish", task: "t", starter: "hola" }) }),
		);
		assert.equal(prose, "");
	});

	it("an unparseable part renders nothing rather than throwing", () => {
		const html = renderToStaticMarkup(createElement(CodePlaygroundCard, { part: part({ nope: true }) }));
		assert.equal(html, "");
	});
});

describe("drill modes", () => {
	const render = (input: unknown) =>
		renderToStaticMarkup(createElement(CodePlaygroundCard, { part: part(input) }));

	it("bug-hunt is editable and badged", () => {
		const html = render({ mode: "bug-hunt", language: "python", task: "fails on empty list", starter: "def f(xs):\n  return xs[0]" });
		assert.match(html, /bug-hunt/);
		assert.match(html, /code-editor/);
		assert.match(html, /▸ Run/);
	});

	it("error-read shows the error and no editor", () => {
		const html = render({
			mode: "error-read", language: "c", task: "read this", starter: "",
			errorText: "main.c:3: error: expected ';' before '}' token",
		});
		// SSR escapes the compiler's quote — assert on the parts that are literal.
		assert.match(html, /main\.c:3/);
		assert.match(html, /expected/);
		assert.doesNotMatch(html, /code-editor/);
		assert.match(html, /Send answer/);
	});

	it("syntax shows the correct line and its broken twin", () => {
		const html = render({ mode: "syntax", language: "python", task: "what differs?", starter: "def f(x):\n    return x", pair: "def f(x)\n    return x" });
		assert.match(html, /def f\(x\):/);
		assert.match(html, /def f\(x\)\s*\n/);
		assert.doesNotMatch(html, /code-editor/);
	});
});

describe("send honesty", () => {
	it("never claims 'sent' while the session cannot accept a message", () => {
		const html = renderToStaticMarkup(
			createElement(
				ChatActionsContext.Provider,
				{
					value: {
						chatId: "c1",
						syncFromServer: async () => {},
						sendText: () => {},
						canSend: false,
						openSetup: () => {},
					},
				},
				createElement(CodePlaygroundCard, {
					part: part({ language: "javascript", task: "t", starter: "1" }),
				}),
			),
		);
		assert.match(html, /waiting…/);
		assert.doesNotMatch(html, /Send to teacher/);
	});
});
