import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
const renderToStaticMarkup = (node: ReactNode) => renderMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanBlock, PlanPopup, type PopupMessage } from "../components/plan-block.tsx";
import {
	blockLayout,
	chartMeasure,
	edgePathD,
	topoFor,
	GAP_X,
	NODE_W_MIN,
	PAD_X,
	type LabelMeasure,
} from "../components/plan-layout.ts";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering
// (full = borderless + column-filling
// with the glowing current), and the popup's LIVE derivation.

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

/** One node laid out alone: its wrapped lines and box. */
function single(title: string, measure: LabelMeasure = chartMeasure) {
	const L = blockLayout([{ id: "n", title }], [], measure);
	return { lines: L.lines.get("n")!, w: L.nodeW.get("n")!, h: L.nodeH.get("n")!, lineH: L.lineH };
}

/** Fake measures standing in for fonts the chart was never tuned on. The
 *  browser breaks real lines (usePlanLayout); these wrap greedily at spaces
 *  and never split a word, the same contract. */
const graphemesOf = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
function fake(fontSize: number, width: (s: string) => number): LabelMeasure {
	return {
		fontSize,
		width,
		lines(title, maxWidth) {
			const lines: string[] = [];
			for (const word of title.trim().split(/\s+/)) {
				const last = lines[lines.length - 1];
				if (last !== undefined && width(`${last} ${word}`) <= maxWidth) lines[lines.length - 1] = `${last} ${word}`;
				else lines.push(word);
			}
			return lines;
		},
	};
}
/** Monospace at 11px: every grapheme 6.6px (JetBrains Mono's advance). */
const mono = fake(11, (s) => graphemesOf(s).length * 6.6);
/** CJK-aware: ideographs/kana full-width (1em), the rest like mono. */
const cjk = fake(11, (s) => graphemesOf(s).reduce((w, g) => w + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。「」]/u.test(g) ? 11 : 6.6), 0));

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges, chartMeasure);
		// Text-first sizing (owner, plan-hug round 2026-10-07): short titles
		// hug to the minimum — no more fixed 160px slabs.
		assert.equal(layout.nodeW.get("a"), NODE_W_MIN); // ≈ 50 wide → floored at the min
		assert.equal(layout.nodeW.get("c"), NODE_W_MIN); // ≈ 59.9
		assert.equal(layout.width, NODE_W_MIN);
		// 44 tall each: two 13px rows + 9px top/bottom — the minimum height
		// since the first plan round, now derived from the 11px font size.
		assert.equal(layout.height, 3 * 44 + 2 * 48);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(
			nodes,
			[
				{ from: "r", to: "x" },
				{ from: "r", to: "y" },
				{ from: "ghost", to: "r" }, // dangling: ignored defensively
			],
			chartMeasure,
		);
		const W = NODE_W_MIN;
		assert.equal(layout.width, 2 * W + GAP_X);
		// Root centered over its two children: (2*W+GAP - W)/2
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("edgePathD draws dagre's route through curveBasis — mouth pulled back from the border", () => {
		// Straight 3-point route (source border → mid → target border): the
		// basis curve starts exactly at the border point; the END pulls
		// back by HEAD_TIP_OVERHANG + the docking gap (92 − 2.359 − 2.667) so
		// the head's TIP floats 2.67 short of the border with its mouth at
		// the path's end, on a straight shaft (owner, rounds 11–12; the head
		// + gap scaled ⅔ with the 1px lines, 2026-09-26).
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"), "starts at the source border point");
		assert.ok(d.endsWith("L80,86.974"), "mouth pulled back; tip floats 2.67 off the border");
		// The whole run stays on-axis (every x is 80): a collinear route
		// renders straight — the shaft stub never bends a straight edge.
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((m) => m[1]);
		assert.ok(xs.length > 0 && xs.every((v) => v === "80"), "collinear route renders on-axis");
		// A perpendicular entry with the target box is the SAME geometry.
		const pd = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 });
		assert.equal(pd, d);
	});

	it("edgePathD clamps the entry to ±40° of the face perpendicular (owner, round 14)", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		// A 60° tilt into the top face swings to the 40° cone edge: the
		// mouth lands at (97.726, 93.289) and the final segment runs at
		// exactly 40° (Δx/Δy = tan 40°). The tip floats DOCK_GAP (4) off the
		// face along the normal: border (100,100) → tip (100,96).
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L98.484,95.526"), "swung to the cone edge");
		// final L's from-point is the previous number pair; recompute direction
		const nums = [...clamped.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
		const ax = nums[nums.length - 4]!;
		const ay = nums[nums.length - 3]!;
		const bx = nums[nums.length - 2]!;
		const by = nums[nums.length - 1]!;
		assert.ok(Math.abs((bx - ax) / (by - ay) - Math.tan((40 * Math.PI) / 180)) < 0.01, "40° cone edge");
		// Tip = mouth + u'·overhang floats 2.67 above the face.
		const tipY = by + 0.766 * 2.359;
		assert.ok(Math.abs(tipY - 97.333) < 0.01, "docking gap along the face normal");
		// A shallow (~9.5°) tilt is WITHIN the limit: no swing.
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.612,95.006"), "unclamped within the cone");
	});

	it("takes its lines from the measure, capped at 12.75 em, and NEVER drops content", () => {
		assert.deepEqual(single("Chain rule intuition").lines, ["Chain rule intuition"]); // ≈ 86 — one line
		assert.deepEqual(single("Chain rule intuition and fluency").lines, ["Chain rule intuition and", "fluency"]);
		const caps: number[] = [];
		const spy = (fontSize: number): LabelMeasure => ({ ...fake(fontSize, chartMeasure.width), lines: (t, max) => (caps.push(max), [t]) });
		single("x", spy(11));
		single("x", spy(22));
		assert.deepEqual(caps, [12.75 * 11, 12.75 * 22]);
	});

	it("never splits a word: one wider than the line gets its own line and widens the box", () => {
		const s = single("supercalifragilisticexpialidocious word");
		assert.deepEqual(s.lines, ["supercalifragilisticexpialidocious", "word"]);
		assert.equal(s.w, Math.ceil(chartMeasure.width("supercalifragilisticexpialidocious")) + 2 * PAD_X);
		assert.ok(s.w > 12.75 * 11 + 2 * PAD_X, "wider than the usual line cap");
	});

	it("each box hugs its widest measured line: 16px each side, never below the floor", () => {
		const s = single("Symmetry and orthogonal complements");
		assert.equal(s.w, Math.ceil(chartMeasure.width("Symmetry and orthogonal")) + 2 * PAD_X); // 117 + 32
		assert.equal(s.w, 149);
		assert.equal(single("a").w, NODE_W_MIN);
	});
});

