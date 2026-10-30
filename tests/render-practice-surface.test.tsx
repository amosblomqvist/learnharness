/**
 * THE PRACTICE SURFACE — SSR render pins (the render-suite discipline:
 * pure bodies, renderToStaticMarkup, testids). The dock (the active
 * problem replaces the composer: statement above, "Your thinking"
 * field below with ONE Send (Enter sends, Shift+Enter is a newline)),
 * the transcript cards (the
 * problem's compact-expandable statement — commitment NEVER renders;
 * the conclusion's outcome + verdict + reveal; the learner's thinking
 * register cards), and the view projection (the thinking marker's
 * data part; the dismissal's silence).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";

import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard, ProblemCard, ThinkingCard } from "../components/practice-cards.tsx";
import { GraphContextCard } from "../components/graph-context-card.tsx";
import { newGraphContextMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { ArtifactPartProps } from "../src/core";
import {
	newThinkingMessage,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";

const part = (over: Partial<ArtifactPartProps["part"]>): ArtifactPartProps["part"] => ({
	type: "tool-problem",
	state: "input-available",
	toolCallId: "call_p1",
	...over,
});

// ── the dock ─────────────────────────────────────────────────────────────────

describe("PracticeDock", () => {
	it("expanded: statement renders, the two lanes sit in the thinking field", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "Show that the sum is even." }}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /Show that the sum is even\./);
		// The 'Problem' eyebrow (owner round, 2026-10-05): the quiz cards'
		// label row, mirrored — dock and transcript card read identically.
		assert.match(html, /Problem/);
		// The measured column cap (the old fixed 40vh is only the fallback).
		assert.match(html, /--dock-max-h/);
		assert.match(html, /YOUR THINKING/);
		assert.match(html, /data-testid="practice-send"/);
		assert.ok(!html.includes("practice-nudge") && !html.includes("practice-commit"), "the two-lane buttons are gone");
		// The buttons carry their lane in the disabled gate; both start
		// disabled (empty field).
		assert.match(html, /disabled/);
	});

	it("collapsed: the slim bar carries the statement excerpt", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "Show that the sum is even." }}
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /data-testid="practice-dock-bar"/);
		assert.match(html, /Show that the sum is even\./);
	});

	it("collapsed: a missing statement leaves the excerpt empty", () => {
		for (const statement of [undefined, null]) {
			const html = renderToStaticMarkup(
				<PracticeDock
					problemCallId="call_p1"
					input={{ statement } as never}
					expanded={false}
					onExpand={() => {}}
					onSubmit={() => {}}
				/>,
			);
			assert.match(html, /<span class="min-w-0 flex-1 truncate"><\/span>/, String(statement));
			assert.doesNotMatch(html, /undefined|null/, String(statement));
		}
	});

	it("collapsed: an Arabic statement reads right-to-left on one line", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "أثبت أن المجموع زوجي.\nثم عمم النتيجة." }}
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /<span class="min-w-0 flex-1 truncate" dir="rtl">أثبت أن المجموع زوجي\. ثم عمم النتيجة\.<\/span>/);
	});
});

// ── the transcript cards ─────────────────────────────────────────────────────

describe("the practice transcript cards", () => {
	it("ProblemCard: ALWAYS OPEN, the 'Problem' eyebrow + the statement — the commitment NEVER renders", () => {
		const html = renderToStaticMarkup(
			<ProblemCard
				part={part({
					input: {
						statement: "Prove the parity claim.",
						mode: "recall",
						modelSolution: "Pair them.",
					},
				})}
			/>,
		);
		assert.match(html, /data-testid="problem-card"/);
		assert.match(html, /Problem/);
		assert.match(html, /Prove the parity claim\./);
		assert.doesNotMatch(html, /Pair them\./, "the commitment stays hidden");
		// No chevron, no collapsed bar (owner round, 2026-10-05).
		assert.doesNotMatch(html, /lucide-chevron|<button/, "nothing collapsible");
	});

	it("ConcludeCard: the SOLUTION is the hero (the pose's modelSolution via part.reveal); the verdict rides below, low-key", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solvedWithHints", verdict: "The pairing came after R2." },
					reveal: "Pair them; each pair is even.",
				})}
			/>,
		);
		assert.match(html, /data-testid="conclude-card"/);
		assert.match(html, /Solved with hints/);
		assert.match(html, /Pair them; each pair is even\./, "the committed solution, verbatim");
		assert.match(html, /Concluded/); // the plain eyebrow (owner round 3)
		assert.match(html, /Solved/); // the outcome rides the quiz chip
		assert.match(html, /Model solution/); // the labeled hero after the divider
		assert.ok(html.indexOf("Solved") < html.indexOf("Model solution"), "chip at the top");
		assert.match(html, /The pairing came after R2\./);
		// VERDICT FIRST (owner round 3): verdict under the heading row, then
		// the divider, then the labeled model solution.
		assert.ok(html.indexOf("The pairing came after R2.") < html.indexOf("Pair them; each pair is even."));
		assert.doesNotMatch(html, /<button/, "nothing collapsible");
	});

	it("ConcludeCard: legacy records fall back to their own solutionReveal", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solved", verdict: "Clean.", solutionReveal: "Pair them; each pair is even." },
				})}
			/>,
		);
		assert.match(html, /Pair them; each pair is even\./);
	});

	it("ConcludeCard: THE METADATA POPOVER (owner round 17 refinement) — quiet trigger at the bottom, box hidden until clicked", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={part({
					type: "tool-conclude",
					input: { outcome: "solvedWithHints", verdict: "v", rung: "R2", missClass: "cue", retest: true },
					problemInput: { mode: "discrimination", target: ["n_abc"] },
					reveal: "The solution.",
				})}
			/>,
		);
		assert.ok(html.includes('data-testid="metadata-toggle"'), "the trigger row");
		assert.match(html, /Metadata/, "the label (CSS renders it mono-caps)");
		assert.ok(!html.includes('data-testid="metadata-box"'), "the info box is CLOSED until clicked — no rows in the markup");
		assert.ok(!html.includes("border-t \"/>"), "no separate divider — the trigger just sits at the bottom");
		// The open face (info-box rows at the model solution's 15px) is a
		// client useState fold — static render cannot click; the rows' data
		// shape is pinned by the view-join test in practice-record.
	});

	it("ConcludeCard: no metadata trigger when the calls filled nothing beyond the visible card", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "dismissed" } })} />,
		);
		assert.ok(!html.includes("metadata-"), "the dismissal line carries no trigger");
		const legacy = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "solved" }, reveal: "s" })} />,
		);
		assert.ok(!legacy.includes("metadata-"), "empty problemInput + bare outcome: nothing to reveal");
	});

	it("ConcludeCard: the dismissal synthesis is one muted line — no reveal card", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "dismissed" } })} />,
		);
		assert.match(html, /Problem dismissed\./);
		assert.doesNotMatch(html, /The solution/);
	});

	it("ThinkingCard: one label, right side, expanded arrival (owner round, 2026-10-07)", () => {
		const trace = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "c", commit: false, text: "stuck at step two" }} />);
		assert.match(trace, /YOUR THINKING/);
		// Transcript rows arrive EXPANDED (clearly conveyed as sent) as
		// full-width card-color bands with the 6px rail (the document,
		// all-in — owner round two, 2026-10-07).
		assert.match(trace, /aria-expanded="true"/);
		assert.ok(trace.includes("stuck at step two"), "the text is visible on arrival");
		assert.ok(trace.includes("bg-card"), "the card-color band");
		assert.ok(trace.includes("border-l-[calc(3ch-14px)]"), "narrow rail inside the 3ch inset");
		const legacy = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "c", commit: true, text: "It is 42." }} />);
		assert.match(legacy, /YOUR THINKING/);
		assert.doesNotMatch(legacy, /Your solution/);
	});
});

// ── the view projection ──────────────────────────────────────────────────────

describe("the practice view projection", () => {
	it("the thinking marker projects as a user-side data part (register in details)", () => {
		const marker = newThinkingMessage("call_p1", "It is 42.");
		const view = projectView([marker as LhMessage]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const dataPart = view[0]!.parts[0]!;
		assert.equal(dataPart.type, "data-practice-thinking");
		assert.deepEqual(dataPart.data, { problemCallId: "call_p1", text: "It is 42." });
	});

	it("the problem pose's ack keeps the part input-available (the dock's mount)", () => {
		// Pose call + ack result (details: null — the placeholder fork).
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "S." } }],
			},
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call_p1",
				toolName: PRACTICE_PROBLEM_TOOL,
				content: [{ type: "text", text: "Problem posed" }],
				details: null,
				isError: false,
			},
		] as unknown as LhMessage[];
		const view = projectView(messages);
		const toolPart = view[0]!.parts.find((p) => p.type === `tool-${PRACTICE_PROBLEM_TOOL}`)!;
		assert.equal(toolPart.state, "input-available");
	});
});

// ── the graph-context card (a session's map pick; collapsed by default) ─────

describe("GraphContextCard", () => {
	it("collapsed: counts only — the statements stay hidden until expanded", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard data={{ propositions: [
				{ id: "n1", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
				{ id: "n2", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
			], chains: ["Modus ponens → Soundness"] }} />,
		);
		assert.ok(html.includes('data-testid="graph-context-card"'));
		assert.ok(html.includes("2 propositions"));
		assert.ok(html.includes("1 chain"));
		// minimal: the collapsed bar carries NO statement text
		assert.ok(!html.includes("If P implies Q"));
		assert.ok(!html.includes("graph-context-body"));
	});

	it("zero chains: the chain count stays out of the summary", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard data={{ propositions: [{ id: "n1", name: "A", statement: "S." }], chains: [] }} />,
		);
		assert.ok(html.includes("1 proposition</span>"));
		assert.ok(!html.includes("chain"));
	});

	it("the marker projects to the card's part (projectView fold)", () => {
		const view = projectView([newGraphContextMessage(
			[{ id: "n1", name: "A", statement: "S." }], [],
		) as unknown as LhMessage]);
		assert.equal((view[0]!.parts[0] as { type: string }).type, "data-graph-context");
	});
});
