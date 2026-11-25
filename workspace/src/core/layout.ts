/**
 * The layout engine — d3-force, everywhere (DECIDED 2026-09-13).
 *
 * One engine owns the equilibrium: the merge-time incremental settle AND
 * the live drag physics run the SAME force set (links as springs, charge
 * repulsion, weak gravity), so the positions ledger and the transient
 * simulation agree on what "resting" means. (FA2 was replaced after a
 * research round: it has no annealing/pinning/settle model and mixing it
 * with a different live engine visibly re-flows the graph on every drag.)
 *
 * Layout EVOLVES instead of reshuffling (Option A): each settle warm-starts
 * from the positions ledger and spring-ties every previously-positioned
 * node toward its anchor (a per-node anchor force). New nodes seed near
 * their positioned neighbors; orphans seed on the rim OUTSIDE the core and
 * are anchored there, so they read as "not yet connected knowledge".
 *
 * Design constraints (kept deliberately, for live physics):
 *  - PURE: no fs, no server types — this module runs server-side (the
 *    merge settle) and in the browser (the live simulation, via the core
 *    barrel). A pinned node is just fx/fy; an anchored node is a spring.
 *  - DETERMINISTIC: seeds derive from node id; d3-force ticks are
 *    deterministic — same inputs, same layout.
 */

import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode, Position } from "./contracts.ts";
import { seededRandom } from "./question-core.ts";

/** A node the d3 simulation mutates (x/y/vx/vy; fx/fy = pinned). */
export interface LayoutNode extends SimulationNodeDatum {
	id: string;
}

/** A link as d3 sees it (id strings resolve to node refs on init). */
type SimLink = SimulationLinkDatum<LayoutNode>;

/** How the inference rank is expressed spatially (playground, 2026-09-13):
 *  the graph's `follows`/`supports` edges encode derivation (premise →
 *  conclusion), so depth-0 nodes (no incoming edges — the fundamentals)
 *  can anchor a shared baseline and every derivation level rises from it.
 *  `vertical`: levels are horizontal rows, arrows point up.
 *  `radial`: levels are concentric rings, foundations at the center, the
 *  outer boundary IS the edge of the user's knowledge.
 *  `off`: today's free layout. */
export type DepthAnchorMode = "off" | "vertical" | "radial";

export interface DepthAnchor {
	mode: DepthAnchorMode;
	/** Anchor pull toward the level (same units as clusterPull). */
	strength: number;
	/** Distance between consecutive inference levels (world units). */
	spacing: number;
	/** Baseline point: vertical mode uses .y as the depth-0 line; radial
	 *  mode uses the full point as the ring center. Default (0,0). */
	center?: { x: number; y: number };
	/** Inner ring radius (radial only; depth-0 nodes sit at this ring). */
	baseRadius?: number;
}

/** Inference depth per node: the longest chain of directed edges from a
 * base node. CYCLE-SAFE (2026-09-13, user requirement — the DAG property
 * is typical, not guaranteed): Tarjan SCC condensation collapses each
 * strongly connected component to one super-node, ranks the (always
 * acyclic) condensation, and every cycle member shares its component's
 * depth — mutual support reads as equal footing. Iterative Tarjan (no
 * recursion depth limits), O(V+E), deterministic. */
