// Record kinds (session/record kinds, stage A — owner rulings 2026-11-16):
// a record kind is "what extraction deposits into" — it OWNS one host-held
// coverage ledger. The native graph is the only kind in stage A; stage B
// adds plugin-declared kinds. A chat's record kind is a FUNCTION of its
// session kind (teach → graph, practice → nothing), so coverage rows carry
// no record field and the ledger is looked up by record kind, never stored
// per row.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRecordKindRegistry, NATIVE_GRAPH_RECORD_KIND, type RecordKind } from "../src/core/record-kinds.ts";
import { recordKindIdOf } from "../src/core/session-kinds.ts";
import type { CoverageLedger } from "../src/core/ports.ts";

const memoryCoverage = (): CoverageLedger => {
	const rows: ReturnType<CoverageLedger["read"]> = [];
	return { read: () => [...rows], append: (e) => { rows.push(e); }, rewrite: (next) => { rows.splice(0, rows.length, ...next); } };
};
const kind = (id: string): RecordKind => ({ id, label: id, coverage: memoryCoverage() });

describe("record-kind registry", () => {
	it("resolves kinds by id, lists them in registration order, and rejects duplicates and blank ids", () => {
		const graph = kind(NATIVE_GRAPH_RECORD_KIND);
		const other = kind("example:vocabulary");
		const registry = createRecordKindRegistry([graph, other]);
		assert.equal(registry.get(NATIVE_GRAPH_RECORD_KIND), graph);
		assert.equal(registry.get("example:vocabulary"), other);
		assert.equal(registry.get("missing"), undefined);
		assert.deepEqual(registry.list().map((k) => k.id), [NATIVE_GRAPH_RECORD_KIND, "example:vocabulary"]);
		assert.throws(() => createRecordKindRegistry([graph, kind(NATIVE_GRAPH_RECORD_KIND)]), /already registered/);
		assert.throws(() => createRecordKindRegistry([kind("")]), /id/);
	});

	it("each kind owns exactly one coverage ledger — rows never cross kinds", () => {
		const registry = createRecordKindRegistry([kind("graph"), kind("x:y")]);
		registry.get("graph")!.coverage.append({ chatId: "c", fp: "f", tokens: 1, foldedAt: "t" });
		assert.equal(registry.get("graph")!.coverage.read().length, 1);
		assert.equal(registry.get("x:y")!.coverage.read().length, 0);
	});
});

describe("recordKindIdOf — the chat's record kind is a function of its session kind", () => {
	it("teach and an absent kind extract into the native graph; practice extracts into nothing; plugin kinds name theirs", () => {
		assert.equal(recordKindIdOf("teach"), NATIVE_GRAPH_RECORD_KIND);
		assert.equal(recordKindIdOf(undefined), NATIVE_GRAPH_RECORD_KIND);
		assert.equal(recordKindIdOf("practice"), null);
		assert.equal(recordKindIdOf("example:lesson"), undefined, "a plugin kind's definition names its record");
	});
});

describe("server composition — resolveChatRecord", () => {
	it("hands out the wired graph ledger for teaching chats and none for practice", async () => {
		const { resolveChatRecord, recordKinds } = await import("../src/server/record-kinds.ts");
		const { stores } = await import("../src/server/stores.ts");
		for (const kind of ["teach", undefined] as const) {
			const target = await resolveChatRecord(kind);
			assert.equal(target.status, "graph");
			assert.equal(target.status === "graph" && target.coverage, stores.coverage);
		}
		assert.deepEqual(await resolveChatRecord("practice"), { status: "none", sessionKindId: "practice" });
		assert.deepEqual(recordKinds.list().map((k) => k.id), [NATIVE_GRAPH_RECORD_KIND]);
		assert.equal(recordKinds.get(NATIVE_GRAPH_RECORD_KIND)!.coverage, stores.coverage);
	});
});
