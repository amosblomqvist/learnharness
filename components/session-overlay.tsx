"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import { renderMermaid } from "@/components/mermaid-render";
import { MermaidError } from "@/components/mermaid-error";
import { Hint } from "@/components/ui/hint";
import { SvgImage } from "@/components/artifacts/svg-image";

/**
 * SESSION-SCOPED OVERLAYS (owner wave, 2026-09-19): the "fullscreen"
 * expansions — the plan focus, this mermaid focus — do NOT cover the app
 * chrome. They mount ABSOLUTE INSIDE THE SESSION AREA (the `relative` div
 * below the top bar, right of the sidebar, where the transcript and dock
 * live), so the 60px drag bar stays sharp, visible, and draggable and the X
 * can never land in drag territory — the old `fixed inset-0` overlays put it
 * exactly there, which is what drove this redesign. Surface: 80% background +
 * blur (user-decided) — the transcript ghosts through while the focus owns
 * the session area.
 *
 * The chart source registers from wherever it lives in the transcript
 * (md-blocks' expand button) via the context below; the CHAT PAGE owns the
 * open state so this overlay mounts as a sibling of the scroller inside the
 * session area — never inside it (an absolute inset-0 inside the scroller
 * would cover the scrollable extent, not the visible area).
 */

/** The expand seam: md-blocks' mermaid hover button calls openMermaid with
 *  the chart source; the figure card's fullscreen button calls openFigure
 *  with the raw svg (+ its invert state). The chat page (which provides
 *  this context) opens the overlay. Null when no chat page is mounted
 *  (sidebar previews etc.) — the buttons simply don't render there. */
export const SessionMermaidContext = createContext<{
	openMermaid: (chart: string) => void;
	openFigure: (svg: string, inverted: boolean) => void;
} | null>(null);

export function useSessionMermaid() {
	return useContext(SessionMermaidContext);
}

/** A chart svg's natural size — mermaid always emits a viewBox; this is the
 *  extent at zoom 1 (1 svg unit = 1 px), like the plan diagram's natural
 *  size. Figure svgs (2026-10-07) may declare width/height instead — that
 *  pair is the fallback. The final fallback covers a degenerate svg with
 *  neither. Pure. */
