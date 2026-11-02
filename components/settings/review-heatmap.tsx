"use client";
/**
 * The schedule heatmap (Settings > Review, 2026-11-02: "like the
 * Anki heatmap add-on"): one tile per review day, weeks as columns, 26
 * weeks either side of today (GET /api/review/schedule). Days behind are
 * shaded by reviews logged in the chosen colour (appearance
 * reviewHeatmapColor, 2026-11-02), brighter = more; days ahead in
 * grey by propositions due — each side on its own scale. Today is ringed,
 * stays grey, and holds everything overdue plus today's new allowance.
 *
 * Clicking a tile opens its day below the grid: a past day shows counts
 * only (the full problems are too much); today and later days list
 * what comes due, with the replayed FSRS facts for debugging.
 *
 * Refetched on the review pill's signals: a settled turn, a chat-list
 * change, a review-settings save, every channel resync.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useSettingsSaved } from "@/components/settings-signal";
import { cn } from "@/lib/utils";

type PastDay = {
	date: string;
	reviews: number;
	propositions: number;
	again: number;
	hard: number;
	good: number;
	introduced: number;
};

type DueCard = {
	id: string;
	name: string;
	statement: string;
	state: "learning" | "review" | "relearning";
	due: string;
	lastReview: string;
	intervalDays: number;
	stability: number;
	difficulty: number;
	retrievability: number;
	reviews: number;
	lapses: number;
};

type ScheduleView = {
	today: string;
	start: string;
	end: string;
	past: PastDay[];
	future: { date: string; due: DueCard[] }[];
	newToday: { id: string; name: string; statement: string }[];
	later: number;
};

function isScheduleView(v: unknown): v is ScheduleView {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.today === "string" && Array.isArray(r.past) && Array.isArray(r.future) && Array.isArray(r.newToday);
}

function useReviewSchedule(): { schedule: ScheduleView | null; failed: boolean } {
	const [schedule, setSchedule] = useState<ScheduleView | null>(null);
	const [failed, setFailed] = useState(false);
	const refresh = useCallback(() => {
		void fetch("/api/review/schedule")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: unknown) => {
				const ok = isScheduleView(body);
				setSchedule(ok ? body : null);
				setFailed(!ok);
			})
			.catch(() => {
				setSchedule(null);
				setFailed(true);
			});
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("turn-settled", refresh);
	useServerEvent("chats-changed", refresh);
	useServerResync(refresh);
	useSettingsSaved((section) => {
		if (section === "review") refresh();
	});
	return { schedule, failed };
}

// ─── day keys (YYYY-MM-DD, local) ────────────────────────────────────────────

const parseKey = (key: string) => {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y!, m! - 1, d!);
};
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (key: string) =>
	parseKey(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortDateTime = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Weeks (Sunday-first columns) covering [start, end]. */
function weeksOf(start: string, end: string): string[][] {
	const first = parseKey(start);
	const last = parseKey(end);
	const weeks: string[][] = [];
	for (let day = addDays(first, -first.getDay()); day <= last; day = addDays(day, 7)) {
		weeks.push(Array.from({ length: 7 }, (_, i) => keyOf(addDays(day, i))));
	}
	return weeks;
}

