import React from "react";
(globalThis as Record<string, unknown>).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";

describe("the reading-thinking field (owner round, 2026-10-07)", () => {
	it("carries vertical padding — the 1px-scrollbar absorption", () => {
		const html = renderToStaticMarkup(
			<ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} />,
		);
		// The fix (empirically diagnosed): Source Sans 3's font box (22px at
		// 16px) exceeds lh-input's 20px line box by 1px; Chromium counts that
		// in scrollHeight and a zero-padding field-sizing textarea becomes a
		// permanent 1px scroll (a bar shown empty AND at every expansion below
		// max-h). py-0.5 absorbs it — the composer/dock fields get the same
		// absorption implicitly from py-2. Line-height stays 1.25 (caret law).
		assert.ok(html.includes("py-0.5"), "the vertical padding is on the textarea");
		// The cap survives: growth past max-h-40 still scrolls honestly.
		assert.ok(html.includes("max-h-40"), "the 160px growth cap stays");
	});
});
