/**
 * The surfaces that hardcoded dark (light-mode wave, 2026-10-29): each now
 * reads the active palette or the rendered mode.
 */

import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { confidenceRailStyle } from "../components/confidence-rail.tsx";
import { MERMAID_FONT_SIZE, PELE_RENDER_OPTIONS, renderMermaid } from "../components/mermaid-render.ts";
import { CLUSTER_LIGHTNESS } from "../components/graph-canvas.ts";
import { LhMark } from "../components/lh-mark.tsx";

describe("confidence rail", () => {
	it("sits on the page background, ticks in the foreground ink", () => {
		const style = confidenceRailStyle(50);
		assert.equal(style.backgroundColor, "var(--background)");
		const tick = "color-mix(in oklab, var(--foreground) 35%, transparent)";
		assert.ok(String(style.backgroundImage).includes(`linear-gradient(90deg, ${tick}, ${tick})`));
		assert.ok(!String(style.backgroundImage).includes("rgba(230,230,230"));
	});
});

describe("chat diagrams (pele)", () => {
	it("pins base fontSize, disabled external links/images, Temml trust/XSS safety, and house --pele-* tokens", () => {
		assert.equal(PELE_RENDER_OPTIONS.fontSize, MERMAID_FONT_SIZE);
		assert.equal(PELE_RENDER_OPTIONS.images, false);
		assert.equal(PELE_RENDER_OPTIONS.links, false);
		const inlineMath = renderMermaid('flowchart LR\nA["$$x^2$$"]');
		assert.equal(inlineMath.error, null);
		assert.ok(inlineMath.svg?.includes('xmlns="http://www.w3.org/1998/Math/MathML"'), "emits XML-namespaced MathML");
		assert.ok(!inlineMath.svg?.includes('display="block"'), "labels stay inline (displayMode: false)");
		// Temml's real isTrusted gates: \includegraphics and \style (both succeed if trust: true).
		const blockedImg = renderMermaid('flowchart LR\nA["$$\\includegraphics{https://example.invalid/x.png}$$"]');
		assert.equal(blockedImg.error, null);
		assert.ok(!blockedImg.svg?.includes("<img"), "trust: false rejects \\includegraphics");
		assert.ok(!blockedImg.svg?.includes('class="pele-math"'), "untrusted \\includegraphics falls back cleanly");
		const blockedStyle = renderMermaid('flowchart LR\nA["$$\\style{color:red}{x}$$"]');
		assert.equal(blockedStyle.error, null);
		assert.ok(!blockedStyle.svg?.includes('class="pele-math"'), "trust: false rejects \\style");
		const xssAttempt = renderMermaid('flowchart LR\nA["$$\\text{</math><script>alert(1)</script>}$$"]');
		assert.equal(xssAttempt.error, null);
		assert.ok(!xssAttempt.svg?.includes("<script"), "script tag inside \\text is escaped");
		const css = readFileSync("app/globals.css", "utf8");
		assert.ok(css.includes("--pele-font: var(--font-prose);"), "globals.css binds --pele-font to reading font");
		assert.ok(css.includes(".pele-math math {"), "globals.css scopes MathML rules under .pele-math");
		assert.ok(css.includes("[data-streamdown=\"mermaid\"] svg.pele {"), "globals.css scales svg.pele to its em holder");
		for (const token of ["--pele-bg:", "--pele-fg:", "--pele-line:", "--pele-surface:", "--pele-border:", "--pele-accent:"]) {
			assert.ok(css.includes(token), `globals.css defines ${token}`);
		}
	});
});

describe("graph clusters", () => {
	it("dark keeps today's lightness; light darkens rings and labels", () => {
		assert.deepEqual(CLUSTER_LIGHTNESS.dark, { ring: 60, label: 78 });
		assert.ok(CLUSTER_LIGHTNESS.light.ring < CLUSTER_LIGHTNESS.dark.ring);
		assert.ok(CLUSTER_LIGHTNESS.light.label < CLUSTER_LIGHTNESS.dark.label);
	});
});

describe("LH mark", () => {
	it("the ring follows the strong line ink; the spiral gray stays", () => {
		const html = renderToStaticMarkup(<LhMark />);
		assert.equal((html.match(/fill:var\(--lh-line-strong\)/g) ?? []).length, 2);
		assert.ok(!html.includes("#fff"));
		assert.ok(html.includes("rgb(148,148,148)"));
	});
});
