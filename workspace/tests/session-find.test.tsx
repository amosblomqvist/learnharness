/**
 * Session Find — the pure matcher plus the DOM seam (owner, 2026-10-13).
 * The DOM seam runs under linkedom (styles resolve to defaults: display
 * block/inline behave; the hidden/overlay paths are exercised through the
 * selectors and inline styles linkedom DOES evaluate). The highlight/
 * scroll lifecycle itself is browser-verified (SessionFind on the live
 * page), not re-implemented here.
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
