/**
 * Graph render settings: the shape, the defaults, the sanitizer, and the
 * slider mapping (log-scaled, default-centered) — shared by the client (components/graph-canvas.ts,
 * graph-view.tsx), the server store (src/store/render-settings.ts, which
 * persists them to data/render-settings.json), and the API route.
 *
 * This module is pure: no DOM, no d3, no node APIs — safe everywhere.
 *
 * Settings are server-persisted (render-settings.json); the localStorage era
 * is over. Whatever arrives from disk or the network is passed through
 * sanitizeRenderSettings before use — never trusted raw.
 *
 * SIZE SEMANTICS (2026-09-15 pivot): nodeSize, labelSize, arrowLength and
 * regions.dilation are WORLD UNITS — the same law as the physics spacings.
 * The world scale is canonical: identical settings render identically at
 * any graph size, at any zoom. (They were "screen px at fit zoom" before,
 * which made node sizes a function of graph extent — the small-graph bug.)
 *
 * The labelZoom semantics: the sigma-compatible "camera ratio" threshold
 * (1 = fit zoom, SMALLER = zoomed in). Node labels show at ratio <= labelZoom
 * and cross-fade with the cluster labels across a span proportional to the
 * gate (see LABELS_FADE_RATIO in the renderer). Persisted values keep these
 * units across the renderer swap.
 *
 * SLIDER LADDERS (2026-09-17, user-directed): every NON-physics knob moves on
 * a hand-authored 11-stop ladder — the classic two-per-octave nice-number
 * series (x1.5 / x1.33 alternation: ...1, 1.5, 2, 3, 4, 6, 8, 12...) — with
 * the DEFAULT dead-center at position 50 (slider step 10, one stop per
 * detent). No more log-slider artifacts like 2.18137...977: a knob's possible
 * values ARE the ladder, the sanitizer snaps any incoming value to the
 * nearest entry, and out-of-range snaps to the end. Physics keeps the
 * fine-grained log sliders (user: "very fine tunable... good as they are").
 */

import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
} from "./layout.ts";

export interface GraphRenderSettings {
	/** Semantic stamp for the size-unit pivot (2026-09-15): "world" =
	 *  nodeSize/labelSize/arrowLength/regions.dilation are WORLD units;
	 *  absent = the old "screen px at fit zoom" semantics — the
	 *  sanitizer resets those four fields (their meaning changed, not
	 *  their magnitude) and keeps everything else. */
	sizeUnits: "world";
	nodeSize: number;
	edgeWidth: number;
	arrowLength: number;
	/** Camera-ratio threshold for node labels (see module doc). */
	labelZoom: number;
	/** Node + hover label font size, WORLD units (scales with camera). */
	labelSize: number;
	/** Toggle for the cluster region labels (hulls always draw). */
	clusterLabels: boolean;
	/** Cluster label font size, px on screen (camera-compensated —
	 *  constant at any zoom, unlike labelSize which scales with the
	 *  graph). Defaults to the old REGION_LABEL_SIZE constant (14). */
	clusterLabelSize: number;
	/** Region rendering (the blurred cluster tints). Server-persisted
	 *  since 2026-09-13 (user request) — was session-only dev state. */
	regions: RegionTuning;
	/** Live-sim physics + inference-depth anchoring. Server-persisted
	 *  since 2026-09-13 (user request) — was session-only dev state. */
	physics: PhysicsTuning;
}


const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Coerce arbitrary JSON (server file, network body, localStorage leftovers)
 * into valid settings: missing keys fall back to defaults, out-of-range
 * values clamp, wrong types reset. Never throws.
 */
