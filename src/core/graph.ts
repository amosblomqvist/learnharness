/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer, tree-blind and post-hoc
 * (2026-09-27 cleanup — clear separation of work):
 *
 *   extractor (LLM)  → SessionFindings: the raw reasoning chains —
 *                      propositions (lonely relevant ones included) and
 *                      chains, from the stretch (one batch) PLUS the
 *                      same-source digest (digest-aware, 2026-09-30
 *                      evening: the extractor continues its own source,
 *                      references existing ids verbatim, assembles
 *                      cross-stretch itself). Session propositions carry
 *                      their passage's messageId (2026-10-13) — the
 *                      merger's provenance anchor. Fully trusted: no
 *                      stage re-checks it.
 *   auditor (LLM)    → AuditVerdicts: identity links (local id → an existing
 *                      node, or create) via graph-exploration tools —
 *                      links ONLY (owner, 2026-09-28 evening: the auditor
 *                      never mints edges; cross-source connection happens
 *                      solely through identified equivalences). Never sees
 *                      the source; never drops; never sees chains — its
 *                      input is the fresh propositions only.
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *                      + the chain-simplification maintenance pass
 *                      (2026-09-30 evening — simplifyChains below).
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what the
 * propositions are, what follows/supports what, whether a proposition IS an
 * existing node), while timestamps/provenance — anything the model could
 * silently mis-copy — are rebuilt deterministically. Idempotent +
 * incremental: edges dedupe by (from,to,type)-already-asserted-by-this-chat,
 * mapping lines dedupe by (chat, sourceId), and coverage entries /
 * sessions.jsonl checkpoints which messages and chats have been extracted
 * (never the same turns twice). No events: the events ledger is GONE
 * (2026-09-27) — the graph carries propositions + edges, nothing else.
 *
 * Identity across re-encounters is the AUDITOR's judgment (link-or-create
 * with an equivalence bias — paraphrases merge), not string matching.
 * A re-extracted session's propositions link to the existing nodes; the
 * link appends a node line whose phrasings join `aliases` and whose
 * provenance unions (getGraph merges lines by id).
 *
 * Derivation below (getGraph / graphSnapshot) is reads only — everything
 * is recomputed from the ledgers. Every function takes the storage ports
 * (core/ports.ts) as explicit parameters — pure core, no adapter imports;
 * the composition root (src/server/stores.ts) wires the fs adapters in.
 */

import { randomBytes } from "node:crypto";
import type { CoverageEntry,
} from "./contracts/graph.ts";
import type {
	AuditVerdicts,
	ExtractedChain,
	GraphChain,
	SessionFindings,
	Cluster,
	EmissionStats,
	GraphEdge,
	GraphNode,
	ProvenancePoint,
	GraphSnapshot,
} from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
import { formatChainLine } from "./chains.ts";
import { attachImpToCommunities, birthSessionOf, birthSessionPartition } from "./session-clusters.ts";
import { sourceFileLabel } from "./source-label.ts";
import type { ChatStore, GraphStore } from "./ports.ts";

/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

/** "n_" + 12 hex chars (contracts.ts GraphNode.id — store-assigned). */
function newGraphNodeId(): string {
	return `n_${randomBytes(6).toString("hex")}`;
}

/** "arg_" + 12 hex chars — the implication-node namespace (a chain's id
 *  IS its derived node's id; collision-free with n_ by construction). */
function newGraphChainId(): string {
	return `arg_${randomBytes(6).toString("hex")}`;
}

/** A chain's merge key: sorted premises + conclusion — the identity an
 *  assertion re-stating the same argument merges under. */
function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** What one merge run merges FROM (the caller supplies it — the merger never
 *  reads the chat store): the coverage checkpoint for a session batch, or —
 *  for the format-agnostic notes front door (2026-09-13) — no coverage at
 *  all: the whole-file checkpoint stamps the import.
 *
 *  Coverage (vision-extraction-coverage.md, settled 2026-09-15): a chat merge
 *  passes the BATCH it extracted — the caller computed the fingerprints
 *  before the run, from the same snapshot the merger sees — and the final
 *  step appends one CoverageEntry per message on success ("covered" means
 *  exactly this merge happened). The notes path passes neither and keeps
 *  the whole-file checkpoint. */
