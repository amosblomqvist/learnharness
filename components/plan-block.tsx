"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
// The placement engine — literally mermaid's: dagre-d3-es, the fork
// mermaid 11 ships with (owner, plan-graph round 8: same engine as the
// mermaid graphs, our SVG skin stays). The deep subpath is how mermaid
// itself imports it.
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
// Mermaid's default flowchart edge curve: dagre's waypoints drawn through
// d3's curveBasis (the exact recipe dagre-d3's own renderer uses).
import { curveBasis, line } from "d3-shape";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import type { PlanBlockData, PlanNodeStatus, PlanTree } from "@/src/core";
import { derivedNodeStatus, derivePlanStatuses, hasRtlLetter, isolateLtrRuns, letterDirection } from "@/src/core";
import { Hint } from "@/components/ui/hint";

/**
 * PLAN BLOCKS — the plan lives in the chat (wave 4): persisted
 * `data-plan-block` parts render as DAG blocks in the transcript flow, and
 * the right sidebar is retired.
 *
 * - kind "full": the whole DAG, BORDERLESS — no wrapping chrome, the SVG
 *   scales to the full column width (viewBox = layout extent + GRAPH_PAD,
 *   so strokes/glow never clip), natural height, capped at the chat prose
 *   font size (TEXT_CAP_SCALE — fills the column, never oversizes text).
 * - Clicking opens the full plan in a session-scoped focus overlay
 *   (absolute inside the session area, below the drag bar — chrome-melt
 *   wave, 2026-09-19; was a fixed inset-0 full-screen popup) —
 *   the LIVE plan: the latest tree from the transcript with statuses
 *   derived at click time (contracts/plan.ts derivePlanStatuses). Blocks
 *   are frozen snapshots rendered exactly as carried (never re-derived);
 *   the popup is the live view (user decision, 2026-09).
 *
 * Hand-built SVG everywhere (user decision): placement runs on dagre
 * (mermaid's engine — deterministic, synchronous, DOM-free, so SSR and
 * render tests stay exact); the skin is ours — no coupling to the graph
 * stream's internals. Pan/zoom in the popup
 * is harvested from the retired tree panel's graph (fit-floor semantics:
 * fully zoomed out IS the fit; panning locks at the floor).
 */

// ─── Layout constants + pure helpers (exported for tests) ────────────────────

/** Text-first node sizing (owner, plan-hug round 2026-10-07): the box
 * hugs its wrapped text instead of a fixed 160px slab. Width comes from
 * the wrapped lines — a per-character-CLASS width estimate (the flat
 * px/char rate of the first cut overshot the real rendered width, and
 * the invisible slack read as "a lot of empty space" beside the text;
 * owner follow-up 2026-10-07) plus symmetric padding, floored at a
 * minimum so short titles don't collapse into pills. Estimate, NOT
 * canvas measurement: the layout path stays deterministic,
 * synchronous, and DOM-free (SSR + exact render pins keep working). */

/** Symmetric horizontal padding — EQUALS the vertical padding the
 * single-line text gets in NODE_H (owner: "the horizontal padding
 * should be the same as the vertical one"): (44 − 11) / 2 ≈ 16 (the
 * prose font renders text-xs at 11px). */
export const PAD_X = 16;
export const NODE_W_MIN = 96;
export const NODE_H = 44;

// Width classes for the PROSE font (Source Sans 3 as shipped, text-xs
// rendering at 11px): narrow stems and punctuation, wide m/w, caps +
// digits, everything else. Rates least-squares-fitted against
// getComputedTextLength() measurements of the live plan titles
// (2026-10-07 smoke) — residuals land within ±4px per LINE, so
// per-side padding reads as PAD_X ±2. A different reading font
// (Appearance override) drifts the estimate slightly; accepted.
const NARROW_CHARS = new Set(" ijltfr.,:;'!|()[]-\\");
const WIDE_CHARS = new Set("mwMW@");
const CAP_DIGIT = /[A-Z0-9]/;
const COMBINING_MARK = /\p{M}/u;
// RTL letters are estimated at about 5.5px each at 11px.
// Their marks have no advance; other width classes keep their existing rates.
const RTL_LETTER_WIDTH = 5.5;

