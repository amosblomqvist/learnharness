"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActivity } from "@/components/activity-dock";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useSettingsSaved } from "@/components/settings-signal";
import { formatTokens } from "@/components/usage-format";
import { Hint } from "@/components/ui/hint";
import { timeAgo } from "@/components/sidebar";
import { resolveSettings } from "@/src/core";

/**
 * The extraction-coverage surfaces (extraction-UX redesign, owner-locked
 * dispatch 2026-09-24): the ring meter in the chat top bar and the coverage
 * block in the sidebar's session context menu — the two replacements for
 * the graph view's coverage panel (components/graph-coverage.tsx, retired
 * with this wave). Coverage is the SAME derivation, scoped to one session:
 * GET /api/chats/[id] now carries `coverage` (Platform's eed4b4e).
 *
 * The ring fills with uncoveredTokens / extractionChunkTokens — the chunk
 * budget the threshold setting (Graph ▸ extractionChunkTokens) pins: the
 * meter is "how close this session is to firing its next extraction run".
 * It DRAINS as a run folds (coverage re-derives per request), pulses while
 * a run is in flight, and vanishes entirely when the graph is off (the
 * master kill-switch means no extraction, so no meter).
 *
 * The manual affordance stays POST /api/graph/coverage/extract {chatId}
 * (409 = already running, BENIGN — the trigger raced us; the dock's
 * start-site nudge seam refreshes either way).
 */

/** Client-safe mirror of the server's SessionCoverage (src/server/chats.ts
 *  — the GET /api/chats/[id] `coverage` block). */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	running: boolean;
	lastFoldedAt: string | null;
}

/** One session's coverage read — null on transport/404 (callers render
 *  nothing rather than a fake zero; the honest-render doctrine). */
