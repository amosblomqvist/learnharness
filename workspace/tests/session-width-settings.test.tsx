import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import {
	DEFAULT_THEME,
	FACTORY_SETTINGS,
	isTranscriptMaxWidth,
	resolveSettings,
	sanitizeUserSettings,
	type AppearanceSettings,
} from "../src/core/index.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { AppearanceProvider, appearanceVars, resolveAppearance, useAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection, transcriptWidthLabel } from "../components/settings/appearance-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

(globalThis as Record<string, unknown>).React = React;

it("factory: transcript width Full (absent), adaptive question layout ON", () => {
	assert.equal(FACTORY_SETTINGS.appearance.transcriptMaxWidth, null);
	assert.equal(FACTORY_SETTINGS.appearance.adaptiveQuestions, true);
	for (const appearance of [undefined, {}, { proseFontSize: 20 }]) {
		const resolved = resolveSettings({ version: 1, appearance }).appearance;
		assert.equal(resolved.transcriptMaxWidth, null);
		assert.equal(resolved.adaptiveQuestions, true);
		assert.equal(resolveAppearance(appearance).transcriptMaxWidth, null);
		assert.equal(resolveAppearance(appearance).adaptiveQuestions, true);
	}
});

it("valid widths: even rem steps 46-120; writes round-trip through parse, sanitize and resolve", () => {
	for (const width of [46, 48, 80, 118, 120]) {
		assert.equal(isTranscriptMaxWidth(width), true, String(width));
		const appearance = { transcriptMaxWidth: width, adaptiveQuestions: false };
		const parsed = parseAppearanceSettingsBody(appearance);
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.settings, appearance);
		const record = sanitizeUserSettings({ version: 1, appearance });
		assert.deepEqual(record?.appearance, appearance);
		assert.equal(resolveSettings(record).appearance.transcriptMaxWidth, width);
		assert.equal(resolveSettings(record).appearance.adaptiveQuestions, false);
	}
});

it("invalid widths/toggles are rejected on save and dropped on read (= Full / on)", () => {
	for (const value of [44, 47, 122, 64.5, 0, -46, null, "80", "Full", [], {}, Number.NaN, Infinity]) {
		assert.equal(isTranscriptMaxWidth(value), false, String(value));
		const parsed = parseAppearanceSettingsBody({ transcriptMaxWidth: value });
		assert.equal(parsed.ok, false, JSON.stringify(value));
		const record = sanitizeUserSettings({ version: 1, appearance: { transcriptMaxWidth: value, proseFontSize: 20 } });
		assert.deepEqual(record?.appearance, { proseFontSize: 20 });
		assert.equal(resolveSettings(record).appearance.transcriptMaxWidth, null);
	}
	for (const value of [null, "true", 0, 1]) {
		assert.equal(parseAppearanceSettingsBody({ adaptiveQuestions: value }).ok, false, JSON.stringify(value));
		const record = sanitizeUserSettings({ version: 1, appearance: { adaptiveQuestions: value } });
		assert.equal(resolveSettings(record).appearance.adaptiveQuestions, true);
	}
});

it("the appearance mapping sets the transcript variable only when capped", () => {
	const full = appearanceVars(resolveAppearance(undefined), DEFAULT_THEME);
	assert.equal("--lh-transcript-max" in full, false);
	const capped = appearanceVars(resolveAppearance({ transcriptMaxWidth: 64 }), DEFAULT_THEME);
	assert.deepEqual(capped, { ...full, "--lh-transcript-max": "64rem" });
	// The adaptive toggle is behavior, not a stylesheet variable.
	assert.deepEqual(appearanceVars(resolveAppearance({ adaptiveQuestions: false }), DEFAULT_THEME), full);
});

it("the transcript column reads the variable; unset leaves today's full-bleed column", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-transcript-column \{\s*max-width: calc\(var\(--lh-transcript-max\) \+ 1rem\);\s*\}/);
	const chat = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /const COLUMN = "lh-transcript-column mx-auto w-full px-6";/);
	assert.match(chat, /const DOCK = "mx-auto w-full max-w-\[46rem\] px-4";/);
});

it("inline code and inline math never wrap on the session page; a span wider than its column scrolls", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const rule = /\[data-session-surface\] \[data-streamdown="inline-code"\],\s*\[data-session-surface\] :not\(\.katex-display\) > \.katex \{([^}]*)\}/.exec(css)?.[1] ?? "";
	for (const decl of ["white-space: nowrap", "display: inline-block", "max-width: 100%", "overflow-x: auto", "baseline-source: first"]) {
		assert.ok(rule.includes(decl), decl);
	}
	// Display math keeps its own sideways scroller; only inline math is scoped.
	assert.match(css, /\.katex-display \{\s*overflow-x: auto;/);
	const chat = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /<div data-session-surface="" className="flex h-dvh">/);
});

it("labels: px at 16px per rem, or Full", () => {
	assert.equal(transcriptWidthLabel(null), "Full");
	assert.equal(transcriptWidthLabel(46), "736px");
	assert.equal(transcriptWidthLabel(120), "1920px");
});

it("Appearance rows: the slider commits on release (Full = absent) and the toggle writes adaptiveQuestions", async () => {
	const dom = parseHTML(`<!doctype html><html><body><div id="root"></div></body></html>`);
	const { document } = dom;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = globalThis as Record<string, unknown>;
	for (const [key, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => Response.json({ themes: [DEFAULT_THEME] }),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const writes: AppearanceSettings[] = [];
	function Panel() {
		const { delta, onAppearanceChange } = useAppearance();
		return <AppearanceSection appearance={delta} onSectionChange={next => { writes.push(next); onAppearanceChange(next); return true; }} />;
	}
	const slider = () => document.querySelector<HTMLInputElement>('[data-testid="input-transcript-width"]')!;
	const label = () => document.querySelector('[data-testid="transcript-width-value"]')!.textContent;
	const release = async (value: number) => {
		await act(async () => {
			slider().value = String(value);
			slider().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
	};
	const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Adapt question layout"]')!;
	try {
		await act(async () => root.render(<InteractionLayersProvider><AppearanceProvider initialAppearance={{ proseFontSize: 20 }} initialTheme={DEFAULT_THEME}><Panel /></AppearanceProvider></InteractionLayersProvider>));
		assert.equal(slider().getAttribute("min"), "46");
		assert.equal(slider().getAttribute("max"), "122", "one step past 120rem is Full");
		assert.equal(slider().getAttribute("step"), "2");
		assert.equal(label(), "Full");
		await release(64);
		assert.deepEqual(writes.at(-1), { proseFontSize: 20, transcriptMaxWidth: 64 });
		assert.equal(document.documentElement.style.getPropertyValue("--lh-transcript-max"), "64rem");
		assert.equal(label(), "1024px");
		await release(122);
		assert.equal("transcriptMaxWidth" in JSON.parse(JSON.stringify(writes.at(-1))), false, "Full is absence");
		assert.equal(document.documentElement.style.getPropertyValue("--lh-transcript-max"), "", "the stale cap is removed");
		assert.equal(label(), "Full");
		assert.equal(toggle().getAttribute("aria-checked"), "true");
		await act(async () => toggle().click());
		assert.equal(writes.at(-1)?.adaptiveQuestions, false);
		assert.equal(toggle().getAttribute("aria-checked"), "false");
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
