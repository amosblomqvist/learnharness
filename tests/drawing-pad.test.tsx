import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DrawingAttachment, DrawingStroke } from "../src/core/drawings.ts";
import { newThinkingMessage, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import {
	BASE_WIDTH,
	EXPORT_MARGIN,
	EXPORT_MAX_SIDE,
	commit,
	LOWER_BUTTON,
	UPPER_BUTTON,
	backfillStartPressure,
	contactEnds,
	contactMode,
	contactStarts,
	continuesGesture,
	endsGesture,
	handleAt,
	insideBox,
	lassoSelects,
	pointInPolygon,
	resizeFactor,
	scaleStrokes,
	selectionBox,
	translateStrokes,
	exportGeometry,
	historyOf,
	inkBounds,
	redo,
	strokeHit,
	undo,
	widthAt,
} from "../components/drawing/strokes.ts";
import { localIngest, rememberLocalDrawing } from "../components/drawing/pad-state.ts";
import type { DrawingAttachmentsApi } from "../components/drawing/drawing-attachments.tsx";
import { Composer } from "../components/composer.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ThinkingCard } from "../components/practice-cards.tsx";
import { absorbed } from "../components/session-core.ts";

/**
 * THE DRAWING PAD (2026-11-04): the stroke model, the attachment chips
 * on all four surfaces, transcript thumbnails, and the optimistic copy's
 * absorption into the record.
 */

const line = (x0: number, y0: number, x1: number, y1: number, p = 0.5): DrawingStroke => ({
	ink: "ink",
	points: [{ x: x0, y: y0, p }, { x: x1, y: y1, p }],
});

const attachment = (id: string): DrawingAttachment => ({ id, strokes: [line(0, 0, 10, 10)], png: `PNG${id}`, width: 40, height: 30 });

function api(drawings: DrawingAttachment[]): DrawingAttachmentsApi {
	return {
		drawings,
		ref: { current: drawings },
		editing: null,
		openNew: () => {},
		openExisting: () => {},
		finish: () => {},
		remove: () => {},
		clear: () => {},
		replace: () => {},
	};
}

describe("stroke model", () => {
	it("pressure shapes the width; a mouse's 0.5 is exactly the base", () => {
		assert.equal(widthAt(0.5), BASE_WIDTH);
		assert.ok(widthAt(0.1) < widthAt(0.5) && widthAt(0.5) < widthAt(1));
		assert.equal(widthAt(7), widthAt(1), "clamped");
		assert.equal(widthAt(Number.NaN), BASE_WIDTH);
	});

	it("the whole-stroke eraser hits a stroke anywhere along it, not beside it", () => {
		const s = line(0, 0, 100, 0);
		assert.ok(strokeHit(s, 50, 5));
		assert.ok(!strokeHit(s, 50, 30));
		assert.ok(strokeHit({ ink: "red", points: [{ x: 20, y: 20, p: 0.5 }] }, 25, 25), "a dot is hittable");
	});

	it("ink bounds include line widths; a blank page has none", () => {
		assert.equal(inkBounds([]), null);
		const b = inkBounds([line(10, 20, 110, 70)])!;
		assert.ok(b.minX < 10 && b.maxX > 110 && b.minY < 20 && b.maxY > 70);
	});

	it("the export crops to the ink plus a margin, capped at the longest side", () => {
		const g = exportGeometry({ minX: 100, minY: 100, maxX: 200, maxY: 150 }, 2);
		assert.equal(g.originX, 100 - EXPORT_MARGIN);
		assert.equal(g.width, (100 + EXPORT_MARGIN * 2) * 2);
		const huge = exportGeometry({ minX: 0, minY: 0, maxX: 5000, maxY: 100 }, 2);
		assert.ok(huge.width <= EXPORT_MAX_SIDE, "never past the cap");
	});

	it("a split pen continues the gesture: mouse press (id 1), pen contact motion (id 3)", () => {
		// The owner's XWayland Wacom trace, 2026-11-04.
		assert.ok(continuesGesture(1, { pointerId: 3, pointerType: "pen", buttons: 1 }), "pen contact motion under another id");
		assert.ok(continuesGesture(1, { pointerId: 1, pointerType: "mouse", buttons: 1 }), "its own pointer");
		assert.ok(continuesGesture(1, { pointerId: 4, pointerType: "pen", buttons: 32 }), "the eraser end in contact");
		assert.ok(!continuesGesture(1, { pointerId: 2, pointerType: "pen", buttons: 0 }), "a hovering pen is not contact");
		assert.ok(!continuesGesture(1, { pointerId: 9, pointerType: "touch", buttons: 1 }), "a resting palm never joins");
		assert.ok(endsGesture(1, { pointerId: 3, pointerType: "pen" }), "either half of the split pen can release");
		assert.ok(!endsGesture(1, { pointerId: 9, pointerType: "touch" }));
	});

	it("a pen's zero-pressure contact takes its first real pressure", () => {
		// OTD Artist Mode via XWayland: pointerdown at 0, motion at 0.03 (light).
		const points = [{ x: 0, y: 0, p: 0.5 }, { x: 1, y: 1, p: 0.03 }];
		backfillStartPressure(points, 0.03);
		assert.deepEqual(points.map((p) => p.p), [0.03, 0.03], "no mid-pressure blob at a light stroke's start");
	});

	it("undo/redo walk snapshot history; a new commit clears redo", () => {
		let h = historyOf([]);
		h = commit(h, [line(0, 0, 1, 1)]);
		h = commit(h, [...h.present, line(2, 2, 3, 3)]);
		assert.equal(h.present.length, 2);
		h = undo(h);
		assert.equal(h.present.length, 1);
		h = redo(h);
		assert.equal(h.present.length, 2);
		h = undo(h);
		h = commit(h, []);
		assert.equal(h.future.length, 0, "a fresh edit drops the redo branch");
		assert.equal(undo(historyOf([])).present.length, 0, "undo on an empty history is a no-op");
	});
});

describe("pen side buttons (the owner's tablet, 2026-11-04)", () => {
	it("lower button held erases, upper held selects, eraser end erases — pens only", () => {
		const pen = (buttons: number) => ({ pointerType: "pen", buttons });
		assert.equal(contactMode(pen(1 | LOWER_BUTTON), "pen"), "erase", "lower (middle) + tip");
		assert.equal(contactMode(pen(1 | UPPER_BUTTON), "pen"), "select", "upper (barrel) + tip");
		assert.equal(contactMode(pen(32), "pen"), "erase", "eraser end");
		assert.equal(contactMode(pen(1), "pen"), "draw", "tip alone follows the toolbar");
		assert.equal(contactMode(pen(1), "eraser"), "erase");
		assert.equal(contactMode(pen(1), "select"), "select");
		assert.equal(contactMode(pen(1 | UPPER_BUTTON), "eraser"), "select", "a held button beats the toolbar");
		const mouse = (buttons: number) => ({ pointerType: "mouse", buttons });
		assert.equal(contactMode(mouse(1 | LOWER_BUTTON), "pen"), "draw", "a mouse's middle button never erases");
		assert.equal(contactMode(mouse(1 | UPPER_BUTTON), "pen"), "draw", "a mouse's right button never selects");
	});

	it("contact follows the tip bit through a held button (the probe's 4 → 5 → 4)", () => {
		assert.ok(!contactStarts(0, LOWER_BUTTON), "pressing the side button while hovering is not contact");
		assert.ok(contactStarts(LOWER_BUTTON, LOWER_BUTTON | 1), "the tip touching under a held button is");
		assert.ok(!contactStarts(LOWER_BUTTON | 1, LOWER_BUTTON | 1), "continuing contact is not a new one");
		assert.ok(contactEnds(LOWER_BUTTON | 1, LOWER_BUTTON), "lifting the tip ends it while the button stays held");
		assert.ok(!contactEnds(LOWER_BUTTON, 0), "releasing the button after lifting ends nothing");
		assert.ok(contactStarts(0, 1), "a plain tip press");
		assert.ok(contactStarts(0, 32), "the eraser end touching");
	});
});

describe("lasso selection", () => {
	const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

	it("point in polygon", () => {
		assert.ok(pointInPolygon(50, 50, square));
		assert.ok(!pointInPolygon(150, 50, square));
		const concave = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 50, y: 40 }, { x: 0, y: 100 }];
		assert.ok(!pointInPolygon(50, 80, concave), "the notch of a concave loop is outside");
	});

	it("takes a stroke when at least half of it is inside the loop", () => {
		assert.ok(lassoSelects(line(10, 10, 90, 90), square), "fully inside");
		const half = { ink: "ink" as const, points: [{ x: 50, y: 50, p: 0.5 }, { x: 150, y: 50, p: 0.5 }] };
		assert.ok(lassoSelects(half, square), "half inside counts");
		const mostlyOut = { ink: "ink" as const, points: [{ x: 50, y: 50, p: 0.5 }, { x: 150, y: 50, p: 0.5 }, { x: 160, y: 50, p: 0.5 }] };
		assert.ok(!lassoSelects(mostlyOut, square));
		assert.ok(!lassoSelects(line(10, 10, 90, 90), square.slice(0, 2)), "a loop needs three points");
	});

	it("the box pads the ink; handles and inside hit-test against it", () => {
		const box = selectionBox([line(100, 100, 200, 150)])!;
		assert.ok(box.x < 100 && box.y < 100 && box.x + box.w > 200 && box.y + box.h > 150);
		assert.equal(handleAt(box, box.x + 2, box.y - 3), "nw");
		assert.equal(handleAt(box, box.x + box.w, box.y + box.h), "se");
		assert.equal(handleAt(box, box.x + box.w / 2, box.y + box.h / 2), null);
		assert.ok(insideBox(box, 150, 125));
		assert.ok(!insideBox(box, 300, 125));
		assert.equal(selectionBox([]), null);
	});

	it("move and resize transform positions only — pressure (line thickness) is kept", () => {
		const s = line(10, 10, 20, 30, 0.8);
		const [moved] = translateStrokes([s], 5, -5);
		assert.deepEqual(moved!.points, [{ x: 15, y: 5, p: 0.8 }, { x: 25, y: 25, p: 0.8 }]);
		const [scaled] = scaleStrokes([s], { x: 10, y: 10 }, 2);
		assert.deepEqual(scaled!.points, [{ x: 10, y: 10, p: 0.8 }, { x: 30, y: 50, p: 0.8 }], "anchored, doubled, same pressure");
		assert.notEqual(moved, s, "copies, never mutations (undo keeps the original)");
	});

	it("resizing is proportional from the dragged corner, with a floor", () => {
		const box = { x: 0, y: 0, w: 100, h: 50 };
		assert.equal(resizeFactor(box, "se", 200, 60), 2, "the larger of the two axis ratios wins");
		assert.equal(resizeFactor(box, "nw", 50, 25), 0.5, "dragging the far corner toward the anchor shrinks");
		assert.ok(resizeFactor(box, "se", -500, -500) > 0, "dragging past the anchor never flips or vanishes");
	});
});

