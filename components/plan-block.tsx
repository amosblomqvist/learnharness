"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import {
	blockLayout,
	chartMeasure,
	edgePathD,
	HEAD_H,
	HEAD_W,
	NODE_W_MIN,
	STROKE_W,
	type LabelMeasure,
	type LayoutNode,
	type PlanLayout,
} from "@/components/plan-layout";
import type { PlanBlockData, PlanNodeStatus, PlanTree } from "@/src/core";
import { derivedNodeStatus, derivePlanStatuses } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { useAppearance } from "@/components/settings/appearance";
import { InteractionLayerOwner, useInteractionLayer } from "./interaction-layers";

/**
 * PLAN BLOCKS — the plan lives in the chat (wave 4): persisted
 * `data-plan-block` parts render as DAG blocks in the transcript flow, and
 * the right sidebar is retired.
 *
 * - kind "full": the whole DAG, BORDERLESS — no wrapping chrome, the SVG
 *   scales to the full column width (viewBox = layout extent + GRAPH_PAD,
 *   so strokes/glow never clip), natural height, labels capped at the
 *   chat's reading size (textCap: fills the column, never oversizes text).
 * - Clicking opens the full plan in a session-scoped focus overlay
 *   (absolute inside the session area, below the drag bar — chrome-melt
 *   wave, 2026-09-19; was a fixed inset-0 full-screen popup) —
 *   the LIVE plan: the latest tree from the transcript with statuses
 *   derived at click time (contracts/plan.ts derivePlanStatuses). Blocks
 *   are frozen snapshots rendered exactly as carried (never re-derived);
 *   the popup is the live view (user decision, 2026-09).
 *
 * Hand-built SVG everywhere (user decision): placement runs on dagre
 * (mermaid's engine) in components/plan-layout.ts; the skin is ours — no
 * coupling to the graph stream's internals. Box sizes come from the real
 * label text measured in the real font (usePlanLayout below, #671). Pan/zoom
 * in the popup is harvested from the retired tree panel's graph (fit-floor
 * semantics: fully zoomed out IS the fit; panning locks at the floor).
 */

// ─── Measuring the labels (#671) ──────────────────────────────────────────────

/** The label type every plan view draws its titles in. Width-relevant
 *  classes only (size + weight) — the probe measures with exactly these.
 *  font-medium is the HEAVIEST weight any status draws (the current node,
 *  TEXT.current below), so every box fits its text at any status and the
 *  layout never shifts when the current step moves (owner, #671 design). */
const LABEL_TYPE = "text-xs";
const PROBE_TYPE = `${LABEL_TYPE} font-medium`;
/** The sentinel's fixed sample: Latin, digits and CJK, so a font change or
 *  a font finishing its load changes its size whatever script the plan
 *  uses. */
const SENTINEL_TEXT = "Hamburgefonstiv 0123 漢字";

/** The hidden probe a diagram carries (rendered by PlanDiagram, inside its
 *  own <svg> so it inherits exactly the cascade the real labels do —
 *  subtrees may redefine --font-prose, e.g. chain-table.tsx):
 *  - sentinel: fixed text the ResizeObserver watches;
 *  - measurer: SVG <text> whose width answers `width(line)`;
 *  - breaker: HTML block where the browser's own line breaker lays out each
 *    title, answering `lines(title)`. */
