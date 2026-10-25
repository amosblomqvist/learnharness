"use client";

/**
 * The home knowledge-graph view (W4; vision §1 "Rendering (DECIDED)").
 *
 * ARCHITECTURE (2026-09-13, decided after the research pass —
 * docs/research/graph-rendering.md, Option B): sigma.js is GONE. The
 * renderer is now a hand-rolled single Canvas 2D (./graph-canvas.ts) —
 * a DUMB DRAW FUNCTION over plain data with ONE requestAnimationFrame
 * loop and a dirty flag. Everything that made the sigma era fragile is
 * structurally impossible now: hulls cannot lag nodes (one loop, one
 * camera, one frame), settings changes cannot shift anything (the
 * camera lives in the renderer and no rebuild ever happens), and the
 * per-camera-event full-canvas repaints (GPU spikes + coil whine) are
 * gone (at most one draw per frame, and NO frame at all while idle).
 *
 * Layout fallback (ledger absent): ONE synchronous incrementalLayout
 * pass (d3-force, core/layout.ts) inside a useEffect writes world-space
 * x/y, then the positions are handed to the renderer as data. No layout
 * animation ever starts; the only animation is the
 * short hover fade, strictly bounded in time — idle CPU is zero (the
 * loop schedules no rAF until something actually changes).
 *
 * The component's job is everything AROUND drawing: fetch + refetch the
 * snapshot, run the layout, resolve theme colors to hex, filter via the
 * search box, own the settings panel / detail card / import button /
 * pipeline chips, and FEED the renderer (data, settings, visibility).
 * The renderer's contract stays presentation-only — which is exactly
 * what the upcoming playground and cluster-first layout work needs: a
 * renderer that draws whatever data it is given, never questioning it.
 *
 * Visual semantics, all preserved verbatim from the sigma era:
 *   - Node labels (the short extractor-coined names) wrap under the
 *     node; one GLOBAL zoom gate fades them together (no per-node pop).
 *   - Hover: a soft glow halo in the node's own color at a constant
 *     radius, opacity cross-faded ~180ms with the name brightening on
 *     the same factor; the whole halo is hit-testable (picking pad).
 *   - Cluster hulls (vision §1): soft layered translucent fills + a
 *     dashed boundary per cluster, stable hue from the cluster id; the
 *     region label at the centroid fades in over the exact zoom span
 *     node labels fade out (THE single zoom control) — and is
 *     toggleable in the settings panel (hulls always draw).
 *   - The persisted labelZoom setting keeps sigma's camera-ratio
 *     convention (1 = fit zoom, SMALLER = zoomed in): labels until
 *     zoom 0.5x means labels appear once zoomed in past 2x fit.
 *   - Click a node -> the detail card anchored just below it (flipping
 *     above near the bottom edge); any camera move dismisses it.
 *     Clicking the empty stage closes it. Search filtering hides nodes
 *     (and their edges) from rendering, picking, hover, AND labels;
 *     an open card closes if its node is filtered out.
 *
 * Rendering settings (2026-09-13): the gear in the search panel reveals
 * five sliders (node size, edge width, arrowhead length, label size, the
 * zoom threshold), and the cluster-labels checkbox. (The supports-edge
 * draw toggle + thickness slider died with supports edges themselves —
 * chains-primary, 2026-09-30.) SERVER-persisted
 * (data/render-settings.json via /api/graph/render-settings): loaded
 * once after mount, saved debounced on every user change — one source
 * of truth shared by every browser. The label-zoom slider is log-scaled
 * (its useful band 0.25–0.5 sits mid-slider, not crammed at the left)
 * and displays normalized units where the default 0.5 reads as "1×".
 * Settings apply by just redrawing — no rebuild, no re-layout, and the
 * camera never moves.
 */

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import Link from "next/link";
import { FileTextIcon, ListTreeIcon, Loader2Icon, SearchIcon, SettingsIcon, UploadIcon, WaypointsIcon } from "lucide-react";
import { incrementalLayout, propositionSessionHref, type GraphCostSummary, type GraphNode, type GraphSnapshot } from "@/src/core";
import { planCostLabel } from "@/components/usage-format";
import { GraphCanvasRenderer, type GraphRenderSettings } from "./graph-canvas.ts";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useActivity } from "@/components/activity-dock";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { MenuShell } from "@/components/menu-shell.tsx";
import { DeleteNodeDialog } from "@/components/delete-node-dialog.tsx";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { Hint } from "@/components/ui/hint";
import {
	ARROW_LENGTH_LADDER,
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	DEFAULT_RENDER_SETTINGS,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
	fromLadderPosition,
	snapToLadder,
	toLadderPosition,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	sanitizeRenderSettings,
	toOffSliderPosition,
	toSliderPosition,
} from "@/src/core";

/** The uniform node look (no state classes — canvas wants hex, not oklch):
 *  the accent color, until the state model lands. */
const NODE_COLOR_TOKEN = "--primary";

/** Per-device graph camera persistence (zoom+pan view state). v1 in the
 *  key: the stored shape is the renderer's d3 transform {k, x, y}. */
const CAMERA_STORAGE_KEY = "lh.graph.camera.v1";

// ---- Render settings (the settings-panel controls) ------------------------
//
// The shape, defaults, sanitizer, and slider mappings live in
// src/core/render-settings.ts (shared with the server store + tests).

type RenderSettings = GraphRenderSettings;

/**
 * Pure filter predicate for the search panel: a node is visible when the
 * query is empty or matches its name or statement (case-insensitive).
 * Exported for tests; the visibility feed just consumes its verdict.
 */
export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

/** In-place sessions patch for a live rename (rename-shuffle fix,
 *  2026-09-23). The OLD path built a fresh snapshot object, which
 *  flowed through the [snapshot]-keyed setData effect → geometry
 *  rebuild → last-fetched ledger became authoritative + pending drag
 *  commit cancelled → the graph visibly rewound whenever display had
 *  drifted. This seam NEVER changes object identity: same snapshot
 *  reference, same clusters array — so the data feed cannot re-fire.
 *  The display refresh rides a separate tick state, and the cluster
 *  label itself goes through the renderer's label-only channel
 *  (setClusterLabels). Exported for tests; pure display state only —
 *  the server derives the same join on its next read. */
export function renameSessionsPatch(snapshot: Pick<GraphSnapshot, "sessions">, id: string, title: string): void {
	snapshot.sessions[id] = title;
}

/** Seed positions for nodes the ledger doesn't know yet (hygiene,
 *  2026-09-23 fix wave): they used to fall through to a ?? 0 and dump
 *  at the origin. Place them on a deterministic ring around the known
 *  positions' centroid — angle hashed from the id (FNV-1a), golden-angle
 *  spiral offset so even hash collisions spread. Stable across
 *  remounts, far enough off the mass to see, and they relax with the
 *  pack on the next drag. In-place on the provided map; pure otherwise. */