export interface MergeSource {
	foldedAt: string;
	/** The batch being merged (chat path): one entry per message in the
	 *  extracted batch — undefined (notes path / coverage-less callers) →
	 *  the legacy whole-chat checkpoint is written instead. */
	coverage?: CoverageEntry[];
}

/** The run's provenance point. Chat-level by default (submit-schema slim,
 *  2026-09-28 — the run's source key is the whole point); since the anchor
 *  restore (owner, 2026-10-13) a SESSION birth may carry its passage's
 *  message id — the extractor-copied messageId, validated at the submit
 *  seam against the current batch. Chains, notes imports, and
 *  legacy/core callers lacking an anchor keep "" (chat-level). */
function pointOf(chatId: string, messageId?: string): ProvenancePoint[] {
	return [{ chatId, messageId: messageId ?? "" }];
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
	a.chatId === b.chatId && a.messageId === b.messageId;

// ─── the merger (extraction pipeline stage 3 — deterministic) ────────────────

/**
 * Merge one job's audited findings into the graph ledgers — the pipeline's
 * apply stage. Deterministic. Each chunk/batch job merges INDEPENDENTLY
 * (owner, 2026-09-29): resolution is a job-local in-memory map from this
 * submit's proposition ids to graph node ids — nothing persists between
 * jobs, so no job can see (or collide with) another's ids. Cross-job
 * identity is the auditor's alone: it links this job's propositions to
 * existing nodes before this function is ever called.
 *
 * Identity inside the job is the auditor's link-or-create verdict: `linkTo`
 * an existing node (validated against the ledger — an unknown id falls
 * back to create) appends a LINK line (the job's phrasings join the node's
 * aliases and the provenance unions; getGraph merges lines by id);
 * absent → a new node.
 *
 * `chatId` is the job's source key: a real chat, or a notes source id
 * ("src_…") for the format-agnostic import path. The `source` parameter
 * carries the checkpoint stamp; the merger itself is chat-store-free.
 */
export function mergeFindings(
	chatId: string,
	findings: SessionFindings,
	verdicts: AuditVerdicts,
	deps: GraphDeps,
	source: MergeSource,
): EmissionStats {
	const { graphStore: ledgers } = deps;
	const stats: EmissionStats = { nodes: 0, chains: 0 };

	// 1. Resolution: THIS job's propositions → graph node ids, built
	//    in-memory as the propositions resolve (owner, 2026-09-29: the
	//    mappings ledger is gone — a persisted table was a shared namespace
	//    across independent jobs, and cross-job id collisions silently
	//    dropped propositions and welded wrong edges). Dedupe across runs
	//    is the coverage ledger (nothing re-extracts) and the auditor's
	//    equivalence links (re-encountered knowledge merges in).
	const existingIds = new Set(ledgers.readNodes().map((n) => n.id));
	const mapping = new Map<string, string>();
	const now = new Date().toISOString();
	const linkOf = new Map(verdicts.links.map((l) => [l.id, l.linkTo]));

	// VERDICTS-ONLY (owner, 2026-09-28): the propositions come from the
	// extractor's findings verbatim; the auditor's links join here by id.
	for (const p of findings.propositions) {
		if (mapping.has(p.id)) continue; // duplicate id WITHIN this submit — first resolution stands
		// The anchor (2026-10-13): a session proposition may carry its
		// passage's messageId — it rides BOTH the create and the link-append
		// line (each re-encounter anchors to ITS passage); absent (notes,
		// legacy/core callers) → "", chat-level as before.
		const points = pointOf(chatId, p.messageId);
		const linkTo = linkOf.get(p.id);
		let graphNodeId: string;
		if (linkTo !== undefined && existingIds.has(linkTo)) {
			// Identity verdict: this proposition IS that node. Append a link
			// line — the session's phrasings (statement + aliases) join the
			// node's aliases, the provenance unions. Reads merge by id.
			graphNodeId = linkTo;
			// Link-append: phrasings + provenance join at read time (the
			// first line's name/statement/createdAt stand).
			ledgers.appendNode({
				id: graphNodeId,
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			});
		} else {
			const node: GraphNode = {
				id: newGraphNodeId(),
				name: p.name,
				statement: p.statement,
				aliases: [...p.aliases],
				createdAt: now,
				provenance: points,
			};
			ledgers.appendNode(node);
			stats.nodes++;
			graphNodeId = node.id;
			existingIds.add(graphNodeId);
		}
		mapping.set(p.id, graphNodeId);
	}

	// 2. Chains — the extractor's alone since the digest-aware redesign
	//    (owner, 2026-09-30 evening: the extractor continues its own
	//    source, so ITS chains may span stretches and digests). Endpoints
	//    resolve through the job-local map OR pass through verbatim when
	//    they name an existing node (digest references, ids verbatim);
	//    chains carry the run's chat-level provenance point and
	//    dedupe by (premises, conclusion) already asserted by THIS chat —
	//    an assertion by another chat stays untouched (provenance unions
	//    at read time; a known argument re-stated appends under the SAME
	//    arg_ id — link-style, exactly like node link-appends; the first
	//    line's premises/createdAt stand at read time).
	const assertedByChat = new Set<string>();
	const idOfKey = new Map<string, string>();
	for (const line of ledgers.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		if (!idOfKey.has(key)) idOfKey.set(key, line.id);
		if (line.provenance.some((pt) => pt.chatId === chatId)) assertedByChat.add(key);
	}
	const emitChain = (chain: ExtractedChain): void => {
		// Mixed namespace (digest-aware extraction, 2026-09-30): an
		// endpoint resolves through the job-local map (this submit's
		// propositions) OR passes through verbatim when it names an
		// existing node (THE GRAPH SO FAR references, ids verbatim).
		// Anything else is unresolvable — skip.
		const resolve = (endpoint: string): string | undefined =>
			mapping.get(endpoint) ?? (existingIds.has(endpoint) ? endpoint : undefined);
		const conclusion = resolve(chain.conclusion);
		if (conclusion === undefined) return; // unresolvable endpoint — skip
		// Duplicate local ids resolving to one node (two phrasings of one
		// premise) collapse; a premise equal to the conclusion is dropped.
		const premises = [...new Set(chain.premises.map(resolve))].filter(
			(p): p is string => p !== undefined && p !== conclusion,
		);
		if (premises.length === 0) return; // a chain IS an argument — bare propositions ride the node ledger alone
		const key = chainKey(premises, conclusion);
		if (assertedByChat.has(key)) return; // this chat already asserted this argument
		const id = idOfKey.get(key) ?? newGraphChainId();
		ledgers.appendChain({ id, premises, conclusion, createdAt: now, provenance: pointOf(chatId) });
		idOfKey.set(key, id);
		assertedByChat.add(key);
		stats.chains!++;
	};
	for (const chain of findings.chains) emitChain(chain); // the extractor's chains — the one chain source (digest-aware, owner 2026-09-30)

	// 2b. Simplification (owner, 2026-09-30 evening) — the deterministic
	//     dedupe pass over the WHOLE chain ledger (this merge runs inside
	//     the serialized audit section, so the rewrite is race-free). Two
	//     rules, decided per conclusion group, greedy in (premiseCount,
	//     createdAt, key) order — the leanest, earliest derivation stands:
	//     • prefer-fewest-premises: a chain whose premise set strictly
	//       contains a kept chain's premise set is redundant;
	//     • ancestry-cover: a chain whose every premise is a premise of a
	//       kept chain, or derivable from one (transitively, through the
	//       FULL pre-simplification chain set) is redundant — [A,B]⟹X
	//       plus [X,C]⟹Y makes [A,B,C]⟹Y redundant.
	//     Dropped keys take every provenance line with them (the rewrite is
	//     atomic); stats count APPENDS only — simplification is maintenance.
	const allChains = ledgers.readChains();
	const keptChains = simplifyChains(allChains);
	if (keptChains.length !== allChains.length) {
		ledgers.rewriteLedgers({ chains: keptChains });
		stats.droppedChains = allChains.length - keptChains.length;
	}

	// 3. Checkpoint — THE COVERAGE DISCIPLINE (vision-extraction-coverage.md):
	//    only now, after every append succeeded, is the batch covered. The
	//    chat path appends one CoverageEntry per message (per-batch atomic —
	//    an abort or failure mid-run leaves earlier batches covered, this
	//    batch's messages uncovered); the notes path keeps the whole-file
	//    checkpoint (a file is one shot).
	if (source.coverage !== undefined) {
		for (const entry of source.coverage) ledgers.appendCoverage(entry);
	} else {
		ledgers.appendCheckpoint({ chatId, foldedAt: source.foldedAt });
	}
	return stats;
}

/** The deterministic chain-simplification pass (owner, 2026-09-30
 *  evening): strips redundant derivations — same-conclusion chains whose
 *  premises add nothing a leaner kept chain doesn't already derive. Pure
 *  over the input list; the caller owns the ledger rewrite. Exported for
 *  tests.
 *
 *  Same (premises, conclusion) lines are ONE logical chain (read-time
 *  merge semantics) — a key is kept or dropped as a whole, every
 *  provenance line with it. */
export function simplifyChains(lines: GraphChain[]): GraphChain[] {
	if (lines.length < 2) return lines;

	// Group lines by chain key (logical chains).
	const groups = new Map<string, GraphChain[]>();
	for (const line of lines) {
		const key = chainKey(line.premises, line.conclusion);
		const bucket = groups.get(key);
		if (bucket === undefined) groups.set(key, [line]);
		else bucket.push(line);
	}

	// Ancestry over the FULL chain set: every node id reachable as a
	// premise behind an id (A⟹X makes A an ancestor of X; [X,C]⟹Y makes
	// both A and C ancestors of Y). Memoized walk, cycle-guarded (a cycle
	// cannot be minted by the extractor — a premise equal to the
	// conclusion is refused — but the walk stays honest if one ever lands).
	const premisesOf = new Map<string, string[][]>();
	for (const line of lines) {
		const bucket = premisesOf.get(line.conclusion);
		if (bucket === undefined) premisesOf.set(line.conclusion, [line.premises]);
		else bucket.push(line.premises);
	}
	const ancestryMemo = new Map<string, Set<string>>();
	const ancestry = (id: string, visiting: Set<string>): Set<string> => {
		const memo = ancestryMemo.get(id);
		if (memo !== undefined) return memo;
		const out = new Set<string>();
		if (visiting.has(id)) return out;
		visiting.add(id);
		for (const premises of premisesOf.get(id) ?? []) {
			for (const premise of premises) {
				out.add(premise);
				for (const ancestor of ancestry(premise, visiting)) out.add(ancestor);
			}
		}
		visiting.delete(id);
		ancestryMemo.set(id, out);
		return out;
	};

	// Per conclusion: greedy in (premiseCount, createdAt, key).
	const byConclusion = new Map<
		string,
		Array<{ key: string; premises: string[]; createdAt: string }>
	>();
	for (const [key, bucket] of groups) {
		const head = bucket[0]!; // the representative — its premises stand
		const entry = { key, premises: head.premises, createdAt: head.createdAt };
		const list = byConclusion.get(head.conclusion);
		if (list === undefined) byConclusion.set(head.conclusion, [entry]);
		else list.push(entry);
	}
	const droppedKeys = new Set<string>();
	for (const candidates of byConclusion.values()) {
		candidates.sort(
				(a, b) =>
					a.premises.length - b.premises.length ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.key.localeCompare(b.key),
		);
		const kept: typeof candidates = [];
		for (const candidate of candidates) {
			const candidateSet = new Set(candidate.premises);
			const redundant = kept.some((k) => {
					// Rule 1 — prefer-fewest-premises: strict subset (equal keys are
					// grouped, so a kept ⊆ candidate with fewer premises is strict).
					if (k.premises.every((p) => candidateSet.has(p))) return true;
					// Rule 2 — ancestry-cover: every candidate premise is a kept
					// premise, or reachable behind one.
					const covered = new Set(k.premises);
					for (const p of k.premises) {
						for (const ancestor of ancestry(p, new Set())) covered.add(ancestor);
					}
					return candidate.premises.every((p) => covered.has(p));
			});
			if (redundant) droppedKeys.add(candidate.key);
			else kept.push(candidate);
		}
	}
	if (droppedKeys.size === 0) return lines;
	return lines.filter((line) => !droppedKeys.has(chainKey(line.premises, line.conclusion)));
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

/** The merged STORED truth: propositions + chains (chains-primary, owner
 *  2026-09-30). `nodes` are PROPOSITIONS ONLY — no derived implication
 *  nodes; the auditor's and prober's views see the world, not the
 *  rendering. The canvas-facing VIEW (implication nodes + untyped
 *  arrows) is deriveView() below — the lossy image. */
export interface DerivedGraph {
	nodes: GraphNode[];
	chains: GraphChain[];
}

/**
 * The whole graph from the ledgers. Node LINES may repeat an id (link-
 * appends): the FIRST line defines name/statement/createdAt; later
 * lines' statements and aliases join `aliases`, provenance unions — the
 * name never changes after creation. Chain LINES are assertions, merged
 * by (premises, conclusion) with unioned provenance; the first line's
 * arg_ id / premises / createdAt are the chain's identity.
 * `store events, derive state` — this is the only reader that matters.
 */
export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph {
	// Merge node lines by id (first line defines; later lines add phrasings).
	const byId = new Map<string, GraphNode>();
	for (const line of graphStore.readNodes()) {
		const existing = byId.get(line.id);
		if (!existing) {
			byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
			continue;
		}
		// A later line's statement is a phrasing, not a replacement.
		for (const phrasing of [line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
		}
		for (const pt of line.provenance) {
			if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
		}
	}

	// Merge chain assertion lines by (premises, conclusion): the first
	// line's id/premises/createdAt stand, provenance unions.
	const chains: GraphChain[] = [];
	const byKey = new Map<string, GraphChain>();
	for (const line of graphStore.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		const existing = byKey.get(key);
		if (existing) {
			for (const pt of line.provenance) {
				if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
			}
		} else {
			const chain: GraphChain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
			byKey.set(key, chain);
			chains.push(chain);
		}
	}
	return { nodes: [...byId.values()], chains };
}

/** The DERIVED view — what the canvas renders. A SINGLE-premise chain
 *  collapses to ONE direct arrow premise → conclusion (no imp node:
 *  a chain is always N-in/1-out, so one premise is the degenerate
 *  1-in-1-out case). A MULTI-premise chain mints an implication NODE
 *  (id = the chain's arg_ id; name "⟹"; statement = the chain line;
 *  the chain's provenance/createdAt) plus arrows: each premise → the
 *  implication node, the implication node → the conclusion — the
 *  canvas renders imp nodes as pure geometry (owner, rendering arc:
 *  invisible, unpickable; co-premise lines converge headless to a
 *  point, one arrowed line leaves it). Physics keeps imp nodes as
 *  regular citizens (half link distance — layout.ts). Dangling chains
 *  (a member node missing) drop here — the deletion cascades should
 *  prevent them; this is the honest belt. */
export function deriveView(graph: DerivedGraph): {
	nodes: GraphNode[];
	edges: GraphEdge[];
	logicalEdges: GraphEdge[];
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
	const names: Record<string, { name: string }> = {};
	for (const node of graph.nodes) names[node.id] = { name: node.name };
	const live = new Set(graph.nodes.map((node) => node.id));
	const impNodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	// The LOGICAL edge set (owner, 2026-09-30): every chain contracted to
	// direct premise→conclusion arrows over PROPOSITION ids only —
	// what inference semantics (the depth pass) consumes. The drawn edges
	// are the canvas image; these are the meaning.
	const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
	const logicalEdges: GraphEdge[] = [];
	const logicalSeen = new Set<string>();
	const emitLogical = (from: string, to: string): void => {
		const key = from + "\u0000" + to;
		if (logicalSeen.has(key)) return;
		logicalSeen.add(key);
		logicalEdges.push({ from, to });
	};
	for (const chain of graph.chains) {
		if (!live.has(chain.conclusion) || !chain.premises.every((premise) => live.has(premise))) continue;
		for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
		// Single premise: the argument IS a plain arrow — no geometry
		// point needed (the 1-in/1-out collapse; rendering arc, owner).
		if (chain.premises.length === 1) {
			edges.push({ from: chain.premises[0]!, to: chain.conclusion });
			continue;
		}
		impNodes.push({
			id: chain.id,
			name: "⟹",
			statement: formatChainLine(chain, names),
			aliases: [],
			createdAt: chain.createdAt,
			provenance: [...chain.provenance],
		});
		// The junction's linkage — what the depth pass needs for the
		// midpoint anchor (owner, 2026-09-30).
		impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
		for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
		edges.push({ from: chain.id, to: chain.conclusion });
	}
	return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps, sourceNames: Readonly<Record<string, string>> = {}): GraphSnapshot {
	const graph = getGraph(deps.graphStore);
	// The canvas-facing lossy image: propositions + derived implication
	// nodes, untyped arrows. `chains` (the stored truth) ride along for
	// the chain table — it reads the truth, never the derived fan-out,
	// never the derived fan-out.
	const view = deriveView(graph);
	const nodes = view.nodes;

	const nodeChats = new Map<string, Set<string>>();
	const touch = (nodeId: string, chatId: string): void => {
		let chats = nodeChats.get(nodeId);
		if (!chats) {
			chats = new Set();
			nodeChats.set(nodeId, chats);
		}
		chats.add(chatId);
	};
	for (const node of nodes) {
		for (const pt of node.provenance) touch(node.id, pt.chatId);
	}
	// Labels for every source the graph can point back at: real chats
	// (title, deep-linkable) and imported notes files (path, static — the
	// format-agnostic front door's provenance).
	const sourceIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) sourceIds.add(id);
	}
	const sessions: Record<string, string> = {};
	const fileSources: Record<string, string> = {};
	for (const id of sourceIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) {
			sessions[id] = chat.title;
			continue;
		}
		const source = deps.graphStore.readSources().find((s) => s.id === id);
		if (source) fileSources[id] = source.filePath;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined || fileSources[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	// BIRTH-SESSION CLUSTERS (wave 7, owner-locked 2026-09-23): embeddings
	// are dead — a cluster is the SESSION THAT CREATED ITS PROPOSITIONS,
	// derived on read from provenance (core/session-clusters.ts). The label
	// is the session's NAME (chat title / file path): no LLM naming pass, no
	// persisted partition to invalidate. MIN_CLUSTER_SIZE stays the hull
	// presentation rule (a region needs >= 3 propositions for a hull). A
	// birth session whose record is gone (deleted chat) keeps its members
	// but renders unlabeled — honest, never guessed.
	// PROPOSITIONS ONLY (owner, 2026-09-30): derived implication nodes
	// never partition — the stored world clusters, its image follows.
	const communities = birthSessionPartition(graph.nodes);
	const clusters: Cluster[] = communities
		.filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
		.map((community) => {
			// Display names never replace the original provenance path.
			const file = fileSources[community.id];
			return {
				id: community.id,
				label: sessions[community.id] ?? (file === undefined ? null : sourceNames[community.id] ?? sourceFileLabel(file)),
				members: community.members,
			};
		});
	// IMP-NODE CLUSTER ASSIGNMENT (owner, 2026-09-30): majority among the
	// premises' birth sessions, ties to the chain's own birth — attached
	// AFTER the hull filter so a two-proposition community + its bundle
	// never resurrects a hull (the filter counts propositions). Both
	// cluster-membership consumers — the sim's centroid pull and the
	// canvas's region rasterization — read it through this one list.
	attachImpToCommunities(clusters, graph.nodes, graph.chains);

	// Resting layout (Option A): the positions ledger, when the settle has
	// ever run. Absent on a fresh graph — the view falls back to its own
	// one-shot pass until the first merge writes the ledger.
	const positions = deps.graphStore.readPositions();

	return {
		nodes,
		propositions: graph.nodes,
		edges: view.edges,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
		chains: graph.chains,
		sessions,
		fileSources,
		nodeSessions,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}

// ─── Prober graph tools — the data seam (wave 7, owner-locked 2026-09-23) ───

/** One session in the prober's graph view: every provenance anchor the
 *  graph can name — a real chat (deep-linkable) or an imported notes file
 *  (owner ruling 2026-09-23: files are birth-sessions too, kind "file").
 *  The prober's session-list tool renders these; the per-session view is
 *  graphSessionPropositions below. Pure derivation over the same ports
 *  the snapshot reads — Teacher's tool handlers call these in-process. */
export interface GraphSessionEntry {
	/** chatId or notes source id ("src_…") — the birth-session key. */
	id: string;
	/** The chat's title, or the file's path — the cluster label's source. */
	name: string;
	/** A real chat (its record still exists) or an imported notes file. */
	kind: "chat" | "file";
	/** When the session began: the chat's createdAt, or the file's
	 *  importedAt. null when no record can date it. */
	createdAt: string | null;
	/** Most recent activity: the chat's updatedAt, or the file's
	 *  importedAt. null when no record can date it. */
	updatedAt: string | null;
	/** How many propositions were BORN in this session (birth-session
	 *  clustering's count — shared/re-encountered nodes count for their
	 *  birth session only). */
	propositions: number;
}

/** The prober's session list: every birth session, most-recently-active
 *  first (undatable records sink, in stable id order). */
export function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[] {
	const counts = new Map<string, number>();
	const born = getGraph(deps.graphStore);
	for (const cluster of birthSessionPartition(born.nodes)) {
		counts.set(cluster.id, cluster.members.length);
	}
	const chats = new Map(deps.chatStore.listChats().map((chat) => [chat.id, chat]));
	const sources = new Map(deps.graphStore.readSources().map((s) => [s.id, s]));
	const entries: GraphSessionEntry[] = [];
	for (const [id, propositions] of counts) {
		const chat = chats.get(id);		if (chat) {
			entries.push({
				id,
				name: chat.title,
				kind: "chat",
				createdAt: chat.createdAt,
				updatedAt: chat.updatedAt,
				propositions,
			});
			continue;
		}
		const source = sources.get(id);
		entries.push({
			id,
			name: source?.filePath ?? id,
			kind: "file",
			createdAt: source?.importedAt ?? null,
			updatedAt: source?.importedAt ?? null,
			propositions,
		});
	}
	return entries.sort(
		(a, b) =>
			(b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
			(b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
			(a.id < b.id ? -1 : 1),
	);
}

/** One birth proposition of one session — WHAT WAS COVERED there (2026-09-27
 *  cleanup: no understanding levels; assessment is
 *  territory and nothing writes it until that module exists). */
export interface GraphSessionProposition {
	nodeId: string;
	/** The compact handle — the same name the canvas shows. */
	name: string;
}

/** The propositions BORN in one session — what that session first
 *  articulated. Members sorted by node id — deterministic. */
export function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[] {
	const born = getGraph(deps.graphStore).nodes.filter((node) => birthSessionOf(node) === sessionId);
	return born
		.map((node) => ({ nodeId: node.id, name: node.name }))
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
}

// Re-export: the contract owns the shape; legacy importers still reach it.
export type { EmissionStats };


