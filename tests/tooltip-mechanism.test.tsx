/**
 * Tooltip-wave mechanism pins (owner, 2026-09-25): the composition rule —
 * icon/pill controls ride the styled Radix tooltip via Hint, the shortcut
 * appended as an em-dash suffix off the LIVE registry (a rebind changes
 * the suffix); truncation-reveals keep native title=; the copy carries no
 * internal vocabulary. Node 26 exposes the host platform through navigator,
 * so expectations cover Mac glyphs AND Ctrl+/Shift+ elsewhere. Composition
 * is the pin; running on a Mac must not be a test prerequisite.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Hint, hintText } from "../components/ui/hint.tsx";
import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip.tsx";
import { AUTO_UPDATE_HINT } from "../components/settings/update-settings.tsx";
import { IS_MAC } from "../src/core/keyboard.ts";

describe("hintText — the parenthesized composition", () => {
	it("a registry action appends the LIVE binding (override-aware source)", () => {
		assert.equal(hintText("Dictate", "toggle-dictation"), IS_MAC ? "Dictate (⌘D)" : "Dictate (Ctrl+D)");
		assert.equal(hintText("Settings", "open-settings"), IS_MAC ? "Settings (⌘,)" : "Settings (Ctrl+,)");
		assert.equal(hintText("Search sessions", "sessions-search"), IS_MAC ? "Search sessions (⌘⇧F)" : "Search sessions (Ctrl+Shift+F)");
	});

	it("surface-owned keys ride the binding prop (no registry entry)", () => {
		assert.equal(hintText("Close", undefined, "escape"), "Close (Esc)");
		assert.equal(hintText("Send", undefined, "enter"), "Send (↵)");
	});

	it("no shortcut = the label alone, no dangling dash", () => {
		assert.equal(hintText("Home"), "Home");
		assert.equal(hintText("Stop dictation (Esc)"), "Stop dictation (Esc)");
	});
});

describe("subtlety round pins (owner 2026-09-25)", () => {
	it("the rest delay is 500ms — tooltips appear on pause, never in passing", () => {
		assert.equal(TOOLTIP_DELAY_MS, 500);
	});
});

describe("spot-pins: the dev-speak cull (owner copy review at merge)", () => {
	it("the auto-update hint is honest user language — no stream jargon", () => {
		assert.equal(AUTO_UPDATE_HINT, "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.");
		assert.ok(!AUTO_UPDATE_HINT.includes("wave"), "no stream vocabulary");
	});
});

describe("Hint — the mechanism (SSR: the tooltip itself stays closed)", () => {
	it("asChild: no wrapper DOM — the control keeps its own testid and classes", () => {
		const html = renderToStaticMarkup(
			createElement(Hint, {
				label: "Dictate",
				action: "toggle-dictation",
				children: createElement("button", { "data-testid": "dictation-toggle", className: "the-quiet-chrome" }, "Dictate"),
			}),
		);
		assert.match(html, /^<button/, "the trigger IS the button — nothing wraps it");
		assert.ok(html.includes('data-testid="dictation-toggle"'));
		assert.ok(html.includes("the-quiet-chrome"));
		assert.ok(!html.includes("<span"), "no portal content renders while closed");
	});
});