export function sanitizeRenderSettings(raw: unknown): GraphRenderSettings {
	const r = (raw ?? {}) as Partial<GraphRenderSettings>;
	// Ladder knob: any finite value snaps to the nearest ladder entry (ties
	// break low); non-numbers fall back to the default (dead-center anyway).
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	// The size-unit pivot (2026-09-15): pre-"world" files stored sizes in
	// "screen px at fit zoom" — a unit whose meaning depended on the
	// graph's own extent (THE small-graph bug). Those values cannot be
	// carried into world units honestly, so they reset to defaults; the
	// reference default IS the old tuned look expressed in world units.
	const legacySizes = r.sizeUnits !== "world";
	return {
		sizeUnits: "world",
		nodeSize: legacySizes ? DEFAULT_RENDER_SETTINGS.nodeSize : ladd(r.nodeSize, NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize),
		edgeWidth: ladd(r.edgeWidth, EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth),
		arrowLength: legacySizes ? DEFAULT_RENDER_SETTINGS.arrowLength : ladd(r.arrowLength, ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength),
		labelZoom: ladd(r.labelZoom, LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom),
		labelSize: legacySizes ? DEFAULT_RENDER_SETTINGS.labelSize : ladd(r.labelSize, LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize),
		clusterLabels:
			typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
		clusterLabelSize: ladd(
			r.clusterLabelSize,
			CLUSTER_LABEL_SIZE_LADDER,
			DEFAULT_RENDER_SETTINGS.clusterLabelSize,
		),
		// Nested sections (2026-09-13): old files lack them → defaults.
		// Legacy files also reset regions.dilation (its units changed with
		// the pivot); the rest of the section's semantics are untouched.
		regions: legacySizes
			? { ...sanitizeRegionTuning(r.regions), dilation: DEFAULT_REGION_TUNING.dilation }
			: sanitizeRegionTuning(r.regions),
		physics: sanitizePhysicsTuning(r.physics),
	};
}

// ─── Region + physics tuning (moved from the renderer, 2026-09-13) ─────────────
//
// The renderer's region/physics controls became USER-FACING persisted
// settings: one shape + one sanitizer in core, consumed by the settings
// store (this file's schema), the panel, and the renderer's
// setRegionTuning/setPhysicsTuning. Every clamp below is a SWEEP-VALIDATED
// safe range (2026-09-13, real graph, renderer's exact sim): each field at
// both range ends AND all four range corners settles cleanly — no NaN, no
// explosion (linkStrength ≥ 8 explodes the layout, 5 wobbles; cap 4),
// no non-settle (velocityDecay 0 never damps; floor 0.1), no 3x sprawl
// (gravity 0 / charge -1000 excluded). 2026-09-17: CHARGE_RANGE
// narrowed to [120, 480] around the new −240 default — strictly inside
// the validated [30, 480], so every corner stays sweep-safe.

/** Region rendering knobs (the blurred cluster tints). */
export interface RegionTuning {
	/** Dilation half-width of the round-cap edge strokes, WORLD units
	 *  (the expansion of the cluster skeleton). */
	dilation: number;
	/** Region softness: the blur's reach, WORLD units (3 box-blur
	 *  passes ≈ Gaussian). The 2026-09-15 world-unit pivot ended the
	 *  bitmap-px era — the old reach scaled with the graph's span
	 *  (blur × span / bitmap), so the same value read 6× softer on a
	 *  338-node graph than on a 13-node one. Now the reach is canonical
	 *  like dilation; the renderer rasterizes it (round to bitmap px,
	 *  floor 1px when the graph out-resolves the blur). */
	blur: number;
	/** Max bitmap dimension (cell = worldSpan / this). Fixed set:
	 *  see REGION_BITMAP_OPTIONS (dropdown in the panel). */
	bitmap: number;
	/** Region alpha, applied ONCE after the blur (dilate at full
	 *  opacity → blur → scale). Constant interior, soft edges; overlaps
	 *  of any count never stack (DECIDED 2026-09-14 — per-stroke alpha
	 *  accumulated through source-over and double-counted orphans). */
	edgeAlpha: number;
	/** THE off switch (user 2026-09-15): false = the renderer never runs
	 *  the region build — no splat, no blur, no readback, no bitmap
	 *  allocation, no blit. Compute skipped, not just paint hidden.
	 *  Cluster labels are decoupled and follow `clusterLabels`. */
	enabled: boolean;
}

export const REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512] as const;
export const DEFAULT_REGION_TUNING: RegionTuning = {
	dilation: 20,
	// New default 40 (owner, 2026-10-07): softer, wider region tints.
	blur: 40,
	bitmap: 256,
	edgeAlpha: 0.2,
	enabled: true,
};

