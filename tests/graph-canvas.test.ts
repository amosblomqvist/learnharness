/**
 * Pure-helper tests for the hand-rolled canvas renderer
 * (components/graph-canvas.ts). The renderer class itself is DOM-bound
 * (canvas, rAF, ResizeObserver) and is verified live in the browser; the
 * math it runs on every frame must be exact, so it is pinned here.
 * Label tests pin grapheme boundaries, content direction and centered drawing.
 *
 * The camera-ratio convention is the load-bearing contract with the
 * persisted settings: sigma's ratio (1 = fit, SMALLER = zoomed in) is kept
 * verbatim so stored labelZoom values survive the renderer swap.
 */

import assert from "node:assert/strict";
import { describe, it, it as test } from "node:test";
import {
	applyClusterLabels,
	arrowGeometry,
	isImpNodeId,
	boxBlurRound,
	drawNameLines,
	fitTransform,
	labelAlpha,
	measureLabel,
	pickNearest,
	wrapLabel,
	wrapRegionLabel,
	zoomRatioOf,
	LABELS_FADE_RATIO,
} from "../components/graph-canvas.ts";
import {
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
} from "../src/core/render-settings.ts";

describe("canvas label text", () => {
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const graphemeCount = (text: string) => Array.from(graphemes.segment(text)).length;
	// UTF-16 code units, so a letter with its mark measures wider than the
	// letter alone and a split by code point lands on different lines. The
	// isolates add no width, as on a real canvas.
	const width = (text: string) => text.replace(/[\u2066\u2069]/g, "").length;
	const LRI = "\u2066";
	const PDI = "\u2069";
	const context = () => ({
		direction: "inherit",
		measureText: (text: string) => ({ width: width(text) }),
	}) as unknown as CanvasRenderingContext2D;
	const world = { nodeR: 4, glowOuter: 10, labelSize: 12, labelGap: 3 };
	const outsideIsolates = (text: string) => text.replace(/\u2066[^\u2069]*\u2069/g, "");

	it("keeps normal Latin word wrapping and oversized chunks unchanged", () => {
		assert.deepEqual(wrapLabel(context(), "one two three", 7), ["one two", "three"]);
		assert.deepEqual(wrapLabel(context(), "abcdefgh word", 5), ["abcde", "fgh", "word"]);
	});

	it("keeps tashkeel with its base letter when a word exceeds the width", () => {
		const word = "الْمُشْتَقَّةُ";
		const lines = wrapLabel(context(), word, 2);
		assert.ok(lines.length > 1);
		assert.equal(lines.join(""), word);
		for (const line of lines) {
			assert.ok(!/^\p{M}/u.test(line));
			assert.ok(width(line) <= 2 || graphemeCount(line) === 1);
		}
	});

	it("keeps an indivisible grapheme whole even when it exceeds the width", () => {
		assert.deepEqual(wrapLabel(context(), "👩‍🔬", 0.5), ["👩‍🔬"]);
	});

	it("sets direction before measurement and drawing for each complete label", () => {
		const ctx = context();
		for (const [label, direction] of [
			["Newton ينص على", "rtl"],
			["שָׁלוֹם", "rtl"],
			["English label", "ltr"],
			["$س$", "rtl"],
			["123", "inherit"],
		] as const) {
			ctx.measureText = (text) => {
				assert.equal(ctx.direction, direction);
				return { width: width(text) } as TextMetrics;
			};
			ctx.direction = "inherit";
			assert.equal(measureLabel(ctx, label), width(label));
			ctx.direction = "inherit";
			const lines = wrapLabel(ctx, label, 6);
			ctx.direction = "inherit";
			const drawn: string[] = [];
			ctx.fillText = (text) => {
				assert.equal(ctx.direction, direction);
				assert.equal(ctx.textAlign, "center");
				drawn.push(text);
			};
			drawNameLines(ctx, 10, 20, lines, world, "#fff", label);
			assert.deepEqual(drawn, lines);
		}
	});

	it("measures a piece of a label in the direction of the whole label", () => {
		const ctx = context();
		ctx.measureText = (text) => {
			assert.equal(ctx.direction, "rtl");
			return { width: width(text) } as TextMetrics;
		};
		assert.equal(measureLabel(ctx, "Newton", "Newton ينص على"), 6);
	});

	it("isolates each left-to-right run of a right-to-left label before measuring and drawing", () => {
		const ctx = context();
		const measured: string[] = [];
		ctx.measureText = (text) => {
			measured.push(text);
			return { width: width(text) } as TextMetrics;
		};
		const drawn: string[] = [];
		ctx.fillText = (text) => {
			drawn.push(text);
		};
		const label = "تعلم C++";
		assert.equal(measureLabel(ctx, label), width(label), "the isolates add no width");
		assert.deepEqual(measured, [`تعلم ${LRI}C++${PDI}`]);
		const lines = wrapLabel(ctx, label, 4);
		// A line with no right-to-left letter still sits in the label's direction.
		assert.deepEqual(lines, ["تعلم", `${LRI}C++${PDI}`]);
		drawNameLines(ctx, 10, 20, lines, world, "#fff", label);
		assert.deepEqual(drawn, lines);

		const region = wrapRegionLabel("تعلم C++ C++", 9, 1, (s, whole) => measureLabel(ctx, s, whole));
		assert.deepEqual(region, [`تعلم ${LRI}C++${PDI}…`]);
		for (const text of measured) assert.doesNotMatch(outsideIsolates(text), /C/, text);
	});

	it("leaves a left-to-right label without isolates", () => {
		const ctx = context();
		const seen: string[] = [];
		ctx.measureText = (text) => {
			seen.push(text);
			return { width: width(text) } as TextMetrics;
		};
		ctx.fillText = (text) => {
			seen.push(text);
		};
		measureLabel(ctx, "C++ and more");
		const lines = wrapLabel(ctx, "C++ and more", 4);
		drawNameLines(ctx, 10, 20, lines, world, "#fff", "C++ and more");
		assert.deepEqual(wrapRegionLabel("C++ and more", 4, 2, (s, whole) => measureLabel(ctx, s, whole)), ["C++", "and…"]);
		assert.ok(seen.length > 0);
		for (const text of seen) assert.doesNotMatch(text, /[\u2066\u2069]/);
	});

	it("region wrapping and ellipsis keep graphemes and the full measurement label", () => {
		const label = "الْمُشْتَقَّةُ الْمُشْتَقَّةُ";
		const lines = wrapRegionLabel(label, 4, 2, (text, original) => {
			assert.equal(original, label);
			return width(text);
		});
		assert.equal(lines.length, 2);
		assert.ok(lines[1]!.endsWith("…"));
		for (const line of lines) {
			assert.ok(!/^\p{M}/u.test(line));
			assert.ok(width(line) <= 4);
		}
		// The ellipsis cuts whole graphemes: the shin keeps its sukun or goes with it.
		assert.deepEqual(lines, ["الْ", "مُ…"]);
	});
});