describe("drawing controls on every surface", () => {
	const quizInput = { question: "Closest planet?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "x" };

	it("the question dock offers the pen and restores drafted drawings as chips", () => {
		const html = renderToStaticMarkup(
			<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput} expanded onExpand={() => {}} onSubmit={() => {}}
				initialDraft={{ selection: { selected: new Set([0]), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: 3, drawings: [attachment("a"), attachment("b")] }} />,
		);
		assert.match(html, /data-testid="draw-button"/);
		assert.equal(html.match(/data-testid="drawing-chip"/g)?.length, 2);
		assert.match(html, /data:image\/png;base64,PNGa/);
	});

	it("a drawing alone can submit a written answer", () => {
		const draft = { selection: { selected: new Set<number>(), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: null };
		const empty = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="e1" input={{ question: "Derive it.", correctAnswer: "x" }} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.match(empty, /<button[^>]*type="submit"[^>]*disabled=""/);
		const drawn = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="e1" input={{ question: "Derive it.", correctAnswer: "x" }} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={{ ...draft, drawings: [attachment("a")] }} />);
		assert.doesNotMatch(drawn, /<button[^>]*type="submit"[^>]*disabled=""/);
	});

	it("the practice dock offers the pen beside Submit thinking", () => {
		const html = renderToStaticMarkup(<PracticeDock problemCallId="p1" input={{ statement: "Integrate x." }} expanded onExpand={() => {}} onSubmit={() => {}} />);
		assert.match(html, /data-testid="draw-button"[\s\S]*data-testid="practice-send"/);
	});

	it("the chat composer puts chips above the row and the pen after the paperclip", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend drawings={api([attachment("a")])} />);
		assert.match(html, /data-testid="drawing-chips"[\s\S]*data-file-path-input[\s\S]*data-testid="attach-files"[\s\S]*data-testid="draw-button"[\s\S]*aria-label="Send"/);
		const bare = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />);
		assert.ok(!bare.includes("draw-button"), "no drawings api, no pen");
	});

	it("the pen disables at the cap", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend drawings={api(["a", "b", "c", "d"].map(attachment))} />);
		assert.match(html, /aria-label="Draw" aria-disabled="true"/);
	});
});

