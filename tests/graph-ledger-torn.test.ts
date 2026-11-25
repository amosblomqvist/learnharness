/** A torn ledger append (power loss, full disk) must not swallow the next
 *  record, and an unreadable ledger must not read as empty. Hermetic:
 *  LH_DATA_DIR → a temp dir, set before the first store import. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-torn-ledger-"));
process.env.LH_DATA_DIR = dir;
const { graphStore } = await import("../src/store/graph.ts");
const { LEDGER_FILES } = await import("../config.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const node = (id: string) => ({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-10-06T00:00:00.000Z", provenance: [] });

describe("graph ledger", () => {
	it("keeps the next record when the last append was torn", () => {
		graphStore.appendNode(node("n_a"));
		fs.appendFileSync(LEDGER_FILES.nodes, '{"id":"n_torn","na');
		graphStore.appendNode(node("n_b"));
		assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["n_a", "n_b"]);
	});

	it("does not read an unreadable ledger as empty", () => {
		fs.rmSync(LEDGER_FILES.chains, { force: true });
		fs.mkdirSync(LEDGER_FILES.chains);
		try { assert.throws(() => graphStore.readChains()); }
		finally { fs.rmSync(LEDGER_FILES.chains, { recursive: true }); }
		assert.deepEqual(graphStore.readChains(), []);
	});
});