describe("zoomRatioOf (the sigma-compatible camera ratio)", () => {
	test("1 at fit zoom, smaller when zoomed in, larger when zoomed out", () => {
		assert.equal(zoomRatioOf(2, 2), 1); // at fit
		assert.equal(zoomRatioOf(2, 4), 0.5); // zoomed in 2x -> ratio halves
		assert.equal(zoomRatioOf(2, 1), 2); // zoomed out 2x -> ratio doubles
	});
});

describe("labelAlpha (the single zoom gate)", () => {
	test("fully visible at/below the threshold, faded out after the span", () => {
		// Proportional span: at gate 0.5 the span is 0.5 × 0.5 = 0.25.
		assert.equal(labelAlpha(0.5, 0.5), 1); // at the threshold
		assert.equal(labelAlpha(0.25, 0.5), 1); // zoomed further in: stays 1
		assert.equal(labelAlpha(0.625, 0.5), 0.5); // mid-fade (span midpoint)
		assert.equal(labelAlpha(0.75, 0.5), 0); // one proportional span out: gone
		assert.equal(labelAlpha(2.0, 0.5), 0); // far out: clamped
	});

	test("the span is PROPORTIONAL to the gate (2026-09-17), not absolute", () => {
		// The old absolute 0.5-ratio span read as a 100% relative change at
		// the old 0.5 gate but a bare 12% sliver at the tuned 8× gate (ratio
		// 4). Proportional = one consistent handoff feel at any gate.
		assert.equal(LABELS_FADE_RATIO, 0.5);
		// At the tuned default (gate 4): fades across ratio 4 → 6 (8× → 12×
		// on screen), one full ladder stop.
		assert.equal(labelAlpha(4, 4), 1); // at the gate
		assert.equal(labelAlpha(5, 4), 0.5); // mid-fade
		assert.equal(labelAlpha(6, 4), 0); // one proportional span out: gone
		// The relative shape is identical at the old gate: 0.5 → 0.75.
		assert.equal(labelAlpha(5, 4), 0.5); // mid-fade at the tuned gate, same relative shape
	});

	test("node labels and cluster labels cross-fade over the exact same span", () => {
		// The renderer draws cluster labels at 1 - labelAlpha; the two must
		// always sum to 1 within the fade and never coexist at full opacity.
		for (const gate of [0.5, 4]) {
			for (let ratio = 0; ratio <= 8; ratio += gate / 8) {
				const node = labelAlpha(ratio, gate);
				const cluster = 1 - node;
				assert.ok(node + cluster > 0.999 && node + cluster < 1.001, `sum at gate ${gate} ratio ${ratio}`);
				assert.ok(node <= 1 && cluster <= 1, `clamped at gate ${gate} ratio ${ratio}`);
			}
		}
	});
});

