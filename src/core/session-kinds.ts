/**
 * Session kinds (session/record kinds, stage A — owner rulings 2026-11-16).
 *
 * A chat's SESSION KIND (contracts/chat.ts ChatKind) decides what the chat
 * extracts into — its RECORD KIND (record-kinds.ts). Stage A keeps the two
 * native kinds and makes that function explicit in one place; stage B
 * opens ChatKind to plugin-declared kinds and turns this into a registry
 * lookup where each kind names exactly one record kind.
 */

import type { ChatKind } from "./contracts/chat.ts";
import { NATIVE_GRAPH_RECORD_KIND } from "./record-kinds.ts";

/** The record kind a chat of this session kind extracts into; null when
 *  the kind writes nothing (practice, owner 2026-10-04: no extraction, no
 *  graph, no coverage). An absent kind reads as teach — no migration. */
export function recordKindIdOf(kind: ChatKind | undefined): string | null {
	switch (kind) {
		case undefined:
		case "teach":
			return NATIVE_GRAPH_RECORD_KIND;
		case "practice":
			return null;
	}
}