describe("drawings in the transcript", () => {
	it("an answered card shows thumbnails for its drawings", () => {
		const answer = { kind: "explain" as const, questionText: "Derive it.", dontKnow: false, answers: [], answeredAt: "synthetic", drawings: [{ snapshotId: "a".repeat(64), width: 40, height: 30 }] };
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /data-testid="drawing-thumbnails"/);
		assert.match(html, /aria-label="Open drawing 1"/);
	});

	it("a drawing-only practice submission renders its thumbnails without an empty thinking row", () => {
		const html = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p1", text: "", drawings: [{ snapshotId: "a".repeat(64), width: 4, height: 3 }] }} />);
		assert.match(html, /data-testid="drawing-thumbnails"/);
		assert.ok(!html.includes('data-testid="thinking-card"'));
	});

	it("an optimistic thumbnail resolves from the local registry", () => {
		rememberLocalDrawing({ png: "LOCALPNG", width: 8, height: 6 });
		const ingest = localIngest([{ data: "LOCALPNG" }])!;
		const html = renderToStaticMarkup(<AnsweredCard answer={{ kind: "explain", questionText: "q", dontKnow: false, answers: [], answeredAt: "s", drawings: ingest.refs }} />);
		assert.match(html, /data:image\/png;base64,LOCALPNG/);
	});
});