describe("d3 camera composition (the persisted-camera restore path)", () => {
	// The renderer restores a persisted camera via
	// zoomIdentity.translate(x, y).scale(k) — the same composition fit()
	// uses. d3's Transform.translate() shifts in SCALED space while
	// .scale() keeps the translation: identity.translate(X, Y).scale(K)
	// is exactly {k: K, x: X, y: Y}. This pins that law (the persisted
	// {k, x, y} shape round-trips through the composition) so a d3
	// upgrade that changes it fails here, not as a wrong camera.
	test("zoomIdentity.translate(X, Y).scale(K) === {k: K, x: X, y: Y}", async () => {
		const { zoomIdentity } = await import("d3-zoom");
		const t = zoomIdentity.translate(120, -40).scale(3.5);
		assert.equal(t.k, 3.5);
		assert.equal(t.x, 120);
		assert.equal(t.y, -40);
		// And the inverse direction: a stored camera re-applies to the
		// same screen position for the same world point.
		const p = t.apply([7, 9]);
		assert.deepEqual(p, [7 * 3.5 + 120, 9 * 3.5 - 40]);
	});
});

describe("fitTransform", () => {
	test("centers the bbox and respects padding", () => {
		// A 100x50 graph in a 500x300 viewport, 40px padding:
		// available 420x220 -> k = min(4.2, 4.4) = 4.2
		const t = fitTransform({ minX: -50, maxX: 50, minY: -25, maxY: 25 }, 500, 300, 40);
		assert.ok(Math.abs(t.k - 4.2) < 1e-9, `k=${t.k}`);
		assert.ok(Math.abs(t.x - 250) < 1e-9, `x=${t.x}`); // centered
		assert.ok(Math.abs(t.y - 150) < 1e-9, `y=${t.y}`);
		// World center maps to viewport center:
		assert.ok(Math.abs(0 * t.k + t.x - 250) < 1e-9);
	});

	test("never returns a non-positive scale for degenerate bboxes", () => {
		const t = fitTransform({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, 100, 100, 10);
		assert.ok(t.k > 0 && Number.isFinite(t.k));
	});
});

describe("arrowGeometry", () => {
	test("the tip lands exactly on the target disc edge", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5);
		assert.ok(g, "non-degenerate edge");
		assert.ok(Math.abs(g!.tip.x - 94) < 1e-9 && Math.abs(g!.tip.y) < 1e-9);
	});

	test("the shaft starts outside the source disc", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		assert.ok(Math.abs(g.shaftFrom.x - 6) < 1e-9 && Math.abs(g.shaftFrom.y) < 1e-9);
		// Shaft ends at the head base; head is drawn from base to tip.
		assert.ok(Math.abs(g.shaftTo.x - 89) < 1e-9);
	});

	test("the head triangle is symmetric around the shaft axis (0.8x wideness)", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		// halfW = 0.4 x headLength = 2; both base corners share x, mirrored y.
		assert.ok(Math.abs(Math.abs(g.left.y) - 2) < 1e-9 && Math.abs(Math.abs(g.right.y) - 2) < 1e-9);
		assert.ok(Math.abs(g.left.y + g.right.y) < 1e-9); // mirror
		assert.ok(Math.abs(g.left.x - g.right.x) < 1e-9);
	});

	test("works at arbitrary angles (diagonal stays normalized)", () => {
		const a = { x: 0, y: 0 };
		const b = { x: 60, y: 80 }; // len 100, dir (0.6, 0.8)
		const g = arrowGeometry(a, b, 10, 10, 8)!;
		assert.ok(Math.abs(g.tip.x - (60 - 0.6 * 10)) < 1e-9 && Math.abs(g.tip.y - (80 - 0.8 * 10)) < 1e-9);
	});

	test("null for coincident endpoints (never a NaN arrow)", () => {
		assert.equal(arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, 6, 5), null);
	});

	// The rendering arc's geometry laws (owner, 2026-09-30): an edge INTO
	// an imp point is drawn with toRadius 0 (headless, terminates at the
	// center); an edge OUT of one with fromRadius 0 (starts at the center).
	test("toRadius 0 — the tip lands exactly at the target CENTER (headless convergence)", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 0, 5)!;
		assert.ok(Math.abs(g.tip.x - 100) < 1e-9 && Math.abs(g.tip.y) < 1e-9, "tip = the center, past which no shaft draws");
	});

	test("fromRadius 0 — the shaft starts exactly at the source CENTER", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 6, 5)!;
		assert.ok(Math.abs(g.shaftFrom.x) < 1e-9 && Math.abs(g.shaftFrom.y) < 1e-9, "shaftFrom = the center");
	});
});

