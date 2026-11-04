"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, EraserIcon, PencilIcon, Redo2Icon, Trash2Icon, Undo2Icon } from "lucide-react";
import type { DrawingInk, DrawingPoint, DrawingStroke } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { markDrawingPadOpen } from "@/components/drawing/pad-state";
import {
	EXPORT_INK,
	INKS,
	commit,
	continuesGesture,
	endsGesture,
	historyOf,
	paintStrokes,
	redo,
	strokeHit,
	undo,
	type StrokeHistory,
} from "@/components/drawing/strokes";

/**
 * The drawing pad (owner design, 2026-11-04): a big overlay over the
 * session for hand-drawn reasoning — a Wacom pen first, a mouse works.
 *
 *   - the question/problem stays visible in a strip on top (math
 *     rendered); the chat composer has none;
 *   - pen (pressure → width), whole-stroke eraser (also the pen's eraser
 *     END, buttons & 32), four inks, undo/redo/clear;
 *   - Done and Esc both close and KEEP the page (Esc is claimed at the
 *     document level — the ONE-ESC LAW — so nothing underneath is
 *     dismissed). Ctrl/⌘+Z undoes; Ctrl/⌘+Shift+Z and Ctrl+Y redo.
 *
 * Paper follows the app theme (the dark pad, light theme ink); the PNG
 * the teacher reads is exported separately as dark ink on white.
 */