export function seedMissingNodePositions(
	nodes: readonly { id: string }[],
	positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
	if (positions.size === 0 || nodes.every((n) => positions.has(n.id))) return positions;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of positions.values()) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
	const missing = nodes.filter((n) => !positions.has(n.id));
	missing.forEach((n, i) => {
		// FNV-1a hash → [0,1) → angle; the golden-angle spiral offset
		// both spreads collisions and staggers long paths deterministically.
		let h = 0x811c9dc5;
		for (let c = 0; c < n.id.length; c++) {
			h ^= n.id.charCodeAt(c);
			h = (h * 0x01000193) >>> 0;
		}
		const angle = ((h / 0xffffffff) * 2 * Math.PI + i * 2.39996323) % (2 * Math.PI);
		positions.set(n.id, {
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
		});
	});
	return positions;
}

// ---- Color helpers (canvas wants hex, not oklch) ---------------------------

/** Resolve a CSS variable (oklch in this app) to #rrggbb via the canvas. */
function cssColorToHex(css: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "#888888";
	ctx.fillStyle = css;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

function tokenHex(cssVar: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	return value ? cssColorToHex(value) : "#888888";
}

// ---- Component ------------------------------------------------------------

interface Selection {
	node: GraphNode;
	/** The sources that touched this node: chat ids (deep-linkable sessions)
	 *  and notes-source ids ("src_…" — imported files, static entries). */
	sourceIds: string[];
	/** Node position in container pixels (at click time; camera moves
	 *  dismiss the card, so it never needs re-anchoring). */
	anchor: { x: number; y: number };
}

/** One labeled range row for the rendering-settings panel. */
/** Compact size display for the log sliders: "2", "1.6", "0.75". */
function sizeDisplay(v: number): string {
	return `${v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}`;
}

function SettingSlider({
	label,
	min,
	max,
	step,
	value,
	display,
	onChange,
	disabled,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	/** Value display override (e.g. "1.5×" for zoom) — defaults to the raw number. */
	display?: string;
	onChange: (v: number) => void;
	/** Dependency graying (user 2026-09-17): children dim + lock when
	 *  their parent toggle/mode is off — consistently across sections. */
	disabled?: boolean;
}) {
	return (
		<label className={`flex flex-col gap-1${disabled ? " opacity-40" : ""}`}>
			<span className="flex items-center justify-between text-[11px] text-muted-foreground">
				{label}
				<span className="tabular-nums">{display ?? value}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 w-full accent-primary"
			/>
		</label>
	);
}

/** Compact token display: 45231 → "45.2k"; absent → "—". */
function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Relative time for run rows: "now", "12m", "3h", "2d". */
function timeAgo(startedAt: number): string {
	const mins = Math.round((Date.now() - startedAt) / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Run/stage cost at 3 decimals (pipeline pennies are real money at this
 *  scale); headline totals use 2. Null (unpriced model) renders "—". */
function fmtRunCost(dollars: number | null, providers: readonly string[] = []): string {
	return planCostLabel(dollars, providers, (value) => `$${value.toFixed(3)}`);
}
function graphProviders(value: { subscriptionRuns?: number; subscriptionProviders?: string[] }): string[] {
	return value.subscriptionProviders ?? ((value.subscriptionRuns ?? 0) > 0 ? ["ChatGPT"] : []);
}
function graphUsageLabel(costs: Pick<GraphCostSummary, "stages">): string {
	const stages = [costs.stages.extraction, costs.stages.audit];
	const providers = [...new Set(stages.flatMap(graphProviders))];
	const priced = stages.some((stage) => stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) > 0);
	const dollars = displayCostTotals(costs).totalDollars;
	return planCostLabel(priced ? dollars : null, providers, (value) => `$${value.toFixed(2)}`);
}

/**
 * The cost figures the UI DISPLAYS (owner refinement round, 2026-09-24):
 * extraction + audit only. Cluster naming is dead — labels are session
 * titles / file names — so the core's naming fold (and its historical
 * spend) is deliberately not shown anywhere: the pill and the panel must
 * agree, and both read THIS, never GraphCostSummary.totalDollars.
 * (The core fold's naming stage was then culled outright — 2026-09-24 —
 * so the recent-runs list carries extraction runs only.)
 */
export function displayCostTotals(costs: Pick<GraphCostSummary, "stages">): {
	totalDollars: number;
	unpricedRuns: number;
} {
	// The two live stages (the spine came and went on one day,
	// 2026-09-30 — digest-aware extraction replaced it).
	return {
		totalDollars: costs.stages.extraction.dollars + costs.stages.audit.dollars,
		unpricedRuns: costs.stages.extraction.unpricedRuns + costs.stages.audit.unpricedRuns,
	};
}

/**
 * The graph-pipeline cost control (2026-09-20 placement wave): a bare
 * cumulative-dollars number — no pill chrome (owner: "just a number"),
 * hover-highlighted, click toggles the breakdown panel. Same dismiss
 * pattern as the settings gear: outside click or Escape closes. The
 * panel is viewport-capped + scrollable like the coverage dropdown.
 */
/** Exported for the chains home (graph rendering off, owner
 * 2026-10-06): the same bare cumulative-dollars pill + panel. */
export function GraphCostControl({ costs }: { costs: GraphCostSummary }) {
	const [open, setOpen] = useState(false);
	// Click anywhere outside (or Escape) closes the panel — the root
	// wraps button + panel, so the toggle itself keeps working.
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	return (
		<div ref={rootRef} className="relative">
			<Hint
				// Trimmed (owner, subtlety round 2026-09-25).
				label="Graph costs — click for details"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				{graphUsageLabel(costs)}
			</button>
			</Hint>
			{open && (
				<div className="absolute right-0 top-full mt-2 max-h-[60vh] overflow-y-auto">
					<GraphCostPanel costs={costs} />
				</div>
			)}
		</div>
	);
}

/**
 * The cost control's expanded panel: stage totals (extraction / audit —
 * dollars headline, tokens secondary) + the recent-runs list.
 * Presentational: the fold happens server-side (core/cost-summary.ts);
 * dollars are inferred read-time, never stored. Cluster naming is GONE
 * from the panel (owner refinement round, 2026-09-24): labels are session
 * titles / file names now, the namer is dead, and its historical spend is
 * not tracked anymore — the headline sums the displayed stages only and
 * naming-kind runs never reach the list.
 */
function GraphCostPanel({ costs }: { costs: GraphCostSummary }) {
	const stageRows: [string, GraphCostSummary["stages"]["extraction"]][] = [
		["Extraction", costs.stages.extraction],
		["Audit", costs.stages.audit],
	];
	// The displayed figures come from displayCostTotals (naming excluded —
	// the pill and this panel must agree).
	const { unpricedRuns } = displayCostTotals(costs);
	return (
		<div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
			<div className="mb-2 flex items-baseline justify-between">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Graph pipeline costs
				</span>
				<span className="text-foreground tabular-nums">
					{graphUsageLabel(costs)}
					{unpricedRuns > 0 && (
						<span className="text-muted-foreground"> · {unpricedRuns} unpriced</span>
					)}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				{stageRows.map(([label, stage]) => (
					<div key={label} className="flex items-baseline justify-between gap-2 text-[11px]">
						<span className="shrink-0 text-muted-foreground">{label}</span>
						<span className="min-w-0 text-right tabular-nums">
							{fmtRunCost(stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) <= 0 ? null : stage.dollars, graphProviders(stage))}
							{stage.unpricedRuns > 0 && (stage.runs - stage.unpricedRuns - (stage.subscriptionRuns ?? 0) > 0 || (stage.subscriptionRuns ?? 0) > 0) && (
								<span className="text-muted-foreground"> +{stage.unpricedRuns} unpriced</span>
							)}
							<span className="text-muted-foreground">
								{" "}
								· {fmtTokens(stage.tokens.inputTokens)} in / {fmtTokens(stage.tokens.outputTokens)} out
							</span>
						</span>
					</div>
				))}
			</div>
			<div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
				{costs.runs.map((run) => (
						<div key={run.startedAt} className="flex items-baseline justify-between gap-2 text-[11px]">
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								<span className="text-foreground/70">{timeAgo(run.startedAt)}</span>{" "}
								{run.title}
								{run.merged && (
									<span className="text-muted-foreground">
										{" "}
										+{run.merged.nodes}n
									</span>
								)}
							</span>
							<span className="shrink-0 tabular-nums">{fmtRunCost(run.dollars, graphProviders(run))}{run.dollars === null && run.subscriptionRuns === 1 ? " +1 unpriced" : ""}</span>
						</div>
					))}
			</div>
		</div>
	);
}

/**
 * The rendering-settings gear + its collapsible panel (owner, graph-view
 * round 2): its own container at the top right, separate from the search
 * box and the import button — clicking the gear expands/collapses the
 * panel, which drops below the button, right-aligned with it.
 */
function GraphSettingsControl({
	settings,
	changeSettings,
}: {
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
}) {
	const [open, setOpen] = useState(false);
	// Click anywhere outside (or Escape) closes the panel (2026-09-17) —
	// the root wraps button + panel, so the toggle itself keeps working.
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	return (
		<div ref={rootRef} className="relative">
			<Hint
				// User language (tooltip wave) — "rendering" is internal.
				label="Graph display settings"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<SettingsIcon className="size-4" />
			</button>
			</Hint>
			{open && (
				// Viewport-capped + internally scrollable — the coverage
				// dropdown's exact pattern (owner, 2026-09-17): max-h keeps a
				// floor of free space above the window bottom at any height,
				// and the overflow-y-auto column (which also zeroes the flex
				// item's min-height) scrolls instead of stretching the page.
				// w-72 + inner pr (owner, 2026-09-20): the scrollbar used to
				// press against the content — the panel widens so the scroll
				// gutter gets real air. Spacing concentric: content -> 10px
				// (pr-2.5) -> scrollbar -> 10px (p-2.5) -> panel edge. The
				// scrollbar itself does NOT move: it stays pinned at the same
				// distance from the panel's right border.
				<div className="absolute right-0 top-full mt-2 flex max-h-[60vh] w-72 flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
					<div className="flex flex-col gap-2 overflow-y-auto pr-2.5">
							{/* Size/zoom/region sliders: LADDER-mapped 0-100, step 10 (11
							    stops, every DEFAULT dead-center at 50, every value a nice
							    number — src/core/render-settings.ts). Physics keeps the
							    fine-grained log sliders (step 5). */}
							<SettingSlider
								label="Node size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)}
								display={sizeDisplay(settings.nodeSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, nodeSize: fromLadderPosition(p, NODE_SIZE_LADDER) }))}
							/>
							<SettingSlider
								label="Edge width"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)}
								display={sizeDisplay(settings.edgeWidth)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, edgeWidth: fromLadderPosition(p, EDGE_WIDTH_LADDER) }))}
							/>
							<SettingSlider
								label="Arrowhead size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.arrowLength, ARROW_LENGTH_LADDER)}
								display={sizeDisplay(settings.arrowLength)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, arrowLength: fromLadderPosition(p, ARROW_LENGTH_LADDER) }))}
							/>
							<SettingSlider
								label="Label size"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.labelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelSize: fromLadderPosition(p, LABEL_SIZE_LADDER) }))}
							/>
							{/* Display is absolute (ratio / 0.5): "1×" is the default, dead-center (owner, 2026-10-07). */}
							<SettingSlider
								label="Labels until zoom"
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)}
								display={labelZoomDisplay(settings.labelZoom)}
								onChange={(p) =>
									changeSettings((cur) => ({ ...cur, labelZoom: fromLadderPosition(p, LABEL_ZOOM_LADDER) }))}
							/>
							{/* Regions: the blurred cluster tints. Sliders + a fixed-set
						    dropdown for the bitmap resolution (it's a discrete
						    choice, not a free number). Server-persisted like the
						    sizes; every range end was sweep-validated on the real
						    graph. The enable switch is a COMPUTE switch: off skips
						    the whole build (splat/blur/readback/blit), not just
						    the paint. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Regions
							</span>
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Background colors</span>
								<input
									type="checkbox"
									checked={settings.regions.enabled}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, enabled: e.target.checked },
										}))}
										className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Dilation"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.dilation, REGION_DILATION_LADDER)}
								display={sizeDisplay(regionTuning.dilation)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, dilation: fromLadderPosition(p, REGION_DILATION_LADDER) },
									}))}
							/>
							<SettingSlider
								label="Blur"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.blur, REGION_BLUR_LADDER)}
								display={sizeDisplay(regionTuning.blur)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, blur: fromLadderPosition(p, REGION_BLUR_LADDER) },
									}))
								}
							/>
							<SettingSlider
								label="Edge alpha"
								disabled={!regionTuning.enabled}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(regionTuning.edgeAlpha, REGION_EDGE_ALPHA_LADDER)}
								display={sizeDisplay(regionTuning.edgeAlpha)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										regions: { ...cur.regions, edgeAlpha: fromLadderPosition(p, REGION_EDGE_ALPHA_LADDER) },
									}))}
							/>
							<label
								className={`flex items-center justify-between gap-2 text-[11px] text-muted-foreground${!regionTuning.enabled ? " opacity-40" : ""}`}
							>
								<span>Bitmap resolution</span>
								<select
									disabled={!regionTuning.enabled}
									className="rounded-md border bg-background px-1.5 py-0.5 text-xs tabular-nums text-foreground"
									value={regionTuning.bitmap}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											regions: { ...cur.regions, bitmap: Number(e.target.value) },
										}))
									}
								>
									{REGION_BITMAP_OPTIONS.map((o) => (
										<option key={o} value={o}>
											{o}
										</option>
									))}
								</select>
							</label>
							{/* Cluster labels moved here 2026-09-16 (user: cluster
							    stuff lives in the regions section). Decoupled from
							    the Background colors switch above — labels follow
							    their own clusterLabels toggle. Size is screen px
							    (constant at any zoom, unlike node labels). */}
							<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
								<span>Cluster labels</span>
								<input
									type="checkbox"
									checked={settings.clusterLabels}
									onChange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: e.target.checked }))}
									className="accent-primary"
								/>
							</label>
							<SettingSlider
								label="Cluster label size"
								disabled={!settings.clusterLabels}
								min={0}
								max={100}
								step={10}
								value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)}
								display={sizeDisplay(settings.clusterLabelSize)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										clusterLabelSize: fromLadderPosition(p, CLUSTER_LABEL_SIZE_LADDER),
									}))}
							/>
						</div>
						{/* Physics: the live sim's forces. Every value feeds the SAME
						    engine the server settle runs (createGraphSimulation);
						    changing one rebuilds the sim from the current positions —
						    drag mid-settle re-anneals, pins survive. Sliders over
						    sweep-validated ranges (src/core/render-settings.ts):
						    range ends and all four corners settle cleanly — no NaN,
						    no explosion, no non-settle. Repulsion is displayed as
						    the negative it is; cluster pull's far left = off.
						    Order (user 2026-09-17): general forces first; depth
						    anchor + its gray-out-able controls last. */}
						<div className="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Physics
							</span>
							<SettingSlider
								label="Node repulsion"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(-physicsTuning.chargeStrength, -CHARGE_RANGE.max, -CHARGE_RANGE.min)}
								display={`-${Math.round(-physicsTuning.chargeStrength)}`}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, chargeStrength: -fromSliderPosition(p, -CHARGE_RANGE.max, -CHARGE_RANGE.min) },
									}))}
							/>
							<SettingSlider
								label="Edge attraction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkStrength, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkStrength: fromSliderPosition(p, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Edge length"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.linkDistance, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max)}
								display={sizeDisplay(physicsTuning.linkDistance)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, linkDistance: fromSliderPosition(p, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Central pull"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.gravity, GRAVITY_RANGE.min, GRAVITY_RANGE.max)}
								display={sizeDisplay(physicsTuning.gravity)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, gravity: fromSliderPosition(p, GRAVITY_RANGE.min, GRAVITY_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Cluster pull"
								min={0}
								max={100}
								step={5}
								value={toOffSliderPosition(physicsTuning.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)}
								display={physicsTuning.clusterPull <= 0 ? "off" : sizeDisplay(physicsTuning.clusterPull)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, clusterPull: fromOffSliderPosition(p, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Friction"
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.velocityDecay, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max)}
								display={sizeDisplay(physicsTuning.velocityDecay)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, velocityDecay: fromSliderPosition(p, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max) },
									}))}
							/>
							{/* Depth anchor LAST (user 2026-09-17): general
							    forces first, then the mode + its conditional
							    controls at the very bottom — the grayed group reads
							    as a self-contained sub-section. */}
							<label className="flex items-center justify-between gap-2 text-xs">
								Depth anchor
								<select
									className="rounded border bg-background px-1 py-0.5 text-xs"
									value={physicsTuning.depthMode}
									onChange={(e) =>
										changeSettings((cur) => ({
											...cur,
											physics: { ...cur.physics, depthMode: e.target.value as GraphRenderSettings["physics"]["depthMode"] },
										}))
									}
								>
									<option value="off">Off</option>
									<option value="vertical">Vertical (up)</option>
									<option value="radial">Radial (outward)</option>
								</select>
							</label>
							<SettingSlider
								label="Depth strength"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthStrength, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthStrength)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthStrength: fromSliderPosition(p, DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Depth spacing"
								disabled={physicsTuning.depthMode === "off"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthSpacing, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthSpacing)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthSpacing: fromSliderPosition(p, DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max) },
									}))}
							/>
							<SettingSlider
								label="Base ring radius"
								disabled={physicsTuning.depthMode !== "radial"}
								min={0}
								max={100}
								step={5}
								value={toSliderPosition(physicsTuning.depthBaseRadius, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max)}
								display={sizeDisplay(physicsTuning.depthBaseRadius)}
								onChange={(p) =>
									changeSettings((cur) => ({
										...cur,
										physics: { ...cur.physics, depthBaseRadius: fromSliderPosition(p, DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max) },
									}))}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** The top-chrome actions row's body (empty-graph chrome wave, owner
 *  2026-09-25): Import Notes renders ALWAYS (graph enabled) — it's the
 *  one action that works on an empty graph, the entry point itself;
 *  search + settings render only when the snapshot has nodes (dead
 *  controls are lies — the honesty principle). The two gated controls
 *  fade in on their mount (graph-chrome-fade-in, globals.css — the
 *  appear-once transition as the first nodes land). Exported pure for
 *  the empty/populated SSR pins (the DeleteNodeBody pattern). */