/** Nearest member of a fixed option set (dropdowns have no free values). */
function snapToOption(value: number, options: readonly number[]): number {
	return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0] as number);
}

/** Clamp/validate a region tuning. `bitmap` snaps to the nearest allowed
 *  option (a fixed set — dropdown, not a free number). */
export function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning {
	const d = DEFAULT_REGION_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	const bitmap = num(input?.bitmap, d.bitmap);
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	return {
		dilation: ladd(input?.dilation, REGION_DILATION_LADDER, d.dilation),
		blur: ladd(input?.blur, REGION_BLUR_LADDER, d.blur),
		bitmap: snapToOption(bitmap, REGION_BITMAP_OPTIONS),
		edgeAlpha: ladd(input?.edgeAlpha, REGION_EDGE_ALPHA_LADDER, d.edgeAlpha),
		// Old persisted files predate the switch: missing → on (the look
		// users tuned); only an explicit false turns regions off.
		enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
	};
}

/** Live-sim physics controls (user-facing since 2026-09-13): every value
 *  feeds createGraphSimulation — the SAME engine the server settle runs —
 *  so tuning the feel changes exactly what a drag relaxes toward. */
export interface PhysicsTuning {
	/** Node repulsion (d3 charge, negative = push apart). */
	chargeStrength: number;
	/** Edge attraction: link-spring stiffness multiplier (1 = d3 default). */
	linkStrength: number;
	/** Link spring rest length (world units). */
	linkDistance: number;
	/** Central pull toward the graph centroid. */
	gravity: number;
	/** Per-cluster pull toward the cluster centroid. 0 = off. */
	clusterPull: number;
	/** Per-tick velocity damping (d3 default 0.4). */
	velocityDecay: number;
	/** Inference-depth anchoring mode (see DepthAnchor in core). */
	depthMode: DepthAnchorMode;
	/** Depth-anchor pull strength. */
	depthStrength: number;
	/** Spacing between inference levels (world units). */
	depthSpacing: number;
	/** Inner ring radius, radial mode (world units). */
	depthBaseRadius: number;
}

export const DEFAULT_PHYSICS_TUNING: PhysicsTuning = {
	chargeStrength: CHARGE_STRENGTH,
	linkStrength: 1,
	linkDistance: LINK_DISTANCE,
	gravity: INCREMENTAL_GRAVITY,
	clusterPull: CLUSTER_PULL_STRENGTH,
	velocityDecay: 0.4,
	depthMode: "off",
	// 0.8 by sweep on the real graph: 215/216 arrows read upward with
	// organic sag (mean |dev| from level ~34u at spacing 60); 1.5 gives
	// crisp rows (dev ~18) if the promoted default wants them.
	depthStrength: 0.8,
	depthSpacing: 60,
	depthBaseRadius: 220,
};

/** Clamp anything into a usable tuning (sliders/JSON can be empty/NaN). */
export function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning {
	const d = DEFAULT_PHYSICS_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	return {
		chargeStrength: Math.min(Math.max(num(input?.chargeStrength, d.chargeStrength), CHARGE_RANGE.min), CHARGE_RANGE.max),
		linkStrength: Math.min(Math.max(num(input?.linkStrength, d.linkStrength), LINK_STRENGTH_RANGE.min), LINK_STRENGTH_RANGE.max),
		linkDistance: Math.min(Math.max(num(input?.linkDistance, d.linkDistance), LINK_DISTANCE_RANGE.min), LINK_DISTANCE_RANGE.max),
		gravity: Math.min(Math.max(num(input?.gravity, d.gravity), GRAVITY_RANGE.min), GRAVITY_RANGE.max),
		clusterPull: Math.min(Math.max(num(input?.clusterPull, d.clusterPull), 0), CLUSTER_PULL_RANGE.max),
		velocityDecay: Math.min(Math.max(num(input?.velocityDecay, d.velocityDecay), VELOCITY_DECAY_RANGE.min), VELOCITY_DECAY_RANGE.max),
		depthMode: input?.depthMode === "vertical" || input?.depthMode === "radial" ? input.depthMode : "off",
		depthStrength: Math.min(Math.max(num(input?.depthStrength, d.depthStrength), DEPTH_STRENGTH_RANGE.min), DEPTH_STRENGTH_RANGE.max),
		depthSpacing: Math.min(Math.max(num(input?.depthSpacing, d.depthSpacing), DEPTH_SPACING_RANGE.min), DEPTH_SPACING_RANGE.max),
		depthBaseRadius: Math.min(Math.max(num(input?.depthBaseRadius, d.depthBaseRadius), DEPTH_BASE_RADIUS_RANGE.min), DEPTH_BASE_RADIUS_RANGE.max),
	};
}