/** GitHub's four shades: 0 = empty, 1–4 by share of the side's busiest day. */
const levelOf = (count: number, max: number) => (count <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4)));
const SHADES = ["bg-accent","bg-foreground/15", "bg-foreground/35", "bg-foreground/60", "bg-foreground/90"];
/** The past side's levels 1–4: the review colour's share over the card. */
const INK = [0, 30, 50, 75, 100];
const inkOf = (color: string, level: number) =>
	level === 0 ? undefined : { backgroundColor: `color-mix(in srgb, ${color} ${INK[level]}%, transparent)` };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReviewHeatmap({ color }: { color: string }) {
	const { schedule, failed } = useReviewSchedule();
	const [selected, setSelected] = useState<string | null>(null);

	const view = useMemo(() => {
		if (!schedule) return null;
		const past = new Map(schedule.past.map((d) => [d.date, d]));
		const future = new Map(schedule.future.map((d) => [d.date, d.due]));
		const countOf = (key: string) =>
			key > schedule.today
				? (future.get(key)?.length ?? 0)
				: key === schedule.today
					? (future.get(key)?.length ?? 0) + schedule.newToday.length
					: (past.get(key)?.reviews ?? 0);
		let maxPast = 0;
		let maxFuture = 0;
		for (const d of schedule.past) if (d.date < schedule.today) maxPast = Math.max(maxPast, d.reviews);
		for (const d of schedule.future) maxFuture = Math.max(maxFuture, countOf(d.date));
		maxFuture = Math.max(maxFuture, countOf(schedule.today));
		return { past, future, countOf, maxPast, maxFuture, weeks: weeksOf(schedule.start, schedule.end) };
	}, [schedule]);

	if (!schedule || !view) {
		return (
			<p className="text-xs text-muted-foreground" data-testid="review-heatmap-status">
				{failed ? "Could not load the schedule." : "Loading schedule…"}
			</p>
		);
	}

	const active = selected ?? schedule.today;
	const tileTitle = (key: string) => {
		const n = view.countOf(key);
		const label = key < schedule.today ? plural(n, "review") : `${n} due`;
		return `${longDate(key)}: ${label}`;
	};

	return (
		<div data-testid="review-heatmap" className="flex flex-col gap-3">
			<div className="overflow-x-auto pb-1">
				<div className="inline-flex flex-col gap-1">
					{/* Month labels: on the column where a month's first day falls. */}
					<div className="flex gap-0.5 pl-7 text-[10px] text-muted-foreground">
						{view.weeks.map((week) => {
							const firstOfMonth = week.find((key) => key.endsWith("-01"));
							return (
								<span key={week[0]} className="w-2.5 shrink-0 overflow-visible whitespace-nowrap">
									{firstOfMonth ? MONTHS[parseKey(firstOfMonth).getMonth()] : ""}
								</span>
							);
						})}
					</div>
					<div className="flex gap-0.5">
						<div className="flex w-6.5 shrink-0 flex-col gap-0.5 text-[10px] leading-2.5 text-muted-foreground">
							{["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) => (
								<span key={i} className="h-2.5">{label}</span>
							))}
						</div>
						{view.weeks.map((week) => (
							<div key={week[0]} className="flex flex-col gap-0.5">
								{week.map((key) => {
									if (key < schedule.start || key > schedule.end) return <span key={key} className="size-2.5" />;
									const n = view.countOf(key);
									const isPast = key < schedule.today;
									const level = levelOf(n, isPast ? view.maxPast : view.maxFuture);
									const inked = isPast && level > 0;
									return (
										<button
											key={key}
											type="button"
											title={tileTitle(key)}
											aria-label={tileTitle(key)}
											aria-pressed={key === active}
											data-testid={`review-tile-${key}`}
											onClick={() => setSelected(key)}
											style={inked ? inkOf(color, level) : undefined}
											className={cn(
												"size-2.5 rounded-[2px] outline-offset-1 transition-colors hover:outline hover:outline-muted-foreground",
												!inked && SHADES[level],
												key === schedule.today && "ring-1 ring-foreground",
												key === active && "outline outline-1 outline-foreground",
											)}
										/>
									);
								})}
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				<span className="flex items-center gap-1" data-testid="review-heatmap-legend-reviews">
					Reviews: Less
					{INK.map((_, level) => (
						<span
							key={level}
							style={inkOf(color, level)}
							className={cn("size-2.5 rounded-[2px]", level === 0 && SHADES[0])}
						/>
					))}
					More
				</span>
				<span className="flex items-center gap-1" data-testid="review-heatmap-legend-due">
					Due: Less
					{SHADES.map((shade) => (
						<span key={shade} className={cn("size-2.5 rounded-[2px]", shade)} />
					))}
					More
				</span>
				{schedule.later > 0 && <span data-testid="review-heatmap-later">later: {schedule.later}</span>}
			</div>
			<DayDetail schedule={schedule} date={active} past={view.past.get(active)} due={view.future.get(active) ?? []} />
		</div>
	);
}

function DayDetail({ schedule, date, past, due }: {
	schedule: ScheduleView;
	date: string;
	past: PastDay | undefined;
	due: DueCard[];
}) {
	const isToday = date === schedule.today;
	const isPast = date < schedule.today;
	return (
		<div data-testid="review-day-detail" className="flex flex-col gap-2 rounded-sm border border-border/60 p-3">
			<p className="text-xs uppercase tracking-widest text-muted-foreground">
				{longDate(date)}
				{isToday ? " · today" : ""}
			</p>
			{(isPast || isToday) && <PastStats day={past} today={isToday} />}
			{!isPast && (
				<>
					{due.length === 0 && schedule.newToday.length === 0 && (
						<p className="text-xs text-muted-foreground">Nothing due.</p>
					)}
					{due.length > 0 && (
						<ul className="flex flex-col gap-2" data-testid="review-day-due">
							{due.map((card) => (
								<DueRow key={card.id} card={card} />
							))}
						</ul>
					)}
					{isToday && schedule.newToday.length > 0 && (
						<>
							<p className="text-xs text-muted-foreground">
								New today ({schedule.newToday.length}, in introduction order)
							</p>
							<ul className="flex flex-col gap-2" data-testid="review-day-new">
								{schedule.newToday.map((pick) => (
									<li key={pick.id} className="min-w-0">
										<p className="truncate font-prose text-(length:--lh-prose-size)">{pick.name}</p>
										<p className="truncate text-xs text-muted-foreground">{pick.statement}</p>
									</li>
								))}
							</ul>
						</>
					)}
				</>
			)}
		</div>
	);
}

function PastStats({ day, today }: { day: PastDay | undefined; today: boolean }) {
	if (!day) return <p className="text-xs text-muted-foreground">{today ? "Nothing studied yet today." : "Nothing studied."}</p>;
	const facts = [
		plural(day.reviews, "review"),
		plural(day.propositions, "proposition"),
		`Again ${day.again} · Hard ${day.hard} · Good ${day.good}`,
		`${day.introduced} new introduced`,
	];
	return (
		<p className="text-xs text-foreground" data-testid="review-day-stats">
			{today ? "Studied today: " : ""}
			{facts.join(" · ")}
		</p>
	);
}

function DueRow({ card }: { card: DueCard }) {
	const overdueDays = Math.floor((Date.now() - new Date(card.due).getTime()) / 86_400_000);
	const facts = [
		card.state,
		overdueDays >= 1 ? `overdue ${plural(overdueDays, "day")}` : `due ${shortDateTime(card.due)}`,
		`last ${shortDateTime(card.lastReview)}`,
		`interval ${card.intervalDays}d`,
		`S ${card.stability.toFixed(1)}`,
		`D ${card.difficulty.toFixed(1)}`,
		`R ${Math.round(card.retrievability * 100)}%`,
		plural(card.reviews, "review"),
		plural(card.lapses, "lapse"),
	];
	return (
		<li className="min-w-0">
			<p className="truncate font-prose text-(length:--lh-prose-size)">{card.name}</p>
			<p className="truncate text-xs text-muted-foreground">{card.statement}</p>
			<p className="text-[11px] text-muted-foreground/80">{facts.join(" · ")}</p>
		</li>
	);
}
