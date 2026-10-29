/**
 * Session Find — the pure matcher plus the DOM seam (owner, 2026-10-13).
 * The DOM seam runs under linkedom (styles resolve to defaults: display
 * block/inline behave; the hidden/overlay paths are exercised through the
 * selectors and inline styles linkedom DOES evaluate). The highlight/
 * scroll lifecycle itself is browser-verified (SessionFind on the live
 * page), not re-implemented here.
 * Compatibility expansions produce unique, non-overlapping original spans.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { findSessionTextMatches, stepSessionMatch } from "../src/core/session-find.ts";
import { sessionFindRanges, sessionRangeIdentity, sameSessionRange } from "../components/session-find-dom.ts";
import { clearSessionFindHighlights, injectFindStyles, sessionFindHasForegroundLayer } from "../components/session-find.tsx";

const dom = parseHTML("<html><head><style></style></head><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;
// linkedom ships no Highlight registry — stub the one field the clearer reads.
(globalThis as Record<string, unknown>).CSS = dom.window.CSS ?? { highlights: new Map() };

describe("findSessionTextMatches — literal, case-insensitive, regex-inert", () => {
	it("finds every literal occurrence, any case — substrings included", () => {
		assert.deepEqual(findSessionTextMatches("Cat and CAT", "cat"), [
			{ start: 0, end: 3 }, { start: 8, end: 11 },
		]);
		assert.deepEqual(findSessionTextMatches("scat", "cat"), [{ start: 1, end: 4 }]);
	});

	it("regex metacharacters are inert", () => {
		assert.deepEqual(findSessionTextMatches("a.b axb ?*+ (x) [y]", "a.b"), [{ start: 0, end: 3 }]);
		assert.deepEqual(findSessionTextMatches("cost $5 now", "$5"), [{ start: 5, end: 7 }]);
		assert.deepEqual(findSessionTextMatches("a\\b", "a\\b"), [{ start: 0, end: 3 }]);
	});

	it("empty query matches nothing; no query, no ranges", () => {
		assert.deepEqual(findSessionTextMatches("anything", ""), []);
	});

	it("unicode-aware, and offsets are UTF-16 into the text as-is", () => {
		assert.deepEqual(findSessionTextMatches("α αα", "αα"), [{ start: 2, end: 4 }]);
	});

	it("maps Arabic matches back to exact original spans including diacritics", () => {
		const text = "😀 أَحْمَدُ في مَدْرَسَةٍ مع عَلَى وعَلِيّ";
		for (const [query, spans] of [
			["احمد", ["أَحْمَدُ"]],
			["مدرسه", ["مَدْرَسَةٍ"]],
			["على", ["عَلَى", "عَلِيّ"]],
			["علي", ["عَلَى", "عَلِيّ"]],
		] as const) {
			const matches = findSessionTextMatches(text, query);
			assert.deepEqual(matches.map(({ start, end }) => text.slice(start, end)), spans);
			assert.deepEqual(matches, spans.map((span) => ({ start: text.indexOf(span), end: text.indexOf(span) + span.length })));
		}
	});

	it("normalizes the query too and ignores queries made entirely of removed marks", () => {
		assert.deepEqual(findSessionTextMatches("احمد", "أَحْمَد"), [{ start: 0, end: 4 }]);
		assert.deepEqual(findSessionTextMatches("عَـلْم", "علم"), [{ start: 0, end: 6 }]);
		assert.deepEqual(findSessionTextMatches("نص", "َـ"), []);
	});

	it("applies Unicode folding and preserves literal punctuation and non-overlap", () => {
		assert.deepEqual(findSessionTextMatches("İ i K k ſ s", "i"), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
		assert.deepEqual(findSessionTextMatches("İ i K k ſ s", "k"), [{ start: 4, end: 5 }, { start: 6, end: 7 }]);
		assert.deepEqual(findSessionTextMatches("İ i K k ſ s", "s"), [{ start: 8, end: 9 }, { start: 10, end: 11 }]);
		assert.deepEqual(findSessionTextMatches("😀aaa", "aa"), [{ start: 2, end: 4 }]);
		assert.deepEqual(findSessionTextMatches("قيمة a.b و axb", "a.b"), [{ start: 5, end: 8 }]);
	});

	it("finds accent-free and niqqud-free queries with exact original highlight spans", () => {
		const text = "😀 café cafe\u0301 שָׁלוֹם ﬃ\u0301";
		for (const [query, spans] of [["cafe", ["café", "cafe\u0301"]], ["שלום", ["שָׁלוֹם"]], ["ffi", ["ﬃ\u0301"]]] as const) {
			const matches = findSessionTextMatches(text, query);
			assert.deepEqual(matches.map(({ start, end }) => text.slice(start, end)), spans);
			assert.deepEqual(matches, spans.map((span) => ({ start: text.indexOf(span), end: text.indexOf(span) + span.length })));
		}
		assert.deepEqual(findSessionTextMatches("cafe", "café"), [{ start: 0, end: 4 }]);
		assert.deepEqual(findSessionTextMatches("שלום", "שָׁלוֹם"), [{ start: 0, end: 4 }]);
	});

	it("coalesces duplicate and overlapping spans from compatibility ligatures", () => {
		assert.deepEqual(findSessionTextMatches("ﬃ", "f"), [{ start: 0, end: 1 }]);
		assert.deepEqual(findSessionTextMatches("ﬃﬃﬃ", "iff"), [{ start: 0, end: 3 }]);
		assert.deepEqual(findSessionTextMatches("ﬃﬃ", "f"), [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
	});

	it("keeps tashkeel in coalesced Arabic spans and preserves separate letters", () => {
		assert.deepEqual(findSessionTextMatches("ﷲُ", "ل"), [{ start: 0, end: 2 }]);
		const text = "مُعَلِّمٌ";
		assert.deepEqual(findSessionTextMatches(text, "م").map(({ start, end }) => text.slice(start, end)), ["مُ", "مٌ"]);
	});

	it("keeps adjacent hits separate and never overlapping", () => {
		assert.deepEqual(findSessionTextMatches("aaaa", "a"), [
			{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 },
		]);
		assert.deepEqual(findSessionTextMatches("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
	});

	it("finds a Greek word whose final sigma the text lowercases differently from the query", () => {
		assert.deepEqual(findSessionTextMatches("ΟΔΟΣΑ", "ΟΔΟΣ"), [{ start: 0, end: 4 }]);
		assert.deepEqual(findSessionTextMatches("οδός", "οδοσ"), [{ start: 0, end: 4 }]);
	});

	it("a spacing accent matches no space, and a math letter matches its plain letter", () => {
		assert.deepEqual(findSessionTextMatches("a b c", "¨"), []);
		assert.deepEqual(findSessionTextMatches("a b c", "´"), []);
		assert.deepEqual(findSessionTextMatches("x ∈ ℝ", "r"), [{ start: 4, end: 5 }]);
		assert.deepEqual(findSessionTextMatches("𝐀bc", "abc"), [{ start: 0, end: 4 }]);
	});

	it("keeps voiced kana and Indic vowels apart from their bare letters", () => {
		assert.deepEqual(findSessionTextMatches("バス ハス", "ハス"), [{ start: 3, end: 5 }]);
		assert.deepEqual(findSessionTextMatches("ハ\u3099ス", "バス"), [{ start: 0, end: 3 }]);
		assert.deepEqual(findSessionTextMatches("पानी पन", "पन"), [{ start: 5, end: 7 }]);
	});
});

describe("stepSessionMatch — wraparound navigation", () => {
	it("steps forward and wraps; backward and wraps; empty stays empty", () => {
		assert.equal(stepSessionMatch(0, 3, 1), 1);
		assert.equal(stepSessionMatch(2, 3, 1), 0);
		assert.equal(stepSessionMatch(0, 3, -1), 2);
		assert.equal(stepSessionMatch(1, 3, -1), 0);
		assert.equal(stepSessionMatch(-1, 0, 1), -1);
	});
});

describe("sessionFindRanges — the displayed-text DOM seam", () => {
	function mount(html: string): void {
		document.body.innerHTML = html;
	}

	it("matches text spanning inline markup, never across blocks", () => {
		mount(`<div data-session-find-root="">
			<p data-testid="p1">chain <strong>rule</strong> lives here</p>
			<p data-testid="p2">chain rule</p>
		</div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "chain rule");
		assert.equal(ranges.length, 2, "both paragraphs match; the first spans its <strong>");
		const first = ranges[0]!;
		assert.equal(first.startContainer.nodeName, "#text");
		assert.equal(first.toString().length, "chain rule".length);
	});

	it("searches only marked session roots — chrome, dialogs, and the composer stay out", () => {
		mount(`<div data-session-find-root=""><p>needle in the session</p></div>
			<div data-testid="chrome"><p>needle in chrome</p></div>
			<div role="dialog"><p>needle in a dialog</p></div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "needle");
		assert.equal(ranges.length, 1);
		assert.ok((ranges[0]!.startContainer as Text).data.includes("session"));
	});

	it("hidden subtrees never match: hidden attr, menus, katex MathML duplicate, draft editors (display:none is browser-verified)", () => {
		mount(`<div data-session-find-root="">
			<p>needle visible</p>
			<p hidden>needle hidden-attr</p>
			<div data-lh-menu><p>needle menu</p></div>
			<span class="katex-mathml">needle mathml</span>
			<textarea>needle draft</textarea>
			<div contenteditable="true" data-file-path-input>needle path draft <span contenteditable="false">notes.pdf</span></div>
		</div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "needle");
		assert.equal(ranges.length, 1);
		assert.ok((ranges[0]!.startContainer as Text).data.includes("visible"));
	});

	it("collapsed whitespace matches: a phrase with spaces/tabs/newlines between words", () => {
		mount(`<div data-session-find-root=""><p>the\n\tchain    rule</p></div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "the chain rule");
		assert.equal(ranges.length, 1);
	});

	it("code spans keep their literal whitespace (pre): no collapse", () => {
		mount(`<div data-session-find-root=""><pre>a  b</pre><p>a b</p></div>`);
		assert.equal(sessionFindRanges(document.body as unknown as HTMLElement, "a  b").length, 1);
		assert.equal(sessionFindRanges(document.body as unknown as HTMLElement, "a b").length, 1);
	});

	it("empty query returns no ranges", () => {
		mount(`<div data-session-find-root=""><p>text</p></div>`);
		assert.equal(sessionFindRanges(document.body as unknown as HTMLElement, "").length, 0);
	});

	it("identity survives text appended after the match (streaming)", () => {
		mount(`<div data-session-find-root=""><p>findme and more to come</p></div>`);
		const [range] = sessionFindRanges(document.body as unknown as HTMLElement, "findme");
		const identity = sessionRangeIdentity(range!);
		const p = document.querySelector("p")!;
		p.firstChild!.textContent = "findme and more text streamed in";
		const [again] = sessionFindRanges(document.body as unknown as HTMLElement, "findme");
		assert.ok(sameSessionRange(again!, identity), "same node/offsets: refresh holds the active match");
	});

	it("a phrase spans an isolated English run inside Arabic text", () => {
		mount(`<div data-session-find-root=""><p dir="rtl">قانون <span dir="ltr">Newton</span> ينص</p></div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "قانون newton ينص");
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0]!.toString(), "قانون Newton ينص");
	});

	it("Arabic marks split across inline nodes still fold with their letter", () => {
		mount(`<div data-session-find-root=""><p>أ<em>َ</em>حْ<strong>مَدُ</strong> هنا</p></div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "احمد");
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0]!.toString(), "أَحْمَدُ");
	});

	it("a zero-width space inside a word does not break the match", () => {
		mount(`<div data-session-find-root=""><p>the deriv\u200Bative rule</p></div>`);
		const ranges = sessionFindRanges(document.body as unknown as HTMLElement, "derivative");
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0]!.toString(), "deriv\u200Bative");
	});
});

describe("sessionFindHasForegroundLayer — the one-Esc law", () => {
	const mount = (html: string): void => {
		document.body.innerHTML = html;
	};

	it("no surfaced layer when only session content exists", () => {
		mount(`<div data-testid="user-message"><p>needle</p></div>`);
		assert.equal(sessionFindHasForegroundLayer(document), false);
	});

	it("a surfaced menu/dialog/cheat sheet outranks the Find bar", () => {
		for (const html of [
			'<div data-lh-menu></div>',
			'<div data-testid="cheat-sheet"></div>',
			'<div role="dialog"></div>',
			'<div data-radix-popper-content-wrapper></div>',
		]) {
			mount(html);
			assert.equal(sessionFindHasForegroundLayer(document), true, html);
		}
	});

	it("a closed Radix layer is not surfaced", () => {
		mount(`<div role="dialog" data-state="closed"></div>`);
		assert.equal(sessionFindHasForegroundLayer(document), false);
	});
});

describe("injectFindStyles — ::highlight rules ship outside the PostCSS pipeline", () => {
	const mount = (html: string): void => {
		document.body.innerHTML = html;
	};

	it("injects both rules once, idempotently", () => {
		document.head.innerHTML = "";
		injectFindStyles();
		injectFindStyles();
		const styles = [...document.querySelectorAll("style")];
		assert.equal(styles.length, 1, "one style element, never duplicated");
		const css = styles[0]!.textContent ?? "";
		assert.ok(css.includes("::highlight(lh-session-find) {"));
		assert.ok(css.includes("::highlight(lh-session-find-active) {"));
	});
});

describe("clearSessionFindHighlights — browser-API shaped, linkedom-safe", () => {
	const mount = (html: string): void => {
		document.body.innerHTML = html;
	};
	it("clears registered highlights without touching the DOM", () => {
		mount(`<div data-session-find-root=""><p>needle</p></div>`);
		const [range] = sessionFindRanges(document.body as unknown as HTMLElement, "needle");
		// linkedom ships no Highlight constructor — the publisher guards on it.
		(CSS as { highlights?: Map<string, unknown> }).highlights = new Map([["lh-session-find", {}]]);
		clearSessionFindHighlights();
		assert.equal((CSS as { highlights?: Map<string, unknown> }).highlights!.size, 0);
		assert.ok(range!, "a range existed and the DOM beneath it is untouched");
	});
});
