/**
 * The appearance wave's font dropdown (2026-09-26): the pure row-set
 * (fontMenuResults — the DEFAULT row is a fuzzy candidate, so Enter can
 * never pick a row that isn't on screen), the pick composer (null = the
 * factory Source Sans 3), the curated dev-browser fallback roster, the
 * FontMenuList SSR shape, and the emphasis-ink factory ruling (globals.css
 * no longer ships #ee928c/#6fa9d6 — unset inks are the text color).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { FontMenuList, customFamilyFor, fontMenuResults } from "../components/settings/model-menu";
import {
	CURATED_FALLBACK_FONTS,
	DEFAULT_READING_FONT,
	AppearanceSection,
	composeFontFamily,
} from "../components/settings/appearance-section";

describe("fontMenuResults — the DEFAULT row is a candidate, never a ghost pick", () => {
	const families = ["Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"];

	it("empty query → the DEFAULT row first, then every family", () => {
		assert.deepEqual(fontMenuResults("", families), [null, "Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"]);
	});

	it("the default row matches its own identity (source/sans/default), not everything", () => {
		assert.deepEqual(fontMenuResults("georgia", families), ["Georgia"]);
		assert.deepEqual(fontMenuResults("menlo", families), ["Menlo"]);
		// the default row is reachable by search…
		assert.deepEqual(fontMenuResults("source", families)[0], null);
		assert.ok(fontMenuResults("default", families).includes(null));
		// …and drops out of unrelated queries
		assert.ok(!fontMenuResults("georgia", families).includes(null));
	});

	it("a query matching nothing yields an empty list (the custom input is the escape)", () => {
		assert.deepEqual(fontMenuResults("zzzz", families), []);
	});
});

describe("composeFontFamily — null/blank = the factory family, otherwise verbatim", () => {
	it("null → fontFamily null (Source Sans 3 semantics preserved)", () => {
		assert.equal(composeFontFamily({ background: "#101010" }, null).fontFamily, null);
	});
	it("blank/whitespace → null too", () => {
		assert.equal(composeFontFamily(undefined, "  ").fontFamily, null);
	});
	it("a family commits verbatim (trimmed)", () => {
		assert.equal(composeFontFamily(undefined, " Georgia ").fontFamily, "Georgia");
	});
	it("the rest of the section rides along", () => {
		const next = composeFontFamily({ background: "#101010" }, "Menlo");
		assert.equal(next.background, "#101010");
	});
});

describe("the curated dev-browser fallback", () => {
	it("is the app's knowns + ubiquitous macOS families — and never a fabricated system list member for the factory family", () => {
		assert.ok(CURATED_FALLBACK_FONTS.includes("CMU Serif"));
		assert.ok(CURATED_FALLBACK_FONTS.includes("Georgia"));
		assert.ok(CURATED_FALLBACK_FONTS.includes("JetBrains Mono"), "the bundled mono is always offered");
		// the factory family lives ONLY as the DEFAULT row — never a
		// duplicated family row
		assert.ok(!CURATED_FALLBACK_FONTS.includes(DEFAULT_READING_FONT));
	});
});

describe("FontMenuList (thin SSR)", () => {
	it("renders the DEFAULT row, the families, and the custom escape", () => {
		const html = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily={null} onPick={() => {}} />,
		);
		assert.ok(html.includes('data-testid="font-option-default"'), "the default row");
		assert.ok(html.includes("default</span>"), "the default row carries its mark");
		assert.ok(html.includes('data-testid="font-option-Georgia"'), "a family row");
		assert.ok(html.includes('data-testid="font-option-Menlo"'), "another family row");
		assert.ok(html.includes('data-testid="font-search"'), "the search field");
		// ONE field (owner ask 2026-09-26: "why two?") — the custom-family
		// input is gone; the search field absorbed its job via the
		// "Use '<query>'" action row.
		assert.ok(!html.includes('data-testid="font-custom-input"'), "no separate custom input");
		assert.ok(!html.includes('data-testid="font-custom-set"'), "no Set button");
		assert.ok(!html.includes("Type a family name"), "no second field placeholder");
		assert.ok(html.includes("Search fonts…"), "the search placeholder");
	});

	it("the effective family's row carries the quiet highlight; the default row does when unset", () => {
		const unset = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily={null} onPick={() => {}} />,
		);
		const defaultRow = unset.split('data-testid="font-option-default"')[1]?.split("</button>")[0] ?? "";
		assert.ok(defaultRow.includes("bg-muted/60"), "unset → the default row is the effective one");

		const menlo = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily="Menlo" onPick={() => {}} />,
		);
		const menloRow = menlo.split('data-testid="font-option-Menlo"')[1]?.split("</button>")[0] ?? "";
		const georgiaRow = menlo.split('data-testid="font-option-Georgia"')[1]?.split("</button>")[0] ?? "";
		assert.ok(menloRow.includes("bg-muted/60"), "the stored family highlights");
		assert.ok(!georgiaRow.includes("bg-muted/60"), "others do not");
	});

	it("undefined families = the enumerating state (Loading fonts…), not an empty picker", () => {
		const html = renderToStaticMarkup(
			<FontMenuList families={undefined} effectiveFamily={null} onPick={() => {}} />,
		);
		assert.ok(html.includes("Loading fonts…"));
	});
});

describe("the appearance section's font control (thin SSR)", () => {
	it("the reading-font row renders the dropdown TRIGGER — the old free-text input is gone", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={undefined} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes('data-testid="font-trigger"'), "the trigger");
		assert.ok(html.includes(DEFAULT_READING_FONT), "unset shows the factory family");
		assert.ok(html.includes('aria-expanded="false"'), "the collapsed state");
		// the old CommitInput is retired
		assert.ok(!html.includes('data-testid="input-font"'));
		assert.ok(!html.includes('placeholder="Source Sans 3"'));
	});

	it("a stored family shows in the trigger (the record never lies)", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={{ fontFamily: "Georgia" }} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes("Georgia"));
	});
});

describe("the emphasis-ink factory ruling (globals.css)", () => {
	it("the old emphasis hexes are GONE from the ink token declarations", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		assert.ok(!css.includes("--lh-ink-strong: #ee928c"), "bold factory is not the old orange");
		assert.ok(!css.includes("--lh-ink-italic: #6fa9d6"), "italic factory is not the old blue");
	});

	it("the Default theme's inks are the regular text color", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		const text = css.match(/--foreground: (#[0-9a-f]{6});/)?.[1];
		assert.ok(text, "the factory text color");
		assert.ok(css.includes(`--lh-ink-strong: ${text};`), "bold ink = text");
		assert.ok(css.includes(`--lh-ink-italic: ${text};`), "italic ink = text");
	});

	it("the bold and italic override rows' empty-state hints name the text color", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={undefined} onSectionChange={() => {}} />,
		);
		const text = html.match(/data-testid="row-color-text"[\s\S]*?Empty = (#[0-9a-f]{6})/)?.[1];
		assert.ok(text, "the text row's hint");
		for (const key of ["bold", "italic"]) {
			const hint = html.match(new RegExp(`data-testid="row-color-${key}"[\\s\\S]*?Empty = (#[0-9a-f]{6})`))?.[1];
			assert.equal(hint, text, `${key} row`);
		}
		assert.ok(!html.includes("#ee928c"));
		assert.ok(!html.includes("#6fa9d6"));
	});
});

describe("customFamilyFor — the single-field custom escape (2026-09-26)", () => {
	const families = ["Arial", "CMU Serif", "Georgia", "Menlo"];

	it("a query matching nothing becomes the custom pick", () => {
		assert.equal(customFamilyFor("Baskerville", families), "Baskerville");
		assert.equal(customFamilyFor("  zzz  ", families), "zzz");
	});

	it("a matching family is the better pick — no action row", () => {
		assert.equal(customFamilyFor("georgia", families), null);
		// the default row matches too — "source"/"sans"/"default" queries pick it
		assert.equal(customFamilyFor("source", families), null);
	});

	it("an empty query is never a custom pick", () => {
		assert.equal(customFamilyFor("", families), null);
		assert.equal(customFamilyFor("   ", families), null);
	});
});