describe("optimistic drawings are absorbed by their record copy", () => {
	const server = (refs = 1) => ({
		refs: Array.from({ length: refs }, (_, i) => ({ snapshotId: `${i}`.padStart(64, "f"), width: 8, height: 6 })),
		images: Array.from({ length: refs }, () => ({ type: "image" as const, data: "IMG", mimeType: "image/png" })),
	});

	it("user messages match on typed text plus drawing count", () => {
		rememberLocalDrawing({ png: "P1", width: 8, height: 6 });
		const optimistic = { ...newUserMessage("steps", localIngest([{ data: "P1" }])), id: "c_local1" } as LhMessage;
		assert.ok(absorbed(optimistic, [{ ...newUserMessage("steps", server(1)), id: "srv_1" }]));
		assert.ok(!absorbed(optimistic, [{ ...newUserMessage("steps"), id: "srv_2" }]), "a drawing-less copy is a different message");
		assert.ok(!absorbed(optimistic, [{ ...newUserMessage("steps", server(2)), id: "srv_3" }]), "the count must agree");
	});

	it("practice thinking markers compare drawings by count", () => {
		rememberLocalDrawing({ png: "P2", width: 8, height: 6 });
		const optimistic = { ...newThinkingMessage("p1", "try", localIngest([{ data: "P2" }])), id: "c_local2" } as unknown as LhMessage;
		const record = { ...newThinkingMessage("p1", "try", server(1)), id: "srv_4" } as unknown as LhMessage;
		assert.ok(absorbed(optimistic, [record]));
	});
});