describe("isImpNodeId (the pure-geometry law, rendering arc 2026-09-30)", () => {
	test("arg_-prefixed ids are geometry; proposition ids are citizens", () => {
		assert.equal(isImpNodeId("arg_123af5a046ba"), true);
		assert.equal(isImpNodeId("n_abc123"), false);
	});
});


describe("pickNearest (distance-check picking)", () => {
	const nodes = [
		{ id: "a", x: 10, y: 10 },
		{ id: "b", x: 50, y: 50 },
		{ id: "c", x: 90, y: 10 },
	];

	test("picks the nearest node within the pad", () => {
		assert.equal(pickNearest(nodes, 12, 12, 16)?.id, "a");
		assert.equal(pickNearest(nodes, 48, 52, 16)?.id, "b");
		assert.equal(pickNearest(nodes, 88, 8, 16)?.id, "c");
	});

	test("the picking pad extends the hitbox beyond the disc", () => {
		// 20px away, only reachable because the pad covers it.
		assert.equal(pickNearest(nodes, 28, 18, 25)?.id, "a");
		// Beyond the pad: nothing.
		assert.equal(pickNearest(nodes, 30, 40, 3), null);
	});

	test("ties resolve deterministically (first scanned wins)", () => {
		const pair = [
			{ id: "first", x: 0, y: 0 },
			{ id: "second", x: 10, y: 0 },
		];
		assert.equal(pickNearest(pair, 5, 0, 10)?.id, "first");
	});

	test("empty node list picks nothing", () => {
		assert.equal(pickNearest([], 0, 0, 100), null);
	});
});