/** Estimated rendered width (px) of one line at text-xs. Pure. */
export function estimateLineWidth(line: string): number {
	let w = 0;
	let rtlBase = false;
	for (const ch of line) {
		if (COMBINING_MARK.test(ch) && rtlBase) continue;
		rtlBase = hasRtlLetter(ch);
		if (rtlBase) w += RTL_LETTER_WIDTH;
		else if (NARROW_CHARS.has(ch)) w += 3.1;
		else if (WIDE_CHARS.has(ch)) w += 9.2;
		else if (CAP_DIGIT.test(ch)) w += 6.0;
		else w += 5.4;
	}
	return w;
}
/** Baseline-to-baseline distance of node titles. */
export const LINE_H = 13;
export const GAP_X = 24;
export const GAP_Y = 48;

/** A node for layout purposes — the payload's shape and the tree's shape agree. */
export interface LayoutNode {
	id: string;
	title: string;
}

/** Topological order + longest-path depth (Kahn, authoring tie-break) —
 *  order + depth semantics kept for tests; placement itself runs on dagre
 *  now (owner, round 8). */
export function topoFor(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const index = new Map(nodes.map((n, i) => [n.id, i] as const));
	const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
	const dependents = new Map<string, string[]>();
	for (const e of edges) {
		if (!index.has(e.from) || !index.has(e.to)) continue; // defensive: dangling ids
		indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
		const list = dependents.get(e.from);
		if (list) list.push(e.to);
		else dependents.set(e.from, [e.to]);
	}
	const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
	const order: LayoutNode[] = [];
	const depth = new Map<string, number>();
	const byId = new Map(nodes.map((n) => [n.id, n] as const));
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		const d = depth.get(id) ?? 0;
		depth.set(id, d);
		for (const t of dependents.get(id) ?? []) {
			if ((depth.get(t) ?? -1) < d + 1) depth.set(t, d + 1);
			const left = (indegree.get(t) ?? 0) - 1;
			indegree.set(t, left);
			if (left === 0) ready.push(t);
		}
	}
	for (const n of nodes) {
		if (!depth.has(n.id)) {
			order.push(n);
			depth.set(n.id, 0);
		}
	}
	return { order, depth };
}

/** Placement — dagre (mermaid's engine, owner round 8): Sugiyama-style
 *  layered layout, TB, with our geometry (text-first sized boxes,
 *  GAP_X/GAP_Y
 *  separations, zero margin — the caller adds GRAPH_PAD/POPUP_PAD).
 *  Node sizes are fed in (boxes grow with their wrapped content, round
 *  7); dagre returns node CENTERS, we hand back top-lefts like before,
 *  so every consumer (diagram, popup fit, plan window) is unchanged.
 *  Deterministic + synchronous + DOM-free: SSR and render tests stay
 *  exact. Dangling edges are ignored defensively — a ghost endpoint
 *  would spawn an unmeasured node and break the measurer. */
