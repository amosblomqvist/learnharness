/**
 * GET /api/graph/reviews (issue #33, retention) — the due surface under an
 * isolated temp LH_DATA_DIR: due count + list (most overdue first), the
 * due rule (retrievability < 0.9 OR dueAt passed), and the exclusions
 * (never-scheduled propositions, entries whose proposition left the graph).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ReviewEntry } from "../src/core/retention.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retention-route-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");

const { GET } = await import("../app/api/graph/reviews/route.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { reviewStore } = await import("../src/store/reviews.ts");
const { newGraphContextMessage } = await import("../src/core/native-messages.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();

const node = (id: string, name: string) => ({
	id,
	name,
	statement: `${name} — proposition statement`,
	aliases: [],
	createdAt: new Date(NOW - 30 * DAY).toISOString(),
	provenance: [],
});

/** A Review-state entry last touched `daysAgo` with the given stability. */
function entry(stabilityDays: number, lastReviewDaysAgo: number): ReviewEntry {
	const last = new Date(NOW - lastReviewDaysAgo * DAY);
	return {
		state: "Review",
		difficulty: 5,
		stability: stabilityDays,
		reps: 3,
		lapses: 0,
		lastReviewAt: last.toISOString(),
		dueAt: new Date(last.getTime() + stabilityDays * DAY).toISOString(),
		updatedInSession: "chat_seed",
	};
}

describe("GET /api/graph/reviews — the due surface", () => {
	it("an empty graph/ledger reports zero due", async () => {
		const res = await GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { count: 0, due: [] });
	});

	it("reports due propositions most-overdue first; fresh and never-scheduled ones stay out", async () => {
		graphStore.appendNode(node("n_gone", "Gone"));
		graphStore.appendNode(node("n_fresh", "Fresh"));
		graphStore.appendNode(node("n_due_soon", "Due soon"));
		graphStore.appendNode(node("n_due_long", "Due long ago"));
		graphStore.appendNode(node("n_new", "Never practiced"));
		// The marker message is irrelevant here — this pins that the due
		// fold reads PROPOSITIONS (the merged graph), not other shapes.
		assert.ok(newGraphContextMessage([], []).customType === "graph-context");
		reviewStore.writeReviews({
			n_gone: entry(2, 5), // proposition deleted below — entry ignored
			n_fresh: entry(30, 1), // R ≈ 0.99, dueAt far out — not due
			n_due_soon: entry(2, 4), // dueAt 2 days past
			n_due_long: entry(2, 10), // dueAt 8 days past — most overdue
			// n_new: absent — never scheduled, never due
		});
		// n_gone leaves the graph (its entry stays — the ledger follows).
		const kept = graphStore.readNodes().filter((n) => n.id !== "n_gone");
		graphStore.rewriteLedgers({ nodes: kept });

		const res = await GET();
		assert.equal(res.status, 200);
		const body = (await res.json()) as { count: number; due: Array<{ id: string; retrievability: number; dueAt: string }> };
		assert.equal(body.count, 2);
		assert.deepEqual(body.due.map((d) => d.id), ["n_due_long", "n_due_soon"]);
		for (const d of body.due) {
			assert.ok(d.retrievability < 0.9, `due propositions have decayed recall (${d.id}: ${d.retrievability})`);
		}
	});
});