export function chartSize(svg: string): { w: number; h: number } {
	const m = /<svg[^>]*\bviewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
	if (m) {
		const w = Number.parseFloat(m[3]!);
		const h = Number.parseFloat(m[4]!);
		if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
	}
	const attr = (name: string): number | null => {
		const a = new RegExp(`<svg\\b[^>]*?\\b${name}\\s*=\\s*["'](\\d+(?:\\.\d+)?)(?:px)?["']`, "i").exec(svg);
		if (!a) return null;
		const n = Number.parseFloat(a[1]!);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const w = attr("width");
	const h = attr("height");
	if (w !== null && h !== null) return { w, h };
	return { w: 600, h: 400 };
}

/** The diagram focus: the chart at natural size inside a pan/zoom viewport
 *  (the plan popup's fit-floor semantics — fitGraphView/zoomedGraphView in
 *  pan-zoom.ts), Esc/X close. Renders its own copy of the chart (mermaid
 *  ids are per-render), not the injected inline svg. FIGURE MODE
 *  (2026-10-07): pass a raw `svg` instead of a mermaid `chart` — the same
 *  shell then focuses a figure card's svg on a white stage, with the
 *  caller's invert state carried over (the filter rides the white stage,
 *  exactly like the in-card holder). */
export function MermaidOverlay({
	chart,
	svg: rawSvg,
	inverted = false,
	onClose,
}: {
	chart?: string;
	svg?: string;
	inverted?: boolean;
	onClose: () => void;
}) {
	// ── chart render (own instance, own ids); figure mode uses the raw svg ──
	const [svg, setSvg] = useState<string | null>(rawSvg ?? null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (rawSvg !== undefined) {
			setSvg(rawSvg);
			setError(null);
			return;
		}
		if (chart === undefined) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		renderMermaid(chart)
			.then((s) => {
				if (!cancelled) setSvg(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [rawSvg, chart, attempt]);

	// Esc closes — claimed at the document level (THE ONE-ESC LAW, owner
	// keyboard round 2026-10-06): one Esc, one action; the window chain
	// (dictation → abort) never fires under a surfaced layer.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// ── pan/zoom viewport (same wiring as the plan popup) ──
	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const box = useMemo(() => (svg ? chartSize(svg) : { w: 0, h: 0 }), [svg]);
	const fitZoom = useMemo(() => fitZoomFor(box, size), [box, size]);

	const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const userAdjustedRef = useRef(false);
	const atFloor = view.zoom <= fitZoom + 1e-9;
	const [settled, setSettled] = useState(false);
	const [panning, setPanning] = useState(false);

	useEffect(() => {
		if (atFloor) userAdjustedRef.current = false;
	}, [atFloor]);
	useEffect(() => {
		if (userAdjustedRef.current || !size.w || !size.h || !svg) return;
		setView(fitGraphView(box, size, fitZoom));
		const raf = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(raf);
	}, [fitZoom, size, box, svg]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const factor = Math.exp(-dy * 0.0015);
			const rect = el.getBoundingClientRect();
			setView((v) =>
				zoomedGraphView(v, factor, fitZoom, { x: e.clientX - rect.left, y: e.clientY - rect.top }, box, size),
			);
			userAdjustedRef.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fitZoom, box, size]);

	const dragRef = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
	const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		if (atFloor) return;
		dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
		setPanning(true);
		e.currentTarget.classList.add("cursor-grabbing");
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d) return;
		d.moved = true;
		setView((v) =>
			v.zoom <= fitZoom + 1e-9 ? v : { ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) },
		);
	};
	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (d) {
			dragRef.current = null;
			if (d.moved) userAdjustedRef.current = true;
		}
		setPanning(false);
		e.currentTarget.classList.remove("cursor-grabbing");
	};
	const stepZoom = (factor: number) => {
		userAdjustedRef.current = true;
		setView((v) => zoomedGraphView(v, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size));
	};
	const fitView = () => {
		userAdjustedRef.current = false;
		if (!size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
	};

	return (
		<div
			data-testid="mermaid-overlay"
			// SESSION-SCOPED (not fixed): mounts absolute inside the chat
			// page's session-area div — below the drag bar, right of the
			// sidebar. 80% + blur: the transcript ghosts through (owner
			// decision, 2026-09-19).
			className="absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-label="Diagram focus"
		>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-sm font-medium">Diagram</span>
				<span className="text-xs text-muted-foreground">from this lesson</span>
				<Hint label="Close" binding="escape" side="left">
<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					data-testid="mermaid-overlay-close"
					className="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
</Hint>
			</div>
			<div
				ref={viewportRef}
				className={cn(
					"relative min-h-0 flex-1 touch-none overflow-hidden rounded-xl border select-none",
					atFloor ? "cursor-default" : "cursor-grab",
				)}
				onPointerDown={startDrag}
				onPointerMove={moveDrag}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				{error ? (
					<div className="flex h-full items-center justify-center p-4">
						<MermaidError chart={chart ?? ""} error={error} retry={() => setAttempt((a) => a + 1)} />
					</div>
				) : svg ? (
					<>
						<div
							className="absolute top-0 left-0 origin-top-left"
							style={{
								width: `${box.w}px`,
								transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
								// Hidden until the first fit has APPLIED: the fit runs in an
							// effect (after paint), and the chart would otherwise flash
							// at the initial top-left zoom:1 state for a frame (the
							// owner saw exactly that; transition-gating alone doesn't
							// hide it — VISIBILITY must be gated on settled too).
								opacity: settled ? 1 : 0,
								transition:
									panning || !settled
										? "none"
										: "transform 180ms ease-out, opacity 160ms ease-out",
							}}
						>
							{/* Figures share the card's image boundary and white backing.
							    Mermaid keeps its inline renderer; globals.css removes
							    its max-width cap so it fills the natural-size box. */}
							{rawSvg !== undefined ? (
								<div
									data-lh-overlay-chart
									className="bg-white"
									style={inverted ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
								>
									<SvgImage svg={svg} className="block h-auto w-full" />
								</div>
							) : (
								<div
									data-lh-overlay-chart
									className="[&_svg]:h-auto [&_svg]:w-full"
									dangerouslySetInnerHTML={{ __html: svg }}
								/>
							)}
						</div>
						<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
							<span className="text-xs text-muted-foreground/60">Drag to pan · scroll to zoom</span>
							<div className="flex gap-1">
								<Hint label="Zoom out" side="bottom">
<button
									type="button"
									aria-label="Zoom out"
									onClick={() => stepZoom(1 / 1.25)}
									className="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
								>
									<MinusIcon className="size-3.5" />
								</button>
</Hint>
								<Hint label="Fit diagram to view" side="bottom">
<button
									type="button"
									aria-label="Fit diagram to view"
									onClick={fitView}
									className="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
								>
									<MaximizeIcon className="size-3.5" />
								</button>
</Hint>
								<Hint label="Zoom in" side="bottom">
<button
									type="button"
									aria-label="Zoom in"
									onClick={() => stepZoom(1.25)}
									className="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
								>
									<PlusIcon className="size-3.5" />
								</button>
</Hint>
							</div>
						</div>
					</>
				) : (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2" />
						Rendering diagram…
					</div>
				)}
			</div>
		</div>
	);
}
