/**
 * The record-kind composition (session/record kinds, stage A): the registry
 * of what extraction can deposit into, wired to the adapters. Stage A holds
 * the native graph only, with its host-owned coverage ledger from the
 * storage root (stores.coverage); stage B adds plugin-declared kinds here.
 */

import type { ChatKind } from "../core/contracts/chat.ts";
import type { CoverageLedger } from "../core/ports.ts";
import { createRecordKindRegistry, NATIVE_GRAPH_RECORD_KIND, type RecordKindRegistry } from "../core/record-kinds.ts";
import { recordKindIdOf } from "../core/session-kinds.ts";
import { stores } from "./stores.ts";

export const recordKinds: RecordKindRegistry = createRecordKindRegistry([
	{ id: NATIVE_GRAPH_RECORD_KIND, label: "Knowledge graph", coverage: stores.coverage },
]);

/** The coverage ledger a chat of this session kind folds into — null when
 *  the kind extracts nothing (practice). Every host-side coverage read for a
 *  chat (post-turn trigger, session ring) resolves through here, never
 *  straight to the graph. */
export function coverageLedgerFor(kind: ChatKind | undefined): CoverageLedger | null {
	const recordKindId = recordKindIdOf(kind);
	if (recordKindId === null) return null;
	return recordKinds.get(recordKindId)?.coverage ?? null;
}