async function fetchCoverage(chatId: string): Promise<SessionCoverage | null> {
	try {
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}?only=coverage`);
		if (!res.ok) return null;
		const body = (await res.json()) as { coverage?: SessionCoverage | null };
		return body.coverage ?? null;
	} catch {
		return null;
	}
}

/** The ring's denominator + visibility, resolved through the SAME core
 *  resolver the server's effective settings use (fix, 2026-10-02): the
 *  meter denominates at exactly the number the extraction trigger waits
 *  for — the old hand-rolled `?? 4096` fallback drifted from the factory
 *  default (8192) and the ring filled at half the truth. Null on fetch
 *  failure → no ring. */
export interface GraphRead {
	enabled: boolean;
	chunkTokens: number;
}

/** Exported for the render pin (the ringFill precedent): resolves the
 *  raw settings delta to the factory-true graph section. */
export async function fetchGraphRead(): Promise<GraphRead | null> {
	try {
		const res = await fetch("/api/settings");
		if (!res.ok) return null;
		const body = (await res.json()) as { settings?: Parameters<typeof resolveSettings>[0] };
		const graph = resolveSettings(body.settings ?? null).graph;
		return { enabled: graph.enabled, chunkTokens: graph.extractionChunkTokens };
	} catch {
		return null;
	}
}

/** The manual-extract seam, shared by both surfaces. 409 is BENIGN (the
 *  run is already in flight) — returns "running" so the caller flips to the
 *  optimistic/running state instead of an error. Returns false only on a
 *  real failure, where the caller reverts. */
async function requestExtract(chatId: string): Promise<boolean> {
	try {
		const res = await fetch("/api/graph/coverage/extract", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chatId }),
		});
		if (!res.ok && res.status !== 409) return false;
		return true; // 202 started, or 409 already-running — both "running"
	} catch {
		return false;
	}
}

// ─── The sidebar context menu's coverage block ──────────────────────────────

/**
 * The info block at the bottom of the session context menu (owner-locked
 * redesign): what the extractor hasn't covered yet, plus the manual Extract
 * affordance — visually separated from Rename/Delete below (those stay the
 * two session-management actions). Fetched ON MENU OPEN (the block mounts
 * with the menu — on-demand, never eagerly), polled at 2s while a run is
 * in flight so the numbers settle live. No coverage (fetch failed, 404):
 * the whole block renders nothing — no fake zeros.
 */
export function CoverageMenuBlock({ chatId }: { chatId: string }) {
	const refreshActivity = useActivity().refresh;
	const [coverage, setCoverage] = useState<SessionCoverage | null>(null);
	const [extracting, setExtracting] = useState(false); // optimistic until the server says running
	const lastUncoveredRef = useRef<number | null>(null);

	const load = useCallback(async () => {
		const next = await fetchCoverage(chatId);
		if (next === null) return;
		// The optimistic state stands down once the server says running, or
		// once the fold moved coverage (the run finished).
		if (
			next.running ||
			(lastUncoveredRef.current !== null && next.uncoveredTokens !== lastUncoveredRef.current)
		) {
			setExtracting(false);
		}
		lastUncoveredRef.current = next.uncoveredTokens;
		setCoverage(next);
	}, [chatId]);

	// On MENU OPEN (the block mounts with the menu — on-demand, never
	// eagerly): one read, then the 2s poll below takes over while running.
	useEffect(() => {
		lastUncoveredRef.current = null;
		setExtracting(false);
		void load();
	}, [load]);

	// While a run is in flight the block polls at 2s (the old panel's
	// open-only cadence, bounded to the running state) — the numbers
	// settle live and the block ends in "fully extracted".
	// ACCEPTED BY DESIGN (owner, 2026-10-02): the ring drains per fold,
	// and the events channel is per phase — that granularity gap is why
	// this bounded, run-scoped poll stays.
	useEffect(() => {
		if (coverage?.running !== true && !extracting) return;
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	}, [load, coverage?.running, extracting]);

	if (coverage === null) return null;

	const onExtract = async () => {
		setExtracting(true);
		// The dock's start-site nudge (the 202 registers the run before the
		// response; a 409 means one is already in flight) — refresh so the
		// run surfaces at once either way.
		refreshActivity();
		const started = await requestExtract(chatId);
		if (!started) setExtracting(false);
		void load();
	};
	return (
		<CoverageMenuBody
			coverage={coverage}
			extracting={extracting}
			onExtract={() => void onExtract()}
		/>
	);
}

/** The block's presentational core (exported for static-render tests):
 *  the numbers, the running pulse, and the Extract affordance with its
 *  optimistic "Running" state. */
export function CoverageMenuBody({
	coverage,
	extracting,
	onExtract,
}: {
	coverage: SessionCoverage;
	/** Click-pending (optimistic) until the server says running. */
	extracting: boolean;
	onExtract: () => void;
}) {
	const busy = coverage.running || extracting;
	const complete = coverage.uncoveredTokens === 0 && coverage.uncoveredCount === 0;
	return (
		<div data-testid="ctx-coverage" className="flex flex-col gap-1 px-2.5 pt-1 pb-2">
			{busy ? (
				<span className="flex items-center gap-1.5 text-muted-foreground" data-testid="ctx-coverage-running">
					<span className="size-1.5 animate-pulse rounded-full bg-foreground/70" aria-hidden />
					extracting…
				</span>
			) : complete ? (
				<span className="text-muted-foreground">fully extracted</span>
			) : (
				<span className="flex flex-col">
					<span className="tabular-nums text-foreground">
						{formatTokens(coverage.uncoveredTokens)} tok uncovered
					</span>
					<span className="tabular-nums text-muted-foreground">
						{coverage.uncoveredCount} message{coverage.uncoveredCount === 1 ? "" : "s"} unextracted
					</span>
				</span>
			)}
			<button
				type="button"
				data-testid="ctx-extract"
				onClick={onExtract}
				disabled={busy || complete}
				className="flex items-center justify-center rounded-lg border px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
			>
				{busy ? "Running" : "Extract"}
			</button>
		</div>
	);
}

// ─── The chat top bar's ring meter ──────────────────────────────────────────

/** The donut's geometry (pure, exported for tests): the fill fraction
 *  uncovered/chunk, clamped to [0,1] — at 1 the next run fires. */
export function ringFill(uncoveredTokens: number, chunkTokens: number): number {
	if (!(chunkTokens > 0)) return 0;
	return Math.min(1, Math.max(0, uncoveredTokens / chunkTokens));
}

/**
 * The ring meter (owner-locked: "a donut next to the PhaseChip"): how
 * close this session is to its next extraction run. Click → the exact
 * numbers (covered/uncovered tokens, messages, the threshold, the last
 * fold). Vanishes entirely while the graph is disabled or before the
 * first successful read. While a run is in flight the ring PULSES (the
 * implementer's visual call per the dispatch — motion is the honest
 * state signal in this app's quiet register; no new chrome).
 *
 * Refresh chains: mount + `refreshKey` (the chat view bumps it at turn
 * settle, riding the existing refetch chains) + a 2s poll while running
 * (resets as the fold drains coverage) + the settings signal (the
 * threshold/kill-switch re-read live).
 */
export function CoverageRing({ chatId, refreshKey = 0 }: { chatId: string; refreshKey?: number }) {
	const [graph, setGraph] = useState<GraphRead | null>(null);
	const [coverage, setCoverage] = useState<SessionCoverage | null>(null);
	const [open, setOpen] = useState(false);
	const [nonce, setNonce] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));

	// The activity/refresh chain (the dispatch's seam): runs can fire from
	// OTHER surfaces (the sidebar menu's Extract, the turn pipeline, another
	// tab) — no turn-settle bump announces those to this page. The dock's
	// feed knows; a run for THIS session appearing or settling in it
	// re-reads coverage (same runs-empty-transition the graph view rides).
	const feed = useActivity().feed;
	const runHere = feed.extractions.some((run) => run.chatId === chatId);

	useSettingsSaved((section) => {
		if (section === "graph") setNonce((n) => n + 1);
	});

	useEffect(() => {
		let alive = true;
		void fetchGraphRead().then((g) => alive && setGraph(g));
		return () => {
			alive = false;
		};
	}, [nonce]);

	useEffect(() => {
		let alive = true;
		void fetchCoverage(chatId).then((c) => alive && setCoverage(c));
		return () => {
			alive = false;
		};
	}, [chatId, refreshKey, nonce, runHere]);

	// While a run is in flight: poll at 2s so the ring DRAINS as folds land
	// and settles at zero when the run completes (the "resets on
	// completion" requirement — coverage re-derives per request).
	// ACCEPTED BY DESIGN (owner, 2026-10-02): the ring drains per fold,
	// and the events channel is per phase — that granularity gap is why
	// this bounded, run-scoped poll stays.
	useEffect(() => {
		if (coverage?.running !== true) return;
		const timer = setInterval(() => {
			void fetchCoverage(chatId).then((c) => {
				if (c !== null) setCoverage(c);
			});
		}, 2000);
		return () => clearInterval(timer);
	}, [chatId, coverage?.running]);

	// Vanishes entirely when the graph is off, or before the first honest
	// read (no fake zeros — the doctrine).
	if (graph === null || !graph.enabled || coverage === null) return null;

	const fill = ringFill(coverage.uncoveredTokens, graph.chunkTokens);
	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<Hint
				// Trimmed (owner, subtlety round 2026-09-25).
				label="How much of this session isn't mapped yet"
				side="bottom"
			>
				<button
					type="button"
					data-testid="coverage-ring"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					className="relative flex size-5 cursor-pointer items-center justify-center transition-opacity hover:opacity-80"
				>
					{/* The donut: track + fill. The whole ring pulses while a run
					    is in flight (motion = the working-state signal). */}
					<CoverageRingGlyph fill={fill} running={coverage.running} />
				</button>
			</Hint>
			{open && (
				<div
					data-testid="coverage-ring-popover"
					className="absolute top-full right-0 z-40 mt-1.5 w-64 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<CoverageRingDetail coverage={coverage} chunkTokens={graph.chunkTokens} />
				</div>
			)}
		</div>
	);
}

/** The donut itself (exported for static-render tests): a hairline track
 *  plus the fill arc — uncovered/chunk of the circumference, starting at
 *  12 o'clock. The whole ring pulses while a run is in flight. */
export function CoverageRingGlyph({ fill, running }: { fill: number; running: boolean }) {
	const C = 2 * Math.PI * 6; // r=6 in the 16px viewBox
	return (
		<svg
			viewBox="0 0 16 16"
			className={running ? "size-full animate-pulse" : "size-full"}
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-border" />
			<circle
				cx="8"
				cy="8"
				r="6"
				fill="none"
				strokeWidth="2.5"
				className="stroke-foreground/70"
				strokeDasharray={`${fill * C} ${C}`}
				strokeLinecap="round"
				transform="rotate(-90 8 8)"
			/>
		</svg>
	);
}

/** The popover body (exported for static-render tests): the exact numbers —
 *  covered/uncovered tokens, message coverage, the threshold, the last
 *  fold's age. */
export function CoverageRingDetail({ coverage, chunkTokens }: { coverage: SessionCoverage; chunkTokens: number }) {
	return (
		<>
			<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Extraction coverage
			</div>
			<div className="flex flex-col gap-1 text-muted-foreground">
				<div className="flex justify-between gap-2">
					<span>Uncovered</span>
					<span className="tabular-nums text-card-foreground">
						{formatTokens(coverage.uncoveredTokens)} tokens
					</span>
				</div>
				<div className="flex justify-between gap-2">
					<span>Covered</span>
					<span className="tabular-nums text-card-foreground">
						{formatTokens(coverage.coveredTokens)} tokens
					</span>
				</div>
				<div className="flex justify-between gap-2">
					<span>Messages</span>
					<span className="tabular-nums text-card-foreground">
						{coverage.coveredCount} / {coverage.totalMessages}
					</span>
				</div>
				<div className="flex justify-between gap-2">
					<span>Chunk threshold</span>
					<span className="tabular-nums text-card-foreground">
						{formatTokens(chunkTokens)} tokens
					</span>
				</div>
				<div className="flex justify-between gap-2">
					<span>Last extraction</span>
					<span className="tabular-nums text-card-foreground">
						{coverage.lastFoldedAt ? timeAgo(coverage.lastFoldedAt) : "—"}
					</span>
				</div>
				{coverage.running && (
					<div className="flex justify-between gap-2" data-testid="coverage-ring-running">
						<span>Status</span>
						<span className="text-card-foreground">extracting…</span>
					</div>
				)}
			</div>
		</>
	);
}