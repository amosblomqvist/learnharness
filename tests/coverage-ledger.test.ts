// The host-owned coverage ledger (session/record kinds, stage A — owner
// rulings 2026-11-16): coverage leaves GraphStore and becomes its own
// port + fs adapter, ONE ledger per record kind. The native graph record's
// ledger stays at data/graph/coverage.jsonl, byte-identical to what the
// GraphStore adapter used to write, and keeps the graph-family format
// guards (assert on read, lazy stamp on append).
//
// 1. BYTES: append writes exactly one JSON line + "\n"; a missing file reads
//    empty; corrupt / off-shape lines are skipped, never guessed at.
// 2. REWRITE: atomic full replacement; an empty array writes an empty file;
//    crash leftovers beside the ledger are removed.
// 3. GUARDS: beforeRead runs on every read, beforeAppend on every append,
//    neither on rewrite (mirrors the old GraphStore.rewriteLedgers, which
//    never stamped).
// 4. GRAPH FAMILY: the wired graphCoverage instance stamps format.json on
//    its first append and refuses reads of a newer-stamped data dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { CoverageEntry } from "../src/core/contracts.ts";

// The data-dir seam BEFORE any config-loading import (config.ts reads
// LH_DATA_DIR once at load): the wired graphCoverage must land in TMP.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coverage-ledger-"));
process.env.LH_DATA_DIR = TMP;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const { createCoverageLedger, graphCoverage } = await import("../src/store/coverage.ts");
const { LEDGER_FILES, GRAPH_FORMAT_FILE } = await import("../config.ts");
const { CURRENT_GRAPH_FORMAT_VERSION } = await import("../src/core/contracts/graph.ts");

const row = (chatId: string, i = 0): CoverageEntry => ({ chatId, fp: `${chatId}-${i}`, tokens: 10 + i, foldedAt: "2026-11-16T00:00:00.000Z" });

describe("createCoverageLedger — the fs JSONL adapter", () => {
	it("reads empty before anything was written, and appends one JSON line per row", () => {
		const file = path.join(TMP, "a", "coverage.jsonl");
		const ledger = createCoverageLedger(file);
		assert.deepEqual(ledger.read(), []);
		ledger.append(row("c1"));
		ledger.append(row("c1", 1));
		assert.equal(fs.readFileSync(file, "utf-8"), `${JSON.stringify(row("c1"))}\n${JSON.stringify(row("c1", 1))}\n`, "byte-identical to the legacy GraphStore append");
		assert.deepEqual(ledger.read(), [row("c1"), row("c1", 1)]);
	});

	it("skips corrupt and off-shape lines without failing the read", () => {
		const file = path.join(TMP, "b", "coverage.jsonl");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, [JSON.stringify(row("ok")), "{not json", JSON.stringify({ chatId: "x", fp: 1 }), "", JSON.stringify(row("ok", 1))].join("\n") + "\n");
		assert.deepEqual(createCoverageLedger(file).read(), [row("ok"), row("ok", 1)]);
	});

	it("rewrite replaces the whole ledger atomically, writes an empty file for [], and clears crash leftovers", () => {
		const file = path.join(TMP, "c", "coverage.jsonl");
		const ledger = createCoverageLedger(file);
		ledger.append(row("keep"));
		ledger.append(row("drop"));
		fs.writeFileSync(`${file}.tmp-leftover`, "stale bytes");
		ledger.rewrite([row("keep")]);
		assert.equal(fs.readFileSync(file, "utf-8"), `${JSON.stringify(row("keep"))}\n`);
		assert.equal(fs.existsSync(`${file}.tmp-leftover`), false, "leftover temp removed");
		ledger.rewrite([]);
		assert.equal(fs.readFileSync(file, "utf-8"), "", "a purged ledger is an empty file, not a missing one");
		assert.deepEqual(ledger.read(), []);
	});

	it("runs beforeRead on reads and beforeAppend on appends — never on rewrite", () => {
		const file = path.join(TMP, "d", "coverage.jsonl");
		const calls: string[] = [];
		const ledger = createCoverageLedger(file, { beforeRead: () => calls.push("read"), beforeAppend: () => calls.push("append") });
		ledger.read();
		ledger.append(row("g"));
		ledger.rewrite([]);
		assert.deepEqual(calls, ["read", "append"]);
		const refusing = createCoverageLedger(file, { beforeRead: () => { throw new Error("newer than me"); } });
		assert.throws(() => refusing.read(), /newer than me/);
	});
});

describe("graphCoverage — the native graph record's wired ledger", () => {
	it("stamps the graph-family format on first append and refuses a newer-stamped data dir", () => {
		assert.equal(LEDGER_FILES.coverage, path.join(TMP, "graph", "coverage.jsonl"), "the graph ledger path is unchanged");
		assert.deepEqual(graphCoverage.read(), []);
		graphCoverage.append(row("c"));
		assert.deepEqual(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf-8")), { version: CURRENT_GRAPH_FORMAT_VERSION }, "lazy stamp on the first write");
		assert.equal(fs.readFileSync(LEDGER_FILES.coverage, "utf-8"), `${JSON.stringify(row("c"))}\n`);
		fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION + 1 }));
		assert.throws(() => graphCoverage.read(), /stamped with format version/);
	});
});