export function inferenceDepths(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	edges: ReadonlyArray<LayoutEdge>,
): Map<string, number> {
	const valid = new Set(nodes.map((n) => n.id));
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (e.from === e.to || !valid.has(e.from) || !valid.has(e.to)) continue;
		let list = adj.get(e.from);
		if (!list) adj.set(e.from, (list = []));
		list.push(e.to);
	}

	// Iterative Tarjan SCC.
	const num = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const comp = new Map<string, number>();
	let counter = 0;
	let compCount = 0;
	for (const start of valid) {
		if (num.has(start)) continue;
		num.set(start, counter);
		low.set(start, counter);
		counter++;
		stack.push(start);
		onStack.add(start);
		const work: [string, number][] = [[start, 0]];
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const v = frame[0];
			const outs = adj.get(v) ?? [];
			if (frame[1] < outs.length) {
				const i = frame[1];
				frame[1] = i + 1;
				const w = outs[i]!;
				if (!num.has(w)) {
					num.set(w, counter);
					low.set(w, counter);
					counter++;
					stack.push(w);
					onStack.add(w);
					work.push([w, 0]);
				} else if (onStack.has(w)) {
					low.set(v, Math.min(low.get(v)!, num.get(w)!));
				}
			} else {
				work.pop();
				if (low.get(v) === num.get(v)) {
					let w: string;
					do {
						w = stack.pop()!;
						onStack.delete(w);
						comp.set(w, compCount);
					} while (w !== v);
					compCount++;
				}
				if (work.length > 0) {
					const parent = work[work.length - 1]![0];
					low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
				}
			}
		}
	}

	// Condensation predecessors, then longest path. Tarjan emits sinks
	// first, so descending comp index = topological order (sources first).
	const preds: Set<number>[] = Array.from({ length: compCount }, () => new Set<number>());
	for (const e of edges) {
		const a = comp.get(e.from);
		const b = comp.get(e.to);
		if (a == null || b == null || a === b) continue;
		preds[b]!.add(a);
	}
	const depth = new Array<number>(compCount).fill(0);
	for (let c = compCount - 1; c >= 0; c--) {
		let d = 0;
		for (const p of preds[c]!) d = Math.max(d, depth[p]! + 1);
		depth[c] = d;
	}
	const out = new Map<string, number>();
	for (const n of nodes) out.set(n.id, depth[comp.get(n.id)!] ?? 0);
	return out;
}

export interface SimOptions {
	/** Link spring rest length (world units). */
	linkDistance?: number;
	/** Link spring stiffness MULTIPLIER (1 = d3's default
	 *  1/min(degree) stiffness). */
	linkStrength?: number;
	/** Many-body repulsion strength (negative). */
	chargeStrength?: number;
	/** Center-of-mass gravity: pulls loose components inward. Weak —
	 *  anchors, not gravity, hold the evolved layout's frame. */
	gravity?: { x: number; y: number; strength: number };
	/** Alpha decay per tick — higher = snappier settle. The merge settle
	 *  uses d3's default 0.0228 (~300 ticks); the live sim passes ~0.05. */
	alphaDecay?: number;
	/** Velocity damping per tick (d3 default 0.4). Higher = more friction. */
	velocityDecay?: number;
	/** Inference-depth anchoring (see DepthAnchor). Off by default. */
	depthAnchor?: DepthAnchor;
	/** The LOGICAL edge list (proposition→conclusion, imp hops
	 *  contracted) for the depth machinery — orphan detection AND the
	 *  rank pass (owner, 2026-09-30). Absent = `edges` (legacy
	 *  behavior). Springs ALWAYS run over `edges` — the drawn arrows. */
	logicalEdges?: ReadonlyArray<LayoutEdge>;
	/** The derived imp nodes' chain linkage (id + members), straight
	 *  from deriveView. Drives the IMP MIDPOINT ANCHOR (owner,
	 *  2026-09-30): an implication node's depth is the average of the
	 *  HIGHEST premise row and the conclusion's row — strictly above
	 *  every premise, strictly below the conclusion, uniform in vertical
	 *  (a row) and radial (a ring) modes. Absent = imp nodes keep the
	 *  legacy orphan exemption (never depth-anchored). */
	impLinks?: ReadonlyArray<ImpLink>;
	/** Cluster centroid pull (the "virtual node" without the node):
	 *  members of each cluster accelerate toward their own cluster's
	 *  centroid. Two O(n) passes per tick — cheaper than a real virtual
	 *  node (which would need one extra link spring per member plus a
	 *  maintained position). Strength 0 or absent = force off.
	 *  Callers supply the partition (Louvain output shape). */
	clusterPull?: {
		clusters: ReadonlyArray<{ members: ReadonlyArray<string> }>;
		strength: number;
	};
}