// #671: the box must fit its text in WHATEVER the label renders in — the
// measure is the font. These run the same layout with fonts the chart was
// never tuned on. (Where lines break is the browser's job, proven in real
// Chrome by scripts/smoke-plan-labels.mjs.)
describe("plan block layout fits any font (#671)", () => {
	const TITLES = [
		"Fitting is unidentifiable",
		"Correct step: condition on the response",
		"Two noise numbers: slip, guess",
		"Belief updates by Bayes' rule",
		"Item response theory (IRT) vs BKT",
		"Antidisestablishmentarianism and supercalifragilisticexpialidocious",
		"INTRODUCTION TO EIGENVALUES AND EIGENVECTORS",
		"傅里叶变换的直观理解与实际应用",
		"フーリエ変換、直感的な理解。応用編",
		"🚀 Launch 🎯 targets 📈 growth 👨‍👩‍👧‍👦 family",
		"Ünïcödé àccénts — naïve café façade",
		"x",
		"",
	];

	for (const [name, measure] of [["chart (Source Sans)", chartMeasure], ["monospace", mono], ["CJK full-width", cjk]] as const) {
		it(`${name}: every line fits inside its box with the full padding`, () => {
			for (const title of TITLES) {
				const { lines, w, h, lineH } = single(title, measure);
				for (const line of lines) {
					assert.ok(measure.width(line) + 2 * PAD_X <= w + 1e-9, `"${line}" (${measure.width(line)}) overflows box ${w} in ${name}`);
				}
				assert.ok(lines.length * lineH <= h, `"${title}" lines overflow box height`);
			}
		});
	}

	it("keeps every character, in order (spaces aside)", () => {
		for (const title of TITLES) {
			for (const measure of [chartMeasure, mono, cjk]) {
				const { lines } = single(title, measure);
				assert.equal(lines.join("").replace(/\s+/g, ""), title.replace(/\s+/g, ""), `content changed for "${title}"`);
			}
		}
	});

	it("wide fonts wrap onto more lines instead of widening the box (owner, #671 design)", () => {
		const sans = single("Fitting is unidentifiable");
		const wide = single("Fitting is unidentifiable", mono);
		assert.deepEqual(sans.lines, ["Fitting is unidentifiable"]);
		assert.deepEqual(wide.lines, ["Fitting is", "unidentifiable"]);
		assert.ok(wide.w <= Math.ceil(140.25) + 2 * PAD_X);
	});

	it("line height and the line cap scale with the font size", () => {
		const big = fake(22, (s) => chartMeasure.width(s) * 2);
		const small = single("Chain rule intuition and fluency for everyone");
		const large = single("Chain rule intuition and fluency for everyone", big);
		assert.deepEqual(large.lines, small.lines, "same wrap at twice the size");
		assert.equal(large.lineH, 2 * small.lineH);
	});
});

