/**
 * Composer render tests — the chat input row (content only; the persistent
 * rounded shell lives in the chat view's overlay so it can morph into the
 * question dock without remounting).
 *
 * Same tsx classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatSessionComposer, Composer, enterAction } from "../components/composer.tsx";

function render(
	opts: { busy?: boolean; canSend?: boolean; placeholder?: string; nextProblem?: boolean } = {},
) {
	return renderToStaticMarkup(
		<Composer
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
			{...(opts.placeholder ? { placeholder: opts.placeholder } : {})}
			{...(opts.nextProblem ? { nextProblem: true, onNext: () => {} } : {})}
		/>,
	);
}

describe("Composer", () => {
	it("chat placeholder + send button", () => {
		const html = render();
		assert.match(html, /Ask, answer, or steer the lesson/, "the default — active sessions");
		assert.ok(html.includes('aria-label="Send"'), "send button present");
	});

	it("placeholder is overridable — the new-session page asks the graph view's question", () => {
		const html = render({ placeholder: "What do you want to learn?" });
		assert.match(html, /What do you want to learn\?/);
		assert.ok(!html.includes("Ask, answer"), "the session placeholder must not ride along");
	});

	it("busy with text: the button STAYS Send (click = steer); busy and empty: it becomes Stop", () => {
		const steering = render({ busy: true, canSend: true });
		assert.ok(steering.includes('aria-label="Send"'), "the steer affordance is clickable mid-turn");
		assert.ok(!steering.includes('aria-label="Stop"'), "no morph while there is text to steer with");
		const idleStop = render({ busy: true, canSend: false });
		assert.ok(idleStop.includes('aria-label="Stop"'), "empty composer: stop replaces send while streaming");
	});

	it("send button radius is 10px = 25% of the 40px button (concentric with the shell)", () => {
		const html = render();
		assert.ok(html.includes("rounded-[10px]"), "send radius = shell radius − row padding");
		assert.ok(html.includes("size-10"), "40px send button (10px = 25%)");
	});

	it("disabled when nothing to send", () => {
		const html = render({ canSend: false });
		assert.ok(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/.test(html), "send disabled");
	});

	it("THE NEXT MORPH (owner round 16 refinement): empty composer in the pause → wide green Next problem", () => {
		const html = render({ canSend: false, nextProblem: true });
		assert.ok(html.includes('data-testid="next-problem-button"'), "the morphed button");
		assert.match(html, /Next problem/, "the label");
		assert.ok(html.includes("bg-green-600"), "green — the correct-answer register");
		assert.ok(!html.includes('aria-label="Send"'), "the square send is gone in the pause");
	});

	it("typing anything returns the regular send button (canSend outranks the morph)", () => {
		const html = render({ canSend: true, nextProblem: true });
		assert.ok(html.includes('aria-label="Send"'), "regular send while there is text");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph with text typed");
	});

	it("busy outranks the morph — stop stays reachable", () => {
		const html = render({ busy: true, canSend: false, nextProblem: true });
		assert.ok(html.includes('aria-label="Stop"'), "stop wins the empty lane mid-turn");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph mid-turn");
	});
});

// The Enter decision (composer steering, 2026-10-03): while a turn runs,
// typed text makes Enter a STEER; Enter with an empty composer stays the
// stop shortcut. (The plan-verdict accept branch died 2026-09-26 with the
// verdict itself — the post-plan reply is a natural text message.) Pure
// function so the static-render harness can pin it (key events can't be
// simulated in renderToStaticMarkup).
describe("enterAction", () => {
	it("busy stream with text: Enter steers (the queued send)", () => {
		assert.equal(enterAction({ busy: true, canSend: true }), "send");
	});

	it("busy stream, empty composer: Enter stops", () => {
		assert.equal(enterAction({ busy: true, canSend: false }), "stop");
	});

	it("idle: send when there is the text, nothing when there is not", () => {
		assert.equal(enterAction({ busy: false, canSend: true }), "send");
		assert.equal(enterAction({ busy: false, canSend: false }), "none");
	});

	it("the practice pause (owner round 16): Enter on an EMPTY composer fires the move-on signal", () => {
		assert.equal(enterAction({ busy: false, canSend: false, nextProblem: true }), "next");
	});

	it("typing anything outranks the pause — text makes Enter a send again", () => {
		assert.equal(enterAction({ busy: false, canSend: true, nextProblem: true }), "send");
	});

	it("busy outranks the pause — steering and Stop keep their lanes", () => {
		assert.equal(enterAction({ busy: true, canSend: false, nextProblem: true }), "stop");
		assert.equal(enterAction({ busy: true, canSend: true, nextProblem: true }), "send");
	});
});


describe("ChatSessionComposer attachments", () => {
	it("enables sending an attachment without text and forwards the picker", () => {
		const html = renderToStaticMarkup(<ChatSessionComposer busy={false} value="" revision={0} onChange={() => {}} onSend={() => {}} onStop={() => {}} sendAllowed dictationActive={false} hasAttachments attachmentControl={<span>Attach file</span>} />);
		assert.match(html, /Attach file/);
		assert.match(html, /aria-label="Send"/);
		assert.doesNotMatch(html, /aria-label="Send"[^>]*\\sdisabled(?:=|\\s|>)/);
	});
});
