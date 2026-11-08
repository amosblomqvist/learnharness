import React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";

// An option row is a <button>. Streamdown renders a Markdown link as a
// <button> (its link-safety prompt), so a link in an option label nested a
// button inside a button: invalid HTML and a React hydration warning.
test("a link in an option label renders as text, not a nested button", () => {
	const input = { question: "Which source?", options: [{ label: "See [the docs](https://example.com/docs)" }, { label: "no" }] };
	const html = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="q" input={input} expanded onExpand={() => {}} onSubmit={() => {}} />);
	// From inside the first row up to the first closing tag: with no nested
	// button, that tag closes the row itself.
	const start = html.indexOf('data-kbdrow="0"');
	const row = html.slice(start, html.indexOf("</button>", start));
	assert.match(row, /See .*the docs/);
	assert.doesNotMatch(row, /<button|<a /);
});
