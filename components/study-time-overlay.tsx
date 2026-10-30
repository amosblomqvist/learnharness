"use client";

/**
 * THE STUDY TIME OVERLAY (design: docs/designs/study-time.md): the history
 * behind the home page's "Study time" button — cards, a per-chat bar chart,
 * a time-of-day histogram and a 52-week contribution grid, all styled divs
 * on the theme tokens (no chart library). StudyTimeBody is a pure render
 * (props in, markup out) so the render suite can pin it statically;
 * StudyTimeOverlay owns the fetches. It mounts as the LAST child of its
 * root (the drag-area DOM-order law, same as ChainTableOverlay).
 */
import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { formatStudyDuration, type ChatSummary, type StudyRangeKey, type StudySummary } from "@/src/core";

const RANGES: { key: StudyRangeKey; label: string }[] = [
	{ key: "week", label: "This week" },
	{ key: "month", label: "This month" },
	{ key: "last7", label: "Last 7 days" },
	{ key: "last30", label: "Last 30 days" },
	{ key: "all", label: "All time" },
];

export type StudyTimeState = "loading" | "ready" | "error";

function minutesLabel(n: number): string {
	return n === 1 ? "1 minute" : `${n} minutes`;
}

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const weekdayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });

function utcDate(date: string): Date {
	return new Date(`${date}T00:00:00Z`);
}

function ContributionGrid({ grid }: { grid: StudySummary["grid"] }) {
	const columns = Math.ceil(grid.days.length / 7);
	// One grid for labels and cells: columns share the width (cells are square,
	// so row heights follow), which keeps the grid inside its container.
	return (
		<div
			data-testid="study-grid"
			className="grid w-full gap-[3px]"
			style={{ gridTemplateColumns: `auto repeat(${columns}, minmax(0, 1fr))` }}
		>
			{Array.from({ length: columns }, (_, c) => {
				const first = grid.days[c * 7];
				const prev = c > 0 ? grid.days[(c - 1) * 7] : undefined;
				if (!first || (prev && prev.date.slice(5, 7) === first.date.slice(5, 7))) return null;
				return (
					<span
						key={`m${c}`}
						className="whitespace-nowrap text-[10px] leading-4 text-muted-foreground"
						style={{ gridRow: 1, gridColumn: c + 2 }}
					>
						{monthLabel.format(utcDate(first.date))}
					</span>
				);
			})}
			{Array.from({ length: 7 }, (_, r) => {
				const day = grid.days[r];
				if (!day || (r !== 0 && r !== 2 && r !== 4)) return null;
				return (
					<span
						key={`w${r}`}
						className="pr-1 text-[10px] leading-none text-muted-foreground"
						style={{ gridRow: r + 2, gridColumn: 1, alignSelf: "center" }}
					>
						{weekdayLabel.format(utcDate(day.date))}
					</span>
				);
			})}
			{grid.days.map((d, i) => (
				<div
					key={d.date}
					data-testid="study-grid-cell"
					data-level={d.level}
					title={`${dayLabel.format(utcDate(d.date))} · ${formatStudyDuration(d.ms)}`}
					className="aspect-square min-w-0 rounded-[2px]"
					style={{
						gridRow: (i % 7) + 2,
						gridColumn: Math.floor(i / 7) + 2,
						...(d.level === 0
							? { background: "var(--muted)" }
							: { background: "var(--primary)", opacity: d.level * 0.25 }),
					}}
				/>
			))}
		</div>
	);
}