export interface PlanProbe {
	sentinel: RefObject<SVGTextElement | null>;
	measurer: RefObject<SVGTextElement | null>;
	breaker: RefObject<HTMLDivElement | null>;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const HANGUL = /\p{Script=Hangul}/u;

/** The lines the browser itself broke `title` into, read back from where
 *  each grapheme landed: a grapheme on a new row starts a new line. The
 *  breaker never splits words or hyphenates (CSS on the element), so this
 *  is the browser's word-level line breaking, every script's rules
 *  included. */
function browserLines(box: HTMLDivElement, title: string, maxWidth: number): string[] {
	box.style.maxWidth = `${maxWidth}px`;
	// Korean separates words with spaces, but browsers break Hangul between
	// any two syllables by default; keep-all keeps its words whole. Chinese
	// and Japanese have no spaces and break between characters by their own
	// rules, so they keep the default.
	box.style.wordBreak = HANGUL.test(title) ? "keep-all" : "normal";
	box.textContent = title;
	const text = box.firstChild;
	if (!text) return [""];
	const range = document.createRange();
	const lines: string[] = [];
	let line = "";
	let top: number | null = null;
	for (const { segment, index } of graphemes.segment(title)) {
		range.setStart(text, index);
		range.setEnd(text, index + segment.length);
		const rect = [...range.getClientRects()].find((r) => r.width > 0);
		if (rect && top !== null && Math.abs(rect.top - top) > rect.height / 2) {
			lines.push(line.trim());
			line = "";
		}
		if (rect) top = rect.top;
		line += segment;
	}
	lines.push(line.trim());
	const kept = lines.filter((l) => l !== "");
	return kept.length > 0 ? kept : [""];
}

/** The real-font measure: the breaker answers line breaks, the SVG
 *  measurer answers widths (PROBE_TYPE on both). Answers are cached per
 *  measure — a new measure is made whenever the font may have changed. */
function probeMeasure(el: SVGTextElement, box: HTMLDivElement): LabelMeasure {
	const widths = new Map<string, number>();
	const breaks = new Map<string, string[]>();
	return {
		fontSize: parseFloat(getComputedStyle(el).fontSize),
		width(text) {
			let w = widths.get(text);
			if (w === undefined) {
				el.textContent = text;
				w = el.getComputedTextLength();
				widths.set(text, w);
			}
			return w;
		},
		lines(title, maxWidth) {
			const key = `${maxWidth}\n${title}`;
			let lines = breaks.get(key);
			if (lines === undefined) {
				lines = browserLines(box, title, maxWidth);
				breaks.set(key, lines);
			}
			return lines;
		},
	};
}

/** Stable empties for "no plan yet" (the layout keys on identity). */
const NO_NODES: readonly LayoutNode[] = [];
const NO_EDGES: ReadonlyArray<{ from: string; to: string }> = [];

/**
 * One plan's layout, measured in the real font (null plan = empty layout).
 * Pass the result to the PlanDiagram that draws this plan.
 *
 * - Server render and the first client render lay out with `chartMeasure`
 *   (the Source Sans estimate), so the server HTML and hydration agree.
 * - Right after mount (layout effect, before paint) the real labels are
 *   measured and the layout is replaced.
 * - A ResizeObserver on the sentinel re-measures whenever the label font
 *   actually changes size on screen: a web font finishing its load, a
 *   reading font picked in Settings (applied by the Appearance provider's
 *   own layout effect, which runs AFTER ours — so we watch the result, not
 *   the cause), an installed font that never fires a load event. The
 *   sentinel is never rewritten, so measuring can't retrigger it.
 *
 * Does NOT measure while the diagram has no layout box (an ancestor with
 * display:none reads 0 widths); the chart layout stays until it shows.
 */
export function usePlanLayout(plan: { nodes: readonly LayoutNode[]; edges: ReadonlyArray<{ from: string; to: string }> } | null) {
	const nodes = plan?.nodes ?? NO_NODES;
	const edges = plan?.edges ?? NO_EDGES;
	const sentinel = useRef<SVGTextElement>(null);
	const measurer = useRef<SVGTextElement>(null);
	const breaker = useRef<HTMLDivElement>(null);
	const chart = useMemo(() => blockLayout(nodes, edges, chartMeasure), [nodes, edges]);
	const [measured, setMeasured] = useState<{ nodes: typeof nodes; edges: typeof edges; layout: PlanLayout } | null>(null);
	useLayoutEffect(() => {
		const watch = sentinel.current;
		const el = measurer.current;
		const box = breaker.current;
		if (!watch || !el || !box || typeof el.getComputedTextLength !== "function") return;
		const measure = () => {
			if (watch.getComputedTextLength() === 0) return; // not rendered yet
			setMeasured({ nodes, edges, layout: blockLayout(nodes, edges, probeMeasure(el, box)) });
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		let seen = watch.getComputedTextLength();
		const observer = new ResizeObserver(() => {
			const now = watch.getComputedTextLength();
			if (now === seen) return;
			seen = now;
			// Commit before the browser paints, so the new font never shows
			// in the old boxes for a frame.
			flushSync(measure);
		});
		observer.observe(watch);
		return () => observer.disconnect();
	}, [nodes, edges]);
	const layout = measured && measured.nodes === nodes && measured.edges === edges ? measured.layout : chart;
	const probe: PlanProbe = { sentinel, measurer, breaker };
	return { layout, probe };
}

/** SVG-unit padding around the layout extent: strokes are centered on the
 *  geometry (half bleeds outside the extent) and the glow halo reaches −4 —
 *  without this pad the outermost node borders clip at the svg edge. */
export const GRAPH_PAD = 8;
/** The current node's yellow glow: a fill blurred so it bleeds over the
 *  node's edges (owner). A Gaussian's visible spread is ≈3σ, so the glow
 *  reaches GLOW_MARGIN + 3·GLOW_BLUR past the node — any surface that
 *  shows the glow must pad its viewBox by GLOW_REACH or the blur clips
 *  at the frame edge (owner: extend the container padding to fit it). */
export const GLOW_MARGIN = 8;
export const GLOW_BLUR = 5;
export const GLOW_REACH = GLOW_MARGIN + 3 * GLOW_BLUR;

// ─── The owner's arrowhead (plan-graph round 5) ──────────────────────────────

/** Baked from arrowhead_1.svg (the CM/MJX long-arrow head), transform chain
 *  collapsed: viewBox 0 0 50.2 104, tip at (50.2, 52), notch mouth at
 *  x 27.2 with a 9.6-tall opening — at full height 104 the tail opening
 *  is ≈10, per the owner's spec. Solid strong-ink fill, no padding. */
export const ARROW_HEAD = "M48,55.2C49.4,54.6 50.2,53.4 50.2,52C50.2,50.6 49.4,49.4 48,48.8C38.2,45.6 29.2,38.8 21,28.4C15.2,21.4 11.4,13.2 9.6,3.8C9,1.2 7.4,0 4.8,0C1.6,0 0,1.6 0,5L0.2,5.6C3.6,23 12.6,36.8 27.2,47.2L27.2,56.8C12.6,67.2 3.6,81 0.2,98.4L0,99C0,102.4 1.6,104 4.8,104C7.4,104 9,102.8 9.6,100.2C11.4,90.8 15.2,82.6 21,75.6C29.2,65.2 38.2,58.4 48,55.2Z";

// ─── Status styling (the retired panel's color language, unchanged) ──────────

// The simple look (owner, plan-graph round 4): rectangular boxes,
// outlines/arrows/text in the strong line ink (white in dark, the
// foreground in light); no fill on visited, today's gray look on upcoming,
// and the current node carries a faint yellow glow (a blurred yellow fill
// bleeding over the edges). The IN-CHAT block is monochrome instead — no
// status language; the popup/window show the progression.
const BOX: Record<PlanNodeStatus, string> = {
	// 50%-opacity app background instead of true transparency: a routed
	// edge passing behind the box composites UNDER the fill — dimmed to
	// half, not shown straight through (owner, round 9).
	visited: "fill-background/50 stroke-line-strong",
	current: "fill-background/50 stroke-line-strong",
	// The grayed-out not-yet-visited look stays as-is (owner).
	upcoming: "fill-card stroke-border",
};
// Every label's size + weight must stay within PROBE_TYPE (the probe
// measures the heaviest of them), or boxes stop fitting their text.
const TEXT: Record<PlanNodeStatus, string> = {
	visited: `fill-line-strong ${LABEL_TYPE}`,
	current: `fill-line-strong ${LABEL_TYPE} font-medium`,
	upcoming: `fill-muted-foreground/80 ${LABEL_TYPE}`,
};
// The in-chat block speaks the dock language now (owner, plan-hug
// round 2026-10-07): boxes in the lighter background variant like
// the composer/dock shells — but the outlines STAY the strong line ink,
// white in dark (owner follow-up: the gray fill is good, white box edges).
const MONO_BOX = "fill-card stroke-line-strong";
const MONO_TEXT = `fill-foreground ${LABEL_TYPE}`;

/** The diagram itself: positioned nodes + bezier edges, drawn from the
 *  layout usePlanLayout hands it (`plan`) — every input is data, so SSR
 *  render tests pin the whole thing. The root sets font-family
 *  var(--font-prose): node titles render in the READING font, not the mono
 *  UI font (owner, 2026-09-26) — and the runtime var rides the Appearance
 *  reading-font override (the utility can't: @theme inline bakes literals —
 *  the --font-title trap). It also carries the plan's hidden probe, so the
 *  probe measures under this exact cascade. */
export function PlanDiagram({
	plan,
	nodes,
	edges,
	statusOf,
	glowId,
	markerId,
	viewBoxOverride,
	pad: padUnits,
	textCap,
	naturalSize,
	monochrome,
	fill,
}: {
	/** usePlanLayout's result for these same nodes + edges. */
	plan: { layout: PlanLayout; probe: PlanProbe };
	nodes: readonly LayoutNode[];
	edges: ReadonlyArray<{ from: string; to: string }>;
	statusOf: (id: string) => PlanNodeStatus;
	glowId?: string | null;
	markerId: string;
	/** A windowed viewBox (the plan window) instead of the full extent. */
	viewBoxOverride?: string;
	/** Pads the viewBox by this many svg units so centered strokes and the
	 *  glow halo never clip at the extent edges (full-extent renders only). */
	pad?: number;
	/** The largest on-screen label size (px): the diagram fills its column
	 *  but never scales labels past this. Callers pass the chat's reading
	 *  size (Appearance proseFontSize), so plan text never outgrows prose. */
	textCap?: number;
	/** Renders at the viewBox width in px (1 svg unit = 1 px at zoom 1) —
	 *  the popup's transform math depends on it; w-full inside the popup's
	 *  shrink-to-fit wrapper resolved to the popup width and broke fit. */
	naturalSize?: boolean;
	/** The in-chat block's mode: every node in the strong line ink (stroke
	 *  and text, no glow) — statuses never show in the transcript (owner). */
	monochrome?: boolean;
	/** Meet-fits the diagram inside a fixed box (h-full w-full — the svg's
	 *  default preserveAspectRatio centers + contains the viewBox): the
	 *  dock band's marginalia mode, where the diagram must fit BOTH the
	 *  flank's width and the band's height rather than run width-first. */
	fill?: boolean;
}) {
	const { layout, probe } = plan;
	// Pad only the full-extent render — the plan window's override viewBox is
	// a deliberate viewport crop, and the popup keeps its own fit margins.
	const pad = viewBoxOverride ? 0 : (padUnits ?? 0);
	const w = Math.max(layout.width, 1);
	const h = Math.max(layout.height, 1);
	const vbW = w + 2 * pad;
	const vbH = h + 2 * pad;
	// The origin rides the ink extent (owner, 2026-10-10): an arrow
	// bulging past zero shifts the viewBox with it instead of clipping.
	// Zero-origin plans (the ordinary case) render exactly as before.
	const ox = viewBoxOverride ? 0 : (layout.originX ?? 0);
	const oy = viewBoxOverride ? 0 : (layout.originY ?? 0);
	return (
		<svg
			viewBox={viewBoxOverride ?? `${ox - pad} ${oy - pad} ${vbW} ${vbH}`}
			className={`block ${fill ? "h-full w-full" : `h-auto${naturalSize ? "" : " w-full"}`}${textCap ? " mx-auto" : ""}`}
			style={{
				// The READING font (owner, 2026-09-26) — the same runtime token
				// consumed by font-prose, so Appearance changes reach SVG text.
				fontFamily: "var(--font-prose)",
				...(textCap
					? { maxWidth: `${Math.round(((vbW * textCap) / layout.fontSize) * 100) / 100}px` }
					: naturalSize
						? { width: `${vbW}px` }
						: {}),
			}}
			role="img"
			aria-label="Plan diagram"
		>
			<defs>
				<marker
					id={markerId}
					viewBox="0 0 50.2 104"
					refX={27.2}
					refY={52}
					markerWidth={HEAD_W}
					markerHeight={HEAD_H}
					markerUnits="userSpaceOnUse"
					orient="auto"
				>
					{/* The owner's arrowhead. The mouth (x 27.2) sits at refX so the
					    line ends AT the notch — the tip beyond it is solid fill. */}
					<path d={ARROW_HEAD} className="fill-line-strong" />
				</marker>
				{/* Same head, grayed — arrows into not-yet-visited nodes are
				    grayed out like the nodes themselves (owner, round 6). */}
				<marker
					id={`${markerId}-dim`}
					viewBox="0 0 50.2 104"
					refX={27.2}
					refY={52}
					markerWidth={HEAD_W}
					markerHeight={HEAD_H}
					markerUnits="userSpaceOnUse"
					orient="auto"
				>
					<path d={ARROW_HEAD} className="fill-border" />
				</marker>
				{/* The current node's highlight: a faint yellow fill BLURRED so it
				    bleeds out over the node's edges (owner). Generous filter region
				    so the blur never clips at its own bounds. */}
				<filter id={`${markerId}-glow`} x="-60%" y="-60%" width="220%" height="220%">
					<feGaussianBlur stdDeviation={GLOW_BLUR} />
				</filter>
			</defs>
			{edges.map((e) => {
				// Dagre's route for this edge: border-intersected waypoints —
				// the line leaves/enters nodes on whatever side dagre chose
				// (mermaid's drawing, owner round 11). Unroutable edges
				// (dangling endpoints) draw nothing.
				const pts = layout.edgePts.get(`${e.from}->${e.to}`);
				if (!pts) return null;
				// The target's box — drives the docking gap + entry-angle clamp.
				const tx = layout.x.get(e.to);
				const ty = layout.y.get(e.to);
				const target =
					tx !== undefined && ty !== undefined
						? { x: tx, y: ty, w: layout.nodeW.get(e.to) ?? NODE_W_MIN, h: layout.nodeH.get(e.to) ?? 0 }
						: undefined;
				// An arrow is white only when BOTH its ends are white (owner,
				// 2026-09-26): origin AND terminal covered — a gray box's outgoing
				// arrows stay gray even when they point into covered territory
				// (supersedes round 6's target-only rule); the in-chat block
				// stays all-white.
				const dim =
					!monochrome &&
					(statusOf(e.from) === "upcoming" || statusOf(e.to) === "upcoming");
				return (
					<path
						key={`${e.from}->${e.to}`}
						d={edgePathD(pts, target)}
						className={dim ? "fill-none stroke-border" : "fill-none stroke-line-strong"}
						strokeWidth={STROKE_W}
						markerEnd={`url(#${markerId}${dim ? "-dim" : ""})`}
					/>
				);
			})}
			{nodes.map((n) => {
				const status = statusOf(n.id);
				const glow = n.id === glowId && !monochrome;
				const lines = layout.lines.get(n.id) ?? [n.title];
				// The box hugs its measured, wrapped lines; text centers in it
				// both ways — each line's middle sits on its own row's middle
				// (dominant-baseline central), so no font-specific baseline
				// offset is needed.
				const h = layout.nodeH.get(n.id) ?? 0;
				const w = layout.nodeW.get(n.id) ?? NODE_W_MIN;
				const y0 = (h - lines.length * layout.lineH) / 2 + layout.lineH / 2;
				return (
					<g
						key={n.id}
						transform={`translate(${layout.x.get(n.id) ?? 0}, ${layout.y.get(n.id) ?? 0})`}
						data-testid={`plan-node-${n.id}`}
						data-status={status}
					>
						{/* Rectangular — no corner rounding (owner). */}
						<rect
							width={w}
							height={h}
							className={monochrome ? MONO_BOX : BOX[status]}
							strokeWidth={STROKE_W}
						/>
						{glow && (
							// The current node's highlight: faint yellow, blurred so it
							// bleeds over the edges — static, no pulse (owner, round 6).
							// Paints ABOVE the box fill (owner, round 10): the round-9
							// background fill no longer dims the glow inside the box,
							// while edges behind the box still dim under that fill.
							<rect
								x={-GLOW_MARGIN}
								y={-GLOW_MARGIN}
								width={w + 2 * GLOW_MARGIN}
								height={h + 2 * GLOW_MARGIN}
								className="fill-yellow-400/25"
								filter={`url(#${markerId}-glow)`}
							/>
						)}
						{lines.map((line, i) => (
							<text
								key={i}
								x={w / 2}
								y={y0 + i * layout.lineH}
								textAnchor="middle"
								dominantBaseline="central"
								className={monochrome ? MONO_TEXT : TEXT[status]}
							>
								{line}
							</text>
						))}
					</g>
				);
			})}
			{/* The probe (usePlanLayout): a fixed-text sentinel the resize
			    observer watches, the measurer whose text gets swapped per
			    line, and the HTML breaker where the browser breaks each
			    title into lines (words never split: no overflow-wrap, no
			    hyphens). Hidden, but laid out under this svg's own cascade. */}
			<g aria-hidden="true" visibility="hidden" data-plan-probe="">
				<text ref={probe.sentinel} className={PROBE_TYPE}>{SENTINEL_TEXT}</text>
				<text ref={probe.measurer} className={PROBE_TYPE} />
				<foreignObject width={1} height={1} overflow="visible">
					<div
						ref={probe.breaker}
						className={PROBE_TYPE}
						style={{ width: "max-content", whiteSpace: "normal", overflowWrap: "normal", wordBreak: "normal", hyphens: "none" }}
					/>
				</foreignObject>
			</g>
		</svg>
	);
}

// ─── The transcript block ─────────────────────────────────────────────────────

/**
 * A persisted plan-block part, rendered as carried (snapshot statuses,
 * never re-derived): borderless and column-filling, it opens the live plan
 * popup. Full-only by design since the 2026-09-11 pivot (the neighborhood
 * fragments are retired — position derives live in the popup and the
 * future DAG window).
 */
export function PlanBlock({ data, onOpen }: { data: PlanBlockData; onOpen: () => void }) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const statusMap = useMemo(() => new Map(data.nodes.map((n) => [n.id, n.status] as const)), [data]);
	const statusOf = (id: string): PlanNodeStatus => statusMap.get(id) ?? "upcoming";
	const plan = usePlanLayout(data);
	const { appearance } = useAppearance();
	return (
		<Hint label="Open the full plan" side="bottom">
<button
			type="button"
			data-testid="plan-block-full"
			aria-label="Open the full plan"
			onClick={onOpen}
			className="block w-full text-left"
		>
			{/* pad keeps centered strokes + the glow halo inside the frame; the
		    cap keeps node text at or below chat prose size while still filling
		    the column when it can (owner, plan-graph refinement round 1). */}
		<PlanDiagram
			plan={plan}
			nodes={data.nodes}
			edges={data.edges}
			statusOf={statusOf}
			markerId={markerId}
			pad={GRAPH_PAD}
			textCap={appearance.proseFontSize}
			monochrome
		/>
		</button>
</Hint>
	);
}

// ─── The live plan popup ──────────────────────────────────────────────────────

/** Minimal structural message slice (same trick as phases.ts). */
export interface PopupMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

/** The latest plan tree in the transcript (latest tool-plan_ output). */
export function latestTree(messages: readonly PopupMessage[]): PlanTree | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const parts = messages[m]?.parts;
		if (!parts) continue;
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p]!;
			if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
			const output = part.output as { tree?: PlanTree } | undefined;
			if (output?.tree && Array.isArray(output.tree.nodes)) return output.tree;
		}
	}
	return null;
}

