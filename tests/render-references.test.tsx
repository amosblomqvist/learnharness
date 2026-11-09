/**
 * The References chip's closed-state render (issue #63): the header chip is
 * static markup until opened — count surfacing, kind-agnostic label, no
 * panel body mounted. The open panel (MenuShell portal, fetch-backed save,
 * native picker) is exercised by its seams in tests/references.test.ts; a
 * full interactive harness would re-test MenuShell, not the shelf.
 */
import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ReferencesChip, referenceLabel } from "../components/references-panel.tsx";

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("ReferencesChip (closed)", () => {
	it("renders the chip with a count only when the shelf has entries", () => {
		const empty = documentFor(<ReferencesChip chatId="chat_x" />);
		const chip = empty.body.querySelector('[data-testid="references-chip"]')!;
		assert.match(chip.textContent ?? "", /References/);
		assert.doesNotMatch(chip.textContent ?? "", /·/);
		assert.equal(empty.body.querySelector('[data-testid="references-panel"]'), null);

		const stocked = documentFor(
			<ReferencesChip
				chatId="chat_x"
				initialReferences={[
					{ id: "r1", kind: "file", value: "/tmp/course/chapter-1.pdf", addedAt: "2026-11-09T10:00:00.000Z" },
					{ id: "r2", kind: "url", value: "https://example.com/paper", addedAt: "2026-11-09T10:01:00.000Z" },
				]}
			/>,
		);
		const counted = stocked.body.querySelector('[data-testid="references-chip"]')!;
		assert.match(counted.textContent ?? "", /References · 2/);
	});

	it("keeps the chip a plain button (no live region, no opened panel)", () => {
		const document = documentFor(<ReferencesChip chatId="chat_x" />);
		const chip = document.body.querySelector('[data-testid="references-chip"]')!;
		assert.equal(chip.tagName, "BUTTON");
		assert.equal(chip.getAttribute("aria-expanded"), "false");
		assert.ok(chip.querySelector("svg")!.getAttribute("aria-hidden")); // the bookmark icon
	});
});

describe("referenceLabel", () => {
	it("prefers the name, falls back to the file's short label or the raw URL", () => {
		assert.equal(referenceLabel({ id: "r", kind: "url", value: "https://example.com/paper", name: "The paper", addedAt: "x" }), "The paper");
		assert.equal(referenceLabel({ id: "r", kind: "file", value: "/tmp/course/chapter-1.pdf", addedAt: "x" }), "chapter-1.pdf");
		assert.equal(referenceLabel({ id: "r", kind: "url", value: "https://example.com/paper", addedAt: "x" }), "https://example.com/paper");
	});
});
