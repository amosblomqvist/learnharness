import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-store-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("graphStore stat-validated read cache", () => {
	it("invalidates ledger, positions, and sources caches on writes and external changes", () => {
		assert.deepEqual(graphStore.readNodes(), []);
		assert.deepEqual(graphStore.readPositions(), {});
		assert.deepEqual(graphStore.readSources(), []);

		graphStore.appendNode({
			id: "n1",
			name: "Alpha",
			statement: "Alpha statement",
			aliases: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			provenance: [{ chatId: "c1", messageId: "m1" }],
		});
		const nodes1 = graphStore.readNodes();
		assert.equal(nodes1.length, 1);
		assert.equal(nodes1[0]?.id, "n1");

		// Caller array mutation must not corrupt cached array.
		nodes1.pop();
		assert.equal(graphStore.readNodes().length, 1);

		graphStore.writePositions({ n1: { x: 10, y: 20 } });
		const pos1 = graphStore.readPositions();
		assert.deepEqual(pos1.n1, { x: 10, y: 20 });
		if (pos1.n1) pos1.n1.x = 999;
		assert.equal(graphStore.readPositions().n1?.x, 10);

		graphStore.upsertSource({ id: "s1", filePath: "/tmp/a.md", importedAt: "2026-01-01T00:00:00.000Z" });
		assert.equal(graphStore.readSources().length, 1);

		graphStore.rewriteLedgers({ nodes: [] });
		assert.equal(graphStore.readNodes().length, 0);

		// External write invalidation
		const nodesFile = path.join(TMP_DATA, "graph", "nodes.jsonl");
		fs.writeFileSync(
			nodesFile,
			`${JSON.stringify({
				id: "n2",
				name: "Beta",
				statement: "Beta external statement",
				aliases: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				provenance: [{ chatId: "c2", messageId: "m2" }],
			})}\n`,
		);
		assert.equal(graphStore.readNodes()[0]?.id, "n2");

		assert.equal(graphStore.deleteSources(new Set(["s1"])), 1);
		assert.equal(graphStore.readSources().length, 0);
	});
});
