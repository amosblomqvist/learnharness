import React, { act } from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_THEME, type AppearanceSettings, type DisclosureKind } from "../src/core/index.ts";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { toggleAllDisclosures } from "../components/disclosure-store.ts";
import { ThinkingBlock } from "../components/thinking-block.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => Response.json({ themes: [DEFAULT_THEME] }),
});

type ExpandByDefault = AppearanceSettings["expandByDefault"];

function ssr(expandByDefault: ExpandByDefault, node: React.ReactNode) {
	return renderToStaticMarkup(
		<AppearanceProvider initialAppearance={expandByDefault && { expandByDefault }} initialTheme={DEFAULT_THEME}>{node}</AppearanceProvider>,
	);
}

let live!: ReturnType<typeof useAppearance>;
function Probe() {
	live = useAppearance();
	return null;
}

async function mount(expandByDefault: ExpandByDefault, node: React.ReactNode) {
	const { createRoot } = await import("react-dom/client");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = (next: React.ReactNode) => act(async () => root.render(
		<AppearanceProvider initialAppearance={{ expandByDefault }} initialTheme={DEFAULT_THEME}><Probe />{next}</AppearanceProvider>,
	));
	await render(node);
	return {
		host,
		render,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** What the chat's shortcut listener does with the live setting. */
const keyboardToggle = (kind: DisclosureKind) =>
	act(async () => toggleAllDisclosures(kind, live.appearance.expandByDefault[kind]));

const setExpandByDefault = (expandByDefault: ExpandByDefault) =>
	act(async () => live.onAppearanceChange({ expandByDefault }));

describe("blocks start at their Start expanded setting", () => {
	it("your thinking: one rule for transcript and in-card rows; factory expanded", () => {
		for (const [setting, open] of [[undefined, true], [{ userThinking: true }, true], [{ userThinking: false }, false]] as const) {
			for (const inCard of [false, true]) {
				const html = ssr(setting, <ThinkingBlock text="my thought" inCard={inCard} />);
				assert.ok(html.includes(`aria-expanded="${open}"`), `${JSON.stringify(setting)} inCard=${inCard}`);
				assert.equal(html.includes("my thought"), open);
			}
		}
	});
});

describe("keyboard toggles and setting changes", () => {
	it("a toggle sets every row for this page load; a setting change takes over again", async () => {
		const rows = (count: number) => Array.from({ length: count }, (_, i) => (
			<ThinkingBlock key={i} testId={`t${i}`} text={`thought ${i}`} inCard={i % 2 === 1} />
		));
		const view = await mount({ userThinking: false }, rows(2));
		const open = () => [...view.host.querySelectorAll('[data-testid$="-trigger"]')].map((b) => b.getAttribute("aria-expanded") === "true");
		const click = (i: number) => act(async () => view.host.querySelector<HTMLButtonElement>(`[data-testid="t${i}-trigger"]`)!.click());
		try {
			assert.deepEqual(open(), [false, false], "both placements start at the setting");
			await click(0);
			assert.deepEqual(open(), [true, false], "a click toggles one row");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [true, true], "the first press flips from the setting");
			await view.render(rows(3));
			assert.deepEqual(open(), [true, true, true], "a late mount honors the keyboard set over the setting");
			assert.ok(ssr({ userThinking: false }, <ThinkingBlock text="late" />).includes('aria-expanded="true"'), "from its first render, before any effect");
			await click(1);
			assert.deepEqual(open(), [true, false, true], "a click still toggles one row after a keyboard set");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [false, false, false], "the next press flips from the last keyboard set");
			await setExpandByDefault({ userThinking: true });
			assert.deepEqual(open(), [true, true, true], "a setting change applies to every mounted row");
			await view.render(rows(4));
			assert.deepEqual(open(), [true, true, true, true], "the setting change cleared the keyboard set for later mounts");
			await keyboardToggle("userThinking");
			assert.deepEqual(open(), [false, false, false, false], "the next press flips from the new setting");
			await setExpandByDefault({ userThinking: true, why: true });
			assert.deepEqual(open(), [false, false, false, false], "another kind's setting change leaves these rows alone");
		} finally {
			await view.unmount();
		}
	});
});
