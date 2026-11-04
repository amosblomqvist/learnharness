import type { PlanEdge, PlanNode, PlanTree } from "./contracts.ts";

/**
 * Pure, validated plan-tree operations (vision §2 "the formal plan tree").
 *
 * Every function takes a tree and returns a NEW tree — never mutates its
 * input. All validation throws PlanTreeError with a message written for the
 * agent (it flows straight back as a tool-result error), stating exactly what
 * is wrong and which id/edge is at fault.
 *
 * Invariants enforced everywhere:
 * - Node ids are unique and non-empty; every edge endpoint references an
 *   existing node.
 * - The structure is a DAG: no self-loops, no duplicate edges, no cycles.
 * - `version` increments on every successful STATE-CHANGING op. True no-ops
 *   (setCurrent to the already-current node, markDone of an already-done
 *   node) return the input tree unchanged — version drives UI re-animation,
 *   so a non-change must not tick it. createTree always starts at version 1.
 */

/** Error thrown by every op on invalid input. Message is agent-readable. */
export class PlanTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanTreeError";
	}
}

/** An empty, never-stored tree used as the seed before plan_init runs. */
export function emptyTree(): PlanTree {
	return { nodes: [], edges: [], version: 0 };
}

// ─── validation helpers ──────────────────────────────────────────────────────

function assertValidNode(node: PlanNode): void {
	if (!node || typeof node.id !== "string" || node.id.trim() === "") {
		throw new PlanTreeError("Every node needs a non-empty `id` (a stable slug like 'chain-rule-intuition').");
	}
	if (typeof node.title !== "string" || node.title.trim() === "") {
		throw new PlanTreeError(`Node "${node.id}" needs a non-empty \`title\`.`);
	}
}

function nodeMap(nodes: PlanNode[]): Map<string, PlanNode> {
	const map = new Map<string, PlanNode>();
	for (const node of nodes) {
		assertValidNode(node);
		if (map.has(node.id)) {
			throw new PlanTreeError(`Duplicate node id "${node.id}" — node ids must be unique.`);
		}
		map.set(node.id, node);
	}
	return map;
}

function requireNode(map: Map<string, PlanNode>, id: string, what: string): void {
	if (!map.has(id)) {
		throw new PlanTreeError(`${what} references unknown node id "${id}" — it is not in the tree.`);
	}
}

function edgeKey(from: string, to: string): string {
	return `${from}\u0000${to}`;
}

/**
 * Would adding edge from→to create a cycle? Walk forward from `to` along
 * existing edges; if we can reach `from`, the new edge closes a loop.
 */
function createsCycle(edges: PlanEdge[], from: string, to: string): boolean {
	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		const list = adjacency.get(e.from);
		if (list) list.push(e.to);
		else adjacency.set(e.from, [e.to]);
	}
	const stack = [to];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === from) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const next of adjacency.get(current) ?? []) stack.push(next);
	}
	return false;
}

/** Full edge validation against existing nodes/edges: endpoints exist, no self-loop, no duplicate, acyclic. */
function assertValidEdge(from: string, to: string, nodes: PlanNode[], existingEdges: PlanEdge[]): void {
	const map = nodeMap(nodes); // also re-validates nodes on createTree
	requireNode(map, from, "Edge `from`");
	requireNode(map, to, "Edge `to`");
	if (from === to) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" is a self-loop — a node can't require itself.`);
	}
	if (existingEdges.some((e) => e.from === from && e.to === to)) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" already exists — duplicate edges are not allowed.`);
	}
	if (createsCycle(existingEdges, from, to)) {
		throw new PlanTreeError(
			`Edge "${from}" → "${to}" would create a cycle: "${to}" already leads (directly or transitively) back to "${from}". ` +
				`"from" must be understood before "to" — the tree is a DAG.`,
		);
	}
}

// ─── ops ─────────────────────────────────────────────────────────────────────

/** Build a fresh tree (version 1) from node and edge lists, validating all invariants. */
export function createTree(nodes: PlanNode[], edges: PlanEdge[]): PlanTree {
	const map = nodeMap(nodes);
	for (const e of edges) {
		requireNode(map, e.from, "Edge `from`");
		requireNode(map, e.to, "Edge `to`");
	}
	const accepted: PlanEdge[] = [];
	for (const e of edges) {
		// Each edge is checked against the ones already accepted, so any
		// violation names the culprit edge.
		assertValidEdge(e.from, e.to, nodes, accepted);
		accepted.push({ from: e.from, to: e.to });
	}
	return { nodes: nodes.map((n) => ({ ...n })), edges: accepted, version: 1 };
}

// The per-node mutation ops (addNode/updateNode/removeNode/addEdge/removeEdge/
// setCurrent/markDone) were deleted with the author-once protocol
// (2026-09-03) and their dead exports removed with the 2026-09-11 pivot: the
// tree carries structure ONLY — no progress fields exist to mutate
// (docs/archive/probe-teach-split.md §3). Restructuring is a plan_init rewrite.