// Sizes are WORLD UNITS (the 2026-09-15 pivot — see the ranges block
// below for the full story): the world scale is canonical, identical
// settings render identically at any graph size. The values are the
// 2026-09-13 re-tune (2px at fit on the reference graph) ÷ its kFit 0.69.
// The 2026-09-17 bake: the user's live-tuned values (tuned against the
// real graph after the world-unit pivot), each dead-center on its ladder.
export const DEFAULT_RENDER_SETTINGS: GraphRenderSettings = {
	sizeUnits: "world",
	nodeSize: 2,
	edgeWidth: 1,
	arrowLength: 2,
	// New default 0.5 — displays as 1× on the slider (owner, 2026-10-07:
	// "labels until zoom default one" — the owner speaks in display
	// values, and the display is ratio/0.5). Labels once zoomed past fit.
	labelZoom: 0.5,
	labelSize: 3,
	clusterLabels: true,
	clusterLabelSize: 14,
	regions: DEFAULT_REGION_TUNING,
	physics: DEFAULT_PHYSICS_TUNING,
};

// ─── The slider ladders (2026-09-17) ─────────────────────────────────────────
//
// Non-physics knobs move on hand-authored 11-stop ladders — the classic
// two-per-octave nice-number series (x1.5 / x1.33 alternation: quarter and
// half steps at the low end, integers above) — with the DEFAULT dead-center
// at index 5 / slider position 50. The slider steps by 10: one stop per
// detent, 21 positions → 11 values, all integers or clean fractions. The
// sanitizer snaps ANY incoming value to the nearest entry, so stored files
// can never hold (or render) 2.18137...977-style artifacts.

// Each ladder is authored around its DEFAULT at index 5: five stops down,
// five up, following the x1.5 / x4-3 alternation where it lands clean
// (powers of two at the floors where the series would go fractional).
export const NODE_SIZE_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const EDGE_WIDTH_LADDER = [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6] as const;
export const ARROW_LENGTH_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const LABEL_SIZE_LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;
// Screen px at any zoom (drawn at size / k). 14 = the old REGION_LABEL_SIZE.
export const CLUSTER_LABEL_SIZE_LADDER = [7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28] as const;
// Camera-ratio gates; the DISPLAY ladder reads 1.5×, 2×, 3×, 4×, 6×, 8×,
// 12×, 16×, 24×, 32×, 48× (labelZoomDisplay) with the user's tuned 8×
// (ratio 4) dead-center — it used to sit at the very end of the axis.
// Re-centered on the new default (owner, 2026-10-07): display 1× (ratio
// 0.5) sits dead-center; the upper stops keep the old familiar run, the
// lower stops go finer where the default now lives. Old stored values
// snap to the nearest stop (4 → 3, 24 → 3, 0.75 → 0.75).
export const LABEL_ZOOM_LADDER = [0.125, 0.175, 0.25, 0.35, 0.45, 0.5, 0.75, 1, 1.5, 2, 3] as const;

// ─── Region + physics slider ranges ──────────────────────────────────────────
//
// Same laws as the size sliders: log-scaled, DEFAULT AT 50 (each default is
// the geometric mean of its ends), coarse 5-step tracks. Signed/zeroed
// fields get special treatment:
//   chargeStrength is NEGATIVE — the slider maps |charge| and displays "-x";
//   clusterPull has an OFF zone — position 0 is exactly 0 (see
//   toOffSliderPosition), the log range starts one step in. Blur used to
//   have one too; it's a dropdown since 2026-09-13 (non-integers broke).