export function blockLayout(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	const nodeH = new Map<string, number>();
	const nodeW = new Map<string, number>();
	/** Dagre's per-edge waypoint routes — each starts/ends at the node
	 *  border intersection on whatever SIDE the edge leaves/enters
	 *  (round 11: the mermaid line drawing, no more fixed bottom-center →
	 *  top-center). Keyed `${from}->${to}`. */
	const edgePts = new Map<string, Array<{ x: number; y: number }>>();
	if (nodes.length === 0) return { x, y, nodeH, nodeW, edgePts, width: 0, height: 0 };
	const ids = new Set(nodes.map((n) => n.id));
	const routed: Array<{ from: string; to: string }> = [];
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "TB", nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
	for (const n of nodes) {
		const lines = wrapTitle(n.title);
		const h = NODE_H + Math.max(0, lines.length - 2) * LINE_H;
		nodeH.set(n.id, h);
		nodeW.set(n.id, nodeWidth(lines));
		g.setNode(n.id, { width: nodeW.get(n.id)!, height: h });
	}
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to)) {
			g.setEdge(e.from, e.to, { label: "", width: 0, height: 0 });
			routed.push(e);
		}
	}
	// (the d.ts marks opts required; the runtime ignores it)
	dagreLayout(g, undefined);
	for (const n of nodes) {
		const pos = g.node(n.id);
		const h = nodeH.get(n.id) ?? NODE_H;
		const w = nodeW.get(n.id) ?? NODE_W_MIN;
		if (pos) {
			x.set(n.id, pos.x - w / 2);
			y.set(n.id, pos.y - h / 2);
		}
	}
	for (const e of routed) {
		const pts: Array<{ x: number; y: number }> | undefined = g.edge(e.from, e.to)?.points;
		if (pts) edgePts.set(`${e.from}->${e.to}`, pts.map((pt) => ({ x: pt.x, y: pt.y })));
	}
	// THE CANVAS MUST COVER THE ARROWS (owner, 2026-10-10): dagre's
	// graph extent is the NODE bounding box — the edge curves drawn on
	// top can bow past it (cross-column edges' bezier control points;
	// measured 14–20px cut on the right in the owner's plans) and the
	// viewBox clipped them. The ink extent unions the node boxes with
	// every edge path's control-point hull: a bezier never leaves the
	// hull of its control points, and parsing the d-string edgePathD
	// builds (the SAME call the renderer makes, same inputs) bounds every
	// segment — M, L and C pairs alternate strictly, so even/odd matches
	// are x/y. Dagre's extent stays the FLOOR: plans whose arrows stay
	// inside keep byte-identical viewBoxes (no reflow of every pinned
	// render), and the origin only moves when ink bulges past zero.
	let inkMinX = Infinity;
	let inkMinY = Infinity;
	let inkMaxX = -Infinity;
	let inkMaxY = -Infinity;
	const stretch = (px: number, py: number) => {
		if (px < inkMinX) inkMinX = px;
		if (py < inkMinY) inkMinY = py;
		if (px > inkMaxX) inkMaxX = px;
		if (py > inkMaxY) inkMaxY = py;
	};
	for (const n of nodes) {
		const nx = x.get(n.id);
		const ny = y.get(n.id);
		if (nx === undefined || ny === undefined) continue;
		stretch(nx, ny);
		stretch(nx + (nodeW.get(n.id) ?? NODE_W_MIN), ny + (nodeH.get(n.id) ?? NODE_H));
	}
	for (const e of routed) {
		const pts = edgePts.get(`${e.from}->${e.to}`);
		if (!pts) continue;
		const tx = x.get(e.to);
		const ty = y.get(e.to);
		const target =
			tx !== undefined && ty !== undefined
				? {
						x: tx,
					y: ty,
					w: nodeW.get(e.to) ?? NODE_W_MIN,
						h: nodeH.get(e.to) ?? NODE_H,
					}
				: undefined;
		const nums = edgePathD(pts, target).match(/-?\d+(?:\.\d+)?/g);
		if (!nums) continue;
		for (let i = 0; i + 1 < nums.length; i += 2) {
			stretch(parseFloat(nums[i]!), parseFloat(nums[i + 1]!));
		}
	}
	// Dagre coordinates start at 0; only ink past zero on the negative
	// side moves the origin (viewBox x/y shift with it).
	const originX = Math.min(0, inkMinX === Infinity ? 0 : inkMinX);
	const originY = Math.min(0, inkMinY === Infinity ? 0 : inkMinY);
	return {
		x,
		y,
		nodeH,
		nodeW,
		edgePts,
		originX,
		originY,
		width: Math.max((g.graph().width ?? 0) - originX, inkMaxX === -Infinity ? 0 : inkMaxX - originX, 1),
		height: Math.max((g.graph().height ?? 0) - originY, inkMaxY === -Infinity ? 0 : inkMaxY - originY, 1),
	};
}

