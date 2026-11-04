/**
 * First paint follows the theme end to end: the record and the theme
 * files on a temp LH_DATA_DIR → readThemeBoot (exactly what app/layout.tsx
 * spreads on <html>; the layout itself imports CSS and next/font, so it
 * cannot load under tsx) → the server-rendered <html>. And the status
 * chrome speaks the theme's tokens.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-layout-theme-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { readThemeBoot, writeSettingsRecord, themeStore } = await import("../src/server/index.ts");
const { AnsweredCard } = await import("../components/answered-card.tsx");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** The <html> the layout renders from a boot (className + style). */
function html(): string {
	const { theme, vars } = readThemeBoot();
	return renderToStaticMarkup(
		<html className={theme.mode} style={vars as React.CSSProperties}>
			<body />
		</html>,
	);
}

describe("first paint follows the theme", () => {
	it("Rosé Pine Dawn renders light with its colors on <html>", () => {
		writeSettingsRecord({ version: 1, appearance: { theme: "rose-pine-dawn" } });
		const out = html();
		assert.match(out, /<html class="light"/);
		assert.match(out, /--background:#faf4ed/);
		assert.match(out, /--foreground:#575279/);
	});

	it("an imported theme paints from its file; overrides paint over it", () => {
		themeStore.writeTheme("my-paper", {
			name: "My Paper",
			mode: "light",
			colors: {
				background: "#fdfdfd", surface: "#ffffff", border: "#dddddd", text: "#222222", textMuted: "#666666",
				accent: "#3366ff", bold: "#222222", italic: "#222222", code: "#aa5500",
				error: "#cc0000", success: "#008800", warning: "#aa7700",
			},
		});
		writeSettingsRecord({ version: 1, appearance: { theme: "my-paper", colors: { warning: "#123456" } } });
		const out = html();
		assert.match(out, /<html class="light"/);
		assert.match(out, /--lh-accent:#3366ff/);
		assert.match(out, /--lh-warning:#123456/);
	});

	it("no record = the Default dark theme", () => {
		fs.rmSync(path.join(TMP_DATA, "settings.json"), { force: true });
		const out = html();
		assert.match(out, /<html class="dark"/);
		assert.match(out, /--background:#141414/);
	});
});

describe("status chrome speaks the theme tokens", () => {
	it("an answered quiz's correct chip uses the success token", () => {
		const out = renderToStaticMarkup(
			<AnsweredCard
				answer={{
					kind: "quiz", questionText: "2+2?", options: [{ index: 1, label: "4" }, { index: 2, label: "5" }],
					answers: [{ index: 1, label: "4", value: "a" }], correct: true, correctIndices: [1], dontKnow: false,
					answeredAt: "synthetic",
				}}
			/>,
		);
		assert.match(out, /bg-success\/15[^"]*text-success|text-success[^"]*bg-success\/15/);
		assert.doesNotMatch(out, /green-500/);
	});
});