/** The popup shows the glow, so its frame pads by the glow's reach —
 *  the in-chat block (monochrome, no glow) stays tight at GRAPH_PAD. */
const POPUP_PAD = GLOW_REACH;

// The pan/zoom math now lives in components/pan-zoom.ts (shared with the
// mermaid focus overlay since the session-overlay wave, 2026-09-19) — same
// fit-floor semantics: fully zoomed out IS the fit, panning locks at the
// floor, zoom ceiling 4× for reading node titles closely.

/**
 * The full plan, live: latest tree + statuses derived at click time. Esc,
 * backdrop click, or the X close it; drag pans, wheel zooms to the cursor,
 * the zoom floor is the fit (panning locks at it — nothing to move).
 *
 * SESSION-SCOPED since the chrome-melt wave (2026-09-19): it mounts
 * ABSOLUTE inside the chat page's session-area div (chat.tsx) — below the
 * 60px drag bar, right of the sidebar — instead of a fixed inset-0 overlay.
 * The top bar stays sharp and draggable, and the X can never land in drag
 * territory. Surface 80% + blur (owner decision): the transcript ghosts
 * through while the focus owns the session area.
 */
export function PlanPopup({ messages, onClose }: { messages: readonly PopupMessage[]; onClose: () => void }) {
	const tree = useMemo(() => latestTree(messages), [messages]);
	const statuses = useMemo(
		() => (tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null),
		[tree, messages],
	);
	const statusOf = (id: string): PlanNodeStatus => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");

	const rootRef = useRef<HTMLDivElement>(null);
	const layer = useInteractionLayer({
		kind: "view", enabled: true, rootRef,
		onClose: () => { onClose(); return "closed"; },
	});

	// ── pan/zoom viewport (harvested semantics: fit floor = the default) ──
	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// ONE layout for both the fit math and the drawing — measured once, so
	// the zoom-to-fit frames exactly the boxes on screen.
	const plan = usePlanLayout(tree);
	const { layout } = plan;
	// The fit box is the PADDED ink box — the diagram renders with POPUP_PAD
	// (= the glow's reach) so the blurred glow never clips at the frame, and
	// the fit must account for that padding.
	const box = useMemo(
		() => (tree ? { w: layout.width + 2 * POPUP_PAD, h: layout.height + 2 * POPUP_PAD } : { w: 0, h: 0 }),
		[tree, layout],
	);
	const fitZoom = useMemo(() => fitZoomFor(box, size), [box, size]);

	const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const userAdjustedRef = useRef(false);
	const atFloor = view.zoom <= fitZoom + 1e-9;
	// The transition stays off until the FIRST fit has been applied — the
	// popup paints at the fit directly instead of flying in from the initial
	// top-left zoom:1 state (owner, plan-graph round 4).
	const [settled, setSettled] = useState(false);

	useEffect(() => {
		if (atFloor) userAdjustedRef.current = false;
	}, [atFloor]);
	useEffect(() => {
		if (userAdjustedRef.current || !size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
		// Enable the transition only AFTER the fit has painted: flipping
		// settled in the SAME commit lets the browser animate from the
		// initial top-left zoom:1 state — the fly-in the owner keeps
		// seeing (round 4's gate wasn't enough; round 7 fix).
		const raf = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(raf);
	}, [fitZoom, size, box]);

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

	// Smooth zoom: the transform eases between states (CSS retargets from the
	// current computed value, so chained wheel ticks stay fluid). Panning is
	// per-frame — the transition is off while dragging or it rubber-bands.
	const [panning, setPanning] = useState(false);
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

	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");

	return (
		<InteractionLayerOwner.Provider value={layer.id}>
		<div
			ref={rootRef}
			data-testid="plan-popup"
			// SESSION-SCOPED (absolute, not fixed): the chat page mounts this
			// INSIDE the session-area div — below the drag bar, right of the
			// sidebar. 80% + blur: the transcript ghosts through.
			className="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			// Ranked inside the session's bounded view stack, below app modals.
			style={{ zIndex: 100 + layer.order }}
			role="region"
			aria-label="The full plan"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-sm font-medium">The plan</span>
				<span className="text-xs text-muted-foreground">live — statuses derive from your check outcomes</span>
				<Hint label="Close" binding="escape" side="left">
<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					data-testid="plan-popup-close"
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
				{tree ? (
					<>
						<div
							className="absolute top-0 left-0 origin-top-left"
							style={{
								transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
								// Hidden until the first fit has APPLIED — the fit runs in an
								// effect (after paint), so an opacity-gated chart can never flash
								// at the initial top-left zoom:1 state (same fix as the mermaid
								// overlay; transition-gating alone didn't hide the fly-in the
								// owner kept seeing in rounds 4–7).
								opacity: settled ? 1 : 0,
								transition:
									panning || !settled
										? "none"
										: "transform 180ms ease-out, opacity 160ms ease-out",
							}}
						>
							<PlanDiagram
								plan={plan}
								nodes={tree.nodes}
								edges={tree.edges}
								statusOf={statusOf}
								glowId={statuses?.current ?? null}
								markerId={markerId}
								pad={POPUP_PAD}
								naturalSize
							/>
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
								<Hint label="Fit plan to screen" side="bottom">
<button
									type="button"
									aria-label="Fit plan to screen"
									onClick={fitView}
									data-testid="plan-popup-fit"
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
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No plan in this session yet.
					</div>
				)}
			</div>
		</div>
		</InteractionLayerOwner.Provider>
	);
}