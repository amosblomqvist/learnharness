/**
 * CLUSTER PRESENTATION RULES (vision §1). DETECTION is birth-session
 * clustering since wave 7 (core/session-clusters.ts; the semantic
 * embedder, its Louvain predecessor, and the LLM label matcher are all
 * dead — labels are session names now). What remains here is the
 * one presentation rule the snapshot and the renderer share.
 *
 * Browser-safe pure logic (no node builtins, no fs).
 */

/** Communities below this size are not rendered, not named — presentation
 *  rule (user-decided 2026-09-13): a region of the world model needs at
 *  least three propositions to be worth a hull and a label. */
export const MIN_CLUSTER_SIZE = 3;