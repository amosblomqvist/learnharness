"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
	BookOpenIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	RotateCcwIcon,
	SearchIcon,
	TrashIcon,
} from "lucide-react";
import {
	ERROR_TYPE_LABELS,
	filterMistakes,
	groupMistakes,
	presentMistakeAnalysis,
	summarizeMistakes,
	type ErrorType,
	type MistakeGroupBy,
	type MistakeKind,
	type MistakeRecord,
} from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { TopBar } from "@/components/top-bar";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The Mistakes page: every miss from every session, with its short error
 * analysis, for fast review before an exam. Group by error type,
 * session/source, or topic; filter; expand everything at once.
 *
 * Questions and analysis are MODEL-AUTHORED prose, not plain labels: they
 * render through ToolContentResponse so `$...$`/`$$...$$` become KaTeX, code
 * fences become code, and lists keep their structure. Plain-text spans
 * would show raw TeX.
 */

interface Progress {
	active: number;
	done: number;
	total: number;
}

const KIND_LABEL: Record<MistakeKind, string> = { missed: "Missed", unanswered: "Unanswered", problem: "Problem" };
const KIND_DOT: Record<MistakeKind, string> = {
	missed: "bg-error",
	unanswered: "bg-warning",
	problem: "bg-primary",
};
const GROUPS: { by: MistakeGroupBy; label: string }[] = [
	{ by: "type", label: "Error type" },
	{ by: "session", label: "Session" },
	{ by: "topic", label: "Topic" },
];