/** Link input: edges are undirected for layout purposes. */
export interface LayoutEdge {
	from: string;
	to: string;
}

/** A derived implication node's chain linkage — what the depth pass needs
 *  to anchor the junction between its premises and their conclusion. */
export interface ImpLink {
	/** The imp node's id (arg_-prefixed — the stored chain's id). */
	id: string;
	premises: ReadonlyArray<string>;
	conclusion: string;
}

export const LINK_DISTANCE = 40;
/** Implication-node id prefix (the mint law lives in core/graph.ts's
 *  newGraphChainId). Layout-side: links TOUCHING an imp node get HALF
 *  the base rest length — the argument's geometry (a converging point)
 *  sits tight against its premises/conclusion instead of spread like a
 *  real proposition citizen (owner ruling, rendering arc 2026-09-30). */
const IMP_ID_PREFIX = "arg_";
const impLinkId = (v: string | number | { id: string }): string =>
	typeof v === "object" ? v.id : String(v);
export const CHARGE_STRENGTH = -240; // 2026-09-17: −120 → −240 (user: repulsion default too weak); the default is shared with render-settings (gm-centered in CHARGE_RANGE).
/** Per-tick anchor re-blend: fraction of an anchored node's displacement
 *  from its previous position that SURVIVES each tick. 0.85 = gentle
 *  evolution where forces are strong, stillness where they are not —
 *  the exact FA2-era constant. Position-space (alpha-independent), so it
 *  cannot be overpowered by d3's long-range link springs the way a force-
 *  space anchor can (forceLink is a Hooke spring: strength*(d-L)*alpha). */
const ANCHOR_RETENTION = 0.85;
/** Gravity strengths. d3 manyBody repulsion falls off as 1/d, so two
 *  20-node blobs at distance d push with ~n1*n2*|charge|/d; cluster
 *  spacing settles where that equals g*d*n/2 — g=0.03 lands clusters
 *  ~400 world units apart (the FA2-era density), and the anchor re-blend
 *  (position-space, alpha-independent) keeps gravity's transient sag
 *  from ever moving an anchored node at rest. */
const BOOTSTRAP_GRAVITY = 0.2;
/** Exported: the live sim reuses this so its rest state matches the
 *  server settle's equilibrium (one engine, one rest). */
export const INCREMENTAL_GRAVITY = 0.12;
/** Exported: default cluster-centroid pull strength (tuned by replay —
 *  compact enough to read as blobs, weak enough that cluster shape is
 *  still the edge network's). */
export const CLUSTER_PULL_STRENGTH = 0.15;

/**
 * The one force set. Returns a STOPPED simulation — callers drive it
 * manually (tick-per-frame live, or a bounded tick loop when settling).
 * Deterministic; mutates `nodes` in place (d3 semantics: impure by design,
 * zero per-tick allocation).
 */
