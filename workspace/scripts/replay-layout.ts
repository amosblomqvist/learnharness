/**
 * Option A simulation: replay the CURRENT graph through the incremental
 * layout as if it had arrived one imported-notes file at a time — the
 * organic growth path the user described (one dependency structure /
 * cluster at a time, orphans collecting on the rim).
 *
 * Reads ONLY the ledgers (nodes / edges / mappings / sources); writes ONLY
 * data/graph/positions.json — no LLM calls, no extraction, no chat records.
 *
 *   npx tsx scripts/replay-layout.ts [--depth=vertical|radial]
 *
 * --depth regenerates the ledger WITH inference-depth anchoring (the
 * playground mode baked into the rest state); omit it for the free layout.
 */
import { graphStore } from "../src/store/graph.ts";
// --depth=vertical|radial: bake the playground depth mode into the ledger.
const depthArg = process.argv.find((a) => a.startsWith("--depth="));
const depthMode: "off" | "vertical" | "radial" =
	depthArg === "--depth=vertical" ? "vertical" : depthArg === "--depth=radial" ? "radial" : "off";
import { incrementalLayout } from "../src/core/layout.ts";
import { birthSessionPartition } from "../src/core/session-clusters.ts";
import { deriveView, getGraph } from "../src/core/graph.ts";
import type { GraphNode, Position } from "../src/core/contracts.ts";

function main() {
	const t0 = Date.now();

	// CHAINS-PRIMARY (2026-09-30): the stored truth is nodes + chains; the
	// replay lays out the DERIVED view (implication nodes included, untyped
	// arrows) exactly like the real settle.
	const graph = getGraph(graphStore);
	const nodes = graph.nodes; // getGraph already merges lines by id
	const view = deriveView(graph);
	const edges = view.edges;
	const logicalEdges = view.logicalEdges;
	const impLinks = view.impLinks;
	const viewNodeById = new Map(view.nodes.map((n) => [n.id, n]));
	const chains = graph.chains;
	// An implication node is delivered the moment its chain is complete
	// (conclusion + every premise delivered).
	const chainReady = (id: string): boolean => {
		const chain = chains.find((c) => c.id === id);
		if (!chain) return delivered.has(id);
		return delivered.has(chain.conclusion) && chain.premises.every((p) => delivered.has(p));
	};
	// The cluster source (wave 7): the birth-session partition, derived on
	// read — same as the real settle (core/layout-settle.ts).
	const birthClusters = birthSessionPartition(nodes);

	// Batches: each imported file, in real import order (sources.json
	// importedAt). A node belongs to the session of its FIRST provenance
	// point (line order = arrival); nodes with no provenance (legacy) ride
	// the final batch.
	const sources = [...graphStore.readSources()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
	const batchOf = new Map<string, string>(); // nodeId → srcId
	for (const node of nodes) {
		const birth = node.provenance[0]?.chatId;
		if (birth !== undefined && !batchOf.has(node.id)) batchOf.set(node.id, birth);
	}

	const delivered = new Set<string>();
	let positions = new Map<string, Position>(Object.entries(graphStore.readPositions()));
	if (positions.size > 0) {
		console.log("[replay] discarding existing positions ledger — full replay from empty");
		positions = new Map();
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const unmappedFallback = sources[sources.length - 1]?.id ?? "";

	console.log(`[replay] ${nodes.length} nodes, ${chains.length} chains, ${sources.length} sources`);
	let maxOldShift = 0;
	let shiftReport = "";
	for (const source of sources) {
		const batch = nodes.filter((n) => batchOf.get(n.id) === source.id);
		const isLast = source.id === sources[sources.length - 1]!.id;
		if (isLast) {
			// Sweep in any never-mapped nodes with the last batch.
			for (const n of nodes) {
				if (!batchOf.has(n.id) && !delivered.has(n.id)) {
					batch.push(n);
					batchOf.set(n.id, unmappedFallback);
				}
			}
		}
		for (const n of batch) delivered.add(n.id);
		// Ready chains' implication nodes ride the same batch (they have no
		// provenance of their own — the chain's completeness delivers them).
		for (const chain of chains) {
			if (chainReady(chain.id)) delivered.add(chain.id);
		}

		// Edges activate once BOTH endpoints exist (a later file can claim
		// one endpoint — the edge lights up then).
		const activeEdges = edges.filter((e) => delivered.has(e.from) && delivered.has(e.to));
		const activeLogical = logicalEdges.filter((e) => delivered.has(e.from) && delivered.has(e.to));

		const before = new Map(positions);
		const batchNodes = view.nodes.filter((n) => delivered.has(n.id));
		positions = incrementalLayout(batchNodes, activeEdges, positions, {
			// The same partition the real settle would see for this batch:
			// the birth-session clusters, filtered to delivered nodes.
			clusters: birthClusters
				.map((c) => ({ members: c.members.filter((id) => delivered.has(id)) }))
				.filter((c) => c.members.length > 0),
			...(depthMode === "off"
				? {}
				: {
						depthAnchor: {
							mode: depthMode,
							strength: 0.8,
							spacing: 60,
							...(depthMode === "radial" ? { baseRadius: 220 } : {}),
						},
						logicalEdges: activeLogical,
						// A junction's anchor lights up exactly when the
						// chain is delivered (its members all arrived).
						impLinks: impLinks.filter((l) => delivered.has(l.id)),
					}),
		});
		for (const [id, prev] of before) {
			const now = positions.get(id)!;
			const shift = Math.hypot(prev.x - now.x, prev.y - now.y);
			if (shift > maxOldShift) {
				maxOldShift = shift;
				shiftReport = `${id} ${prev.x.toFixed(0)},${prev.y.toFixed(0)} -> ${now.x.toFixed(0)},${now.y.toFixed(0)} (batch ${batch.length} new, ${activeEdges.length} edges)`;
			}
		}
		const label = source.filePath.split("/").pop() ?? source.id;
		console.log(
			`[replay] +${String(batch.length).padStart(3)} nodes  ${String(activeEdges.length).padStart(4)} edges active  (${label})`,
		);
	}

	graphStore.writePositions(Object.fromEntries(positions));
	console.log(
		`[replay] done: ${positions.size} positions written in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
			` (max old-node shift within a batch: ${maxOldShift.toFixed(1)}: ${shiftReport})`,
	);
}

main();