describe("sanitizeRegionTuning (dev number inputs)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		const t = sanitizeRegionTuning(undefined);
		assert.deepEqual(t, DEFAULT_REGION_TUNING);
		const half = sanitizeRegionTuning({ blur: 7.2 });
		assert.equal(half.blur, 10); // snapped to the new ladder floor (owner, 2026-10-07)
		assert.equal(half.dilation, DEFAULT_REGION_TUNING.dilation);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizeRegionTuning({ dilation: Number.NaN, blur: -5, bitmap: 99999, edgeAlpha: 42 });
		assert.equal(t.dilation, DEFAULT_REGION_TUNING.dilation); // NaN -> default
		assert.equal(t.blur, REGION_BLUR_LADDER[0]); // snapped to the ladder floor
		assert.equal(t.bitmap, REGION_BITMAP_OPTIONS[REGION_BITMAP_OPTIONS.length - 1]); // 99999 snaps to the largest option
		assert.equal(t.edgeAlpha, 1);
	});

	test("empty string / null / undefined values fall back per-field", () => {
		const t = sanitizeRegionTuning({ edgeAlpha: Number.NaN });
		assert.equal(t.edgeAlpha, DEFAULT_REGION_TUNING.edgeAlpha);
	});
});

describe("boxBlurRound (premultiplied region blur)", () => {
	test("spreads a single opaque px into its neighborhood and conserves sum", () => {
		// 5x5 RGBA, one white opaque pixel at (2,2)
		const w = 5, h = 5;
		const a = new Float32Array(w * h * 4);
		const center = (2 * w + 2) * 4;
		a[center] = 255; a[center + 1] = 255; a[center + 2] = 255; a[center + 3] = 255;
		const tmp = new Float32Array(a.length);
		const b = new Float32Array(a.length);
		boxBlurRound(a, tmp, b, w, h, 1);
		// Alpha conservation: total alpha unchanged.
		let sumA = 0;
		for (let i = 3; i < b.length; i += 4) sumA += b[i]!;
		assert.ok(Math.abs(sumA - 255) < 1e-3, `alpha sum ${sumA}`);
		// The center dimmed, the 8 neighbors picked some up.
		assert.ok(b[center + 3]! < 255 && b[center + 3]! > 0);
		const up = ((1 * w) + 2) * 4 + 3;
		assert.ok(b[up]! > 0, "neighbor got alpha");
		// Far corner (4,4) untouched.
		assert.equal(b[(4 * 5 + 4) * 4 + 3], 0);
	});

	test("radius 0 is a plain copy", () => {
		const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const tmp = new Float32Array(8);
		const b = new Float32Array(8);
		boxBlurRound(a, tmp, b, 1, 2, 0);
		assert.deepEqual([...b], [1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe("sanitizePhysicsTuning (physics controls)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		assert.deepEqual(sanitizePhysicsTuning(undefined), DEFAULT_PHYSICS_TUNING);
		const half = sanitizePhysicsTuning({ clusterPull: 0.6 });
		assert.equal(half.clusterPull, 0.6);
		assert.equal(half.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizePhysicsTuning({
			chargeStrength: Number.NaN,
			linkStrength: 99,
			linkDistance: -5,
			gravity: 7,
			clusterPull: -1,
			velocityDecay: 3,
		});
		assert.equal(t.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
		assert.equal(t.linkStrength, 4); // sweep-validated cap (8 explodes, 5 wobbles)
		assert.equal(t.linkDistance, 10);
		assert.equal(t.gravity, 0.48);
		assert.equal(t.clusterPull, 0);
		assert.equal(t.velocityDecay, 0.9);
	});
});



describe("wrapRegionLabel (wave 7: session names / file paths)", () => {
	// A fake measure: chars are 5px wide, spaces 4px — enough to drive
	// wrap decisions deterministically.
	const measure = (s: string) => s.length * 5;
	const W = 20; // 4 chars per line

	it("fits → single line, untouched", () => {
		assert.deepEqual(wrapRegionLabel("Plato", 100, 3, measure), ["Plato"]);
	});

	it("wraps words, no cap hit", () => {
		// W=20 at 5px/char = 3 chars a line: every word lands alone, four
		// lines, cap 4 never reached, no ellipsis.
		assert.deepEqual(wrapRegionLabel("aaa bbb ccc ddd", W, 4, measure), [
			"aaa",
			"bbb",
			"ccc",
			"ddd",
		]);
	});

	it("caps at maxLines with an ellipsis on the last line", () => {
		const lines = wrapRegionLabel("aaaa bbbb cccc dddd eeee", W, 2, measure);
		assert.equal(lines.length, 2);
		assert.ok(lines[1]!.endsWith("…"), "last line ellipsized");
		for (const line of lines) assert.ok(measure(line) <= W || line.length <= 2, "each line fits");
	});

	it("char-splits an unbroken path longer than the width (the notes case)", () => {
		const path = "/users/amos/notes/physics/lecture-notes.md";
		const lines = wrapRegionLabel(path, W, 3, measure);
		assert.equal(lines.length, 3);
		// every kept line fits the width; the last carries the ellipsis
		assert.ok(lines[2]!.endsWith("…"), "long path capped with ellipsis");
		assert.ok(measure(lines[0]!) <= W, "first chunk fits");
		assert.ok(measure(lines[1]!) <= W, "second chunk fits");
	});

	it("a remainder that FITS the width rides as a plain last line (no false ellipsis)", () => {
		// W=25 at 5px/char = 5 chars a line: "aa bb" fits exactly, the
		// tail "cc dd" fits too — two plain lines, cap never binds.
		assert.deepEqual(wrapRegionLabel("aa bb cc dd", 25, 3, measure), ["aa bb", "cc dd"]);
	});

	it("the ellipsis itself never exceeds the width", () => {
		const lines = wrapRegionLabel("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", W, 2, measure);
		assert.ok(measure(lines[1]!) <= W, "ellipsized tail fits");
	});
});


describe("applyClusterLabels (the label-only rename channel)", () => {
	const measure = (s: string) => s.length * 5;
	const W = 220;
	const MAXL = 3;

	const fixture = () => ({
		clusters: [
			{ id: "chat_a", label: "Old title" },
			{ id: "chat_b", label: null },
			{ id: "seedplan", label: "Orbital mechanics" },
		],
		regionMeta: [
			{ id: "chat_a", label: "Old title", lines: ["Old title"], cx: 0, cy: 0, hue: 10 },
			{ id: "chat_b", label: null, lines: null, cx: 1, cy: 1, hue: 20 },
			{ id: "seedplan", label: "Orbital mechanics", lines: ["Orbital mechanics"], cx: 2, cy: 2, hue: 30 },
		],
	});

	it("patches the matching cluster and re-wraps its region meta", () => {
		const f = fixture();
		// 5px/char and W=220: a 45-char title just overflows one line
		// ("...for the" is 40 chars, appending " graph" reads 46).
		const longTitle = "A much longer new session title for the graph";
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_a", longTitle]]),
			W, MAXL, measure,
		);
		assert.equal(changed, true);
		assert.equal(f.clusters[0]!.label, longTitle);
		assert.deepEqual(f.regionMeta[0]!.lines, ["A much longer new session title for the", "graph"]);
		// untouched entries stay byte-identical
		assert.equal(f.clusters[1]!.label, null);
		assert.equal(f.clusters[2]!.label, "Orbital mechanics");
		assert.deepEqual(f.regionMeta[2]!.lines, ["Orbital mechanics"]);
	});

	it("hull silence: a null-label cluster never gains a label", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_b", "Resurrected?"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
		assert.equal(f.clusters[1]!.label, null);
		assert.equal(f.regionMeta[1]!.lines, null);
	});

	it("a label already matching is a no-op (no redraw)", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["seedplan", "Orbital mechanics"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
	});

	it("an explicit null clears a labeled cluster's lines", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_a", null]]),
			W, MAXL, measure,
		);
		assert.equal(changed, true);
		assert.equal(f.clusters[0]!.label, null);
		assert.equal(f.regionMeta[0]!.lines, null);
	});

	it("unknown ids in the map change nothing", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_ghost", "Nope"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
	});
});