export function createGraphSimulation(
	nodes: LayoutNode[],
	edges: ReadonlyArray<LayoutEdge>,
	options: SimOptions = {},
): Simulation<LayoutNode, SimLink> {
	// Link stiffness: d3's default is 1/min(deg) (degree-scaled springs).
	// linkStrength multiplies it, so 1 = unchanged default behavior.
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	const linkStrength = options.linkStrength ?? 1;
	const linkDistance = options.linkDistance ?? LINK_DISTANCE;

	const sim = forceSimulation<LayoutNode, SimLink>(nodes)
		.force(
			"link",
			forceLink<LayoutNode, SimLink>(
				edges.map((e) => ({ source: e.from, target: e.to })),
			)
				.id((d) => d.id)
				// Per-link rest length (rendering arc, owner 2026-09-30): a
				// link touching an implication node (arg_-prefixed id — the
				// string form pre-init, the node ref after) gets HALF the
				// base distance, default or user-tuned alike.
				.distance(
					(l) =>
						impLinkId(l.source).startsWith(IMP_ID_PREFIX) || impLinkId(l.target).startsWith(IMP_ID_PREFIX)
							? linkDistance / 2
							: linkDistance,
				)
				.strength(
					(l) =>
						(linkStrength * 1) /
						Math.min(degree.get((l.source as LayoutNode).id) ?? 1, degree.get((l.target as LayoutNode).id) ?? 1),
				),
		)
		.force("charge", forceManyBody<LayoutNode>().strength(options.chargeStrength ?? CHARGE_STRENGTH))
		.alphaDecay(options.alphaDecay ?? 0.0228)
		.velocityDecay(options.velocityDecay ?? 0.4)
		.stop();

	// Gravity, mode-projected: in vertical mode the depth force OWNS the
	// y axis, so gravity goes x-only (it would fight the level lines); in
	// radial mode a center pull is purely radial and would fight the
	// rings, so it is dropped entirely (rings already bound the radius).
	// Depth mode projections (DECIDED 2026-09-13), with the ORPHAN RULE
	// (user-decided, same day): a node with no edges at all has no
	// dependency structure — depth is a property of inference chains, so
	// stamping unconnected propositions onto the baseline / base ring
	// assigns them meaning they don't have. Orphans are exempt from the
	// depth force and keep the REGULAR view's forces instead (full center
	// gravity + full cluster pull, unprojected). AMENDED (owner,
	// 2026-09-30 physics follow-up): in VERTICAL mode the central pole is
	// a HORIZONTAL force for everyone — structured and orphan/imp alike —
	// y belongs to the depth rows and to nothing else; the full regular
	// pull survives only in radial mode (where the rings own the radius).
	const mode = options.depthAnchor?.mode ?? "off";
	// The depth machinery reads the LOGICAL edge list when supplied —
	// structure is inference over propositions, not the drawn geometry.
	const depthEdges = options.logicalEdges ?? edges;
	let orphan: Uint8Array | null = null;
	let depthsComputed: Map<string, number> | null = null;
	if (mode !== "off") {
		const connected = new Set<string>();
		const valid = new Set(nodes.map((n) => n.id));
		for (const e of depthEdges) {
			// Self-loops and dangling endpoints are not a structure (same
			// guards as inferenceDepths).
			if (e.from === e.to || !valid.has(e.from) || !valid.has(e.to)) continue;
			connected.add(e.from);
			connected.add(e.to);
		}
		// Proposition ranks first; then the IMP MIDPOINT ANCHOR (owner,
		// 2026-09-30): an implication node's depth = (highest premise row
		// + conclusion row) / 2 — the junction sits strictly above every
		// premise and strictly below the conclusion (a conclusion is
		// always ≥ highest premise + 1), uniform in both modes: a row in
		// vertical, a ring in radial. Imp ids WITHOUT a supplied link
		// keep the legacy exemption.
		depthsComputed = inferenceDepths(
			nodes.filter((n) => !n.id.startsWith(IMP_ID_PREFIX)),
			depthEdges,
		);
		const anchored = new Set<string>();
		if (options.impLinks) {
			for (const link of options.impLinks) {
				const conclusionDepth = depthsComputed.get(link.conclusion);
				if (conclusionDepth === undefined || link.premises.length === 0) continue;
				let highest = -Infinity;
				let complete = true;
				for (const premise of link.premises) {
					const d = depthsComputed.get(premise);
					if (d === undefined) {
						complete = false;
						break;
					}
					if (d > highest) highest = d;
				}
				if (!complete) continue;
				depthsComputed.set(link.id, (highest + conclusionDepth) / 2);
				anchored.add(link.id);
			}
		}
		orphan = new Uint8Array(nodes.length);
		nodes.forEach((n, i) => {
			// IMP nodes with a midpoint anchor are STRUCTURED (they sit on
			// their half-row); unlinked arg_ ids keep the orphan exemption.
			if (!connected.has(n.id) && !(n.id.startsWith(IMP_ID_PREFIX) && anchored.has(n.id))) orphan![i] = 1;
		});
	}
	const g = options.gravity;
	if (g && mode === "off") {
		sim.force("x", forceX<LayoutNode>(g.x).strength(g.strength));
		sim.force("y", forceY<LayoutNode>(g.y).strength(g.strength));
	} else if (g) {
		// Mode-projected gravity, EXACTLY d3's forceX/forceY math (restoring
		// force × strength × alpha). VERTICAL (owner, 2026-09-30 physics
		// follow-up): the central pole is horizontal-ONLY for EVERY node —
		// structured (the depth force owns y) and orphan/imp alike (an
		// unstructured node has no row to sit on and no pole to sag
		// toward; its y is free). RADIAL: orphans keep the full regular
		// pull; structured nodes get nothing (the rings own the radius).
		const orphanMask = orphan!;
		sim.force("gravity", (alpha: number) => {
			for (let i = 0; i < nodes.length; i++) {
				const n = nodes[i]!;
				if (mode === "vertical") {
					n.vx = (n.vx ?? 0) + (g.x - (n.x ?? 0)) * g.strength * alpha;
				} else if (orphanMask[i]) {
					n.vx = (n.vx ?? 0) + (g.x - (n.x ?? 0)) * g.strength * alpha;
					n.vy = (n.vy ?? 0) + (g.y - (n.y ?? 0)) * g.strength * alpha;
				}
				// radial + structured: nothing — the rings own the radius.
			}
		});
	}

	// Cluster centroid pull: the membership index is resolved ONCE (nodes
	// don't change clusters mid-sim); each tick is two allocation-free
	// O(n) passes (sum, then pull). Singletons (<2 members) skip themselves.
	const cp = options.clusterPull;
	if (cp && cp.strength > 0 && cp.clusters.length > 0) {
		const clusterIdx = new Map<string, number>();
		cp.clusters.forEach((c, i) => {
			for (const id of c.members) clusterIdx.set(id, i);
		});
		const nodeCluster = nodes.map((n) => clusterIdx.get(n.id) ?? -1);
		const k = cp.clusters.length;
		const sumX = new Float64Array(k);
		const sumY = new Float64Array(k);
		const cnt = new Float64Array(k);
		const strength = cp.strength;
		// The cluster centroid pull also respects the depth mode: vertical
		// → x-only (the depth force owns y); radial → tangential only
		// (the radial component would drag members off their rings; the
		// tangential component still tightens each cluster's angular
		// spread, which is all clustering needs to do there).
		const ringCx = options.depthAnchor?.center?.x ?? 0;
		const ringCy = options.depthAnchor?.center?.y ?? 0;
		sim.force("clusterPull", (alpha: number) => {
			sumX.fill(0);
			sumY.fill(0);
			cnt.fill(0);
			for (let i = 0; i < nodes.length; i++) {
				const ci = nodeCluster[i]!;
				if (ci < 0) continue;
				const n = nodes[i]!;
				sumX[ci] = sumX[ci]! + (n.x ?? 0);
				sumY[ci] = sumY[ci]! + (n.y ?? 0);
				cnt[ci] = cnt[ci]! + 1;
			}
			for (let i = 0; i < nodes.length; i++) {
				const ci = nodeCluster[i]!;
				if (ci < 0 || (cnt[ci] ?? 0) < 2) continue;
				const n = nodes[i]!;
				const px = n.x ?? 0;
				const py = n.y ?? 0;
				const ux = sumX[ci]! / cnt[ci]! - px;
				const uy = sumY[ci]! / cnt[ci]! - py;
				if (orphan && orphan[i]) {
					// Orphans: full regular-view pull (see the ORPHAN RULE above).
					n.vx = (n.vx ?? 0) + ux * strength * alpha;
					n.vy = (n.vy ?? 0) + uy * strength * alpha;
				} else if (mode === "vertical") {
					n.vx = (n.vx ?? 0) + ux * strength * alpha;
				} else if (mode === "radial") {
					const rx = px - ringCx;
					const ry = py - ringCy;
					const r = Math.hypot(rx, ry);
					if (r > 1e-9) {
						// Tangential component: u − (u·r̂)r̂
						const dot = (ux * rx + uy * ry) / (r * r);
						n.vx = (n.vx ?? 0) + (ux - dot * rx) * strength * alpha;
						n.vy = (n.vy ?? 0) + (uy - dot * ry) * strength * alpha;
					}
				} else {
					n.vx = (n.vx ?? 0) + ux * strength * alpha;
					n.vy = (n.vy ?? 0) + uy * strength * alpha;
				}
			}
		});
	}

	// ── Inference-depth anchoring ────────────────────────────────────────
	// The rank is COMPUTED (not simulated): per-node target scalar derived
	// from inferenceDepths, then one O(n) pull pass per tick. Soft knob —
	// high strength approaches pinned rows/rings while low strength leaves
	// organic sag.
	const da = options.depthAnchor;
	if (da && da.mode !== "off" && da.strength > 0) {
		// The rank map (propositions + imp midpoint anchors) was computed
		// with the orphan mask above — one pass, shared.
		const depths = depthsComputed!;
		const strength = da.strength;
		const spacing = da.spacing;
		const c = da.center ?? { x: 0, y: 0 };
		const orphanMask = orphan; // ORPHAN RULE: depth skips unstructured nodes
		if (da.mode === "vertical") {
			const baseY = c.y;
			sim.force("depth", (alpha: number) => {
				for (let i = 0; i < nodes.length; i++) {
					if (orphanMask?.[i]) continue;
					const n = nodes[i]!;
					const targetY = baseY - (depths.get(n.id) ?? 0) * spacing;
					n.vy = (n.vy ?? 0) + (targetY - (n.y ?? 0)) * strength * alpha;
				}
			});
		} else {
			const baseR = da.baseRadius ?? 0;
			const cx0 = c.x;
			const cy0 = c.y;
			sim.force("depth", (alpha: number) => {
				for (let i = 0; i < nodes.length; i++) {
					if (orphanMask?.[i]) continue;
					const n = nodes[i]!;
				const dx = (n.x ?? 0) - cx0;
					const dy = (n.y ?? 0) - cy0;
					// Degenerate direction at the exact ring center: nudge
					// outward on a deterministic axis.
					const r = Math.hypot(dx, dy);
					const ux = r > 1e-9 ? dx / r : 1;
					const uy = r > 1e-9 ? dy / r : 0;
					const target = baseR + (depths.get(n.id) ?? 0) * spacing;
					const mag = (target - r) * strength * alpha;
					n.vx = (n.vx ?? 0) + ux * mag;
					n.vy = (n.vy ?? 0) + uy * mag;
				}
			});
		}
	}
	return sim;
}