export const REGION_DILATION_LADDER = [4, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 120] as const; // world units
// Re-centered on the new default 40 (owner, 2026-10-07): min 10 per the
// owner's suggestion, the old ceiling 120 kept, and every old stop from
// 15 up survives (4/5/7.5 snap to 10).
export const REGION_BLUR_LADDER = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120] as const; // world units
export const REGION_EDGE_ALPHA_LADDER = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1] as const;

export const CHARGE_RANGE = { min: -480, max: -120 } as const; // |gm| = 240 (2026-09-17: default −240, dead-center; a subrange of the sweep-validated [30, 480])
export const LINK_STRENGTH_RANGE = { min: 0.25, max: 4 } as const; // gm = 1
export const LINK_DISTANCE_RANGE = { min: 10, max: 160 } as const; // gm = 40
export const GRAVITY_RANGE = { min: 0.03, max: 0.48 } as const; // gm = 0.12
export const CLUSTER_PULL_RANGE = { min: 0.0225, max: 1 } as const; // gm = 0.15; 0 = off
export const VELOCITY_DECAY_RANGE = { min: 0.18, max: 0.9 } as const; // gm ≈ 0.40
export const DEPTH_STRENGTH_RANGE = { min: 0.2, max: 3.2 } as const; // gm = 0.8
export const DEPTH_SPACING_RANGE = { min: 15, max: 240 } as const; // gm = 60
export const DEPTH_BASE_RADIUS_RANGE = { min: 55, max: 880 } as const; // gm = 220

/** Nearest ladder entry (ties break LOW — deterministic). */
export function snapToLadder(value: number, ladder: readonly number[]): number {
	return ladder.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), ladder[0] as number);
}

/** Ladder index of a value (nearest; ties break low) — the slider position
 *  is index × 10 (step-10 track, 11 stops, default at 50). */
export function ladderIndex(value: number, ladder: readonly number[]): number {
	let best = 0;
	for (let i = 1; i < ladder.length; i++)
		if (Math.abs(ladder[i] as number - value) < Math.abs(ladder[best] as number - value)) best = i;
	return best;
}

/** Setting value → ladder slider position [0, 100]. */
export function toLadderPosition(value: number, ladder: readonly number[]): number {
	return ladderIndex(clampToLadder(value, ladder), ladder) * 10;
}

/** Ladder slider position [0, 100] → setting value (the ladder entry). */
export function fromLadderPosition(position: number, ladder: readonly number[]): number {
	const i = Math.min(Math.max(Math.round(position / 10), 0), ladder.length - 1);
	return ladder[i] as number;
}

/** Clamp a value into the ladder's span (no snapping — bounds only). */
function clampToLadder(value: number, ladder: readonly number[]): number {
	return clamp(value, ladder[0] as number, ladder[ladder.length - 1] as number);
}

/** Off-aware slider mapping (position 0 → value 0 = OFF; the log range
 *  starts one step in). Inverse of fromOffSliderPosition. */
export function toOffSliderPosition(value: number, min: number, max: number): number {
	if (value <= 0) return 0;
	return toSliderPosition(value, min, max);
}

/** Off-aware slider mapping: position 0 → 0 (off), else log-scaled. */
export function fromOffSliderPosition(position: number, min: number, max: number): number {
	if (position <= 0) return 0;
	return fromSliderPosition(position, min, max);
}

/** Setting value → slider position [0, 100] (log scale, default at 50). */
export function toSliderPosition(value: number, min: number, max: number): number {
	const v = clamp(value, min, max);
	const logSpan = Math.log(max / min);
	return (100 * Math.log(v / min)) / logSpan;
}

/** Slider position [0, 100] → setting value (inverse of toSliderPosition). */
export function fromSliderPosition(position: number, min: number, max: number): number {
	const p = clamp(position, 0, 100) / 100;
	const logSpan = Math.log(max / min);
	return min * Math.exp(p * logSpan);
}

/** Display units for labelZoom: ABSOLUTE since 2026-09-17 (ratio / 0.5 —
 *  anchored to the historical pre-bake default, so "8×" keeps its meaning
 *  now that 4 IS the default; the old default-relative form would have
 *  relabeled the user's tuned 8× as "1×"). */
export function labelZoomDisplay(labelZoom: number): string {
	const v = Math.round((labelZoom / 0.5) * 100) / 100;
	return `${v}×`;
}
