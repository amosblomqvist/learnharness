/**
 * JSONL primitives shared by the ledger adapters (graph.ts, coverage.ts):
 * one JSON record per line, trailing newline. Reads skip corrupt lines
 * rather than failing the whole read — a torn append must never take a
 * derived view down with it; the ledgers are the source of truth and the
 * callers apply their own strict shape guards on what comes back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** Append one record as a single line (creates the folder on first write). */
export function appendJsonlLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Every parseable line, in file order; a missing file reads as empty. */
export function readJsonlLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read.
		}
	}
	return out;
}

/** Atomic full-content replacement (atomic-write.ts: a crash mid-write
 *  leaves the original, never a torn ledger). An empty array writes an
 *  empty file — a purged ledger reads as "nothing yet". The reader must
 *  see exactly what appendJsonlLine would have written. */
export function writeJsonlAtomic(file: string, records: readonly unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
	writeFileAtomicSync(file, body);
	removeLeftoverTemps(file); // crash leftovers would still hold the purged records
}
