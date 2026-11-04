"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, EraserIcon, LassoSelectIcon, PencilIcon, Redo2Icon, Trash2Icon, Undo2Icon } from "lucide-react";
import type { DrawingInk, DrawingPoint, DrawingStroke } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { markDrawingPadOpen } from "@/components/drawing/pad-state";
import {
	EXPORT_INK,
	INKS,
	LOWER_BUTTON,
	PRESSURE_WAIT_SAMPLES,
	UPPER_BUTTON,
	backfillStartPressure,
	commit,
	contactEnds,
	contactMode,
	contactStarts,
	continuesGesture,
	cornerPoint,
	endsGesture,
	handleAt,
	historyOf,
	insideBox,
	lassoSelects,
	paintStrokes,
	redo,
	resizeAnchor,
	resizeFactor,
	scaleStrokes,
	selectionBox,
	strokeHit,
	translateStrokes,
	undo,
	type Box,
	type Corner,
	type PadTool,
	type StrokeHistory,
} from "@/components/drawing/strokes";

/**
 * The drawing pad (owner design, 2026-11-04): a big overlay over the
 * session for hand-drawn reasoning — a Wacom pen first, a mouse works.
 *
 *   - the question/problem stays visible in a strip on top (math
 *     rendered); the chat composer has none;
 *   - pen (pressure → width), whole-stroke eraser (also the pen's eraser
 *     END, buttons & 32), lasso Select, four inks, undo/redo/clear;
 *   - the pen's side buttons (owner, 2026-11-04): HOLD the lower one to
 *     erase, HOLD the upper one to lasso-select. A selection moves (drag
 *     inside its box), resizes (drag a corner — proportional, line
 *     thickness kept), and deletes (its trash button, Delete/Backspace);
 *     a contact outside the box only clears it;
 *   - Done and Esc both close and KEEP the page (Esc is claimed at the
 *     document level — the ONE-ESC LAW — so nothing underneath is
 *     dismissed); with a selection, Esc clears it first. Ctrl/⌘+Z
 *     undoes; Ctrl/⌘+Shift+Z and Ctrl+Y redo.
 *
 * Paper follows the app theme (the dark pad, light theme ink); the PNG
 * the teacher reads is exported separately as dark ink on white.
 */

/** Selection chrome on the canvas: the dashed box, its handles, the lasso. */
const SELECT_COLOR = "#60a5fa";
const HANDLE_SIZE = 8;

type Point = { x: number; y: number };

/** The live gesture. pressurePending: a pen touched down at pressure 0 —
 *  the opening points wait for its first real pressure. `idle` is a
 *  contact that only cleared a selection: it draws nothing until it lifts. */
type Gesture =
	| { kind: "draw"; pointerId: number; stroke: DrawingStroke; pressurePending: boolean }
	| { kind: "erase"; pointerId: number; page: DrawingStroke[] }
	| { kind: "lasso"; pointerId: number; loop: Point[] }
	| { kind: "move"; pointerId: number; origin: Point; picked: DrawingStroke[]; moved: DrawingStroke[]; page: DrawingStroke[] }
	| { kind: "resize"; pointerId: number; corner: Corner; box: Box; picked: DrawingStroke[]; moved: DrawingStroke[]; page: DrawingStroke[] }
	| { kind: "idle"; pointerId: number };

/** The page with `picked` strokes swapped for their edited copies. */
function replaceStrokes(page: readonly DrawingStroke[], picked: readonly DrawingStroke[], edited: readonly DrawingStroke[]): DrawingStroke[] {
	const at = new Map(picked.map((st, i) => [st, i]));
	return page.map((st) => {
		const i = at.get(st);
		return i === undefined ? st : edited[i]!;
	});
}

function paintSelectionBox(ctx: CanvasRenderingContext2D, box: Box): void {
	ctx.save();
	ctx.strokeStyle = SELECT_COLOR;
	ctx.lineWidth = 1;
	ctx.setLineDash([5, 4]);
	ctx.strokeRect(box.x, box.y, box.w, box.h);
	ctx.setLineDash([]);
	ctx.fillStyle = "#111111";
	for (const c of ["nw", "ne", "sw", "se"] as const) {
		const p = cornerPoint(box, c);
		ctx.fillRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
		ctx.strokeRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
	}
	ctx.restore();
}

