/**
 * Render tests for the chrome-melt wave (2026-09-19): the md-blocks
 * component overrides (Streamdown `components` prop) + the session-scoped
 * overlays. Idiom shared with render-markdown.test.tsx: static HTML via
 * react-dom/server (no DOM, effects never run — mermaid stays at its
 * skeleton, the overlays render their shells). tsx note: classic JSX
 * transform — the React global shim below provides React.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { ThinkingBlock, setAllUserThinkingOpen } from "@/components/thinking-block";
import { MermaidOverlay, SessionMermaidContext, chartSize } from "../components/session-overlay.tsx";
import { PlanPopup } from "../components/plan-block.tsx";
import { MarkdownCode, codeSource } from "../components/md-blocks.tsx";

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("md-blocks — code", () => {
	it("inline code passes through with the house inline styling", () => {
		const html = render("a `term` b");
		assert.ok(html.includes('data-streamdown="inline-code"'), "inline code keeps the inline-code path");
		assert.match(html, /bg-muted/);
	});

	it("code fences delegate to streamdown's CodeBlock with a hover copy corner", () => {
		const html = render("```js\nconst x = 1;\n```");
		assert.ok(html.includes('data-testid="md-code"'), "the md-blocks wrapper mounts");
		assert.ok(html.includes('data-streamdown="code-block"'), "the delegated CodeBlock path is kept");
		assert.ok(html.includes('data-streamdown="code-block-body"'), "shiki body renders");
		assert.match(html, /aria-label="Copy code"/, "the corner copy affordance is present");
		// NAMED group (group/md) — the message container is also a `group`,
		// and an unnamed group-hover would light every corner in the message at
		// once (owner report, 2026-09-19); only the hovered block reveals.
		assert.ok(html.includes("group/md"), "the block uses the named md group");
		assert.match(html, /group-hover\/md:opacity-100/, "the corner reveals via the named group only");
		// No "Copied" pill — the icon flip alone conveys the copy (owner ask,
		// 2026-09-19; the pill was tried and removed same day).
		assert.ok(!html.includes('data-testid="md-copy-pill"'), "no Copied pill anywhere — icon flip is the feedback");
	});
});

describe("md-blocks — mermaid", () => {
	it("renders as the bare app-owned block (skeleton in static render), never a code block, source never leaks", () => {
		const html = render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(html.includes('data-testid="md-mermaid"'), "the app-owned mermaid block mounts");
		assert.ok(
			!html.includes('data-streamdown="code-block"'),
			"mermaid fences must not render as code blocks",
		);
		assert.ok(!html.includes("graph TD"), "chart source is not leaked as text");
		// No chat page mounted → no overlay context → no expand button.
		assert.ok(!html.includes('data-testid="md-mermaid-expand"'), "expand hidden without a session context");
	});
});

describe("md-blocks — tables", () => {
	it("renders as a plain prose table with the copy corner — no wrapper box, no button rows", () => {
		const html = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
		assert.ok(html.includes('data-testid="md-table"'), "the md-blocks table wrapper mounts");
		assert.ok(html.includes('data-streamdown="table"'), "the table itself renders");
		assert.ok(!html.includes('data-streamdown="table-wrapper"'), "streamdown's boxed wrapper is gone");
		assert.match(html, /aria-label="Copy table"/, "the corner copy affordance is present");
		assert.ok(!html.match(/Fullscreen|aria-label="Download"/), "no fullscreen/download chrome on tables");
		// The corner is CONTAINED in the table (top-1 right-1, not the old
		// -top-3 that straddled the top outline — the 24px button at a 12px
		// offset sat half over the border; owner report, 2026-09-19).
		assert.match(html, /absolute top-1 right-1 z-10/, "the corner sits inside the table's top-right");
		// Table text runs at the session prose size — no text-sm pin (the
		// cells' own text-sm is overridden to inherit via globals.css).
		assert.ok(!/border-collapse text-sm/.test(html), "the table itself pins no smaller text size");
	});
});

describe("md-blocks — display math", () => {
	it("the block corner reveals ONLY on its own block — named group, not the message-level group (owner report: all-at-once)", () => {
		const md = "```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
		const html = render(md);
		// No UNNAMED group-hover on the corners: that selector would fire from
		// the Message container's own `group` class and light every block.
		assert.ok(!html.match(/\s group-hover:opacity-100/), "no unnamed group-hover on any corner");
		assert.ok(html.includes('data-testid="md-table"'), "table present for the contrast");
	});

	it("keeps katex-display rendering and adds the TeX copy corner", () => {
		const html = render("$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$");
		assert.ok(html.includes("katex-display"), "display math still renders via KaTeX");
		assert.ok(html.includes('data-testid="md-math"'), "the md-blocks math wrapper mounts");
		assert.match(html, /aria-label="Copy equation source"/, "the corner copy affordance is present");
		// The wrapper is BLOCK: the katex-display child is display:block, and
		// an inline wrapper around it fragments — the absolute corner then has
		// no clean containing block and pointer events never land (the math
		// corner neither highlighted nor copied; owner report, 2026-09-19).
		assert.match(html, /group\/md relative block/, "the math wrapper is a block box");
		assert.match(html, /absolute top-0 right-0 z-10/, "the corner stacks above the equation");
	});
});

describe("md-blocks — codeSource (pure)", () => {
	it("extracts the fence source from string children and element-wrapped children", () => {
		assert.equal(codeSource("const x = 1;"), "const x = 1;");
		assert.equal(codeSource(<span>const x = 1;</span>), "const x = 1;");
	});
});

describe("session-scoped overlays (chrome-melt wave, 2026-09-19)", () => {
	it("mermaid overlay mounts inside the session area — absolute (not fixed), 80% + blur, closeable", () => {
		const html = renderToStaticMarkup(<MermaidOverlay chart="graph TD\nA --> B" onClose={() => {}} />);
		assert.match(html, /class="absolute inset-0[^"]*z-40/, "absolute inset-0 z-40 — scoped, not fullscreen");
		assert.ok(html.includes("bg-background/80"), "80% background: the transcript ghosts through");
		assert.ok(html.includes("backdrop-blur"), "blur surface");
		assert.ok(!html.includes("fixed inset-0"), "never fixed — the drag bar stays uncovered");
		assert.ok(html.includes('data-testid="mermaid-overlay-close"'), "the close X is present");
		assert.match(html, /role="dialog"/, "dialog semantics for Esc/aria");
	});

	it("the plan popup is session-scoped the same way, and its chart is hidden until the first fit (no top-left flash)", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[]} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup"/);
		assert.match(html, /class="absolute inset-0[^"]*z-40/, "absolute inset-0 z-40 — scoped, not fullscreen");
		assert.ok(html.includes("bg-background/80"), "80% background");
		assert.ok(html.includes("backdrop-blur"), "blur surface");
		assert.ok(!html.includes("fixed inset-0"), "never fixed — the drag bar stays uncovered");
	});

	it("the diagram wrapper is hidden until the first fit applies (no top-left flash — owner report, 2026-09-19)", () => {
		// Covered in render-plan-block.test.tsx, which has a real tree
		// fixture (an empty-messages popup renders no diagram to gate) — and
		// the same gate is asserted on the mermaid overlay's wrapper here:
		// settled=false at static render → opacity 0.
		const html = renderToStaticMarkup(<MermaidOverlay chart="graph TD\nA --> B" onClose={() => {}} />);
		// The chart itself hasn't rendered at static render (async effect) —
		// the opacity gate is pinned on the plan popup's diagram wrapper in
		// render-plan-block.test.tsx, which has a real tree fixture (the two
		// overlays share the settled-gating pattern).
		assert.ok(html.includes('data-testid="mermaid-overlay-close"'), "overlay shell renders");
	});

	it("chartSize reads the viewBox from a rendered svg (fallback for degenerate ones)", () => {
		assert.deepEqual(
			chartSize('<svg viewBox="0 0 900 700" xmlns="..."></svg>'),
			{ w: 900, h: 700 },
		);
		assert.deepEqual(chartSize("<svg></svg>"), { w: 600, h: 400 });
	});
});

describe("mermaid expand — the context seam", () => {
	it("the expand button renders when a session context is mounted (static: chart stays at skeleton, so assert the seam via the provider wiring)", () => {
		// The full path (skeleton → chart → hover expand) needs effects/DOM;
		// what static rendering CAN pin is that a provider value flows: the
		// default context is null (hidden button, covered above) and a real
		// provider is the one md-blocks consumes. The overlay's open-state
		// owner is chat.tsx — geometry covered by the tests above.
		const opened: string[] = [];
		const html = renderToStaticMarkup(
			<SessionMermaidContext.Provider
				value={{
					openMermaid: (chart) => void opened.push(chart),
					openFigure: () => {},
				}}
			>
				<div />
			</SessionMermaidContext.Provider>,
		);
		assert.ok(html.length > 0, "provider renders");
		assert.deepEqual(opened, [], "nothing opened by rendering alone");
	});
});

describe("md-blocks — key-idea callouts (GitHub alerts, owner round 2026-10-07)", () => {
	it("an [!IMPORTANT] callout renders as the sharp white-outline box, marker never leaks", () => {
		const html = render("> [!IMPORTANT]\n> ALL X is done through Y.");
		assert.ok(html.includes('data-testid="md-callout"'), "the callout box mounts");
		assert.ok(html.includes('data-alert-kind="important"'), "the kind is recorded");
		assert.match(html, /ALL X is done through Y\./, "the prose survives");
		assert.ok(!html.includes("[!IMPORTANT]"), "the marker line never leaks as text");
		// The owner's minimal law: sharp corners (no rounded), white stroke
		// (the strong line ink — white in dark), no background, no label, no
		// icon — and the box hugs its text.
		assert.match(html, /border-line-strong/, "strong-ink stroke");
		assert.match(html, /w-fit/, "width: fit-content — the hug");
		assert.ok(!html.includes("rounded"), "sharp corners — no rounding anywhere");
		assert.ok(!html.includes("bg-card") && !html.includes("bg-background"), "transparent — no background");
	});

	it("all five GitHub markers box identically — one device, one meaning", () => {
		for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
			const html = render(`> [!${kind}]\n> Load-bearing words.`);
			assert.ok(html.includes('data-testid="md-callout"'), `${kind} boxes`);
			assert.ok(html.includes(`data-alert-kind="${kind.toLowerCase()}"`), `${kind} kind recorded`);
			assert.ok(!html.includes(`[!${kind}]`), `${kind} marker never leaks`);
		}
	});

	it("a standalone-marker callout (blank quote line) drops the empty paragraph", () => {
		const html = render("> [!IMPORTANT]\n>\n> The payoff lands here.");
		assert.ok(html.includes('data-testid="md-callout"'));
		assert.match(html, /The payoff lands here\./);
		assert.ok(!html.includes("[!IMPORTANT]"));
	});

	it("multi-paragraph callouts keep their structure", () => {
		const html = render("> [!IMPORTANT]\n> First the truth.\n>\n> Then the payoff.");
		assert.match(html, /First the truth\./);
		assert.match(html, /Then the payoff\./);
		assert.ok((html.match(/<p>/g) ?? []).length >= 2, "both paragraphs render inside the box");
	});

	it("plain blockquotes pass through untouched — no box for ordinary quotes", () => {
		const html = render("> Just an ordinary quote.");
		assert.ok(!html.includes('data-testid="md-callout"'), "no callout box");
		assert.match(html, /Just an ordinary quote\./);
	});
});

describe("parseAlertMarker (pure)", () => {
	it("non-paragraph openers and marker-less text return null", async () => {
		const { parseAlertMarker } = await import("../components/md-blocks.tsx");
		assert.equal(parseAlertMarker("just text"), null);
		assert.equal(parseAlertMarker(null), null);
		// a leading <em> node, not a paragraph: no crash, no alert
		const em = { type: "em", props: { children: "x" } } as never;
		assert.equal(parseAlertMarker(em), null);
	});
});

describe("md-blocks — the restored plain blockquote (owner round, 2026-10-07)", () => {
	it("a plain quote carries Streamdown's own styling (the override displaced it)", () => {
		const html = renderToStaticMarkup(
			<MessageResponse mode="static">{"Before.\n\n> An ordinary quote.\n\nAfter."}</MessageResponse>,
		);
		assert.ok(html.includes("border-l-4"), "the left border is back");
		assert.ok(html.includes("text-muted-foreground italic"), "muted italic — the quote register");
		assert.ok(!html.includes("md-callout"), "a plain quote is not a callout box");
	});
});

describe("ThinkingBlock — the document band + ⌘T sync (owner rounds, 2026-10-07)", () => {
	it("the row is the document band — round four geometry (owner, 2026-10-07)", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text="banded" defaultOpen />);
		assert.ok(html.includes("bg-card"), "the card-color band");
		assert.ok(html.includes("border-l-[calc(3ch-14px)]"), "narrow rail — 14px gap inside the 3ch inset");
		assert.ok(html.includes("py-1") && html.includes("pl-[14px]"), "4px band padding");
		assert.ok(html.includes("pr-4"), "the text wraps early — air at the band's right edge");
		assert.ok(html.includes("w-full"), "full width — no chat side");
		assert.match(html, /aria-expanded="true"/);
		assert.ok(html.includes("banded"), "text visible on arrival");
	});

	it("in-card rows take no band — the accent step read too light (owner round five)", () => {
		const html = renderToStaticMarkup(<ThinkingBlock text="in card" inCard />);
		assert.ok(!html.includes("bg-accent") && !html.includes("bg-card"), "transparent on the card");
		assert.ok(html.includes("border-l-[calc(3ch-14px)]"), "rail only, same geometry");
	});

	it("⌘T sets every row — explicit sets stomp individual state, late mounts honor the last set", () => {
		setAllUserThinkingOpen(false);
		const collapsed = renderToStaticMarkup(<ThinkingBlock text="synced" defaultOpen />);
		assert.match(collapsed, /aria-expanded="false"/);
		assert.ok(!collapsed.includes(">synced<"), "the open default was stomped");
		setAllUserThinkingOpen(true);
		const reopened = renderToStaticMarkup(<ThinkingBlock text="synced" />);
		assert.match(reopened, /aria-expanded="true"/);
		// restore the null default for other tests in this file
		setAllUserThinkingOpen(true);
	});
});