export function MistakesPage() {
	const [records, setRecords] = useState<MistakeRecord[] | null>(null);
	const [progress, setProgress] = useState<Progress>({ active: 0, done: 0, total: 0 });
	const [by, setBy] = useState<MistakeGroupBy>("type");
	const [query, setQuery] = useState("");
	const [errorType, setErrorType] = useState<ErrorType | "">("");
	const [kind, setKind] = useState<MistakeKind | "">("");
	const [chatId, setChatId] = useState("");
	const [open, setOpen] = useState<Set<string>>(new Set()); // expanded cards
	const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
	const [scanNote, setScanNote] = useState<{ found: number; retry: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const loadSeq = useRef(0);

	const load = useCallback(async () => {
		const seq = ++loadSeq.current;
		try {
			const res = await fetch("/api/mistakes", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { mistakes?: MistakeRecord[]; progress?: Progress };
			if (!Array.isArray(body.mistakes) || !body.progress) throw new Error("Malformed response");
			if (seq !== loadSeq.current) return;
			setRecords(body.mistakes);
			setProgress(body.progress);
			setLoadError(null);
		} catch {
			if (seq !== loadSeq.current) return;
			// Never turn a failed read into "No mistakes yet" or an endless
			// Loading…: keep the last good list and offer a retry.
			setLoadError("Couldn't load mistakes.");
		}
	}, []);
	useEffect(() => {
		void load();
		return () => {
			loadSeq.current += 1;
		};
	}, [load]);
	// Analyzing a batch emits one event per miss; debounce the refetch like
	// the other list surfaces instead of firing N full-list requests.
	const changeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("mistakes-changed", () => {
		if (changeTimer.current) clearTimeout(changeTimer.current);
		changeTimer.current = setTimeout(() => {
			changeTimer.current = undefined;
			void load();
		}, 250);
	});
	useEffect(() => () => {
		if (changeTimer.current) clearTimeout(changeTimer.current);
	}, []);

	const filtered = useMemo(() => filterMistakes(records ?? [], { query, errorType, kind, chatId }), [records, query, errorType, kind, chatId]);
	const groups = useMemo(() => groupMistakes(filtered, by), [filtered, by]);
	const summary = useMemo(() => summarizeMistakes(records ?? []), [records]);
	const sessions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const r of records ?? []) seen.set(r.chatId, r.sessionTitle || "Untitled session");
		return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	}, [records]);

	const toggle = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const toggleGroup = (key: string) =>
		setClosedGroups((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	const remove = async (id: string) => {
		loadSeq.current += 1;
		setRecords((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
		try {
			const res = await fetch(`/api/mistakes/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
		} catch {
			setLoadError("Couldn't delete mistake.");
			void load();
		}
	};
	const retry = async (id: string) => {
		loadSeq.current += 1;
		setRecords((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, status: "pending", error: undefined } : r)) : prev));
		try {
			const res = await fetch(`/api/mistakes/${encodeURIComponent(id)}/retry`, { method: "POST" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch {
			setLoadError("Couldn't retry mistake analysis.");
			void load();
		}
	};
	const scan = async (confirm: boolean) => {
		setBusy(true);
		setLoadError(null);
		try {
			const res = await fetch("/api/mistakes/scan", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm }),
			});
			const body = (await res.json().catch(() => ({}))) as { found?: number; retry?: number; error?: string };
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			if (confirm) {
				setScanNote(null);
				await load();
			} else {
				setScanNote({ found: body.found ?? 0, retry: body.retry ?? 0 });
			}
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Couldn't scan past sessions.");
		} finally {
			setBusy(false);
		}
	};

	const analyzing = progress.active > 0;
	const allVisibleOpen = filtered.length > 0 && filtered.every((r) => open.has(r.id));

	return (
		<div className="flex h-dvh flex-col" data-testid="mistakes-page">
			<TopBar>
				<span className="flex items-center gap-1.5 font-ui text-sm font-medium">
					<CircleAlertIcon className="size-4 text-primary" /> Mistakes
				</span>
			</TopBar>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="max-w-xl font-ui text-xs text-muted-foreground">
							Every miss, with why. Read the pattern, then the rule that prevents it next time.
						</p>
						<div className="flex items-center gap-2">
							{analyzing && (
								<>
									<span data-testid="mistakes-progress" className="font-ui text-xs text-muted-foreground">
										Analyzing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
									</span>
									<button
										type="button"
										onClick={() => void fetch("/api/mistakes/cancel", { method: "POST" })}
										className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
									>
										Cancel
									</button>
								</>
							)}
							<button
								type="button"
								data-testid="mistakes-scan"
								disabled={busy}
								onClick={() => void scan(false)}
								className="flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
							>
								<SearchIcon className="size-3.5 text-muted-foreground" />
								Scan past sessions
							</button>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="mistakes-summary">
						<StatTile label="Total" value={summary.total} active={kind === ""} onClick={() => setKind("")} />
						<StatTile label="Missed" value={summary.missed} active={kind === "missed"} onClick={() => setKind((cur) => (cur === "missed" ? "" : "missed"))} />
						<StatTile label="Unanswered" value={summary.unanswered} active={kind === "unanswered"} onClick={() => setKind((cur) => (cur === "unanswered" ? "" : "unanswered"))} />
						<StatTile label="Problems" value={summary.problems} active={kind === "problem"} onClick={() => setKind((cur) => (cur === "problem" ? "" : "problem"))} />
					</div>

					{scanNote && (
						<div data-testid="mistakes-scan-note" className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-xs">
							{scanNote.found === 0 && scanNote.retry === 0 ? (
								<>
									<span className="text-foreground">Nothing new — every miss in your sessions is already here.</span>
									<button type="button" onClick={() => setScanNote(null)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
										Close
									</button>
								</>
							) : (
								<>
									<span className="min-w-0 flex-1 text-foreground">
										Found {scanNote.found} new miss{scanNote.found === 1 ? "" : "es"}
										{scanNote.retry > 0 ? ` and ${scanNote.retry} to retry` : ""}. Each gets a short analysis from your cheap model — one call per item,
										within your daily analysis limit.
									</span>
									<span className="ml-auto flex gap-2">
										<button type="button" onClick={() => setScanNote(null)} className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
											Not now
										</button>
										<button
											type="button"
											data-testid="mistakes-scan-confirm"
											disabled={busy}
											onClick={() => void scan(true)}
											className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
										>
											Analyze them
										</button>
									</span>
								</>
							)}
						</div>
					)}

					<div className="flex flex-col gap-2.5 rounded-xl border bg-card p-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="relative min-w-48 flex-1">
								<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
								<input
									data-testid="mistakes-search"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search questions, topics, rules…"
									aria-label="Search mistakes"
									className="h-8 w-full rounded-md border bg-background pl-8 pr-2.5 font-ui text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
								/>
							</span>
							<div
								role="group"
								aria-label="Group mistakes by"
								className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5"
								data-testid="mistakes-groupby"
							>
								{GROUPS.map((g) => (
									<button
										key={g.by}
										type="button"
										aria-pressed={by === g.by}
										onClick={() => setBy(g.by)}
										className={cn(
											"rounded-sm px-2 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors",
											by === g.by ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
										)}
									>
										{g.label}
									</button>
								))}
							</div>
							<select
								aria-label="Filter by session"
								value={chatId}
								onChange={(e) => setChatId(e.target.value)}
								className="h-8 max-w-44 rounded-md border bg-background px-2 font-ui text-xs"
							>
								<option value="">All sessions</option>
								{sessions.map(([id, title]) => (
									<option key={id} value={id}>
										{title}
									</option>
								))}
							</select>
							<button
								type="button"
								data-testid="mistakes-expand-all"
								onClick={() => setOpen(allVisibleOpen ? new Set() : new Set(filtered.map((r) => r.id)))}
								className="ml-auto rounded-md px-2.5 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								{allVisibleOpen ? "Collapse all" : "Expand all"}
							</button>
						</div>
						{summary.byType.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
								<span className="mr-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Error type</span>
								{summary.byType.map(({ type, count }) => (
									<button
										key={type}
										type="button"
										aria-pressed={errorType === type}
										onClick={() => setErrorType((cur) => (cur === type ? "" : type))}
										className={cn(
											"rounded-full border px-2.5 py-0.5 font-ui text-[11px] transition-colors hover:bg-accent",
											errorType === type ? "border-ring bg-accent text-foreground" : "border-border/70 text-muted-foreground",
										)}
									>
										{ERROR_TYPE_LABELS[type]} <span className="tabular-nums opacity-70">{count}</span>
									</button>
								))}
							</div>
						)}
					</div>

					{loadError && (
						<div role="alert" className="flex items-center gap-3 rounded-lg border border-error/40 px-3 py-2 text-xs text-error" data-testid="mistakes-error">
							<span className="min-w-0 flex-1">{loadError}</span>
							<button type="button" onClick={() => void load()} className="rounded-md px-2 py-1 text-foreground hover:bg-accent">
								Retry
							</button>
						</div>
					)}

					<div className="min-h-0 pb-4" data-testid="mistakes-list">
						{records === null && loadError ? (
							<p className="text-xs text-muted-foreground">Couldn&rsquo;t load mistakes.</p>
						) : records === null ? (
							<div className="flex items-center gap-2 py-8 font-ui text-xs text-muted-foreground">
								<BrailleSpinner label="Loading" /> Loading mistakes…
							</div>
						) : records.length === 0 ? (
							<div className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
								<CircleAlertIcon className="mx-auto size-6 text-muted-foreground/60" />
								<p className="mt-3 font-sans text-base font-semibold tracking-tight text-foreground">No mistakes yet</p>
								<p className="mx-auto mt-1 max-w-md font-ui text-xs text-muted-foreground">
									Quiz misses, “I don’t know”, and practice problems you don’t solve cleanly land here with a short analysis.
									Use <span className="text-foreground">Scan past sessions</span> to pull in ones from before.
								</p>
							</div>
						) : filtered.length === 0 ? (
							<div className="rounded-xl border border-dashed bg-card/50 px-6 py-8 text-center font-ui text-xs text-muted-foreground">
								No mistakes match these filters.
								<button
									type="button"
									onClick={() => {
										setQuery("");
										setErrorType("");
										setKind("");
										setChatId("");
									}}
									className="ml-2 text-foreground underline-offset-2 hover:underline"
								>
									Clear filters
								</button>
							</div>
						) : (
							<div className="flex flex-col gap-5">
								{groups.map((g) => {
									const collapsed = closedGroups.has(g.key);
									return (
										<section key={g.key} data-testid="mistakes-group" className="flex flex-col gap-2">
											<div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-background/95 px-1 py-2 backdrop-blur">
												<button
													type="button"
													aria-expanded={!collapsed}
													onClick={() => toggleGroup(g.key)}
													className="flex min-w-0 flex-1 items-center gap-2 text-left"
												>
													{collapsed ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />}
													<span className="font-sans text-base font-semibold tracking-tight text-foreground">{g.label}</span>
													<span className="rounded-full border border-border/60 px-2 py-0.5 font-ui text-[10px] tabular-nums text-muted-foreground">{g.records.length}</span>
													{g.pattern && <span className="ml-1 hidden min-w-0 truncate font-ui text-[11px] text-muted-foreground/80 sm:block" data-testid="mistakes-pattern">{g.pattern}</span>}
												</button>
											</div>
											{!collapsed && (
												<div className="flex flex-col gap-2.5">
													{g.records.map((r) => (
														<MistakeCard key={r.id} record={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} onDelete={() => void remove(r.id)} onRetry={() => void retry(r.id)} />
													))}
												</div>
											)}
										</section>
									);
								})}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function StatTile({
	label,
	value,
	active,
	onClick,
}: {
	label: string;
	value: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"flex items-baseline justify-between gap-2 rounded-xl border bg-card px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
				active && "border-ring bg-accent",
			)}
		>
			<span className={cn("font-ui text-[10px] uppercase tracking-wider", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
			<span className="font-ui text-xl font-bold leading-none tabular-nums tracking-tight text-foreground">{value}</span>
		</button>
	);
}

/** One mistake. Exported for the render test that pins Markdown/KaTeX. */
export function MistakeCard({
	record: r,
	open,
	onToggle,
	onDelete,
	onRetry,
}: {
	record: MistakeRecord;
	open: boolean;
	onToggle: () => void;
	onDelete: () => void;
	onRetry: () => void;
}) {
	const a = r.analysis;
	const previewRef = useRef<HTMLDivElement>(null);
	const [overflows, setOverflows] = useState(false);

	useEffect(() => {
		const el = previewRef.current;
		if (open || !el) return;
		const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 2);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const obs = new ResizeObserver(measure);
		obs.observe(el);
		return () => obs.disconnect();
	}, [open, r.question]);

	return (
		<article
			className="overflow-hidden rounded-xl border bg-card transition-colors hover:border-border/80"
			data-testid="mistake-card"
		>
			<div
				className="flex cursor-pointer items-start gap-2.5 px-4 py-3.5"
				onClick={(event) => {
					// The question is Markdown (block HTML), so the header cannot
					// be a <button>. Keep a real toggle button for the keyboard;
					// the body click just makes the whole row a convenient target.
					if ((event.target as Element).closest("button, a")) return;
					onToggle();
				}}
			>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					aria-label={open ? "Collapse mistake" : "Expand mistake"}
					className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				</button>
				<div className="min-w-0 flex-1">
					<div ref={previewRef} className={cn("relative", !open && "max-h-28 overflow-hidden [&_pre]:hidden [&_[data-testid=md-code]]:hidden")}>
						<ToolContentResponse className="text-(length:--lh-prose-size)">{r.question}</ToolContentResponse>
						{!open && overflows && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card to-transparent" />}
					</div>
					<div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-ui text-[11px]">
						<span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground">
							<span className={cn("size-1.5 rounded-full", KIND_DOT[r.kind])} aria-hidden />
							{KIND_LABEL[r.kind]}
						</span>
						{a ? (
							<span className="rounded-full border border-border/60 bg-accent/60 px-2 py-0.5 text-foreground">{ERROR_TYPE_LABELS[a.errorType]}</span>
						) : r.status === "pending" ? (
							<span className="text-muted-foreground">Analyzing…</span>
						) : (
							<span className="text-muted-foreground" title={r.error}>Analysis unavailable</span>
						)}
						{a && <span className="min-w-0 truncate text-muted-foreground">{a.topic}</span>}
					</div>
				</div>
			</div>

			{open && (
				<div className="flex flex-col gap-3 border-t px-4 py-3.5 text-sm" data-testid="mistake-card-body">
					<div className="grid gap-2 sm:grid-cols-2">
						<AnswerPanel label="Your answer" text={r.yourAnswer} />
						<AnswerPanel label="Correct answer" text={r.correctAnswer} />
					</div>
					{a ? (
						<>
							<div className="grid gap-3 sm:grid-cols-2">
								<AnalysisBlock label="What happened" text={a.whatYouDid} />
								<AnalysisBlock label="What’s correct" text={a.correct} />
							</div>
							<div className="rounded-lg border-l-2 border-l-primary/60 bg-muted/40 px-3 py-2">
								<div className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Remember this</div>
								<ToolContentResponse className="mt-1 text-sm">{presentMistakeAnalysis(a.rule)}</ToolContentResponse>
							</div>
						</>
					) : r.explanation ? (
						<AnalysisBlock label="Why" text={r.explanation} />
					) : null}
					{r.thinking && <AnalysisBlock label="Your reasoning" text={r.thinking} />}
					{r.status === "failed" && r.error && <p className="text-xs text-muted-foreground" data-testid="mistake-error">{r.error}</p>}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2.5 font-ui text-[11px] text-muted-foreground">
						<Link href={`/chat/${r.chatId}`} className="inline-flex items-center gap-1 hover:text-foreground" data-testid="mistake-session-link">
							<BookOpenIcon className="size-3.5" />
							{r.sessionTitle || "Untitled session"}
						</Link>
						{r.sources.length > 0 && <span className="truncate">{r.sources.join(", ")}</span>}
						{typeof r.confidence === "number" && <span>{r.confidence}% sure</span>}
						{!Number.isNaN(Date.parse(r.answeredAt)) && <span>{new Date(r.answeredAt).toLocaleDateString()}</span>}
						<span className="ml-auto flex items-center gap-1">
							{r.status === "failed" && (
								<button
									type="button"
									onClick={onRetry}
									className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent hover:text-foreground"
								>
									<RotateCcwIcon className="size-3" /> Retry analysis
								</button>
							)}
							<button type="button" aria-label="Delete mistake" onClick={onDelete} className="rounded-md p-1.5 hover:bg-accent hover:text-foreground">
								<TrashIcon className="size-3.5" />
							</button>
						</span>
					</div>
				</div>
			)}
		</article>
	);
}

function AnswerPanel({ label, text }: { label: string; text: string }) {
	return (
		<div className="min-w-0 rounded-lg border border-border/60 bg-background/50 px-3 py-2">
			<div className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
			<ToolContentResponse className="mt-1 text-sm">{text}</ToolContentResponse>
		</div>
	);
}

function AnalysisBlock({ label, text }: { label: string; text: string }) {
	return (
		<div className="min-w-0">
			<div className="mb-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
			<ToolContentResponse className="text-sm">{presentMistakeAnalysis(text)}</ToolContentResponse>
		</div>
	);
}