describe("plan block render", () => {
	it("full block: borderless, column-filling, statuses AS CARRIED (never re-derived)", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-09-09T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "Alpha node", status: "visited" },
				{ id: "b", title: "Beta node", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(html, /data-testid="plan-block-full"/);
		// Borderless: the wrapper carries no border/rounded chrome.
		assert.ok(!/data-testid="plan-block-full"[^>]*border/.test(html), "no wrapping chrome");
		// Fills the column UP TO the chat-font cap: the svg is w-full +
		// mx-auto with maxWidth = extent × TEXT_CAP_SCALE, so node text never
		// renders past the 16px prose size (owner, plan-graph round 1; the
		// snap 16.5→16 landed in typography round 4).
		assert.match(html, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		// The reading font, not the mono UI font (owner, 2026-09-26) — via the
		// runtime var (the font-prose utility would bake the @theme literal
		// and ignore the Appearance reading-font override).
		assert.match(html, /<svg[^>]*font-family:var\(--font-prose\)/);
		// Lines + outlines at the app's standard 1px border weight (owner,
		// 2026-09-26; was 1.5).
		assert.match(html, /<rect[^>]*stroke-width="1"/);
		assert.match(html, /max-width:143\.36px/); // (96+16) × 1.28 — boxes hug now
		// Centered text (owner, plan-hug round 2026-10-07): every title line
		// anchors to its box's midline — the old x=12 left inset is gone.
		assert.match(html, /<text[^>]*x="48"[^>]*text-anchor="middle"/); // 96/2
		assert.ok(!/x="12"/.test(html), "no left-inset text");
		// Each line centers on its own row — no font-specific baseline offset (#671).
		assert.match(html, /<text[^>]*dominant-baseline="central"/);
		// The measuring probe rides inside the diagram's own svg (same
		// cascade as the labels), hidden, at the heaviest label weight.
		assert.match(html, /<g aria-hidden="true" visibility="hidden" data-plan-probe=""><text class="text-xs font-medium">Hamburgefonstiv/);
		// …plus the HTML block where the browser breaks lines: never inside a
		// word, never hyphenated.
		assert.match(html, /<foreignObject[^>]*><div class="text-xs font-medium" style="width:max-content;white-space:normal;overflow-wrap:normal;word-break:normal;hyphens:none"><\/div><\/foreignObject>/);
		// The in-chat block speaks the dock language (owner, 2026-10-07):
		// lighter-background boxes like the composer shells — with the strong
		// line ink outlines (white in dark; owner follow-up: gray fill good,
		// box edges stay white).
		assert.match(html, /<rect[^>]*class="fill-card stroke-line-strong"/);
		assert.ok(!/stroke-white|fill-white/.test(html), "no hardcoded white ink");
		// Two stacked nodes: 2*NODE_H + GAP_Y = 136 extent + GRAPH_PAD on
		// every side (strokes/glow never clip at the edges). The width
		// rides the hug now: 96-min boxes, not the old 160 slabs.
		assert.match(html, /viewBox="-8 -8 112 152"/);
		// Snapshot statuses render as carried.
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="upcoming"/);
		assert.ok(html.includes('aria-label="Open the full plan"'), "the trigger names itself (tooltip copy)");
	});

});

