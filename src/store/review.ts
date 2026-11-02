/**
 * ReviewStore — the fs JSONL adapter for the review log (scheduled
 * practice, 2026-11-02): data/review/reviews.jsonl, one ReviewEvent per
 * line, append-only. Memory state is never stored — core/review.ts
 * replays these lines on every read.
 *
 * Format stamp: data/review/format.json, the graph-family contract
 * (src/store/graph-format.ts) for this family — LAZY v1 (no sidecar = v1;
 * the first write creates it, reads never write), and HONEST REFUSAL (a
 * sidecar stamped newer than this build makes reads and writes throw).
 * An empty append writes nothing, so a no-op sync never creates files.
 *
 * Implements core/ports.ts ReviewStore. data/review/* is exclusively this
 * adapter's. Same idioms as src/store/graph.ts: sync fs, corrupt or
 * shape-invalid lines skipped, never guessed at.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { REVIEW_FILES } from "../../config.ts";
import { CURRENT_REVIEW_FORMAT_VERSION, type ReviewEvent } from "../core/contracts.ts";
import type { ReviewStore } from "../core/ports.ts";

function stampedVersion(): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(REVIEW_FILES.format, "utf-8");
	} catch {
		return null; // no sidecar — lazy v1
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // corrupt sidecar reads as unstamped (v1), not fatal
	}
}

function assertReviewFormat(): void {
	const v = stampedVersion();
	if (v !== null && v > CURRENT_REVIEW_FORMAT_VERSION) {
		throw new Error(
			`Review data is stamped with format version ${v}, but this build understands only ${CURRENT_REVIEW_FORMAT_VERSION}. ` +
				"The app is older than its data — upgrade the app before practicing.",
		);
	}
}

function ensureReviewFormat(): void {
	if (stampedVersion() !== null) return;
	fs.mkdirSync(path.dirname(REVIEW_FILES.format), { recursive: true });
	fs.writeFileSync(
		REVIEW_FILES.format,
		JSON.stringify({ version: CURRENT_REVIEW_FORMAT_VERSION }, null, "\t") + "\n",
		"utf-8",
	);
}

const isString = (v: unknown): v is string => typeof v === "string";

const isReviewEvent = (v: unknown): v is ReviewEvent => {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		isString(r.id) &&
		isString(r.chatId) &&
		isString(r.problemCallId) &&
		isString(r.at) &&
		Array.isArray(r.targets) &&
		r.targets.length > 0 &&
		r.targets.every(isString) &&
		isString(r.outcome) &&
		(r.rung === null || isString(r.rung))
	);
};

function readReviews(): ReviewEvent[] {
	assertReviewFormat();
	let raw: string;
	try {
		raw = fs.readFileSync(REVIEW_FILES.reviews, "utf-8");
	} catch {
		return []; // no log yet — nothing has been practiced
	}
	const out: ReviewEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isReviewEvent(parsed)) out.push(parsed);
		} catch {
			// A torn append must never take the queue down with it.
		}
	}
	return out;
}

function appendReviews(events: readonly ReviewEvent[]): void {
	if (events.length === 0) return;
	assertReviewFormat();
	fs.mkdirSync(path.dirname(REVIEW_FILES.reviews), { recursive: true });
	ensureReviewFormat();
	fs.appendFileSync(REVIEW_FILES.reviews, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
}

export const reviewStore: ReviewStore = { readReviews, appendReviews };