export interface IncrementalLayoutOptions {
	/** Manual ticks for the settle (default 300 — d3's anneal to alphaMin). */
	ticks?: number;
	/** Per-tick anchor re-blend (default 0.85; 1 = fully pinned). */
	anchorRetention?: number;
	/** Center-of-mass gravity strength override (tuning/A-B experiments;
	 *  defaults to the internal bootstrap/incremental constants). */
	gravityStrength?: number;
	/** Cluster partition (Louvain output shape). Supplied by callers so
	 *  this module stays louvain-free (the browser bundle must not carry
	 *  embedding ledger; absent = no cluster pull. */
	clusters?: ReadonlyArray<{ members: ReadonlyArray<string> }>;
	/** Cluster centroid pull strength (default CLUSTER_PULL_STRENGTH). */
	clusterPullStrength?: number;
	/** Inference-depth anchoring (see DepthAnchor). `center` defaults to
	 *  the anchored core's centroid. */
	depthAnchor?: DepthAnchor;
	/** The LOGICAL edge list for the depth pass (see SimOptions). */
	logicalEdges?: ReadonlyArray<LayoutEdge>;
	/** The imp chain linkage for the midpoint anchor (see SimOptions). */
	impLinks?: ReadonlyArray<ImpLink>;
}

/**
 * One incremental settle. `nodes`/`edges` describe the CURRENT graph;
 * `previous` is the positions ledger (empty on the very first settle —
 * then this degrades to a seeded-scatter bootstrap). Returns positions
 * for EVERY node in `nodes`.
 */
