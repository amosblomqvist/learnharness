/**
 * Tests for src/core/render-settings.ts — the shared settings contract
 * (shape, defaults, sanitizer, ladder/slider mapping). Pure module, pure
 * tests: whatever JSON arrives from disk or the network goes through
 * sanitizeRenderSettings and must come out valid, never throw.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	ARROW_LENGTH_LADDER,
	CHARGE_RANGE,
	CLUSTER_LABEL_SIZE_LADDER,
	CLUSTER_PULL_RANGE,
	DEFAULT_RENDER_SETTINGS,
	DEPTH_BASE_RADIUS_RANGE,
	DEPTH_SPACING_RANGE,
	DEPTH_STRENGTH_RANGE,
	EDGE_WIDTH_LADDER,
	GRAVITY_RANGE,
	LABEL_SIZE_LADDER,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	NODE_SIZE_LADDER,
	REGION_BLUR_LADDER,
	sanitizeRegionTuning,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	fromLadderPosition,
	fromOffSliderPosition,
	fromSliderPosition,
	labelZoomDisplay,
	ladderIndex,
	sanitizeRenderSettings,
	snapToLadder,
	toLadderPosition,
	toOffSliderPosition,
	toSliderPosition,
} from "../src/core/render-settings.ts";

describe("sanitizeRenderSettings", () => {
	test("garbage in → full defaults out", () => {
		assert.deepEqual(sanitizeRenderSettings(null), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(undefined), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings("junk"), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(sanitizeRenderSettings(42), DEFAULT_RENDER_SETTINGS);
	});

	test("partial input → defaults fill the gaps", () => {
		const s = sanitizeRenderSettings({ sizeUnits: "world", nodeSize: 6 });
		assert.equal(s.nodeSize, 6);
		assert.equal(s.edgeWidth, DEFAULT_RENDER_SETTINGS.edgeWidth);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.labelZoom, DEFAULT_RENDER_SETTINGS.labelZoom);
		assert.equal(s.clusterLabels, DEFAULT_RENDER_SETTINGS.clusterLabels);
		assert.equal(s.clusterLabelSize, DEFAULT_RENDER_SETTINGS.clusterLabelSize); // old files → 14
	});

	test("out-of-range values snap to ladder ends; wrong types reset", () => {
		const s = sanitizeRenderSettings({
			sizeUnits: "world",
			nodeSize: 999,
			edgeWidth: 0,
			arrowLength: -5,
			labelZoom: 100,
			labelSize: "big" as unknown as number,
			clusterLabels: "yes" as unknown as boolean,
			clusterLabelSize: "huge" as unknown as number,
		});
		assert.equal(s.nodeSize, NODE_SIZE_LADDER[NODE_SIZE_LADDER.length - 1]); // snapped to the ladder top
		assert.equal(s.edgeWidth, EDGE_WIDTH_LADDER[0]); // snapped to the ladder floor
		assert.equal(s.arrowLength, ARROW_LENGTH_LADDER[0]);
		assert.equal(s.labelZoom, LABEL_ZOOM_LADDER[LABEL_ZOOM_LADDER.length - 1]);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize); // NaN-safe reset
		assert.equal(s.clusterLabels, DEFAULT_RENDER_SETTINGS.clusterLabels);
		assert.equal(s.clusterLabelSize, DEFAULT_RENDER_SETTINGS.clusterLabelSize); // NaN-safe reset
	});

	test("the ladder law: any finite value snaps to the nearest stop", () => {
		// Stored artifacts like 2.18137...977 (px-at-fit survivors) become
		// nice numbers; nothing non-finite ever enters a file.
		assert.equal(snapToLadder(2.18, NODE_SIZE_LADDER), 2);
		assert.equal(snapToLadder(3.9, NODE_SIZE_LADDER), 4);
		assert.equal(snapToLadder(0.63, NODE_SIZE_LADDER), 0.75); // 0.63 is nearer 0.75 than 0.5
		// Ties break low (deterministic, and the lower stop is the
		// conservative direction for every knob).
		assert.equal(snapToLadder(1.25, NODE_SIZE_LADDER), 1);
		// The display cluster-label ladder snaps too.
		assert.equal(sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 21 }).clusterLabelSize, 20);
	});

	test("clusterLabelSize snaps to its own ladder", () => {
		// Default 14 is a stop (index 5) → dead-center slider.
		assert.equal(DEFAULT_RENDER_SETTINGS.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER[ladderIndex(14, CLUSTER_LABEL_SIZE_LADDER)]);
		const s = sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 999 });
		assert.equal(s.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER[CLUSTER_LABEL_SIZE_LADDER.length - 1]);
		const s2 = sanitizeRenderSettings({ sizeUnits: "world", clusterLabelSize: 1 });
		assert.equal(s2.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER[0]);
	});

	test("the low ends accept small sizes (ladder floors)", () => {
		const s = sanitizeRenderSettings({ sizeUnits: "world", nodeSize: 0.3, edgeWidth: 0.1, arrowLength: 0.2, labelSize: 0.3 });
		assert.deepEqual(
			{ nodeSize: s.nodeSize, edgeWidth: s.edgeWidth, arrowLength: s.arrowLength, labelSize: s.labelSize },
			{ nodeSize: 0.25, edgeWidth: 0.1, arrowLength: 0.25, labelSize: 0.5 }, // snapped to the ladder floors
		);
	});

	test("a fully valid object passes through unchanged", () => {
		const valid = {
			sizeUnits: "world",
			nodeSize: 4,
			edgeWidth: 2,
			arrowLength: 3,
			labelZoom: 2,
			labelSize: 4,
			clusterLabels: false,
			clusterLabelSize: 20,
			regions: DEFAULT_REGION_TUNING,
			physics: DEFAULT_PHYSICS_TUNING,
		};
		assert.deepEqual(sanitizeRenderSettings(valid), valid); // every value a ladder member
	});

	test("supports settings are GONE (chains-primary, 2026-09-30): stale keys silently drop", () => {
		// Supports edges were retired; showSupports/supportsWidth no longer
		// exist. A legacy file carrying them loads without the keys — the
		// sanitizer drops unknown fields by construction.
		const cleaned = sanitizeRenderSettings({ showSupports: false, supportsWidth: 0.9 } as never);
		assert.equal("showSupports" in cleaned, false);
		assert.equal("supportsWidth" in cleaned, false);
	});

	test("the pre-2026-09-13 stored shape (flat, no regions/physics) still loads", () => {
		// data/render-settings.json on disk predates the nested sections —
		// those loads must get defaults, not crash, not shift anything.
		// It also predates sizeUnits — the sizes reset (below), the flat
		// fields keep their stored values (snapped to the nearest stop).
		const s = sanitizeRenderSettings({ nodeSize: 4, edgeWidth: 1, arrowLength: 5, labelZoom: 0.5, clusterLabels: true });
		assert.deepEqual(s.regions, DEFAULT_REGION_TUNING);
		assert.deepEqual(s.physics, DEFAULT_PHYSICS_TUNING);
		assert.equal(s.nodeSize, DEFAULT_RENDER_SETTINGS.nodeSize); // legacy sizes reset
		assert.equal(s.edgeWidth, 1);
		assert.equal(s.labelZoom, 0.5); // 0.5 IS the dead-center stop now (owner, 2026-10-07)
	});

	test("the 2026-09-15 world-unit pivot: legacy files reset ONLY the size fields", () => {
		// Pre-pivot files stored sizes as "screen px at fit zoom" — a unit
		// whose meaning depended on the graph's own extent. Those values
		// cannot be carried into world units honestly → reset; everything
		// whose semantics did NOT change keeps its stored value.
		const s = sanitizeRenderSettings({
			nodeSize: 2, labelSize: 2, arrowLength: 2,
			edgeWidth: 3, labelZoom: 0.75, clusterLabelSize: 21,
			regions: { dilation: 28, blur: 8.1, bitmap: 512, edgeAlpha: 0.6, enabled: false },
			physics: { linkStrength: 2 },
		});
		assert.equal(s.sizeUnits, "world"); // the sanitizer always stamps
		assert.equal(s.nodeSize, DEFAULT_RENDER_SETTINGS.nodeSize);
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.arrowLength, DEFAULT_RENDER_SETTINGS.arrowLength);
		assert.equal(s.regions.dilation, DEFAULT_REGION_TUNING.dilation);
		// Unchanged semantics survive — snapped to the ladder:
		assert.equal(s.edgeWidth, 3);
		assert.equal(s.labelZoom, 0.75);
		assert.equal(s.clusterLabelSize, 20); // 21 snaps to 20
		assert.equal(s.regions.blur, 10); // 8.1 snaps to the new floor (owner, 2026-10-07)
		assert.equal(s.regions.bitmap, 512);
		assert.equal(s.regions.edgeAlpha, 0.6);
		assert.equal(s.regions.enabled, false);
		assert.equal(s.physics.linkStrength, 2);
	});

	test("a stamped world-unit file keeps its size values", () => {
		const s = sanitizeRenderSettings({ sizeUnits: "world", nodeSize: 6, arrowLength: 8, labelSize: 3 });
		assert.equal(s.nodeSize, 6);
		assert.equal(s.arrowLength, 8);
		assert.equal(s.labelSize, 3);
	});

	test("the 2026-09-17 defaults are the user's live-tuned bake", () => {
		// nodeSize 2, edgeWidth 1, arrowLength 2, labelSize 3, labelZoom
		// 0.5 (displays 1×), dilation 20, blur 40, edgeAlpha 0.2, bitmap
		// 256 — each dead-center on its re-centered ladder (owner, 2026-10-07).
		assert.equal(DEFAULT_RENDER_SETTINGS.nodeSize, 2);
		assert.equal(DEFAULT_RENDER_SETTINGS.edgeWidth, 1);
		assert.equal(DEFAULT_RENDER_SETTINGS.arrowLength, 2);
		assert.equal(DEFAULT_RENDER_SETTINGS.labelSize, 3);
		assert.equal(DEFAULT_RENDER_SETTINGS.labelZoom, 0.5); // displays 1× (owner, 2026-10-07)
		assert.equal(DEFAULT_REGION_TUNING.dilation, 20);
		assert.equal(DEFAULT_REGION_TUNING.blur, 40); // new default (owner, 2026-10-07)
		assert.equal(DEFAULT_REGION_TUNING.edgeAlpha, 0.2);
		assert.equal(DEFAULT_REGION_TUNING.bitmap, 256);
	});

	test("nested sections sanitize: garbage snaps inside them without touching the rest", () => {
		const s = sanitizeRenderSettings({
			sizeUnits: "world",
			nodeSize: 3,
			regions: { blur: -5, bitmap: 999, edgeAlpha: 9 },
			physics: { linkStrength: 99, gravity: 7, depthMode: "sideways" },
		});
		assert.equal(s.nodeSize, 3);
		assert.equal(s.regions.blur, REGION_BLUR_LADDER[0]); // snapped to the ladder floor
		assert.equal(s.regions.bitmap, 512); // snaps to the nearest fixed option
		assert.equal(s.regions.edgeAlpha, 1); // snapped to the ladder top
		assert.equal(s.regions.dilation, DEFAULT_REGION_TUNING.dilation);
		assert.equal(s.physics.linkStrength, 4); // sweep-validated cap
		assert.equal(s.physics.gravity, 0.48);
		assert.equal(s.physics.depthMode, "off"); // unknown mode → off
		assert.equal(s.physics.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
	});

	test("the pre-wave stored shape (no labelSize) still loads", () => {
		// localStorage-era records lacked labelSize — must not shift anything.
		const s = sanitizeRenderSettings({ sizeUnits: "world", nodeSize: 4, edgeWidth: 1, arrowLength: 5, labelZoom: 0.5, clusterLabels: true });
		assert.equal(s.labelSize, DEFAULT_RENDER_SETTINGS.labelSize);
		assert.equal(s.nodeSize, 4);
		assert.equal(s.labelZoom, 0.5); // 0.5 IS the dead-center stop now
	});
});

describe("ladder mapping (11 stops, default-centered)", () => {
	const LADDERS: [string, readonly number[], number][] = [
		["nodeSize", NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize],
		["edgeWidth", EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth],
		["arrowLength", ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength],
		["labelSize", LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize],
		["labelZoom", LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom],
		["clusterLabelSize", CLUSTER_LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.clusterLabelSize],
		["regions.dilation", REGION_DILATION_LADDER, DEFAULT_REGION_TUNING.dilation],
		["regions.blur", REGION_BLUR_LADDER, DEFAULT_REGION_TUNING.blur],
		["regions.edgeAlpha", REGION_EDGE_ALPHA_LADDER, DEFAULT_REGION_TUNING.edgeAlpha],
	];

	// The dead-center law is restored (owner, 2026-10-07 round 2): the
	// ladders themselves were re-centered so the new defaults — labelZoom
	// 0.5 (displays 1×) and regions.blur 40 — sit at stop #5 again.
	test("every ladder has 11 stops; every default is stop #5 (dead-center)", () => {
		for (const [name, ladder, dflt] of LADDERS) {
			assert.equal(ladder.length, 11, name);
			assert.equal(ladder[5], dflt, name); // default at index 5 → position 50
		}
	});

	test("every value is a nice number (clean decimal, no float artifacts)", () => {
		// The worst-case granularity across all ladders is 1/40 (the
		// edge-alpha floor 0.025); everything else is eighths, quarters,
		// halves, or integers. Nothing like 2.18137...977 can ever persist.
		for (const [name, ladder] of LADDERS) {
			for (const v of ladder) {
				assert.ok(Number.isInteger(v * 40), `${name} stop ${v} isn't a clean fortieth`);
				assert.equal(String(v), `${+v.toFixed(3)}`, `${name} stop ${v} has float noise`);
			}
		}
	});

	test("round-trips: positions 0-100 step 10 hit every stop and back", () => {
		for (const [name, ladder] of LADDERS) {
			for (let i = 0; i < ladder.length; i++) {
				const p = i * 10;
				const stop = ladder[i] as number;
				assert.equal(fromLadderPosition(p, ladder), stop, `${name} @ ${p}`);
				assert.equal(toLadderPosition(stop, ladder), p, `${name} stop ${i}`);
			}
		}
	});

	test("off-ladder positions snap to the nearest stop; extremes clamp", () => {
		for (const [name, ladder] of LADDERS) {
			assert.equal(fromLadderPosition(-20, ladder), ladder[0], name);
			assert.equal(fromLadderPosition(120, ladder), ladder[ladder.length - 1], name);
			// Round-half-up at the 55 midpoint (JS Math.round), so 54 → stop 5
			// and 58 → stop 6 — the slider readout never shows a non-member.
			assert.equal(fromLadderPosition(54, ladder), ladder[5], name);
			assert.equal(fromLadderPosition(58, ladder), ladder[6], name);
		}
	});

	test("display units are absolute (ratio / 0.5): 8× is the tuned default", () => {
		assert.equal(labelZoomDisplay(0.5), "1×");
		assert.equal(labelZoomDisplay(4), "8×"); // plain math (ratio/0.5) — 4 was the old default, 0.5 is the new one
		assert.equal(labelZoomDisplay(0.75), "1.5×");
		assert.equal(labelZoomDisplay(24), "48×");
		assert.equal(labelZoomDisplay(0.25), "0.5×");
		assert.equal(labelZoomDisplay(0.0625), "0.13×"); // rounded to 2 decimals
	});
});

describe("physics sliders (fine-grained log, unchanged 2026-09-17)", () => {
	test("every region/physics default sits dead-center at position 50", () => {
		// Physics keeps the log-slider law: default = geometric mean of the
		// range ends (repulsion maps |charge|; friction tolerates the
		// sub-0.5° drift).
		const pairs: [number, number, number][] = [
			[-CHARGE_RANGE.max, -CHARGE_RANGE.min, -DEFAULT_PHYSICS_TUNING.chargeStrength],
			[LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.linkStrength],
			[LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max, DEFAULT_PHYSICS_TUNING.linkDistance],
			[GRAVITY_RANGE.min, GRAVITY_RANGE.max, DEFAULT_PHYSICS_TUNING.gravity],
			[VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max, DEFAULT_PHYSICS_TUNING.velocityDecay],
			[DEPTH_STRENGTH_RANGE.min, DEPTH_STRENGTH_RANGE.max, DEFAULT_PHYSICS_TUNING.depthStrength],
			[DEPTH_SPACING_RANGE.min, DEPTH_SPACING_RANGE.max, DEFAULT_PHYSICS_TUNING.depthSpacing],
			[DEPTH_BASE_RADIUS_RANGE.min, DEPTH_BASE_RADIUS_RANGE.max, DEFAULT_PHYSICS_TUNING.depthBaseRadius],
		];
		for (const [min, max, d] of pairs) {
			assert.ok(Math.abs(toSliderPosition(d, min, max) - 50) < 0.6, `default ${d} in [${min}, ${max}]`);
		}
		// Off-zone fields: the default sits at 50 INSIDE the on-part.
		assert.ok(Math.abs(toOffSliderPosition(DEFAULT_PHYSICS_TUNING.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) - 50) < 0.6);
	});

	test("the 2026-09-17 charge bump: default −240, dead-center", () => {
		// User: "repulsion default too weak". −240 is the gm of [120, 480] —
		// the range stays inside the sweep-validated [30, 480].
		assert.equal(DEFAULT_PHYSICS_TUNING.chargeStrength, -240);
		assert.ok(Math.abs(toSliderPosition(240, 120, 480) - 50) < 1e-9);
	});

	test("off-slider mapping: position 0 ↔ value 0; the log part round-trips", () => {
		assert.equal(toOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), 0);
		assert.equal(fromOffSliderPosition(0, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), 0);
		const v = fromOffSliderPosition(toOffSliderPosition(0.15, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max), CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max);
		assert.ok(Math.abs(v - 0.15) < 1e-9);
		// One step in (position 5) sits just above the log floor:
		// min * (max/min)^(5/100), NOT the floor itself (that's position 0,
		// the off zone).
		const stepIn = CLUSTER_PULL_RANGE.min * (CLUSTER_PULL_RANGE.max / CLUSTER_PULL_RANGE.min) ** (5 / 100);
		assert.ok(Math.abs(fromOffSliderPosition(5, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) - stepIn) < 1e-9);
	});

	test("blur is WORLD units (2026-09-15): free values, snapped to the ladder", () => {
		// The bitmap-px era ended: the old reach scaled with the graph's
		// span, so a value tuned on a big graph read far too sharp on a
		// small one. It's a canonical world reach now — any stored value
		// snaps to the nearest stop.
		assert.equal(DEFAULT_REGION_TUNING.blur, 40); // new default (owner, 2026-10-07)
		assert.equal(sanitizeRegionTuning({ blur: 3.7 }).blur, 10); // the new floor
		assert.equal(sanitizeRegionTuning({ blur: 7.2 }).blur, 10);
		assert.equal(sanitizeRegionTuning({ blur: -5 }).blur, REGION_BLUR_LADDER[0]);
		assert.equal(sanitizeRegionTuning({ blur: 999 }).blur, REGION_BLUR_LADDER[REGION_BLUR_LADDER.length - 1]);
		assert.equal(sanitizeRegionTuning({ blur: 99 }).blur, 100); // inside the span → nearest stop, not the top
		// Stored blur 0 (the old off zone) snaps back into the ladder.
		assert.equal(sanitizeRegionTuning({ blur: 0 }).blur, REGION_BLUR_LADDER[0]);
	});

	test("enabled is the compute off switch: only an explicit false turns it off", () => {
		// Default on; old persisted files predate the field (missing → on);
		// garbage falls back to on (fail toward the tuned look).
		assert.equal(DEFAULT_REGION_TUNING.enabled, true);
		assert.equal(sanitizeRegionTuning({}).enabled, true);
		assert.equal(sanitizeRegionTuning({ enabled: false }).enabled, false);
		assert.equal(sanitizeRegionTuning({ enabled: true }).enabled, true);
		assert.equal(sanitizeRegionTuning({ enabled: "no" as unknown as boolean }).enabled, true);
		// An explicit false survives even alongside garbage in other fields.
		assert.equal(sanitizeRegionTuning({ enabled: false, blur: 99, bitmap: 99999 }).enabled, false);
	});
});
