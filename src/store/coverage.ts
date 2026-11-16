/**
 * CoverageLedger — the fs JSONL adapter for host-owned extraction coverage
 * (session/record kinds, stage A — owner rulings 2026-11-16).
 *
 * Coverage is the HOST's bookkeeping of which transcript messages have
 * been folded into a record, ONE ledger per record kind (core/record-kinds.ts).
 * It left GraphStore on 2026-11-16 so that a plugin-declared record kind can
 * own the same bookkeeping without touching the graph family; the native
 * graph record's ledger stays exactly where it was — data/graph/coverage.jsonl,
 * byte-identical lines (contracts/graph.ts CoverageEntry) — and keeps the
 * graph-family format guards (graph-format.ts): assert on read, lazy stamp
 * on append, nothing on rewrite (the old rewriteLedgers never stamped).
 *
 * Plugin record kinds (stage B) get a guard-free ledger under their own
 * data directory: records/<recordKindId>/coverage.jsonl.
 */

import { LEDGER_FILES } from "../../config.ts";
import type { CoverageEntry } from "../core/contracts.ts";
import type { CoverageLedger } from "../core/ports.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { appendJsonlLine, readJsonlLines, writeJsonlAtomic } from "./jsonl.ts";

/** Family hooks: the graph ledger runs the format guards; others run none. */
export interface CoverageLedgerGuards {
	/** Runs before every read (honest refusal on a newer-stamped data dir). */
	beforeRead?: () => void;
	/** Runs before every append (the lazy format stamp). Rewrite never stamps. */
	beforeAppend?: () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Strict shape guard — anything else is skipped, never guessed at. */
export const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && typeof v.chatId === "string" && typeof v.fp === "string" && typeof v.tokens === "number" && typeof v.foldedAt === "string";

export function createCoverageLedger(file: string, guards: CoverageLedgerGuards = {}): CoverageLedger {
	return {
		read(): CoverageEntry[] {
			guards.beforeRead?.();
			return readJsonlLines(file).filter(isCoverageEntry);
		},
		append(entry: CoverageEntry): void {
			guards.beforeAppend?.();
			appendJsonlLine(file, entry);
		},
		rewrite(entries: CoverageEntry[]): void {
			writeJsonlAtomic(file, entries);
		},
	};
}

/** The native graph record's ledger — data/graph/coverage.jsonl, under the
 *  graph-family format stamp exactly as before the extraction. */
export const graphCoverage: CoverageLedger = createCoverageLedger(LEDGER_FILES.coverage, {
	beforeRead: assertGraphFormat,
	beforeAppend: ensureGraphFormat,
});
