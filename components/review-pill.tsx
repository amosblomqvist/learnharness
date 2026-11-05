"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useSettingsSaved } from "@/components/settings-signal";

/** One pick of the review queue — the graph-context marker's shape. */
export type ReviewPick = { id: string; name: string; statement: string };

export type ReviewQueueView = { dueCount: number; newCount: number; picks: ReviewPick[] };

function isReviewQueueView(v: unknown): v is ReviewQueueView {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.dueCount === "number" && typeof r.newCount === "number" && Array.isArray(r.picks);
}

/** The scheduled-practice queue (GET /api/review), refetched when a turn
 *  settles (a practice conclude may have logged reviews), when the chat
 *  list changes (deletions), when the review setting saves, and on every
 *  channel resync. Null until the
 *  first read lands, or when it fails — the pill then simply stays away. */
export function useReviewQueue(): ReviewQueueView | null {
	const [queue, setQueue] = useState<ReviewQueueView | null>(null);
	const refresh = useCallback(() => {
		void fetch("/api/review")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: unknown) => setQueue(isReviewQueueView(body) ? body : null))
			.catch(() => setQueue(null));
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("turn-settled", refresh);
	useServerEvent("chats-changed", refresh);
	useServerResync(refresh);
	useSettingsSaved((section) => {
		if (section === "review") refresh();
	});
	return queue;
}

/** The composer's review action: due + new counts; one click starts a
 *  practice session over the queue's picks. Absent when nothing is due. */
export function ReviewPill({ queue, busy, onStart }: {
	queue: ReviewQueueView | null;
	busy?: boolean;
	onStart: (picks: ReviewPick[]) => void;
}) {
	if (!queue || queue.picks.length === 0) return null;
	const parts = [
		...(queue.dueCount > 0 ? [`${queue.dueCount} due`] : []),
		...(queue.newCount > 0 ? [`${queue.newCount} new`] : []),
	];
	return (
		<button
			type="button"
			data-testid="review-pill"
			disabled={busy}
			onClick={() => onStart(queue.picks)}
			className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40"
		>
			<RotateCcwIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
			{["Review", ...parts].join(" · ")}
		</button>
	);
}
