import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { parseHTML } from "linkedom";
import { ComposerActions, NodePickerControl } from "../components/composer-actions.tsx";
import { ZeroKeysPill } from "../components/setup-cta.tsx";
import { DraftShell } from "../components/new-session.tsx";

const modelSetup = <button data-testid="setup-cta">Set up your models</button>;
const keySetup = <ZeroKeysPill inline onOpen={() => {}} />;
function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("composer action row", () => {
	it("renders nothing when neither action exists", () => {
		assert.equal(renderToStaticMarkup(<ComposerActions picker={false} setup={false} />), "");
	});

	for (const [label, setup] of [["provider key", keySetup], ["models", modelSetup]] as const) {
		it(`${label}: setup-only stays centered`, () => {
			const document = documentFor(<ComposerActions setup={setup} />);
			const row = document.querySelector('[data-testid="composer-actions"]')!;
			assert.ok(row.classList.contains("justify-center"));
			assert.equal(row.children.length, 1);
			assert.equal(row.firstElementChild!.tagName, "BUTTON", "setup must not reserve a nested full-width row");
		});

		it(`${label}: picker leads in one left-aligned wrapping row`, () => {
			const document = documentFor(<ComposerActions picker={<NodePickerControl count={0} />} setup={setup} />);
			const row = document.querySelector('[data-testid="composer-actions"]')!;
			const chip = document.querySelector('[data-testid="practice-props-chip"]')!;
			assert.ok(row.classList.contains("justify-start"));
			assert.ok(row.classList.contains("flex-wrap"));
			assert.ok(row.classList.contains("pointer-events-auto"));
			assert.equal(row.children.length, 2);
			assert.equal(chip.parentElement, row.firstElementChild);
			assert.equal(row.lastElementChild!.tagName, "BUTTON");
			assert.equal(chip.textContent, "Pick nodes");
			assert.equal(document.querySelector('[data-testid="practice-props-clear"]'), null);
		});

		it(`${label}: the practice draft uses that same row and order`, () => {
			const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="practice" setupCta={setup} />);
			const rows = document.querySelectorAll('[data-testid="composer-actions"]');
			assert.equal(rows.length, 1);
			assert.ok(rows[0]!.classList.contains("justify-start"));
			assert.ok(rows[0]!.firstElementChild!.querySelector('[data-testid="practice-props-chip"]'));
			assert.equal(rows[0]!.lastElementChild!.tagName, "BUTTON");
		});
	}

	it("picker-only remains left-aligned", () => {
		const document = documentFor(<ComposerActions picker={<NodePickerControl count={0} />} />);
		assert.ok(document.querySelector('[data-testid="composer-actions"]')!.classList.contains("justify-start"));
	});

	it("singular and plural node counts keep Clear in the same wrapping group", () => {
		for (const count of [1, 2]) {
			const document = documentFor(<ComposerActions picker={<NodePickerControl count={count} />} setup={modelSetup} />);
			const chip = document.querySelector('[data-testid="practice-props-chip"]')!;
			const clear = document.querySelector('[data-testid="practice-props-clear"]')!;
			assert.equal(chip.textContent, `${count} ${count === 1 ? "node" : "nodes"} selected`);
			assert.equal(chip.parentElement, clear.parentElement);
			assert.equal(chip.parentElement!.parentElement!.getAttribute("data-testid"), "composer-actions");
			assert.ok(!chip.parentElement!.classList.contains("flex-wrap"), "count and Clear never wrap apart");
		}
	});

	it("existing chat callers retain the standalone provider-key pill wrapper", () => {
		const document = documentFor(<ZeroKeysPill onOpen={() => {}} />);
		const wrapper = document.body.firstElementChild!;
		assert.equal(wrapper.tagName, "DIV");
		assert.ok(wrapper.classList.contains("justify-center"));
		assert.ok(wrapper.classList.contains("mb-2"));
	});

	it("the practice shell preserves a selected node in teaching mode", () => {
		const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" picks={[{id:"n_1",name:"Parity",statement:"Odd + odd = even."}]} />);
		assert.equal(document.querySelector('[data-testid="practice-props-chip"]')!.textContent, "1 node selected");
		assert.ok(document.querySelector('[data-testid="practice-props-clear"]'));
	});
});
