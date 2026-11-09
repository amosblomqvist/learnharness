/**
 * ReviewStore — the fs JSON-map adapter for the retention ledger (issue #33):
 * config.REVIEWS_FILE (data/graph/reviews.json), propositionId → ReviewEntry
 * (core/retention.ts — the FSRS memory state of every scheduled proposition).
 *
 * Read-modify-write like sources.json (NOT append-only): the pure next-map
 * computation is core/retention.ts; this seam only persists it. Same idioms
 * as src/store/graph.ts: sync fs, tolerant reads (a corrupt file or an
 * invalid entry is skipped, never guessed at), temp-file rename writes
 * (atomic-write.ts), and the graph-family format stamp (graph-format.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { REVIEWS_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";
import type { ReviewLedger, ReviewEntry } from "../core/retention.ts";
import type { ReviewStore } from "../core/ports.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Strict shape guard — anything not matching a ReviewEntry is skipped. */
const isReviewEntry = (v: unknown): v is ReviewEntry =>
	isRecord(v) &&
	(v.state === "New" || v.state === "Learning" || v.state === "Review" || v.state === "Relearning") &&
	isFiniteNumber(v.difficulty) &&
	isFiniteNumber(v.stability) &&
	typeof v.reps === "number" &&
	Number.isInteger(v.reps) &&
	typeof v.lapses === "number" &&
	Number.isInteger(v.lapses) &&
	isString(v.lastReviewAt) &&
	isString(v.dueAt) &&
	isString(v.updatedInSession);

// ─── the port implementation ────────────────────────────────────────────────

export const reviewStore: ReviewStore = {
	/** Tolerant read: absent/corrupt file = {} (nothing scheduled yet);
	 *  invalid entries are dropped, never guessed at. */
	readReviews(): ReviewLedger {
		assertGraphFormat(); // honest refusal on a newer-stamped data dir
		let raw: string;
		try {
			raw = fs.readFileSync(REVIEWS_FILE, "utf-8");
		} catch {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed)) return {};
			const out: ReviewLedger = {};
			for (const [id, value] of Object.entries(parsed)) {
				if (isReviewEntry(value)) out[id] = value;
			}
			return out;
		} catch {
			return {};
		}
	},

	/** Replace the whole ledger atomically (crash-safe rename; the pure
	 *  computation happened in core/retention.ts before this call). */
	writeReviews(reviews: ReviewLedger): void {
		fs.mkdirSync(path.dirname(REVIEWS_FILE), { recursive: true });
		ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
		writeFileAtomicSync(REVIEWS_FILE, JSON.stringify(reviews, null, "\t"));
		removeLeftoverTemps(REVIEWS_FILE);
	},
};