export function incrementalLayout(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	edges: ReadonlyArray<LayoutEdge>,
	previous: ReadonlyMap<string, Position>,
	options: IncrementalLayoutOptions = {},
): Map<string, Position> {
	const ticks = options.ticks ?? 300;
	const retention = options.anchorRetention ?? ANCHOR_RETENTION;

	// Anchors: the warm-start set (the previous rest state).
	const anchors = new Map<string, Position>();
	for (const node of nodes) {
		const prev = previous.get(node.id);
		if (prev) anchors.set(node.id, { x: prev.x, y: prev.y });
	}

	// The anchored core's bounding box + centroid, for rim seeds.
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let cx = 0;
	let cy = 0;
	for (const a of anchors.values()) {
		minX = Math.min(minX, a.x);
		maxX = Math.max(maxX, a.x);
		minY = Math.min(minY, a.y);
		maxY = Math.max(maxY, a.y);
		cx += a.x;
		cy += a.y;
	}
	const hasCore = anchors.size > 0;
	if (hasCore) {
		cx /= anchors.size;
		cy /= anchors.size;
	}
	const coreRadius = hasCore ? Math.max(maxX - minX, maxY - minY) / 2 : 1;

	// Adjacency for neighbor seeding (undirected: edges include assertions).
	const adjacency = new Map<string, string[]>();
	const linkTo = (a: string, b: string): void => {
		if (a === b) return;
		let list = adjacency.get(a);
		if (!list) adjacency.set(a, (list = []));
		list.push(b);
	};
	for (const e of edges) {
		linkTo(e.from, e.to);
		linkTo(e.to, e.from);
	}

	// The rim radius derives from the CONNECTED core's mean radius — orphans
	// never inflate it (a max-span-based radius feeds back: each batch's
	// rim pushes the next batch's rim farther out, and the layout runs
	// away). 1.7x matches the density the FA2-era settle produced
	// (orphan mean r ~338 vs connected ~194).
	let rimRadius = 0;
	let connectedAnchored = 0;
	for (const [id, a] of anchors) {
		if ((adjacency.get(id)?.length ?? 0) === 0) continue;
		connectedAnchored++;
		rimRadius += Math.hypot(a.x - cx, a.y - cy);
	}
	if (connectedAnchored > 0) rimRadius = (rimRadius / connectedAnchored) * 1.7;
	else if (hasCore) rimRadius = coreRadius * 1.15; // no connected anchors yet: bbox fallback
	rimRadius += 4;

	// Seed every node.
	const simNodes: LayoutNode[] = nodes.map((node) => {
		const rand = seededRandom(node.id);
		const anchor = anchors.get(node.id);
		let x: number;
		let y: number;
		if (anchor) {
			// Warm start: resume from the previous rest position.
			x = anchor.x;
			y = anchor.y;
		} else {
			// New node: seed near its positioned neighbors (the cluster it
			// arrived with), else on the rim outside the core, else scatter.
			let sx = 0;
			let sy = 0;
			let found = 0;
			for (const nbr of adjacency.get(node.id) ?? []) {
				const na = anchors.get(nbr);
				if (na) {
					sx += na.x;
					sy += na.y;
					found++;
				}
			}
			if (found > 0) {
				x = sx / found + (rand() - 0.5) * 8;
				y = sy / found + (rand() - 0.5) * 8;
			} else if (hasCore) {
				const angle = rand() * Math.PI * 2;
				const radius = rimRadius + rand() * 8;
				x = cx + Math.cos(angle) * radius;
				y = cy + Math.sin(angle) * radius;
				// An orphan's intended rest spot IS the rim seed: anchor it
				// there so gravity cannot sink it into the core. (A later
				// batch linking it to the graph pulls it in naturally —
				// but then it also has a previous position, and its anchor
				// becomes that previous position, exactly like any node.)
				anchors.set(node.id, { x, y });
			} else {
				// Bootstrap: the classic seeded scatter.
				x = (rand() - 0.5) * 100;
				y = (rand() - 0.5) * 100;
			}
		}
		// d3 is fine with coincident seeds (no division), but nudge exact
		// overlaps of a brand-new node onto its only neighbor anyway.
		if (x === 0 && y === 0) x = 0.5;
		return { id: node.id, x, y };
	});

	const sim = createGraphSimulation(simNodes, edges, {
		gravity: {
			x: cx,
			y: cy,
			strength: options.gravityStrength ?? (hasCore ? INCREMENTAL_GRAVITY : BOOTSTRAP_GRAVITY),
		},
		clusterPull: options.clusters
			? { clusters: options.clusters, strength: options.clusterPullStrength ?? CLUSTER_PULL_STRENGTH }
			: undefined,
		depthAnchor:
			options.depthAnchor && options.depthAnchor.mode !== "off"
				? { ...options.depthAnchor, center: options.depthAnchor.center ?? { x: cx, y: cy } }
				: options.depthAnchor,
		logicalEdges: options.logicalEdges,
		impLinks: options.impLinks,
	});
	const dMode = options.depthAnchor?.mode ?? "off";
	const dCenter = options.depthAnchor?.center ?? { x: cx, y: cy };
	const byId = new Map(simNodes.map((n) => [n.id, n]));
	for (let i = 0; i < ticks; i++) {
		sim.tick();
		// Anchor re-blend (position space, alpha-independent — see the
		// ANCHOR_RETENTION note). Pinned nodes (fx/fy) are left to d3.
		// DEPTH-MODE PROJECTION: the re-blend preserves the user's
		// arrangement in the FREE dimension only — x in vertical mode, the
		// angle in radial mode — because the depth force owns the
		// constrained dimension (a node's level/ring is meaning, not
		// memory). Off-mode: full 2D blend as before.
		if (hasCore && retention < 1) {
			for (const [id, a] of anchors) {
				const n = byId.get(id);
				if (!n || n.fx != null || n.fy != null) continue;
				const x = n.x ?? 0;
				const y = n.y ?? 0;
				if (dMode === "vertical") {
					n.x = a.x + (x - a.x) * retention;
				} else if (dMode === "radial") {
					const rx = x - dCenter.x;
					const ry = y - dCenter.y;
					const r = Math.hypot(rx, ry);
					const ax = a.x - dCenter.x;
					const ay = a.y - dCenter.y;
					const ar = Math.hypot(ax, ay);
					if (r > 1e-9 && ar > 1e-9) {
						const theta = Math.atan2(ry, rx);
						const thetaA = Math.atan2(ay, ax);
						const blended = thetaA + Math.atan2(Math.sin(theta - thetaA), Math.cos(theta - thetaA)) * retention;
						n.x = dCenter.x + r * Math.cos(blended);
						n.y = dCenter.y + r * Math.sin(blended);
					}
				} else {
					n.x = a.x + (x - a.x) * retention;
					n.y = a.y + (y - a.y) * retention;
				}
			}
		}
	}

	const out = new Map<string, Position>();
	for (const n of simNodes) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
	return out;
}
