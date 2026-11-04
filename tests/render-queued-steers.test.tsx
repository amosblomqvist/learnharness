/**
 * The queued-steer indicator's pins (composer steering, owner arc
 * 2026-10-03): the quiet one-liners above the composer shell, and the
 * visibleQueuedSteers fold that decides which queued steers still show.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedSteerEditor, QueuedSteersBody, steerEditKey } from "../components/queued-steers.tsx";
import { visibleQueuedSteers } from "../components/session-core.ts";

describe("QueuedSteersBody (the quiet queue above the composer)", () => {
	it("renders one truncated right-aligned line per queued steer — no background, no container chrome", () => {
		const html = renderToStaticMarkup(
			<QueuedSteersBody
				steers={[
					{ id: "steer_a", text: "also cover Venus while you are at it, please and thank you" },
					{ id: "steer_b", text: "short one" },
				]}
			/>,
		);
		assert.match(html, /data-testid="queued-steers"/);
		assert.equal(html.match(/<span/g)?.length, 2, "one span per steer");
		assert.match(html, /truncate/, "single-line truncation with ellipsis");
		assert.match(html, /items-end/, "right-aligned stack");
		assert.match(html, /max-w-\[240px\]/, "fixed-width stash");
		assert.match(html, /muted-foreground\/60/, "quiet, roughly half opacity");
		assert.doesNotMatch(html, /bg-|border|rounded/, "no background, no container");
		assert.match(html, /also cover Venus/, "the text rides the line");
	});

	it("empty queue renders nothing", () => {
		assert.equal(renderToStaticMarkup(<QueuedSteersBody steers={[]} />), "");
	});
});

describe("visibleQueuedSteers (the fold: a line dies when its card lands)", () => {
	it("a queued steer stays visible until its id lands in the messages", () => {
		const queue = [
			{ id: "steer_a", text: "a" },
			{ id: "steer_b", text: "b" },
		];
		const before = visibleQueuedSteers(queue, [{ id: "msg_1" } as never]);
		assert.equal(before.length, 2, "nothing landed yet — both lines show");
		const after = visibleQueuedSteers(queue, [
			{ id: "msg_1" } as never,
			{ id: "steer_a", role: "user", content: "a" } as never,
		]);
		assert.deepEqual(after.map((s) => s.id), ["steer_b"], "the drained steer's line dropped");
	});
});

describe("QueuedSteersBody with onEdit (click a queued line to edit it — issue #321)", () => {
	const steers = [{ id: "steer_a", text: "also cover Venus" }];

	it("without onEdit the lines stay read-only spans, exactly as before", () => {
		const html = renderToStaticMarkup(<QueuedSteersBody steers={steers} />);
		assert.doesNotMatch(html, /<button/);
	});

	it("with onEdit each line is a button that keeps the quiet look", () => {
		const html = renderToStaticMarkup(<QueuedSteersBody steers={steers} onEdit={() => {}} />);
		assert.match(html, /<button[^>]*type="button"/);
		assert.match(html, /aria-label="Edit queued message"/);
		assert.match(html, /truncate/);
		assert.match(html, /muted-foreground\/60/);
		assert.doesNotMatch(html, /bg-|border|rounded/, "still no chrome in the resting state");
		assert.match(html, /also cover Venus/);
	});
});

describe("QueuedSteerEditor (the inline field)", () => {
	it("renders a single-line input seeded with the queued text", () => {
		const html = renderToStaticMarkup(<QueuedSteerEditor initial="also cover Venus" onSave={() => {}} onCancel={() => {}} />);
		assert.match(html, /<input/);
		assert.match(html, /value="also cover Venus"/);
		assert.match(html, /aria-label="Edit queued message"/);
	});
});

describe("steerEditKey (which keys save or cancel an edit)", () => {
	it("Enter saves, Escape cancels, anything else types", () => {
		assert.equal(steerEditKey({ key: "Enter" }), "save");
		assert.equal(steerEditKey({ key: "Escape" }), "cancel");
		assert.equal(steerEditKey({ key: "a" }), null);
	});

	it("Enter while an IME composition is open is not a save", () => {
		assert.equal(steerEditKey({ key: "Enter", isComposing: true }), null);
	});
});
