import React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";

// Inline code never wraps and scrolls inside its own box when it is wider
// than its column. In an option row (a flex row), the label is a flex item
// that will not shrink below its content unless it has min-width: 0, so a
// long code span pushed the label past the row and the card scrolled.
test("an option label may shrink, so long inline code scrolls inside the option", () => {
	const input = { question: "Which query?", options: [{ label: "`resources | where type =~ 'microsoft.storage/storageaccounts' | where properties.allowSharedKeyAccess != false`" }, { label: "no" }] };
	const html = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="q" input={input} expanded onExpand={() => {}} onSubmit={() => {}} />);
	const start = html.indexOf('data-kbdrow="0"');
	const row = html.slice(start, html.indexOf("</button>", start));
	assert.match(row, /<span class="min-w-0">.*allowSharedKeyAccess/);
});