export function GraphChromeRow({
	isEmpty,
	query,
	onQuery,
	noMatch,
	importing,
	searchInputRef,
	fileInputRef,
	onImportFiles,
	settings,
	changeSettings,
	onOpenChains,
}: {
	isEmpty: boolean;
	query: string;
	onQuery: (v: string) => void;
	/** The search panel's "No matching nodes." note (computed by the
	 *  wrapper — it owns visibleIds + the snapshot). */
	noMatch: boolean;
	importing: boolean;
	searchInputRef: React.RefObject<HTMLInputElement | null>;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onImportFiles: (files: FileList | null) => void;
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	/** Opens the chain table overlay (the chains-overlay plan,
	 *  2026-09-29). */
	onOpenChains: () => void;
}) {
	return (
		<>
			{!isEmpty && (
				<div className="graph-chrome-fade-in w-56 min-w-0 shrink rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint
						// ⌘F focuses node search (surface-scoped registry action).
						label="Search nodes"
						action="find"
						side="bottom"
					>
					<div className="relative">
						<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={searchInputRef}
							value={query}
							onChange={(e) => onQuery(e.target.value)}
							placeholder="Search nodes…"
							aria-label="Search nodes"
							spellCheck={false}
							className="h-7 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
					</div>
					</Hint>
					{noMatch && (
						<div className="px-1.5 pt-1 text-[11px] text-muted-foreground">No matching nodes.</div>
					)}
				</div>
			)}
			{/* The chain table (chains overlay, owner plan 2026-09-29). Own
			    container (36px band), between the search and Import. */}
			{!isEmpty && (
				<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint label="Every reasoning chain" side="bottom">
						<button
							type="button"
							onClick={onOpenChains}
							data-testid="open-chain-table"
							className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
						>
							<ListTreeIcon className="size-3" />
							Chains
						</button>
					</Hint>
				</div>
			)}
			{/* Import notes — its own container (36px, header band); ALWAYS
			    rendered (the empty-graph ruling above — the entry point). */}
			<div className="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept=".md,.markdown,.txt"
					className="hidden"
					onChange={(e) => {
						onImportFiles(e.target.files);
						e.target.value = ""; // allow re-picking the same file
					}}
				/>
				<Hint
					// The one button whose action isn't obvious from its label:
					// the missing fact is where imports go (owner, subtlety
					// round 2026-09-25).
					label="Import notes into the graph"
					side="bottom"
				>
					<button
						type="button"
						disabled={importing}
						onClick={() => fileInputRef.current?.click()}
						data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
						<UploadIcon className="size-3" />
						{importing ? "Importing…" : "Import notes…"}
					</button>
				</Hint>
			</div>
			{!isEmpty && (
				// Rendering settings — own component; the gear toggles it. The
				// gear sits at the far right (owner, round 3) so its panel drops
				// at the very right edge, over less of the graph. The fade wrapper
				// is a plain shrink-0 flex child — the panel itself positions
				// within GraphSettingsControl's own relative root, unaffected.
				<div className="graph-chrome-fade-in shrink-0">
					<GraphSettingsControl settings={settings} changeSettings={changeSettings} />
				</div>
			)}
		</>
	);
}