function paintLasso(ctx: CanvasRenderingContext2D, loop: readonly Point[]): void {
	if (loop.length < 2) return;
	ctx.save();
	ctx.strokeStyle = SELECT_COLOR;
	ctx.lineWidth = 1.5;
	ctx.setLineDash([6, 4]);
	ctx.beginPath();
	ctx.moveTo(loop[0]!.x, loop[0]!.y);
	for (const p of loop.slice(1)) ctx.lineTo(p.x, p.y);
	ctx.closePath();
	ctx.stroke();
	ctx.restore();
}

const INK_LABEL: Record<DrawingInk, string> = { ink: "Ink", red: "Red", blue: "Blue", green: "Green" };

export function DrawingPad({
	initialStrokes,
	context,
	contextLabel,
	onDone,
}: {
	initialStrokes: DrawingStroke[];
	/** The question or problem text shown above the page (markdown). */
	context?: string;
	contextLabel?: string;
	/** Close with the page as it stands (empty = nothing to attach). */
	onDone: (strokes: DrawingStroke[]) => void;
}) {
	const [history, setHistory] = useState<StrokeHistory>(() => historyOf(initialStrokes));
	const [tool, setTool] = useState<PadTool>("pen");
	const [ink, setInk] = useState<DrawingInk>("ink");
	const rootRef = useRef<HTMLDivElement>(null);
	const pageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const gesture = useRef<Gesture | null>(null);
	const historyRef = useRef(history);
	historyRef.current = history;
	// The selected strokes (references into history.present). The ref is
	// the event-time truth; the state drives the trash button.
	const [selection, setSelectionState] = useState<DrawingStroke[] | null>(null);
	const selectionRef = useRef<DrawingStroke[] | null>(null);
	const select = useCallback((next: DrawingStroke[] | null) => {
		selectionRef.current = next && next.length > 0 ? next : null;
		setSelectionState(selectionRef.current);
	}, []);
	// A move/resize is in flight: the trash button hides until it lands.
	const [editing, setEditing] = useState(false);
	// Each pointer's last `buttons`, to see a tip touch down or lift while
	// a side button stays held (4 → 5 → 4 on the owner's pen).
	const lastButtons = useRef(new Map<number, number>());
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	useEffect(() => markDrawingPadOpen(), []);

	/** The theme ink as the page actually renders it (text-foreground). */
	const themeInk = useCallback(() => (pageRef.current ? getComputedStyle(pageRef.current).color : "#e6e6e6"), []);
	const screenColor = useCallback((i: DrawingInk) => (i === "ink" ? themeInk() : EXPORT_INK[i]), [themeInk]);

	/** What the page shows right now: a live gesture included (a resize
	 *  mid-stroke must not wipe the stroke being drawn). */
	const livePage = useCallback((): readonly DrawingStroke[] => {
		const g = gesture.current;
		if (g?.kind === "draw") return [...historyRef.current.present, g.stroke];
		if (g?.kind === "erase" || g?.kind === "move" || g?.kind === "resize") return g.page;
		return historyRef.current.present;
	}, []);

	/** Full repaint: the live page, then the selection chrome (a lasso in
	 *  progress, or the selection's box following a move/resize). */
	const repaint = useCallback(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		paintStrokes(ctx, livePage(), screenColor);
		const g = gesture.current;
		if (g?.kind === "lasso") paintLasso(ctx, g.loop);
		const selected = g?.kind === "move" || g?.kind === "resize" ? g.moved : selectionRef.current;
		const box = selected ? selectionBox(selected) : null;
		if (box) paintSelectionBox(ctx, box);
	}, [livePage, screenColor]);

	// Size the canvas to its box at device resolution; repaint on resize.
	useLayoutEffect(() => {
		const page = pageRef.current;
		const canvas = canvasRef.current;
		if (!page || !canvas) return;
		const fit = () => {
			const dpr = window.devicePixelRatio || 1;
			const r = page.getBoundingClientRect();
			canvas.width = Math.max(1, Math.round(r.width * dpr));
			canvas.height = Math.max(1, Math.round(r.height * dpr));
			canvas.style.width = `${r.width}px`;
			canvas.style.height = `${r.height}px`;
			repaint();
		};
		fit();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(fit);
		ro.observe(page);
		return () => ro.disconnect();
	}, [repaint]);

	useEffect(() => {
		if (!gesture.current) repaint();
	}, [history, selection, repaint]);

	const done = useCallback(() => onDoneRef.current(historyRef.current.present), []);

	/** Remove the selected strokes (one undo step). */
	const deleteSelection = useCallback(() => {
		const picked = selectionRef.current;
		if (!picked) return;
		const gone = new Set(picked);
		setHistory((h) => commit(h, h.present.filter((st) => !gone.has(st))));
		select(null);
	}, [select]);

	/** Undo/redo/clear replace the page: a selection never outlives it. */
	const editHistory = useCallback(
		(step: (h: StrokeHistory) => StrokeHistory) => {
			select(null);
			setHistory(step);
		},
		[select],
	);

	// Keys: claimed at the DOCUMENT level (the ONE-ESC LAW) so the window
	// chain underneath never reads them as abort/submit.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				// A selection is the innermost layer: Esc clears it first.
				if (selectionRef.current) select(null);
				else done();
			} else if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current) {
				e.preventDefault();
				e.stopPropagation();
				deleteSelection();
			} else if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) {
				e.preventDefault();
				e.stopPropagation();
				editHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
			} else if (mod && !e.altKey && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
				e.preventDefault();
				e.stopPropagation();
				editHistory(redo);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [done, select, deleteSelection, editHistory]);

	// Focus the dialog so keys land here, not in the field underneath.
	useEffect(() => {
		rootRef.current?.focus();
	}, []);

	const pointOf = (e: PointerEvent, rect: DOMRect): DrawingPoint => ({
		x: e.clientX - rect.left,
		y: e.clientY - rect.top,
		// A mouse reports 0.5 while pressed. A pen's 0 (its contact sample,
		// or a driver that sends none) reads as mid pressure rather than an
		// invisible hairline; a stroke's start is backfilled once known.
		p: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
	});

	const eraseAt = (page: readonly DrawingStroke[], x: number, y: number) => page.filter((st) => !strokeHit(st, x, y));

	/** A tip (or eraser end) just touched: decide what this contact does.
	 *  With a selection up and no side button held, the contact edits it —
	 *  a handle resizes, inside moves, outside only clears. */
	const begin = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = e.currentTarget;
		try {
			canvas.setPointerCapture(e.pointerId);
		} catch {
			// a pointer without active buttons cannot be captured; harmless
		}
		const rect = canvas.getBoundingClientRect();
		const native = e.nativeEvent;
		const pt = pointOf(native, rect);
		const page = historyRef.current.present;
		const picked = selectionRef.current;
		const sideButton = e.pointerType === "pen" && (e.buttons & (LOWER_BUTTON | UPPER_BUTTON)) !== 0;
		if (picked && !sideButton) {
			const box = selectionBox(picked);
			const corner = box ? handleAt(box, pt.x, pt.y) : null;
			if (box && corner) {
				gesture.current = { kind: "resize", pointerId: e.pointerId, corner, box, picked, moved: picked, page };
				setEditing(true);
				return;
			}
			if (box && insideBox(box, pt.x, pt.y)) {
				gesture.current = { kind: "move", pointerId: e.pointerId, origin: { x: pt.x, y: pt.y }, picked, moved: picked, page };
				setEditing(true);
				return;
			}
			gesture.current = { kind: "idle", pointerId: e.pointerId };
			select(null);
			repaint();
			return;
		}
		if (picked) select(null);
		const mode = contactMode(e, tool);
		if (mode === "select") {
			gesture.current = { kind: "lasso", pointerId: e.pointerId, loop: [{ x: pt.x, y: pt.y }] };
			repaint();
			return;
		}
		if (mode === "erase") {
			gesture.current = { kind: "erase", pointerId: e.pointerId, page: eraseAt(page, pt.x, pt.y) };
			repaint();
			return;
		}
		const stroke: DrawingStroke = { ink, points: [pt] };
		const pressurePending = e.pointerType === "pen" && native.pressure === 0;
		gesture.current = { kind: "draw", pointerId: e.pointerId, stroke, pressurePending };
		// A pending start paints once its pressure is known (extend); a tap
		// that never moves commits as a mid-pressure dot.
		const ctx = canvas.getContext("2d");
		if (ctx && !pressurePending) paintStrokes(ctx, [stroke], screenColor);
	};

	/** Feed a live gesture its new samples. */
	const extend = (g: Gesture, e: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
		const events = samples.length > 0 ? samples : [e.nativeEvent];
		const last = pointOf(events[events.length - 1]!, rect);
		switch (g.kind) {
			case "idle":
				return;
			case "lasso":
				for (const ev of events) g.loop.push(pointOf(ev, rect));
				repaint();
				return;
			case "move":
				g.moved = translateStrokes(g.picked, last.x - g.origin.x, last.y - g.origin.y);
				g.page = replaceStrokes(historyRef.current.present, g.picked, g.moved);
				repaint();
				return;
			case "resize": {
				const s = resizeFactor(g.box, g.corner, last.x, last.y);
				g.moved = scaleStrokes(g.picked, resizeAnchor(g.picked, g.corner), s);
				g.page = replaceStrokes(historyRef.current.present, g.picked, g.moved);
				repaint();
				return;
			}
			case "erase": {
				let page = g.page;
				for (const ev of events) {
					const pt = pointOf(ev, rect);
					page = eraseAt(page, pt.x, pt.y);
				}
				if (page.length !== g.page.length) {
					g.page = page;
					repaint();
				}
				return;
			}
			case "draw": {
				const ctx = e.currentTarget.getContext("2d");
				for (const ev of events) {
					const pt = pointOf(ev, rect);
					const prev = g.stroke.points[g.stroke.points.length - 1]!;
					// A split pen can report one position through both devices.
					if (pt.x === prev.x && pt.y === prev.y) continue;
					g.stroke.points.push(pt);
					if (g.pressurePending) {
						const known = ev.pointerType === "pen" && ev.pressure > 0;
						if (!known && g.stroke.points.length < PRESSURE_WAIT_SAMPLES) continue;
						backfillStartPressure(g.stroke.points, pt.p);
						g.pressurePending = false;
						if (ctx) paintStrokes(ctx, [g.stroke], screenColor);
						continue;
					}
					// Incremental: paint only the new segment.
					if (ctx) paintStrokes(ctx, [{ ink: g.stroke.ink, points: [prev, pt] }], screenColor);
				}
				return;
			}
		}
	};

	/** The contact lifted: land the gesture (one undo step at most). */
	const finish = (g: Gesture) => {
		gesture.current = null;
		switch (g.kind) {
			case "idle":
				repaint();
				return;
			case "lasso": {
				const page = historyRef.current.present;
				select(page.filter((st) => lassoSelects(st, g.loop)));
				repaint();
				return;
			}
			case "move":
			case "resize":
				setEditing(false);
				if (g.moved !== g.picked) {
					setHistory((h) => commit(h, g.page));
					select(g.moved);
				} else repaint();
				return;
			case "erase":
				// One sweep = one undo step; a sweep that touched nothing is no step.
				if (g.page.length !== historyRef.current.present.length) setHistory((h) => commit(h, g.page));
				else repaint();
				return;
			case "draw":
				setHistory((h) => commit(h, [...h.present, g.stroke]));
				return;
		}
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		e.preventDefault();
		const prev = lastButtons.current.get(e.pointerId) ?? 0;
		lastButtons.current.set(e.pointerId, e.buttons);
		if (gesture.current) return;
		if (contactStarts(prev, e.buttons)) begin(e);
		else if (e.pointerType === "pen") {
			// A side button pressed while hovering: keep this pen's moves
			// here so its tip contact (a chorded move) is seen.
			try {
				e.currentTarget.setPointerCapture(e.pointerId);
			} catch {
				// nothing to capture; harmless
			}
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const prev = lastButtons.current.get(e.pointerId) ?? 0;
		lastButtons.current.set(e.pointerId, e.buttons);
		const g = gesture.current;
		if (!g) {
			if (contactStarts(prev, e.buttons)) begin(e);
			return;
		}
		// The tip lifted while a side button stays held (5 → 4).
		if (e.pointerId === g.pointerId && contactEnds(prev, e.buttons)) {
			finish(g);
			return;
		}
		if (continuesGesture(g.pointerId, e)) extend(g, e);
	};

	const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		lastButtons.current.set(e.pointerId, e.buttons);
		const g = gesture.current;
		if (g && endsGesture(g.pointerId, e)) finish(g);
	};

	const trashBox = selection ? selectionBox(selection) : null;

	const toolButton = "flex size-9 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

	return createPortal(
		<div
			ref={rootRef}
			role="dialog"
			aria-modal="true"
			aria-label="Drawing pad"
			tabIndex={-1}
			data-testid="drawing-pad"
			onContextMenu={(e) => e.preventDefault()}
			className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-3 outline-none sm:p-6"
		>
			<div className="flex min-h-0 w-full max-w-[1600px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
				{context && (
					<div data-testid="drawing-pad-context" className="max-h-[25vh] shrink-0 overflow-y-auto border-b border-border/60 px-4 py-3">
						<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{contextLabel ?? "Question"}</div>
						<div className="lh-prose text-sm">
							<ToolContentResponse>{context}</ToolContentResponse>
						</div>
					</div>
				)}
				<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5" role="toolbar" aria-label="Drawing tools">
					<button type="button" aria-label="Pen" aria-pressed={tool === "pen"} data-testid="pad-pen" onClick={() => setTool("pen")} className={cn(toolButton, tool === "pen" && "bg-accent text-foreground")}>
						<PencilIcon className="size-4" />
					</button>
					<button type="button" aria-label="Eraser" aria-pressed={tool === "eraser"} data-testid="pad-eraser" onClick={() => setTool("eraser")} className={cn(toolButton, tool === "eraser" && "bg-accent text-foreground")}>
						<EraserIcon className="size-4" />
					</button>
					<button type="button" aria-label="Select" aria-pressed={tool === "select"} data-testid="pad-select" onClick={() => setTool("select")} className={cn(toolButton, tool === "select" && "bg-accent text-foreground")}>
						<LassoSelectIcon className="size-4" />
					</button>
					<span aria-hidden className="mx-1 h-5 w-px bg-border" />
					{INKS.map((i) => (
						<button
							key={i}
							type="button"
							aria-label={`${INK_LABEL[i]} ink`}
							aria-pressed={ink === i}
							data-testid={`pad-ink-${i}`}
							onClick={() => {
								setInk(i);
								setTool("pen");
							}}
							className={cn(toolButton, ink === i && "bg-accent")}
						>
							<span
								className={cn("size-4 rounded-full border border-border", i === "ink" && "bg-foreground")}
								style={i === "ink" ? undefined : { backgroundColor: EXPORT_INK[i] }}
							/>
						</button>
					))}
					<span aria-hidden className="mx-1 h-5 w-px bg-border" />
					<button type="button" aria-label="Undo" data-testid="pad-undo" disabled={history.past.length === 0} onClick={() => editHistory(undo)} className={toolButton}>
						<Undo2Icon className="size-4" />
					</button>
					<button type="button" aria-label="Redo" data-testid="pad-redo" disabled={history.future.length === 0} onClick={() => editHistory(redo)} className={toolButton}>
						<Redo2Icon className="size-4" />
					</button>
					<button type="button" aria-label="Clear page" data-testid="pad-clear" disabled={history.present.length === 0} onClick={() => editHistory((h) => commit(h, []))} className={toolButton}>
						<Trash2Icon className="size-4" />
					</button>
					<span className="ml-auto pr-2 text-xs text-muted-foreground">Esc or Done keeps the drawing</span>
					<button
						type="button"
						data-testid="pad-done"
						onClick={done}
						className="flex h-9 items-center gap-1.5 rounded-[6px] bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						<CheckIcon className="size-4" />
						Done
					</button>
				</div>
				<div ref={pageRef} data-testid="drawing-page" className="relative min-h-0 flex-1 bg-background text-foreground">
					<canvas
						ref={canvasRef}
						data-testid="drawing-canvas"
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerUp}
						className={cn(
							"absolute inset-0 touch-none select-none",
							tool === "eraser" ? "cursor-cell" : tool === "select" ? "cursor-default" : "cursor-crosshair",
						)}
					/>
					{trashBox && !editing && (
						<button
							type="button"
							aria-label="Delete selection"
							data-testid="pad-delete-selection"
							onClick={deleteSelection}
							// Beside the box's top-right corner (clear of its handle);
							// flipped to the left side when the page edge is near.
							style={{
								left: trashBox.x + trashBox.w + 40 > (pageRef.current?.clientWidth ?? Infinity) ? Math.max(4, trashBox.x - 36) : trashBox.x + trashBox.w + 8,
								top: Math.max(4, trashBox.y),
							}}
							className="absolute flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-red-500"
						>
							<Trash2Icon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