type Tool = "pen" | "eraser";

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
	const [tool, setTool] = useState<Tool>("pen");
	const [ink, setInk] = useState<DrawingInk>("ink");
	const rootRef = useRef<HTMLDivElement>(null);
	const pageRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// The live gesture: a stroke being drawn, or an erase sweep's page.
	const gesture = useRef<
		| { kind: "draw"; pointerId: number; stroke: DrawingStroke }
		| { kind: "erase"; pointerId: number; page: DrawingStroke[] }
		| null
	>(null);
	const historyRef = useRef(history);
	historyRef.current = history;
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	useEffect(() => markDrawingPadOpen(), []);

	/** The theme ink as the page actually renders it (text-foreground). */
	const themeInk = useCallback(() => (pageRef.current ? getComputedStyle(pageRef.current).color : "#e6e6e6"), []);
	const screenColor = useCallback((i: DrawingInk) => (i === "ink" ? themeInk() : EXPORT_INK[i]), [themeInk]);

	/** Full repaint of a page (the committed strokes, or a sweep's live page). */
	const repaint = useCallback(
		(strokes: readonly DrawingStroke[]) => {
			const canvas = canvasRef.current;
			const ctx = canvas?.getContext("2d");
			if (!canvas || !ctx) return;
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			paintStrokes(ctx, strokes, screenColor);
		},
		[screenColor],
	);

	/** What the page shows right now: a live gesture included (a resize
	 *  mid-stroke must not wipe the stroke being drawn). */
	const livePage = useCallback((): readonly DrawingStroke[] => {
		const g = gesture.current;
		if (g?.kind === "draw") return [...historyRef.current.present, g.stroke];
		if (g?.kind === "erase") return g.page;
		return historyRef.current.present;
	}, []);

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
			repaint(livePage());
		};
		fit();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(fit);
		ro.observe(page);
		return () => ro.disconnect();
	}, [repaint, livePage]);

	useEffect(() => {
		if (!gesture.current) repaint(history.present);
	}, [history, repaint]);

	const done = useCallback(() => onDoneRef.current(historyRef.current.present), []);

	// Keys: claimed at the DOCUMENT level (the ONE-ESC LAW) so the window
	// chain underneath never reads them as abort/submit.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				done();
			} else if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) {
				e.preventDefault();
				e.stopPropagation();
				setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
			} else if (mod && !e.altKey && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
				e.preventDefault();
				e.stopPropagation();
				setHistory(redo);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [done]);

	// Focus the dialog so keys land here, not in the field underneath.
	useEffect(() => {
		rootRef.current?.focus();
	}, []);

	const pointOf = (e: PointerEvent, rect: DOMRect): DrawingPoint => ({
		x: e.clientX - rect.left,
		y: e.clientY - rect.top,
		// A mouse reports 0.5 while pressed; a pen's 0 (rare first sample)
		// reads as mid pressure rather than an invisible hairline.
		p: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
	});

	const eraseAt = (page: DrawingStroke[], x: number, y: number) => page.filter((s) => !strokeHit(s, x, y));

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const native = e.nativeEvent;
		// Primary contact only; the pen's eraser end reports buttons & 32.
		const penEraser = e.pointerType === "pen" && (e.buttons & 32) !== 0;
		if (!penEraser && e.button !== 0) return;
		if (gesture.current) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		const rect = e.currentTarget.getBoundingClientRect();
		const pt = pointOf(native, rect);
		if (tool === "eraser" || penEraser) {
			const page = eraseAt(historyRef.current.present, pt.x, pt.y);
			gesture.current = { kind: "erase", pointerId: e.pointerId, page };
			repaint(page);
			return;
		}
		const stroke: DrawingStroke = { ink, points: [pt] };
		gesture.current = { kind: "draw", pointerId: e.pointerId, stroke };
		const ctx = e.currentTarget.getContext("2d");
		if (ctx) paintStrokes(ctx, [stroke], screenColor);
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const g = gesture.current;
		if (!g || !continuesGesture(g.pointerId, e)) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
		const events = samples.length > 0 ? samples : [e.nativeEvent];
		if (g.kind === "erase") {
			let page = g.page;
			for (const ev of events) {
				const pt = pointOf(ev, rect);
				page = eraseAt(page, pt.x, pt.y);
			}
			if (page.length !== g.page.length) {
				g.page = page;
				repaint(page);
			}
			return;
		}
		const ctx = e.currentTarget.getContext("2d");
		for (const ev of events) {
			const pt = pointOf(ev, rect);
			const prev = g.stroke.points[g.stroke.points.length - 1]!;
			// A split pen can report one position through both devices.
			if (pt.x === prev.x && pt.y === prev.y) continue;
			g.stroke.points.push(pt);
			// Incremental: paint only the new segment.
			if (ctx) paintStrokes(ctx, [{ ink: g.stroke.ink, points: [prev, pt] }], screenColor);
		}
	};

	const endGesture = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const g = gesture.current;
		if (!g || !endsGesture(g.pointerId, e)) return;
		gesture.current = null;
		if (g.kind === "erase") {
			// One sweep = one undo step; a sweep that touched nothing is no step.
			if (g.page.length !== historyRef.current.present.length) setHistory((h) => commit(h, g.page));
			else repaint(historyRef.current.present);
			return;
		}
		setHistory((h) => commit(h, [...h.present, g.stroke]));
	};

	const toolButton = "flex size-9 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

	return createPortal(
		<div
			ref={rootRef}
			role="dialog"
			aria-modal="true"
			aria-label="Drawing pad"
			tabIndex={-1}
			data-testid="drawing-pad"
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
					<button type="button" aria-label="Undo" data-testid="pad-undo" disabled={history.past.length === 0} onClick={() => setHistory(undo)} className={toolButton}>
						<Undo2Icon className="size-4" />
					</button>
					<button type="button" aria-label="Redo" data-testid="pad-redo" disabled={history.future.length === 0} onClick={() => setHistory(redo)} className={toolButton}>
						<Redo2Icon className="size-4" />
					</button>
					<button type="button" aria-label="Clear page" data-testid="pad-clear" disabled={history.present.length === 0} onClick={() => setHistory((h) => commit(h, []))} className={toolButton}>
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
						onPointerUp={endGesture}
						onPointerCancel={endGesture}
						onContextMenu={(e) => e.preventDefault()}
						className={cn("absolute inset-0 touch-none select-none", tool === "eraser" ? "cursor-cell" : "cursor-crosshair")}
					/>
				</div>
			</div>
		</div>,
		document.body,
	);
}