export function GraphView({
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	/** PRACTICE SELECT (owner vision, 2026-10-04): the LIFTED, persistent
	 *  pick set — every check/clear in the chain table (however opened)
	 *  reports the full node list up immediately; the composer-side chip
	 *  reflects it live. chainSelectOpen still drives the picker mode
	 *  (Done instead of Delete). */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	// The latest snapshot for the renderer's click callbacks (they are
	// constructed once, so they read through this ref, never a closure).
	const snapshotRef = useRef<GraphSnapshot | null>(null);
	snapshotRef.current = snapshot;

	// Search panel state: the query text + the settings section toggle.
	const [query, setQuery] = useState("");
	// ⌘F (shortcut wave C): the find event focuses the node search —
	// surface-scoped, dispatched as lh:kbd-find (only this page listens).
	const searchInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const onFind = () => searchInputRef.current?.focus();
		window.addEventListener("lh:kbd-find", onFind);
		return () => window.removeEventListener("lh:kbd-find", onFind);
	}, []);
	// Render settings: SERVER-persisted (data/render-settings.json via
	// /api/graph/render-settings) — sizes AND the region/physics sections
	// (user-facing since 2026-09-13; the dev-session era is over). Loaded
	// once after mount; every user change saves back, debounced. Defaults
	// render until the load resolves — a fraction of a second at worst.
	const [settings, setSettings] = useState<GraphRenderSettings>(DEFAULT_RENDER_SETTINGS);
	// The two nested sections, unpacked for the renderer feed effects
	// below (same names the old session state had).
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	// True once the user has moved a control this mount: the server copy
	// must never clobber a (possibly newer) local change.
	const userTouched = useRef(false);
	// True once the initial GET settled — saves are held back until then,
	// so merely mounting never PUTs defaults over the server copy.
	const serverLoaded = useRef(false);
	const savePending = useRef(false);
	const changeSettings = (update: (cur: RenderSettings) => RenderSettings) => {
		userTouched.current = true;
		setSettings(update);
	};
	const saveToServer = (s: RenderSettings) => {
		fetch("/api/graph/render-settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(s),
		}).catch((err) => console.error("[graph] settings save failed:", err));
	};
	useEffect(() => {
		fetch("/api/graph/render-settings")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				// Apply only if the user hasn't already moved a slider —
				// if they outran the network, their change wins.
				if (raw !== null && !userTouched.current) setSettings(sanitizeRenderSettings(raw));
			})
			.catch(() => {
				// server unreachable → in-memory defaults keep working
			})
			.finally(() => {
				serverLoaded.current = true;
				// A change made during the fetch was held back — send now.
				if (savePending.current) {
					savePending.current = false;
					saveToServer(settingsRef.current);
				}
			});
	}, []);
	useEffect(() => {
		if (!userTouched.current) return; // mount-run / server-apply: no save
		if (!serverLoaded.current) {
			savePending.current = true; // hold until the GET settles
			return;
		}
		const id = setTimeout(() => saveToServer(settings), 400);
		return () => clearTimeout(id);
	}, [settings]);

	// The renderer instance lives across snapshot refetches and settings
	// changes (its camera is never reset by either); `posRef` carries the
	// frozen layout out of the layout effect.
	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const posRef = useRef<Map<string, { x: number; y: number }> | null>(null);

	// The id set that survives the current search — consumed by the
	// visibility feed and the "no matches" hint.
	const visibleIds = useMemo(() => {
		const set = new Set<string>();
		if (snapshot)
			for (const node of snapshot.nodes) {
				if (isNodeVisible(node, query)) set.add(node.id);
			}
		return set;
	}, [snapshot, query]);

	// Fetch the derived graph. Re-runs when a background pipeline run
	// finishes (refreshTick) — its merges just landed in the ledger.
	const [refreshTick, setRefreshTick] = useState(0);
	// The chain table overlay (chains-overlay plan, 2026-09-29) —
	// component-local: a browsing surface, not graph state.
	const [chainsOpen, setChainsOpen] = useState(false);
	// PRACTICE SELECT (2026-10-04): the parent's chip drives the select
	// mode; closing (either the picker's confirm or its X) reports back so
	// the chip's open state and the table's never disagree.
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then((data) => {
				if (!cancelled) setSnapshot(data);
			})
			.catch((err) => console.error("[graph] fetch failed:", err));
		return () => {
			cancelled = true;
		};
	}, [refreshTick]);

	// Notes import (the format-agnostic front door): file picker → POST
	// /api/graph/import; the runs surface in the status chips below, and the
	// graph refetches when they finish (the runs-empty transition).
	const fileInputRef = useRef<HTMLInputElement>(null);
	// The dock's start-site nudge (accuracy wave, 2026-09-19): the import
	// POST awaits the WHOLE pipeline server-side, so the run registers long
	// before the response — nudge at click and again at +600ms to catch the
	// start; from its first setPhase the run announces itself on the events
	// channel (S5), and the dock rides those announcements thereafter.
	const refreshActivity = useActivity().refresh;
	const notesImport = useNotesImport({
		onStart: () => {
			refreshActivity();
			setTimeout(() => refreshActivity(), 600);
		},
	});
	const { importing, onImportFiles } = notesImport;

	// Background pipeline status: read /api/graph/status; whenever a run
	// LEAVES the feed (finished / aborted / failed), refetch the graph.
	// A run only leaves the registry after its merge + settle + usage
	// persist complete, so disappearance ⇒ the graph change is already on
	// disk. The old some→none transition batched PARALLEL runs into one
	// reveal (owner 2026-09-28): with serialized audits, the first run's
	// merge is its own graph change and must surface immediately, not wait
	// for the whole feed to drain. A redundant fetch on aborted runs is
	// free — the same doctrine as the deletion-refresh path below.
	// Tracked by ROW id (the registry JOB key — source id, or "src#i" for
	// chunk jobs), NOT chatId: chatId-scoping re-batched per-chunk jobs
	// into one end-of-import reveal (the exact bug this rule exists to
	// prevent — a chunk's row leaving IS its merge landing).
	const [pipelineRuns, setPipelineRuns] = useState<{ id: string; chatId: string; title: string; phase: string; startedAt: number }[]>([]);
	const rowIdsRef = useRef<Set<string>>(new Set());
	const readPipelineStatus = useCallback(() => {
		fetch("/api/graph/status")
			.then((res) => res.json() as Promise<{ runs: typeof pipelineRuns }>)
			.then(({ runs }) => {
				setPipelineRuns(runs);
				const ids = new Set(runs.map((r) => r.id));
				if ([...rowIdsRef.current].some((id) => !ids.has(id))) setRefreshTick((t) => t + 1);
				rowIdsRef.current = ids;
			})
			.catch(() => {}); // status is cosmetic — never surface read errors
	}, []);
	// PUSH (S7, 2026-10-02): the standing 2s poll is RETIRED — the
	// extraction registry announces every phase transition and every
	// finish (activity-changed), so each read lands exactly when truth
	// moved. The per-chunk reveal semantics are PRESERVED event-for-event:
	// setPhase + finishExtraction fire per part, so a chunk's row leaving
	// is still its own, immediately-visible merge landing. Debounced (the
	// S4 law); resync heals a reconnect that ate events.
	const statusDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("activity-changed", () => {
		if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		statusDebounceRef.current = setTimeout(() => {
			statusDebounceRef.current = undefined;
			readPipelineStatus();
		}, 250);
	});
	useServerResync(() => readPipelineStatus());
	useEffect(() => {
		readPipelineStatus();
		return () => {
			if (statusDebounceRef.current) clearTimeout(statusDebounceRef.current);
		};
	}, [readPipelineStatus]);

	// Graph pipeline costs (2026-09 cost metrics wave): the cumulative fold
	// of the usage channels (chat + notes extraction runs; the dead namer's
	// channel is not displayed anymore, owner 2026-09-24)
	// behind the bottom-left cost pill. Fetched once on mount and refetched
	// when a pipeline run finishes (running -> none) so fresh spend lands
	// without a manual reload. Best-effort: a fetch failure never blocks
	// the view — the pill just stays on its last numbers.
	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const refreshCosts = useCallback(() => {
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshCosts();
	}, [refreshCosts]);
	// The same disappearance rule as the snapshot refresh (owner
	// 2026-09-28): usage persists per JOB (per-chunk jobs), so costs refresh
	// per job row — not only when the whole feed drains.
	const prevRunIds = useRef(new Set<string>());
	useEffect(() => {
		const gone = [...prevRunIds.current].some((id) => !pipelineRuns.some((r) => r.id === id));
		if (gone && prevRunIds.current.size > 0) refreshCosts();
		prevRunIds.current = new Set(pipelineRuns.map((r) => r.id));
	}, [pipelineRuns, refreshCosts]);

	/* Deletion refresh (wave 6 chunk A): the DELETE /api/chats/:id response
	   carries the new graphRevision, and the sidebar (which owns the delete
	   flow) announces it as lh:graph-revision. The status poll above can't
	   see a deletion — no pipeline run ever disappears from the feed for
	   it — so this event is the one seam. Refetch the snapshot and the
	   costs on every announcement: deletions are rare, a redundant fetch
	   is free. */
	useEffect(() => {
		const onRevision = () => {
			setRefreshTick((t) => t + 1);
			refreshCosts();
		};
		window.addEventListener("lh:graph-revision", onRevision);
		return () => window.removeEventListener("lh:graph-revision", onRevision);
	}, [refreshCosts]);

	/* Live rename labels (rename-shuffle fix, 2026-09-23): a session
	   rename anywhere (sidebar inline row, chat header) announces itself
	   as lh:chat-renamed {id, title} — and the birth-session partition
	   means that title IS the cluster label. The label update goes
	   through the renderer's label-only channel (setClusterLabels): NO
	   new snapshot object, NO setData, NO geometry rebuild — so the
	   position ledger can't assert itself and a pending drag commit
	   survives. The sessions map (the detail card's provenance line)
	   patches in place; a tick bump re-renders the view so an open
	   detail card reads the fresh title. Unlabeled clusters keep their
	   hull-only silence — the null-label guard lives in the channel
	   (applyClusterLabels): a rename can't reach a gone record. */
	const [, setLabelTick] = useState(0);
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id?: string; title?: string }>).detail ?? {};
			if (typeof id !== "string" || typeof title !== "string" || id === "" || title === "") return;
			const snap = snapshotRef.current;
			if (snap != null) renameSessionsPatch(snap, id, title);
			rendererRef.current?.setClusterLabels(new Map([[id, title]]));
			setLabelTick((t) => t + 1);
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	// The node context menu (node interlude): right-click a node → Delete.
	// The anchor is a zero-size div positioned at the pointer inside the
	// canvas container — MenuShell's placement machine measures it like
	// any element. Camera moves close the menu (it would float stale);
	// the dismissal contract is the sidebar's (wave 6).
	const [ctxNode, setCtxNode] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
	const ctxAnchorRef = useRef<HTMLDivElement | null>(null);
	const [deletingNode, setDeletingNode] = useState<{ id: string; name: string } | null>(null);
	useEffect(() => {
		if (ctxNode === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxNode(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxNode(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxNode]);

	// Layout (Option A): the positions ledger (written by the server's
	// incremental settle after every merge) IS the layout — the renderer
	// receives it as frozen data. The local one-shot forceAtlas2 pass runs
	// ONLY as a fallback when the ledger is absent (a graph never merged
	// through the pipeline, e.g. tests or a fresh install).
	useEffect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		// The ledger path: every positioned node uses its resting position;
		// nodes the ledger doesn't know yet (raced mid-settle) fall through
		// to seeded scatter below.
		const ledger = snapshot.positions;
		if (ledger) {
			const positions = new Map<string, { x: number; y: number }>();
			for (const node of snapshot.nodes) {
				const p = ledger[node.id];
				if (p) positions.set(node.id, { x: p.x, y: p.y });
			}
			if (positions.size > 0) {
				// Hygiene (2026-09-23 fix wave): nodes the ledger doesn't know
				// yet (raced mid-settle) get seeded ring positions instead of
				// the old ?? 0 origin dump.
				posRef.current = seedMissingNodePositions(snapshot.nodes, positions);
				return () => {
					posRef.current = null;
				};
			}
		}
		// Bootstrap fallback: the ledger is absent (fresh graph) — run
		// the SAME engine the server settle uses (d3-force via
		// incrementalLayout, seeded deterministic) and freeze the result.
		// Deterministic for a given node set across remounts.
		posRef.current = incrementalLayout(snapshot.nodes, snapshot.edges, new Map());
		return () => {
			posRef.current = null;
		};
	}, [snapshot]);

	// Construct the renderer once the canvas exists; destroy when it goes
	// away (the empty-graph placeholder replaces it). The callbacks are
	// created once and read through refs, so they never go stale.
	const isEmpty = snapshot === null || snapshot.nodes.length === 0;
	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		// Persisted camera (2026-09-15): the graph reopens exactly where the
		// user left it — zoom AND pan, in localStorage (per-device view
		// state, deliberately NOT the server settings ledger). Absent or
		// corrupt → undefined → the renderer fits on first open, ever.
		let initialCamera: { k: number; x: number; y: number } | null = null;
		try {
			const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as { k?: unknown; x?: unknown; y?: unknown };
				if (
					typeof parsed.k === "number" && Number.isFinite(parsed.k) && parsed.k > 0 &&
					typeof parsed.x === "number" && Number.isFinite(parsed.x) &&
					typeof parsed.y === "number" && Number.isFinite(parsed.y)
				)
					initialCamera = { k: parsed.k, x: parsed.x, y: parsed.y };
			}
		} catch {
			// Corrupt entry → treat as absent; the renderer fits.
		}
		// Debounced camera writes: a pan emits hundreds of transforms per
		// second; one trailing write per quiet spell is plenty.
		let cameraTimer: ReturnType<typeof setTimeout> | null = null;
		let lastCamera: { k: number; x: number; y: number } | null = null;
		const persistCamera = (t: { k: number; x: number; y: number }) => {
			lastCamera = t;
			if (cameraTimer) clearTimeout(cameraTimer);
			cameraTimer = setTimeout(() => {
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(t));
				} catch {
					// Storage full/blocked: camera persistence is best-effort.
				}
			}, 250);
		};
		const renderer = new GraphCanvasRenderer(
			canvas,
			{
				onSelect: (nodeId, pos) => {
					const snap = snapshotRef.current;
					const node = snap?.nodes.find((n) => n.id === nodeId);
					if (!snap || !node) return;
					setSelected({
						node,
						sourceIds: snap.nodeSessions[node.id] ?? [],
						anchor: pos,
					});
				},
				onStageClick: () => setSelected(null),
				// Right-click → the node context menu (node interlude). Null
				// (empty stage) closes a stale menu; a pick opens one anchored
				// at the pointer. The name comes from the snapshot — what the
				// canvas shows is what the menu and dialog speak.
				onContext: (nodeId, pos) => {
					if (nodeId === null) {
						setCtxNode(null);
						return;
					}
					const node = snapshotRef.current?.nodes.find((n) => n.id === nodeId);
					if (!node) return;
					setCtxNode({ id: node.id, name: node.name, x: pos.x, y: pos.y });
				},
				// Any camera move detaches the card from its node — close
				// it, and (debounced) remember where the camera stands. The
				// context menu closes with it: a menu floating over a moved
				// graph is anchored to nothing.
				onCameraMove: (t) => {
					setSelected(null);
					setCtxNode(null);
					persistCamera(t);
				},
				// Live physics settled: persist the new rest state. Fire-and-
				// forget — the next snapshot fetch carries the ledger anyway.
				onCommit: (positions) => {
					void fetch("/api/graph/positions", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(positions),
					}).catch((err) => console.error("[graph] positions commit failed", err));
				},
			},
			initialCamera,
		);
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			// Flush a pending camera write so an unmount <250ms after a
			// move still persists the user's last standpoint.
			if (cameraTimer && lastCamera) {
				clearTimeout(cameraTimer);
				cameraTimer = null;
				try {
					localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(lastCamera));
				} catch {
					// best-effort
				}
			}
			renderer.destroy();
		};
	}, [isEmpty]);

	// Feed #1 — data: positions + edges + clusters + resolved colors. Runs
	// after the layout effect (same commit, declaration order) and after
	// the construct effect, so the renderer exists and positions are fresh.
	useEffect(() => {
		const renderer = rendererRef.current;
		const positions = posRef.current;
		if (!renderer || !snapshot || snapshot.nodes.length === 0 || !positions) return;
		renderer.setData({
			nodes: snapshot.nodes.map((n) => ({
				id: n.id,
				x: positions.get(n.id)?.x ?? 0,
				y: positions.get(n.id)?.y ?? 0,
				label: n.name,
			})),
			edges: snapshot.edges.map((e) => ({ from: e.from, to: e.to })),
			logicalEdges: snapshot.logicalEdges.map((e) => ({ from: e.from, to: e.to })),
			impLinks: snapshot.impLinks,
			clusters: snapshot.clusters.map((c) => ({ id: c.id, label: c.label, members: c.members })),
			colors: {
				node: tokenHex(NODE_COLOR_TOKEN),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			// Match the app typography (Geist via the body's stack).
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
	}, [snapshot, isEmpty]);

	// Feed #2 — settings: just marks the frame dirty. No rebuild, no
	// re-layout, no camera touch (the whole point of the new renderer).
	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(deferredSettings);
	}, [deferredSettings, isEmpty]);

	// Feed #3 — visibility: hidden nodes drop out of rendering, picking,
	// hover, AND labels; edges drop when either endpoint is hidden.
	useEffect(() => {
		rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
		// The open detail card cannot outlive its node's visibility.
		setSelected((sel) => (sel && visibleIds.has(sel.node.id) ? sel : null));
	}, [visibleIds, query]);

	// Feed #4 — region tuning. `isEmpty` in the deps (same as Feed #2):
	// the settings fetch resolves BEFORE the snapshot creates the renderer,
	// so the load-time run hits a null renderer and would never re-fire —
	// the renderer would silently keep the default tuning forever.
	useEffect(() => {
		rendererRef.current?.setRegionTuning(regionTuning);
	}, [regionTuning, isEmpty]);

	// Feed #5 — physics tuning: rebuilds the live sim in place (drag pins
	// survive; a mid-settle change re-anneals, the honest response). Same
	// isEmpty dep as Feed #4 — see there.
	useEffect(() => {
		rendererRef.current?.setPhysicsTuning(physicsTuning);
	}, [physicsTuning, isEmpty]);

	// Position the detail card: below the clicked node, flipped above near
	// the bottom edge, clamped horizontally. Imperative (ref + layout effect,
	// before paint) because the flip needs the card's measured height.
	useLayoutEffect(() => {
		const card = cardRef.current;
		const container = containerRef.current;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(
			Math.max(selected.anchor.x - width / 2, margin),
			Math.max(container.clientWidth - width - margin, margin),
		);
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) {
			top = Math.max(selected.anchor.y - gap - height, margin);
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	}, [selected]);

	return (
		<div className="relative h-full w-full">
			{isEmpty ? (
				// The empty graph keeps the first action clear without zero-valued statistics.
				<div className="flex h-full w-full items-center justify-center px-4">
					<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
						<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
						<div className="text-lg font-medium text-foreground">Knowledge graph</div>
						<p className="max-w-sm text-sm">
							Start a session or import notes to build your graph.
						</p>
					</div>
				</div>
			) : (
				<div ref={containerRef} className="relative h-full w-full">
					{/* THE single canvas: every layer (hulls, edges, nodes, both
					    label systems, hover) draws into it, once per frame. */}
					<canvas ref={canvasRef} className="block h-full w-full touch-none" />
					{/* The context menu's anchor: a zero-size point at the
					    right-click position (canvas-relative == container-relative,
					    the canvas fills this div). */}
					{ctxNode !== null && (
						<div
							ref={ctxAnchorRef}
							style={{ position: "absolute", left: ctxNode.x, top: ctxNode.y, width: 0, height: 0 }}
						/>
					)}
				</div>
			)}

			{/* The node context menu (node interlude): Delete is its one action
			    (the same MenuShell discipline as the sidebar's session menu —
			    placement, focus, arrow cycling; the dismissal effect above owns
			    the contract). */}
			{ctxNode !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="node-context-menu"
					preferredSide="down"
					menuClass="flex w-fit flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="ctx-node-delete"
						onClick={() => {
							setDeletingNode({ id: ctxNode.id, name: ctxNode.name });
							setCtxNode(null);
						}}
						className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
					>
						Delete
					</button>
				</MenuShell>
			)}

			{/* The full-death confirm dialog (node interlude) — portaled to
			    body by the component itself, lives here for state locality. */}
			<DeleteNodeDialog
				nodes={deletingNode ? [deletingNode] : null}
				onClose={() => setDeletingNode(null)}
				onDeleted={(nodeIds, graphRevision) => {
					// Close the dialog; close the detail card if it pointed here
					// (the refetch would close it anyway, but the same frame
					// should not show a card for a node the user just killed).
					setDeletingNode(null);
					if (selected && nodeIds.includes(selected.node.id)) setSelected(null);
					// The wave-6 chain: every listener refetches on this. Clusters
					// shrink / unrender below the minimum on the server's read.
					window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision } }));
				}}
			/>



			{/* Legend + filters: search box and per-state toggle rows. */}
			{/* Top-right controls — separate floating containers (owner,
			    graph-view round 2). Row order (2026-09-17): search,
			    coverage, import, gear — coverage sits between search and
			    import; the gear keeps the corner. items-start (not center)
			    so the search container's no-match note can grow downward
			    without shifting its siblings — every control is 36px tall
			    (header band, 2026-09-20), top alignment pins the row.
			    Coverage renders even when the graph is EMPTY — an empty
			    graph with unextracted sessions is exactly when it matters
			    (extract → the graph gains nodes).
			    lh-no-drag (2026-09-17): home.tsx's floating drag strip
			    underlays this row — Electron's drag mask ignores z-index,
			    so without an explicit carve-out the controls were
			    unclickable in the desktop app (owner report). The old
			    flex-wrap (narrow-window wave, 2026-09-17) folded the row
			    onto two lines below the sidebar threshold — owner rejected
			    it (2026-09-20): one row always, the search shrinks (see
			    the header-band comment on the column below). */}
			{/* Header band (owner, 2026-09-20): the controls sit IN the
			    header's visual row — top-2 aligns with the sidebar toggle's
			    band (header py-2, toggle h-9), every control slimmed to 36px.
			    The width cap lives HERE on the absolute element (100% resolves
			    against the full-bleed parent) — the row NEVER wraps (owner
			    rejected the two-row fold); in narrow windows the search is
			    the flexible element and shrinks instead. */}
			<div className="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
			{/* z-20 (2026-09-20): the row paints above the cost number below
			    it — without this, the later-in-DOM cost control layered over
			    the settings/coverage dropdowns (owner report), still hoverable
			    and clickable on top of them. The row is a stacking context, so
			    its open dropdowns cover the number; clicks land on the panel. */}
			<div className="relative z-20 flex min-w-0 items-start gap-2">
				{/* The actions row (empty-graph chrome wave, owner 2026-09-25):
				    Import Notes always — the empty graph's entry point; search +
				    settings only when nodes exist, fading in on their mount. */}
				<GraphChromeRow
					isEmpty={isEmpty}
					query={query}
					onQuery={setQuery}
					noMatch={snapshot !== null && visibleIds.size === 0 && query.trim() !== ""}
					importing={importing}
					searchInputRef={searchInputRef}
					fileInputRef={fileInputRef}
					onImportFiles={onImportFiles}
					settings={settings}
					changeSettings={changeSettings}
					onOpenChains={() => setChainsOpen(true)}
				/>
			</div>

			<NotesImportErrors errors={notesImport.errors} />
			{/* Top-right tail (owner, 2026-09-20): the pipeline cost number —
			    just a number, hover-highlighted, dropdown breakdown — then
			    the running-pipeline pills under it. Lives BELOW the actions
			    row so narrow windows can never push it over the composer
			    the way the old bottom-left stack did; the whole top-right
			    cluster is one column, right-aligned. */}
			{costs && costs.runs.length > 0 && <GraphCostControl costs={costs} />}
			{pipelineRuns.map((run) => (
				<div
					key={run.id}
					className="flex items-center gap-2 rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
				>
					<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
					<span className="capitalize">{run.phase}</span>
					<span className="max-w-48 truncate text-foreground">{run.title}</span>
					<span className="tabular-nums">{Math.max(0, Math.round((Date.now() - run.startedAt) / 1000))}s</span>
				</div>
			))}
			</div>

			{selected && !isEmpty && (
				<div
					ref={cardRef}
					// Positioned imperatively in the layout effect above; hidden
					// until placed so the flip never flashes in the wrong spot.
					style={{ visibility: "hidden", left: 0, top: 0 }}
					// lh-no-drag: the card is placed anywhere on the canvas —
					// when it lands in the top strip it must stay interactive
					// over home.tsx's drag surface (2026-09-17).
					className="lh-no-drag absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
				>
					<div className="text-sm font-medium leading-snug">{selected.node.name}</div>
					<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
					{selected.sourceIds.length > 0 ? (
						<div className="mt-3 flex flex-col gap-1">
							<div className="text-xs text-muted-foreground">Sessions</div>
							{selected.sourceIds.map((sourceId) => {
								// An imported-notes file: a STATIC entry — the path,
								// plain text, never a link (no session to open).
								if (snapshot?.fileSources?.[sourceId] !== undefined) {
									return (
										<div key={sourceId} className="flex items-center gap-1.5">
											<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">
												{snapshot.fileSources[sourceId]}
											</span>
										</div>
									);
								}
								// A real session: deep-linkable provenance.
								return (
									<div key={sourceId} className="flex items-center gap-1.5">
										<Link
											href={propositionSessionHref(selected.node, sourceId)}
											scroll={false}
											className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
										>
											{snapshot?.sessions[sourceId] ?? sourceId}
										</Link>
									</div>
								);
							})}
						</div>
					) : (
						<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
					)}
				</div>
			)}
			{/* The chain table overlay (chains-overlay plan, 2026-09-29):
			    ABSOLUTE INSIDE the graph area (the session-overlay idiom —
			    never a body portal) so the app chrome stays sharp and
			    reachable; the overlay itself is read-only toward the graph
			    and owns its selection.
			    LAST CHILD OF THE ROOT, DELIBERATELY (owner, 2026-09-29
			    night): app-region subtraction resolves by DOM order, not
			    z-index — mounted earlier, the chrome's lh-no-drag column
			    punched dead zones through the overlay's TopBar drag band
			    (over the counts, around the search field). A full-bleed
			    surface covering a drag band must paint AFTER everything it
			    covers. (DeleteNodeDialog is body-portaled — DOM-irrelevant
			    here.) */}
			<ChainTableOverlay
				open={chainsOpen && !isEmpty}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					// Resolve ids → nodes against the live snapshot; the
					// caller holds the pick set (count + seed).
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>		</div>
	);
}