export function StudyTimeBody({
	summary,
	titles,
	range,
	onRange,
	state,
}: {
	summary: StudySummary | null;
	titles: ReadonlyMap<string, string>;
	range: StudyRangeKey;
	onRange: (key: StudyRangeKey) => void;
	state: StudyTimeState;
}) {
	const idle = summary ? minutesLabel(summary.idleMinutes) : "N minutes";
	const explanation = `Counts time in a chat while its window is focused and you are typing, clicking, scrolling, moving the mouse, or dictating. Pauses after ${idle} without input.`;

	let content: React.ReactNode;
	if (state === "error") {
		content = <p className="text-sm text-muted-foreground">Could not load study time.</p>;
	} else if (!summary) {
		content = <p className="text-sm text-muted-foreground">Loading…</p>;
	} else if (summary.cards.totalMs === 0) {
		content = (
			<p data-testid="study-empty" className="text-sm text-muted-foreground">
				No study time yet. Time spent in a chat appears here after you leave the chat, switch windows, or go {idle} without input.
			</p>
		);
	} else {
		const perChat = summary.range.perChat;
		const maxChat = Math.max(0, ...perChat.map((c) => c.ms));
		const hours = summary.range.hours;
		const maxHour = Math.max(0, ...hours);
		const cards = [
			{ label: "Today", ms: summary.cards.todayMs },
			{ label: "This week", ms: summary.cards.weekMs },
			{ label: "Total", ms: summary.cards.totalMs },
		];
		content = (
			<div className={"flex flex-col gap-6 transition-opacity " + (state === "loading" ? "opacity-50" : "")}>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					{cards.map((c) => (
						<div key={c.label} data-testid={`study-card-${c.label.toLowerCase().replace(" ", "-")}`} className="rounded-xl border bg-card p-4">
							<div className="text-xs text-muted-foreground">{c.label}</div>
							<div className="mt-1 text-2xl font-medium">{formatStudyDuration(c.ms)}</div>
						</div>
					))}
				</div>

				<div className="flex items-center gap-0.5 self-start rounded-md border border-border/60 bg-background p-0.5" data-testid="study-range-switch">
					{RANGES.map((r) => (
						<button
							key={r.key}
							type="button"
							data-testid={`study-range-${r.key}`}
							aria-pressed={range === r.key}
							onClick={() => onRange(r.key)}
							className={
								"rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
								(range === r.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")
							}
						>
							{r.label}
						</button>
					))}
				</div>

				<section>
					<h3 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground/70">By chat</h3>
					{perChat.length === 0 ? (
						<p className="text-sm text-muted-foreground">No study time in this period.</p>
					) : (
						<div data-testid="study-per-chat" className="flex flex-col gap-1.5">
							{perChat.map((c) => (
								<div key={c.chatId} className="flex items-center gap-3 text-xs">
									<span className="w-48 shrink-0 truncate" title={titles.get(c.chatId) ?? "deleted chat"}>
										{titles.get(c.chatId) ?? "deleted chat"}
									</span>
									<div className="h-3 min-w-0 flex-1 rounded-sm bg-muted">
										<div className="h-full rounded-sm bg-primary" style={{ width: `${(c.ms / maxChat) * 100}%` }} />
									</div>
									<span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatStudyDuration(c.ms)}</span>
								</div>
							))}
						</div>
					)}
				</section>

				<section>
					<h3 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground/70">Time of day</h3>
					{maxHour === 0 ? (
						<p className="text-sm text-muted-foreground">No study time in this period.</p>
					) : (
						<div data-testid="study-hours">
							<div className="flex h-24 items-end gap-[3px]">
								{hours.map((ms, h) => (
									<div
										key={h}
										data-testid="study-hour-bar"
										title={`${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00 · ${formatStudyDuration(ms)}`}
										className="min-w-0 flex-1 rounded-t-sm bg-primary"
										style={{ height: `${(ms / maxHour) * 100}%` }}
									/>
								))}
							</div>
							{/* each label sits under its own bar's left edge (hour / 24) */}
							<div className="relative mt-1 h-3 text-[10px] text-muted-foreground">
								{[0, 6, 12, 18].map((h) => (
									<span key={h} className="absolute" style={{ left: `${(h / 24) * 100}%` }}>
										{h}
									</span>
								))}
							</div>
						</div>
					)}
				</section>

				<section>
					<h3 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground/70">Last 52 weeks</h3>
					<ContributionGrid grid={summary.grid} />
				</section>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
			<div>
				<h2 className="text-lg font-medium">Study time</h2>
				<p data-testid="study-explanation" className="mt-1 text-xs text-muted-foreground">{explanation}</p>
			</div>
			{content}
		</div>
	);
}

export function StudyTimeOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [range, setRange] = useState<StudyRangeKey>("week");
	const rangeRef = useRef<StudyRangeKey>("week");
	const [summary, setSummary] = useState<StudySummary | null>(null);
	const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
	const [state, setState] = useState<StudyTimeState>("loading");

	const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
	const fetchSummary = async (key: StudyRangeKey): Promise<StudySummary> => {
		const res = await fetch(`/api/study?tz=${encodeURIComponent(tz())}&range=${key}`, { cache: "no-store" });
		if (!res.ok) throw new Error(`study ${res.status}`);
		return (await res.json()) as StudySummary;
	};

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		rangeRef.current = "week";
		setRange("week");
		setSummary(null);
		setState("loading");
		Promise.all([
			fetch("/api/chats").then(async (res) => {
				if (!res.ok) throw new Error(`chats ${res.status}`);
				return (await res.json()) as { chats: ChatSummary[] };
			}),
			fetchSummary("week"),
		])
			.then(([chats, next]) => {
				if (cancelled) return;
				setTitles(new Map(chats.chats.map((c) => [c.id, c.title])));
				setSummary(next);
				setState("ready");
			})
			.catch(() => {
				if (!cancelled) setState("error");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// The one-Esc law (see ChainTableOverlay): claim it here.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	const onRange = (key: StudyRangeKey) => {
		rangeRef.current = key;
		setRange(key);
		setState("loading");
		fetchSummary(key)
			.then((next) => {
				if (rangeRef.current !== key) return; // a newer range is selected
				setSummary(next);
				setState("ready");
			})
			.catch(() => {
				if (rangeRef.current === key) setState("error");
			});
	};

	return (
		<div data-testid="study-time-overlay" className="absolute inset-0 z-40 flex flex-col bg-background/80 backdrop-blur-sm">
			<TopBar>
				<span className="min-w-0 flex-1" />
				<button
					type="button"
					data-testid="study-time-close"
					onClick={onClose}
					aria-label="Close study time"
					className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<StudyTimeBody summary={summary} titles={titles} range={range} onRange={onRange} state={state} />
			</div>
		</div>
	);
}