describe("plan popup (live derivation)", () => {
	function messages(): PopupMessage[] {
		return [
			{
				parts: [
					{
						type: "tool-plan_init",
						state: "output-available",
						output: { ok: true, tree: CHAIN },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "output-available",
						input: { nodeId: "a" },
						output: { correct: true },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "input-available",
						input: { nodeId: "b" },
					},
				],
			},
		];
	}

	it("derives statuses at click time: latest tagged call → current, earlier → visited (glowing)", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={messages()} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup"/);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
		// The current node is the glow target: a faint yellow fill, blurred
		// so it bleeds over the edges — static, no pulse (owner, round 6).
		assert.match(html, /fill-yellow-400\/25/);
		assert.match(html, /feGaussianBlur/);
		assert.doesNotMatch(html, /animate-pulse/);
		// Arrows into not-yet-visited nodes are grayed out (owner, round 6).
		assert.match(html, /marker-end="url\(#.*-dim\)"/);
		assert.match(html, /live — statuses derive from your check outcomes/);
		// No top-left flash: at static render settled=false, so the diagram
		// wrapper paints at opacity 0 — the fit runs in an effect AFTER the
		// first paint and the chart would otherwise flash at the initial
		// top-left zoom:1 state for a frame (owner report, 2026-09-19;
		// transition-gating alone didn't hide it).
		assert.match(html, /opacity: ?0[;,}]/, "diagram hidden until the first fit applies");
	});

	it("dims an arrow when EITHER end is gray — white needs both ends white (owner, 2026-09-26)", () => {
		// x upcoming → y visited: the OLD rule (target-only) painted this
		// white; the new rule keeps it gray — a gray box's outgoing arrows
		// stay gray even into covered territory. y → z (visited → current)
		// stays white: BOTH ends white.
		const tree: PlanTree = {
			nodes: [
				{ id: "x", title: "Gray origin" },
				{ id: "y", title: "Covered middle" },
				{ id: "z", title: "Covered latest" },
			],
			edges: [
				{ from: "x", to: "y" },
				{ from: "y", to: "z" },
			],
			version: 1,
		};
		const msgs: PopupMessage[] = [
			{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "y" }, output: { correct: true } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "z" }, output: { correct: true } }] },
		];
		const html = renderToStaticMarkup(<PlanPopup messages={msgs} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-x" data-status="upcoming"/);
		assert.match(html, /data-testid="plan-node-y" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-z" data-status="current"/);
		// Exactly one gray edge (x→y, gray origin) and one white edge (y→z,
		// both ends white): count the head markers, one per edge.
		const dimHeads = (html.match(/marker-end="url\(#.*-dim\)"/g) ?? []).length;
		const whiteHeads = (html.match(/marker-end="url\(#(?:R\d+(?:H\d+)?|[a-z0-9-]+)\)"/g) ?? []).length;
		assert.equal(dimHeads, 1, "the gray-origin edge dims");
		assert.equal(whiteHeads, 1, "the both-white edge stays white");
		assert.match(html, /<path[^>]*class="fill-none stroke-border"/);
		assert.match(html, /<path[^>]*class="fill-none stroke-line-strong"/);
		assert.ok(!/stroke-white|fill-white/.test(html), "no hardcoded white ink");
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});