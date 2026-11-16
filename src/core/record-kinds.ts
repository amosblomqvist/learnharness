/**
 * Record kinds (session/record kinds, stage A — owner rulings 2026-11-16).
 *
 * A RECORD KIND is what extraction deposits into: the native knowledge
 * graph today; plugin-declared stores (a vocabulary record, …) from stage B.
 * The host has no opinion on a record's schema — the one thing it holds
 * for every kind is the COVERAGE LEDGER: which transcript messages have
 * been folded, exactly one ledger per record kind, so that "uncovered" can
 * be derived host-side for the post-turn trigger, the session ring and
 * deletion, whatever the record looks like.
 *
 * Why no `record` field on coverage rows: a chat extracts into exactly one
 * record kind, and that kind is a function of the chat's session kind
 * (session-kinds.ts recordKindIdOf) — so the ledger is chosen by kind and
 * its rows stay the bare CoverageEntry they always were. The native graph
 * ledger therefore stays byte-identical (data/graph/coverage.jsonl); a
 * plugin kind's ledger lives in the registering plugin's data directory at
 * records/<recordKindId>/coverage.jsonl (stage B).
 *
 * Stage A registers the graph only; the extractor / reader-tool / view /
 * purge members of a record kind arrive with stage B's contract spec.
 */

import type { CoverageLedger } from "./ports.ts";

/** The native graph's record-kind id — a bare name; plugin kinds are
 *  namespaced "<pluginId>:<kindId>" (owner ruling 2026-11-11, q53). */
export const NATIVE_GRAPH_RECORD_KIND = "graph";

export interface RecordKind {
	id: string;
	/** Human label (the record view switcher, stage C). */
	label: string;
	/** The host-owned coverage ledger for this record — exactly one. */
	coverage: CoverageLedger;
}

export interface RecordKindRegistry {
	get(id: string): RecordKind | undefined;
	/** Registration order. */
	list(): RecordKind[];
}

/** Build the registry from its kinds — ids are unique and non-blank;
 *  the composition root (src/server/record-kinds.ts) assembles the list. */
export function createRecordKindRegistry(kinds: readonly RecordKind[]): RecordKindRegistry {
	const byId = new Map<string, RecordKind>();
	for (const kind of kinds) {
		if (typeof kind.id !== "string" || kind.id.trim().length === 0) throw new Error("A record kind needs a non-blank id");
		if (byId.has(kind.id)) throw new Error(`Record kind "${kind.id}" is already registered`);
		byId.set(kind.id, kind);
	}
	return {
		get: (id) => byId.get(id),
		list: () => [...byId.values()],
	};
}
