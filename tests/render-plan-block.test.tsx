import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanBlock,
	PlanPopup,
	blockLayout,
	topoFor,
	edgePathD,
	wrapTitle,
	GAP_X,
	NODE_H,
	NODE_W_MIN,
	nodeWidth,
	estimateLineWidth,
	type PopupMessage,
} from "../components/plan-block.tsx";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering
// (full = borderless + column-filling
// with the glowing current), and the popup's LIVE derivation.
// Titles retain graphemes, estimate mark-free widths and select RTL per title.

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

describe("plan block layout (pure)", () => {
	it("wraps a title with tashkeel by words and graphemes without losing content", () => {
		const word = "الْمُشْتَقَّةُ";
		const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		const lines = wrapTitle(word, 3);
		assert.ok(lines.length > 1);
		assert.equal(lines.join(""), word);
		for (const line of lines) {
			assert.ok(!/^\p{M}/u.test(line));
			assert.ok(Array.from(graphemes.segment(line)).length <= 3);
		}
		assert.deepEqual(wrapTitle("عِلْمُ حِسَابٍ", 4), ["عِلْمُ", "حِسَابٍ"]);
		assert.deepEqual(wrapTitle("👩‍🔬👩‍🔬", 1), ["👩‍🔬", "👩‍🔬"]);
		// Four graphemes in seven code units: packing by .length would break it.
		assert.deepEqual(wrapTitle("عِلْ مُ", 4), ["عِلْ مُ"]);
	});

	it("estimates sensible RTL widths without charging tashkeel for extra advance", () => {
		assert.equal(estimateLineWidth("e\u0301"), 10.8, "Latin combining-mark width stays unchanged");
		assert.equal(estimateLineWidth("الْمُشْتَقَّةُ"), estimateLineWidth("المشتقة"));
		const title = "مقدمة في حساب المشتقات وتطبيقاتها العملية";
		const lines = wrapTitle(title);
		// The widest line a title can wrap to: one full line of Arabic letters.
		const [fullLine] = wrapTitle("م".repeat(100));
		assert.ok(lines.length > 1);
		for (const line of lines) {
			assert.ok(estimateLineWidth(line) > 20);
			assert.ok(estimateLineWidth(line) <= estimateLineWidth(fullLine!));
		}
		assert.ok(nodeWidth(lines) >= NODE_W_MIN);
		assert.ok(nodeWidth(lines) <= nodeWidth([fullLine!]));
	});

	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		// Text-first sizing (owner, plan-hug round 2026-10-07): these short
		// titles hug to the minimum — no more fixed 160px slabs.
		const W = nodeWidth(wrapTitle("Alpha node"));
		assert.equal(W, NODE_W_MIN); // est ≈ 50 → floored at the min
		// All three short titles floor — the extent is the floor itself.
		assert.equal(nodeWidth(wrapTitle("Gamma node")), NODE_W_MIN); // est ≈ 59.9
		assert.equal(layout.width, NODE_W_MIN);
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
		assert.equal(layout.nodeW.get("a"), W);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" }, // dangling: ignored defensively
		]);
		const W = nodeWidth(wrapTitle("Root"));
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

	it("wrapTitle wraps greedily and NEVER drops content (boxes grow instead)", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]); // well under — one line
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), [
			"Chain rule intuition and", // 24 — appending "fluency" would pass 28
			"fluency",
		]);
		// Oversized word hard-chunked, nothing lost (owner, round 7).
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), [
			"supercalifragilisticexpialid", // the chunker cuts AT maxChars
			"ocious word",
		]);
		assert.deepEqual(wrapTitle("supercalifragilistic"), ["supercalifragilistic"]); // exactly 20 — fits
	});

	it("nodeWidth hugs the wrapped text (the box grows WITH its lines)", () => {
		// Short titles floor at the min; wide ones size to the widest line.
		// Per-char-CLASS estimate (owner follow-up: the flat px/char rate
		// overshot the rendered width — invisible slack beside the text).
		assert.equal(nodeWidth(["supercalifragilistic"]), 117); // est ≈ 85 + 2×16
		assert.equal(nodeWidth(wrapTitle("Symmetry and orthogonal complements")), 149);
		// The hug is symmetric padding — 16 a side, the SAME as the vertical
		// (44−12)/2 — and never below the floor.
		assert.ok(nodeWidth(["a"]) === NODE_W_MIN);
		assert.ok(Math.abs(estimateLineWidth("The normal-form ladder") - 106.3) < 0.5);
	});
});

describe("plan block render", () => {
	it("sets the SVG direction per complete title and leaves letterless titles inheriting", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-10-24T12:00:00Z",
			current: null,
			nodes: [
				{ id: "rtl", title: "Newton ينص على أن القوى تتوازن في هذا المثال", status: "upcoming" },
				{ id: "he", title: "שָׁלוֹם", status: "upcoming" },
				{ id: "latin", title: "English title", status: "upcoming" },
				{ id: "math", title: "1 + 2", status: "upcoming" },
			],
			edges: [],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		for (const id of ["rtl", "he"]) {
			const group = html.match(new RegExp(`data-testid="plan-node-${id}"[^]*?</g>`))![0];
			const texts = group.match(/<text[^>]*>/g)!;
			assert.ok(texts.length > 0);
			for (const text of texts) {
				assert.match(text, /direction="rtl"/);
				assert.doesNotMatch(text, /unicode-bidi=/);
				assert.match(text, /text-anchor="middle"/);
			}
		}
		for (const id of ["latin", "math"]) {
			const group = html.match(new RegExp(`data-testid="plan-node-${id}"[^]*?</g>`))![0];
			assert.doesNotMatch(group, /direction=|unicode-bidi=/, id);
		}
	});

	it("isolates each left-to-right run of a right-to-left title, and nothing in an English one", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-10-24T12:00:00Z",
			current: null,
			nodes: [
				{ id: "rtl", title: "تعلم C++", status: "upcoming" },
				{ id: "latin", title: "Learn C++", status: "upcoming" },
			],
			edges: [],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		const textOf = (id: string) => html.match(new RegExp(`data-testid="plan-node-${id}"[^]*?<text[^>]*>([^<]*)</text>`))![1];
		assert.equal(textOf("rtl"), "تعلم \u2066C++\u2069");
		assert.equal(textOf("latin"), "Learn C++");
	});

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
		// The in-chat block speaks the dock language (owner, 2026-10-07):
		// lighter-background boxes like the composer shells — with WHITE
		// outlines (owner follow-up: gray fill good, box edges stay white).
		assert.match(html, /<rect[^>]*class="fill-card stroke-white"/);
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
		const whiteHeads = (html.match(/marker-end="url\(#(?:R\d+|[a-z0-9-]+)\)"/g) ?? []).length;
		assert.equal(dimHeads, 1, "the gray-origin edge dims");
		assert.equal(whiteHeads, 1, "the both-white edge stays white");
		assert.match(html, /<path[^>]*class="fill-none stroke-border"/);
		assert.match(html, /<path[^>]*class="fill-none stroke-white"/);
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});