const TITLE_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Greedy word wrap to lines of ≤ maxChars graphemes. NOTHING is dropped: the
 *  node's box grows to fit every line (owner: show the full content of
 *  each node). A single oversized word is hard-chunked across lines at
 *  maxChars. Pure. */
export function wrapTitle(title: string, maxChars = 28): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	// Oversized words can never fit a line — chunk them so no content is lost.
	const atoms: { text: string; length: number }[] = [];
	for (const w of words) {
		const graphemes = Array.from(TITLE_GRAPHEMES.segment(w), ({ segment }) => segment);
		for (let i = 0; i < graphemes.length; i += maxChars) {
			const chunk = graphemes.slice(i, i + maxChars);
			atoms.push({ text: chunk.join(""), length: chunk.length });
		}
	}
	const lines: string[] = [];
	let lastLength = 0;
	for (const a of atoms) {
		const last = lines[lines.length - 1];
		if (last !== undefined && lastLength + 1 + a.length <= maxChars) {
			lines[lines.length - 1] = `${last} ${a.text}`;
			lastLength += 1 + a.length;
		} else {
			lines.push(a.text);
			lastLength = a.length;
		}
	}
	return lines;
}

// ─── Geometry caps (owner, plan-graph refinement round 1) ─────────────────────

/** A node's box width for its wrapped lines — the hug itself. Pure. */
export function nodeWidth(lines: readonly string[]): number {
	const widest = Math.max(1, ...lines.map(estimateLineWidth));
	return Math.max(NODE_W_MIN, Math.ceil(widest) + 2 * PAD_X);
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
/** Node titles render at text-xs (12.5px) in svg units. The in-chat block
 *  scales up to fill the column but NEVER past the chat prose size
 *  (--lh-prose-size, 16px — the ladder's reading rung) — the width cap
 *  that makes that hold. */
export const TEXT_CAP_SCALE = 16 / 12.5;

// ─── The owner's arrowhead (plan-graph round 5) ──────────────────────────────

/** Baked from arrowhead_1.svg (the CM/MJX long-arrow head), transform chain
 *  collapsed: viewBox 0 0 50.2 104, tip at (50.2, 52), notch mouth at
 *  x 27.2 with a 9.6-tall opening — at full height 104 the tail opening
 *  is ≈10, per the owner's spec. Solid white fill, no padding. */
export const ARROW_HEAD = "M48,55.2C49.4,54.6 50.2,53.4 50.2,52C50.2,50.6 49.4,49.4 48,48.8C38.2,45.6 29.2,38.8 21,28.4C15.2,21.4 11.4,13.2 9.6,3.8C9,1.2 7.4,0 4.8,0C1.6,0 0,1.6 0,5L0.2,5.6C3.6,23 12.6,36.8 27.2,47.2L27.2,56.8C12.6,67.2 3.6,81 0.2,98.4L0,99C0,102.4 1.6,104 4.8,104C7.4,104 9,102.8 9.6,100.2C11.4,90.8 15.2,82.6 21,75.6C29.2,65.2 38.2,58.4 48,55.2Z";
/** Lines + outlines run at the app's standard border weight (owner,
 *  2026-09-26 — same 1px the UI borders use; was 1.5). */
export const STROKE_W = 1;
/** The heads scale by the SAME factor the lines thinned by (owner,
 *  2026-09-26): 16 was the height tuned for 1.5-wide lines, so both sides
 *  of the head:shaft proportion shrink together — the LaTeX ratio (tail
 *  opening tucking the line flush) is preserved exactly, just smaller. */
const HEAD_H = 16 * (STROKE_W / 1.5);
const HEAD_SCALE = HEAD_H / 104;
const HEAD_W = 50.2 * HEAD_SCALE;
/** The drawn line terminates at the notch mouth (refX 27.2) — it never
 *  reaches the narrow tip, where it would show through (owner). The tip
 *  overhangs the line's end by this much, so edges shorten by it to land
 *  the tip exactly on the target node's border. */
const HEAD_TIP_OVERHANG = (50.2 - 27.2) * HEAD_SCALE;
/** The head floats this far off the target face — the tip kisses nothing
 *  (owner, round 12). ~half a head length: clearly docked-off, still
 *  visually attached. Scaled with the head (2026-09-26) so "half a head"
 *  stays true at the thinner lines. */
const DOCK_GAP = 4 * (STROKE_W / 1.5);
/** The shaft stub — the straight run before the head (owner, round 12):
 *  control points from Q on sit exactly on the approach line, so the
 *  basis spline renders that stretch perfectly straight and the head
 *  lands on a straight shaft; the corner where the route squares up onto
 *  the line is rounded by the curve. ~1.5 head lengths of shaft. */
const STRAIGHT_RUN = 12;
/** The tilt limit at the termination point, measured off the entry
 *  face's perpendicular: past ±40° one of the head's barbs crosses the
 *  tip's level and the silhouette breaks (owner measured it in
 *  Photoshop, round 14). The final run swings to the cone edge instead. */
const ENTRY_ANGLE_LIMIT = (40 * Math.PI) / 180;
const edgeLine = line<{ x: number; y: number }>()
	.x((p) => p.x)
	.y((p) => p.y)
	.curve(curveBasis);

/** The entry face's outward unit normal — whichever face of the target
 *  box dagre's border point sits on. Pure. */
function faceNormal(
	border: { x: number; y: number },
	box: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
	const d = { top: border.y - box.y, bottom: box.y + box.h - border.y, left: border.x - box.x, right: box.x + box.w - border.x };
	const face = (Object.keys(d) as Array<keyof typeof d>).reduce((a, b) => (d[a] <= d[b] ? a : b));
	switch (face) {
		case "top":
			return { x: 0, y: -1 };
		case "bottom":
			return { x: 0, y: 1 };
		case "left":
			return { x: -1, y: 0 };
		default:
			return { x: 1, y: 0 };
	}
}

/** The edge path — mermaid's own line drawing: dagre's border-intersected
 *  waypoints through d3's curveBasis (mermaid's default flowchart curve —
 *  the same recipe dagre-d3's renderer uses). The head docks off the
 *  target: its TIP floats DOCK_GAP past the border along the FACE NORMAL
 *  (constant gap at any tilt), its mouth sits at the path's end on a
 *  straight run (the shaft stub), and — when the target box is given —
 *  the entry direction is clamped to ±ENTRY_ANGLE_LIMIT of the face's
 *  perpendicular (owner, round 14): a steeper natural approach swings to
 *  the 40° cone edge instead of breaking the head's silhouette. Without
 *  a target box the unclamped geometry applies. Straight collinear
 *  routes render identically. Pure, exported for tests. */
export function edgePathD(
	points: Array<{ x: number; y: number }>,
	target?: { x: number; y: number; w: number; h: number },
): string {
	const pts = points.map((p) => ({ ...p }));
	if (pts.length >= 2) {
		const last = pts[pts.length - 1]!;
		const prev = pts[pts.length - 2]!;
		const dx = last.x - prev.x;
		const dy = last.y - prev.y;
		const len = Math.hypot(dx, dy) || 1;
		let ux = dx / len;
		let uy = dy / len;
		// The tip: DOCK_GAP outside the face along its normal (or along the
		// approach when no box is known).
		let tipx: number;
		let tipy: number;
		if (target) {
			const n = faceNormal(last, target);
			tipx = last.x + n.x * DOCK_GAP;
			tipy = last.y + n.y * DOCK_GAP;
			// Clamp the approach to the ±LIMIT cone around the normal: if
			// the outgoing direction -u tilts past ENTRY_ANGLE_LIMIT, swing
			// it to the cone edge (same rotation side as the route).
			const v = { x: -ux, y: -uy };
			const vn = v.x * n.x + v.y * n.y;
			if (vn < Math.cos(ENTRY_ANGLE_LIMIT)) {
				const t = { x: v.x - vn * n.x, y: v.y - vn * n.y };
				const tl = Math.hypot(t.x, t.y);
				const that = tl > 0 ? { x: t.x / tl, y: t.y / tl } : { x: -n.y, y: n.x };
				const c = Math.cos(ENTRY_ANGLE_LIMIT);
				const s = Math.sin(ENTRY_ANGLE_LIMIT);
				v.x = c * n.x + s * that.x;
				v.y = c * n.y + s * that.y;
				ux = -v.x;
				uy = -v.y;
			}
		} else {
			tipx = last.x - ux * DOCK_GAP;
			tipy = last.y - uy * DOCK_GAP;
		}
		// The mouth: overhang back from the tip along the (clamped) approach.
		const M = { x: tipx - ux * HEAD_TIP_OVERHANG, y: tipy - uy * HEAD_TIP_OVERHANG };
		// From Q the control points lie on the approach line — the basis
		// spline renders Q→M perfectly straight (a B-spline span with
		// collinear control points IS the line), and curveBasis's internal
		// endpoint repetition makes the end tangent exactly the approach
		// direction. NOTE: do NOT repeat M manually — a duplicated final
		// control point renders a zero-length last segment, and
		// orient="auto" on a zero-length segment falls back to 0° (every
		// head pointing right — the round-12 regression, fixed round 13).
		const Q = { x: M.x - ux * STRAIGHT_RUN, y: M.y - uy * STRAIGHT_RUN };
		pts.splice(pts.length - 1, 1, Q, M);
	}
	return edgeLine(pts) ?? "";
}

// ─── Status styling (the retired panel's color language, unchanged) ──────────

// The simple look (owner, plan-graph round 4): rectangular boxes, white
// outlines/arrows/text; no fill on visited, today's gray look on upcoming,
// and the current node carries a faint yellow glow (a blurred yellow fill
// bleeding over the edges). The IN-CHAT block is monochrome white instead
// — no status language; the popup/window show the progression.
const BOX: Record<PlanNodeStatus, string> = {
	// 50%-opacity app background instead of true transparency: a routed
	// edge passing behind the box composites UNDER the fill — dimmed to
	// half, not shown straight through (owner, round 9).
	visited: "fill-background/50 stroke-white",
	current: "fill-background/50 stroke-white",
	// The grayed-out not-yet-visited look stays as-is (owner).
	upcoming: "fill-card stroke-border",
};
const TEXT: Record<PlanNodeStatus, string> = {
	visited: "fill-white text-xs",
	current: "fill-white text-xs font-medium",
	upcoming: "fill-muted-foreground/80 text-xs",
};
// The in-chat block speaks the dock language now (owner, plan-hug
// round 2026-10-07): boxes in the lighter background variant like
// the composer/dock shells — but the outlines STAY white (owner
// follow-up: the gray fill is good, white box edges).
const MONO_BOX = "fill-card stroke-white";
const MONO_TEXT = "fill-foreground text-xs";

/** The diagram itself: positioned nodes + bezier edges. Pure-ish render —
 *  every input is data, so SSR render tests pin the whole thing. The root
 *  sets font-family var(--font-prose): node titles render in the READING
 *  font, not the mono UI font (owner, 2026-09-26) — and the runtime var
 *  rides the Appearance reading-font override (the utility can't: @theme
 *  inline bakes literals — the --font-title trap). */
export function PlanDiagram({
	nodes,
	edges,
	statusOf,
	glowId,
	markerId,
	viewBoxOverride,
	pad: padUnits,
	textCapScale,
	naturalSize,
	monochrome,
	fill,
}: {
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
	/** Caps the rendered width at extent × scale — the chat-font-size zoom
	 *  ceiling for the in-chat block (fills the column, never past prose). */
	textCapScale?: number;
	/** Renders at the viewBox width in px (1 svg unit = 1 px at zoom 1) —
	 *  the popup's transform math depends on it; w-full inside the popup's
	 *  shrink-to-fit wrapper resolved to the popup width and broke fit. */
	naturalSize?: boolean;
	/** The in-chat block's mode: every node white (fill-none, white stroke
	 *  and text, no glow) — statuses never show in the transcript (owner). */
	monochrome?: boolean;
	/** Meet-fits the diagram inside a fixed box (h-full w-full — the svg's
	 *  default preserveAspectRatio centers + contains the viewBox): the
	 *  dock band's marginalia mode, where the diagram must fit BOTH the
	 *  flank's width and the band's height rather than run width-first. */
	fill?: boolean;
}) {
	const layout = useMemo(() => blockLayout(nodes, edges), [nodes, edges]);
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
			className={`block ${fill ? "h-full w-full" : `h-auto${naturalSize ? "" : " w-full"}`}${textCapScale ? " mx-auto" : ""}`}
			style={{
				// The READING font (owner, 2026-09-26) — via the runtime var, NOT
				// the font-prose utility: @theme inline bakes the literal into
				// utilities (the --font-title trap), which would freeze the
				// graph at Source Sans 3 and ignore the Appearance reading-font
				// override. var(--font-prose) rides it.
				fontFamily: "var(--font-prose)",
				...(textCapScale
					? { maxWidth: `${Math.round(vbW * textCapScale * 100) / 100}px` }
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
					<path d={ARROW_HEAD} className="fill-white" />
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
						? { x: tx, y: ty, w: layout.nodeW.get(e.to) ?? NODE_W_MIN, h: layout.nodeH.get(e.to) ?? NODE_H }
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
						className={dim ? "fill-none stroke-border" : "fill-none stroke-white"}
						strokeWidth={STROKE_W}
						markerEnd={`url(#${markerId}${dim ? "-dim" : ""})`}
					/>
				);
			})}
			{nodes.map((n) => {
				const status = statusOf(n.id);
				const glow = n.id === glowId && !monochrome;
				const lines = wrapTitle(n.title);
				// Only a right-to-left title carries the attribute; the rest inherit.
				const dir = letterDirection(n.title) === "rtl" ? "rtl" : undefined;
				// The box hugs its wrapped content; text centers in it —
				// horizontally too now (text-first sizing round, 2026-10-07).
				const h = layout.nodeH.get(n.id) ?? NODE_H;
				const w = layout.nodeW.get(n.id) ?? NODE_W_MIN;
				const y0 = (h - lines.length * LINE_H) / 2 + 10;
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
								y={y0 + i * LINE_H}
								textAnchor="middle"
								direction={dir}
								className={monochrome ? MONO_TEXT : TEXT[status]}
							>
								{/* A <text> has no spans, so the isolates keep `C++` in order; the width estimate never sees them. */}
								{dir ? isolateLtrRuns(line) : line}
							</text>
						))}
					</g>
				);
			})}
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
			nodes={data.nodes}
			edges={data.edges}
			statusOf={statusOf}
			markerId={markerId}
			pad={GRAPH_PAD}
			textCapScale={TEXT_CAP_SCALE}
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

	// Esc closes — claimed at the DOCUMENT level (THE ONE-ESC LAW, owner
	// keyboard round 2026-10-06): a surfaced layer's Esc is exactly one
	// action. The window-level chain (dictation cancel → abort) is the
	// fallback for when NOTHING is surfaced; a window listener here could
	// never stop it — same-node listeners all fire — which was the
	// plan-open-while-dictating double-act (Esc closed the plan AND
	// cancelled the dictation).
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

	const layout = useMemo(() => (tree ? blockLayout(tree.nodes, tree.edges) : null), [tree]);
	// The fit box is the PADDED ink box — the diagram renders with POPUP_PAD
	// (= the glow's reach) so the blurred glow never clips at the frame, and
	// the fit must account for that padding.
	const box = useMemo(
		() => (layout ? { w: layout.width + 2 * POPUP_PAD, h: layout.height + 2 * POPUP_PAD } : { w: 0, h: 0 }),
		[layout],
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
		<div
			data-testid="plan-popup"
			// SESSION-SCOPED (absolute, not fixed): the chat page mounts this
			// INSIDE the session-area div — below the drag bar, right of the
			// sidebar. 80% + blur: the transcript ghosts through.
			className="absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
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
	);
}