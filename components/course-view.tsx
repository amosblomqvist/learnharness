"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckIcon, CircleDotIcon, CircleIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
	lessonMinutesBreakdown,
	paceLine,
	wouldCycle,
	type CourseView,
	type LessonStatus,
	type LessonView,
	type PlanNodeStatus,
} from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { PlanDiagram, GRAPH_PAD, TEXT_CAP_SCALE } from "@/components/plan-block";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The course page (courses plan, 2026-10-30). Draft: review, regenerate
 * with feedback, accept or discard. Active: lessons as a List (dependency
 * order, prerequisite chips, derived status, learned-pace minutes) and a
 * Graph (the session plan's PlanDiagram — hand-built SVG, owner decision),
 * hand edits, lesson session starts, and Replan → a reviewed proposal.
 * Everything shown is the server's derived view (GET /api/courses/:id);
 * the page refetches on course/session events.
 */

type LongRun = "regenerate" | "replan";

function fmtMinutes(m: number): string {
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

const STATUS_TO_PLAN: Record<LessonStatus, PlanNodeStatus> = {
	done: "visited",
	"in-progress": "current",
	"not-started": "upcoming",
};

async function send(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<CourseView> {
	const res = await fetch(url, {
		method,
		...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
		...(signal ? { signal } : {}),
	});
	const json = (await res.json().catch(() => ({}))) as CourseView & { error?: string };
	if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
	return json;
}

export function CourseViewPage({ initial }: { initial: CourseView }) {
	const router = useRouter();
	const [view, setView] = useState(initial);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState<LongRun | null>(null);
	const [feedback, setFeedback] = useState("");
	const [tab, setTab] = useState<"list" | "graph">("list");
	const [selected, setSelected] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const base = `/api/courses/${view.id}`;

	const refresh = useCallback(async () => {
		try {
			setView(await send("GET", base));
		} catch {
			// the course may have been deleted elsewhere — keep the last view
		}
	}, [base]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void refresh(), 250);
	};
	useServerEvent("courses-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(() => void refresh());

	const mutate = useCallback(async (method: string, url: string, body?: unknown): Promise<boolean> => {
		setError(null);
		try {
			setView(await send(method, url, body));
			return true;
		} catch (err) {
			setError((err as Error).message);
			return false;
		}
	}, []);

	async function longRun(kind: LongRun) {
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(kind);
		setError(null);
		try {
			setView(await send("POST", `${base}/${kind === "regenerate" ? "generate" : "replan"}`, { feedback }, controller.signal));
			setFeedback("");
		} catch (err) {
			if ((err as Error).name !== "AbortError") setError((err as Error).message);
			void refresh(); // usage of a failed run still landed
		} finally {
			abortRef.current = null;
			setRunning(null);
		}
	}

	async function deleteCourse() {
		const res = await fetch(base, { method: "DELETE" });
		if (res.ok) router.push("/");
		else setError("Couldn’t delete the course.");
	}

	const byId = useMemo(() => new Map(view.lessons.map((l) => [l.id, l])), [view.lessons]);
	const remainingMinutes = view.lessons.filter((l) => l.status !== "done").reduce((sum, l) => sum + l.estimate.minutes, 0);
	const isDraft = view.status === "draft";

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Course</span>
				{isDraft && (
					<span className="rounded-sm border border-border px-1.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground" data-testid="course-draft-badge">
						Draft
					</span>
				)}
				<span className="flex-1" />
				<DeleteCourseButton label={isDraft ? "Discard draft" : "Delete course"} onConfirm={() => void deleteCourse()} />
			</TopBar>
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
					<header className="flex flex-col gap-3">
						<EditableText
							value={view.title}
							testid="course-title"
							className="font-title text-3xl tracking-tight"
							onCommit={(title) => void mutate("PATCH", base, { title })}
						/>
						<div className="flex flex-wrap items-baseline gap-2 text-sm">
							<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Goal</span>
							<EditableText value={view.goal} testid="course-goal-text" className="min-w-0 flex-1" onCommit={(goal) => void mutate("PATCH", base, { goal })} />
							{view.goalInferred && (
								<span className="rounded-sm border border-border px-1 font-ui text-[10px] uppercase tracking-wider text-muted-foreground" data-testid="goal-inferred">
									Inferred
								</span>
							)}
						</div>
						<div className="flex flex-wrap items-center gap-4 text-sm">
							<label className="flex items-center gap-2">
								<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Deadline</span>
								<Input
									type="date"
									data-testid="course-deadline-edit"
									defaultValue={view.deadline}
									key={view.deadline}
									className="h-7 w-40"
									onBlur={(e) => {
										if (e.target.value && e.target.value !== view.deadline) void mutate("PATCH", base, { deadline: e.target.value });
									}}
								/>
							</label>
							{!isDraft && (
								<span
									data-testid="course-health"
									className={cn("font-ui text-xs uppercase tracking-wider", view.health === "behind" ? "text-amber-500" : "text-muted-foreground")}
								>
									{view.health === "behind" ? "Behind schedule" : "On track"}
								</span>
							)}
							<span className="font-ui text-xs text-muted-foreground" data-testid="course-progress">
								{view.doneCount}/{view.lessons.length} lessons done · ~{fmtMinutes(remainingMinutes)} remaining
							</span>
						</div>
						<div className="flex flex-wrap items-baseline gap-2 text-sm">
							<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Availability</span>
							<EditableText
								value={view.availabilityNotes}
								placeholder="No availability notes"
								testid="course-notes-text"
								className="min-w-0 flex-1 text-muted-foreground"
								allowEmpty
								onCommit={(availabilityNotes) => void mutate("PATCH", base, { availabilityNotes })}
							/>
						</div>
						<p className="font-ui text-xs text-muted-foreground" data-testid="course-pace">
							Your pace: {paceLine(view.pace)} · estimates {view.estimateMode === "live" ? "update live from your pace" : "frozen at planning"}
						</p>
						<p className="font-ui text-xs text-muted-foreground" data-testid="course-cost">
							Planning cost: ${view.cost.dollars.toFixed(2)} over {view.cost.runs} run{view.cost.runs === 1 ? "" : "s"}
							{view.cost.unpriced > 0 ? ` (+${view.cost.unpriced} unpriced)` : ""}
						</p>
						{view.feasibility && (
							<p className="rounded-lg border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground" data-testid="course-feasibility">
								{view.feasibility}
							</p>
						)}
					</header>

					<section className="flex flex-col gap-2 rounded-lg border border-border p-4" data-testid={isDraft ? "draft-panel" : "replan-panel"}>
						<Textarea
							data-testid="course-feedback"
							value={feedback}
							onChange={(e) => setFeedback(e.target.value)}
							placeholder={isDraft ? "Feedback for a new version (optional)…" : "Feedback to restructure the remaining lessons (optional — without it, only dates and estimates change)…"}
							className="min-h-14"
							disabled={running !== null}
						/>
						<div className="flex flex-wrap items-center gap-2">
							{running ? (
								<>
									<span className="flex items-center gap-2 text-sm text-muted-foreground">
										<BrailleSpinner /> {running === "regenerate" ? "Regenerating…" : "Replanning…"}
									</span>
									<Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
										Cancel
									</Button>
								</>
							) : isDraft ? (
								<>
									<Button variant="outline" size="sm" data-testid="course-regenerate" onClick={() => void longRun("regenerate")}>
										Regenerate
									</Button>
									<Button size="sm" data-testid="course-accept" disabled={view.lessons.length === 0} onClick={() => void mutate("PATCH", base, { status: "active" })}>
										Accept course
									</Button>
								</>
							) : (
								<Button variant="outline" size="sm" data-testid="course-replan" onClick={() => void longRun("replan")}>
									Replan
								</Button>
							)}
						</div>
					</section>

					{view.pendingReplan && (
						<ProposalPanel
							view={view}
							onAccept={() => void mutate("POST", `${base}/replan/accept`)}
							onDiscard={() => void mutate("DELETE", `${base}/replan`)}
						/>
					)}

					{error && (
						<p className="text-sm text-destructive" data-testid="course-view-error">
							{error}
						</p>
					)}

					<section className="flex flex-col gap-3">
						<div className="flex items-center gap-0.5 self-start rounded-md border border-border/60 p-0.5" data-testid="course-tabs">
							{(["list", "graph"] as const).map((t) => (
								<button
									key={t}
									type="button"
									data-testid={`course-tab-${t}`}
									onClick={() => setTab(t)}
									className={cn(
										"rounded-sm px-3 py-1 text-[11px] uppercase tracking-wider transition-colors",
										tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
									)}
								>
									{t === "list" ? "List" : "Graph"}
								</button>
							))}
						</div>
						{tab === "list" ? (
							<div className="flex flex-col gap-2" data-testid="lesson-list">
								{view.lessons.map((lesson) => (
									<LessonRow
										key={lesson.id}
										lesson={lesson}
										view={view}
										byId={byId}
										selected={selected === lesson.id}
										onMutate={mutate}
										onError={setError}
									/>
								))}
								<AddLessonForm view={view} onMutate={mutate} />
							</div>
						) : (
							<div
								className="rounded-lg border border-border p-4"
								data-testid="lesson-graph"
								onClick={(e) => {
									const g = (e.target as Element).closest("[data-testid^='plan-node-']");
									const id = g?.getAttribute("data-testid")?.slice("plan-node-".length);
									if (id && byId.has(id)) {
										setSelected(id);
										setTab("list");
									}
								}}
							>
								<PlanDiagram
									nodes={view.lessons.map((l) => ({ id: l.id, title: l.title }))}
									edges={view.lessons.flatMap((l) => l.prerequisites.filter((p) => byId.has(p)).map((p) => ({ from: p, to: l.id })))}
									statusOf={(id) => STATUS_TO_PLAN[byId.get(id)?.status ?? "not-started"]}
									glowId={selected}
									markerId={`course-arrow-${view.id}`}
									pad={GRAPH_PAD}
									textCapScale={TEXT_CAP_SCALE}
								/>
							</div>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function DeleteCourseButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
	const [confirming, setConfirming] = useState(false);
	if (confirming) {
		return (
			<span className="flex items-center gap-1 text-xs">
				<span className="text-muted-foreground">Sessions stay.</span>
				<Button variant="destructive" size="xs" data-testid="course-delete-confirm" onClick={onConfirm}>
					{label}
				</Button>
				<Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
					Cancel
				</Button>
			</span>
		);
	}
	return (
		<Button variant="ghost" size="xs" data-testid="course-delete" onClick={() => setConfirming(true)}>
			<Trash2Icon /> {label}
		</Button>
	);
}

function EditableText({
	value,
	onCommit,
	className,
	testid,
	placeholder,
	allowEmpty = false,
}: {
	value: string;
	onCommit: (next: string) => void;
	className?: string;
	testid: string;
	placeholder?: string;
	allowEmpty?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	if (editing) {
		const commit = () => {
			setEditing(false);
			const next = draft.trim();
			if (next !== value && (allowEmpty || next)) onCommit(next);
		};
		return (
			<Input
				autoFocus
				data-testid={`${testid}-input`}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit();
					if (e.key === "Escape") setEditing(false);
				}}
				className={cn("h-auto py-1", className)}
			/>
		);
	}
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={() => {
				setDraft(value);
				setEditing(true);
			}}
			className={cn("cursor-text text-left hover:underline hover:decoration-dotted hover:underline-offset-4", className)}
		>
			{value || <span className="text-muted-foreground/60">{placeholder}</span>}
		</button>
	);
}

function StatusIcon({ status }: { status: LessonStatus }) {
	if (status === "done") return <CheckIcon aria-label="Done" className="size-4 text-emerald-500" />;
	if (status === "in-progress") return <CircleDotIcon aria-label="In progress" className="size-4 text-foreground" />;
	return <CircleIcon aria-label="Not started" className="size-4 text-muted-foreground/60" />;
}

function LessonRow({
	lesson,
	view,
	byId,
	selected,
	onMutate,
	onError,
}: {
	lesson: LessonView;
	view: CourseView;
	byId: ReadonlyMap<string, LessonView>;
	selected: boolean;
	onMutate: (method: string, url: string, body?: unknown) => Promise<boolean>;
	onError: (message: string) => void;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [confirmStart, setConfirmStart] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [starting, setStarting] = useState(false);
	const url = `/api/courses/${view.id}/lessons/${lesson.id}`;
	const unmet = lesson.prerequisites.filter((p) => byId.get(p)?.status !== "done");

	async function start() {
		setStarting(true);
		try {
			const res = await fetch(`${url}/sessions`, { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as { chatId?: string; openingPrompt?: string; error?: string };
			if (!res.ok || !body.chatId || !body.openingPrompt) throw new Error(body.error ?? "Couldn’t start the session.");
			if (!stashOpeningPrompt(body.chatId, body.openingPrompt)) throw new Error("Couldn’t start the session.");
			router.push(`/chat/${body.chatId}`);
		} catch (err) {
			onError((err as Error).message);
			setStarting(false);
		}
	}

	return (
		<div
			data-testid={`lesson-${lesson.id}`}
			data-status={lesson.status}
			className={cn(
				"flex flex-col gap-2 rounded-lg border px-4 py-3",
				lesson.overdue ? "border-amber-500/60" : "border-border",
				selected && "ring-2 ring-ring/50",
			)}
		>
			<div className="flex items-start gap-3">
				<span className="pt-0.5">
					<StatusIcon status={lesson.status} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="font-medium">{lesson.title}</span>
						<span className={cn("font-ui text-xs", lesson.overdue ? "text-amber-500" : "text-muted-foreground")} data-testid={`lesson-date-${lesson.id}`}>
							{lesson.targetDate}
							{lesson.overdue ? " · overdue" : ""}
						</span>
						<span className="font-ui text-xs text-muted-foreground" title={lessonMinutesBreakdown(lesson.estimate)} data-testid={`lesson-minutes-${lesson.id}`}>
							~{fmtMinutes(lesson.estimate.minutes)}
						</span>
					</div>
					<p className="text-sm text-muted-foreground">{lesson.goal}</p>
					{lesson.prerequisites.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{lesson.prerequisites.map((p) => (
								<span key={p} className="rounded-sm border border-border px-1.5 text-[11px] text-muted-foreground">
									{byId.get(p)?.title ?? p}
								</span>
							))}
						</div>
					)}
					{lesson.sessions.length > 0 && (
						<div className="flex flex-wrap gap-2 text-xs">
							{lesson.sessions.map((s) => (
								<Link key={s.id} href={`/chat/${s.id}`} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
									{s.done ? "✓ " : ""}
									{s.title}
								</Link>
							))}
						</div>
					)}
				</div>
				{view.status === "active" && (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="xs"
							variant={lesson.sessions.length > 0 ? "outline" : "default"}
							data-testid={`lesson-start-${lesson.id}`}
							disabled={starting}
							onClick={() => (unmet.length > 0 ? setConfirmStart(true) : void start())}
						>
							{lesson.sessions.length > 0 ? "Start another session" : "Start lesson"}
						</Button>
					</div>
				)}
				<Button size="icon-xs" variant="ghost" aria-label="Edit lesson" data-testid={`lesson-edit-${lesson.id}`} onClick={() => setEditing((v) => !v)}>
					<PencilIcon />
				</Button>
				<Button size="icon-xs" variant="ghost" aria-label="Delete lesson" data-testid={`lesson-delete-${lesson.id}`} onClick={() => setConfirmDelete(true)}>
					<Trash2Icon />
				</Button>
			</div>
			{confirmStart && (
				<div className="flex flex-wrap items-center gap-2 text-xs" data-testid={`lesson-prereq-warning-${lesson.id}`}>
					<span className="text-amber-500">Prerequisites not done: {unmet.map((p) => byId.get(p)?.title ?? p).join(", ")}.</span>
					<Button size="xs" variant="outline" onClick={() => void start()} disabled={starting}>
						Start anyway
					</Button>
					<Button size="xs" variant="ghost" onClick={() => setConfirmStart(false)}>
						Cancel
					</Button>
				</div>
			)}
			{confirmDelete && (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="text-muted-foreground">Delete this lesson? Its sessions stay.</span>
					<Button size="xs" variant="destructive" data-testid={`lesson-delete-confirm-${lesson.id}`} onClick={() => void onMutate("DELETE", url)}>
						Delete
					</Button>
					<Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			)}
			{editing && (
				<LessonEditor
					lesson={lesson}
					lessons={view.lessons}
					onCancel={() => setEditing(false)}
					onSave={async (body) => {
						if (await onMutate("PATCH", url, body)) setEditing(false);
					}}
				/>
			)}
		</div>
	);
}

function LessonEditor({
	lesson,
	lessons,
	onCancel,
	onSave,
}: {
	lesson: LessonView;
	lessons: readonly LessonView[];
	onCancel: () => void;
	onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
	const [title, setTitle] = useState(lesson.title);
	const [goal, setGoal] = useState(lesson.goal);
	const [summary, setSummary] = useState(lesson.guideSummary);
	const [date, setDate] = useState(lesson.targetDate);
	const [nodes, setNodes] = useState(String(lesson.predictedNodes));
	const [prereqs, setPrereqs] = useState<string[]>(lesson.prerequisites);
	const others = lessons.filter((l) => l.id !== lesson.id);
	// Cycle check against the edited prerequisite set (the server re-checks).
	const current = lessons.map((l) => (l.id === lesson.id ? { ...l, prerequisites: prereqs } : l));
	return (
		<div className="flex flex-col gap-2 border-t border-border pt-3" data-testid={`lesson-editor-${lesson.id}`}>
			<Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" data-testid="lesson-edit-title" />
			<Textarea value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal" className="min-h-12" data-testid="lesson-edit-goal" />
			<Textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Guide summary" className="min-h-24 text-xs" data-testid="lesson-edit-summary" />
			<div className="flex flex-wrap items-center gap-3 text-xs">
				<label className="flex items-center gap-2">
					Target date
					<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-7 w-40" data-testid="lesson-edit-date" />
				</label>
				<label className="flex items-center gap-2" title="Plan steps the tutor will need — minutes derive from your pace">
					Predicted plan nodes
					<Input type="number" min={1} max={50} value={nodes} onChange={(e) => setNodes(e.target.value)} className="h-7 w-20" data-testid="lesson-edit-nodes" />
				</label>
			</div>
			{others.length > 0 && (
				<div className="flex flex-wrap items-center gap-1 text-xs">
					<span className="mr-1 text-muted-foreground">Prerequisites:</span>
					{others.map((o) => {
						const on = prereqs.includes(o.id);
						const blocked = !on && wouldCycle(current, o.id, lesson.id);
						return (
							<button
								key={o.id}
								type="button"
								disabled={blocked}
								title={blocked ? "Would create a cycle" : undefined}
								data-testid={`lesson-edit-prereq-${o.id}`}
								onClick={() => setPrereqs((ps) => (on ? ps.filter((p) => p !== o.id) : [...ps, o.id]))}
								className={cn(
									"rounded-sm border px-1.5 py-0.5 transition-colors disabled:opacity-40",
									on ? "border-foreground/60 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground",
								)}
							>
								{o.title}
							</button>
						);
					})}
				</div>
			)}
			<div className="flex gap-2">
				<Button
					size="xs"
					data-testid="lesson-edit-save"
					onClick={() =>
						void onSave({ title, goal, guideSummary: summary, targetDate: date, predictedNodes: Number(nodes), prerequisites: prereqs })
					}
				>
					Save
				</Button>
				<Button size="xs" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function AddLessonForm({ view, onMutate }: { view: CourseView; onMutate: (method: string, url: string, body?: unknown) => Promise<boolean> }) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [goal, setGoal] = useState("");
	const [date, setDate] = useState("");
	const [nodes, setNodes] = useState("");
	if (!open) {
		return (
			<Button variant="ghost" size="sm" className="self-start" data-testid="lesson-add" onClick={() => setOpen(true)}>
				<PlusIcon /> Add lesson
			</Button>
		);
	}
	const ready = title.trim() && goal.trim() && date && Number(nodes) >= 1;
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-3" data-testid="lesson-add-form">
			<Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" data-testid="lesson-add-title" />
			<Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal" data-testid="lesson-add-goal" />
			<div className="flex flex-wrap items-center gap-3 text-xs">
				<label className="flex items-center gap-2">
					Target date
					<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-7 w-40" data-testid="lesson-add-date" />
				</label>
				<label className="flex items-center gap-2">
					Predicted plan nodes
					<Input type="number" min={1} max={50} value={nodes} onChange={(e) => setNodes(e.target.value)} className="h-7 w-20" data-testid="lesson-add-nodes" />
				</label>
			</div>
			<div className="flex gap-2">
				<Button
					size="xs"
					disabled={!ready}
					data-testid="lesson-add-save"
					onClick={async () => {
						const ok = await onMutate("POST", `/api/courses/${view.id}/lessons`, { title, goal, targetDate: date, predictedNodes: Number(nodes) });
						if (ok) {
							setOpen(false);
							setTitle("");
							setGoal("");
							setDate("");
							setNodes("");
						}
					}}
				>
					Add
				</Button>
				<Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function ProposalPanel({ view, onAccept, onDiscard }: { view: CourseView; onAccept: () => void; onDiscard: () => void }) {
	const proposal = view.pendingReplan!;
	const current = new Map(view.lessons.map((l) => [l.id, l]));
	return (
		<section className="flex flex-col gap-3 rounded-lg border border-foreground/30 p-4" data-testid="replan-proposal">
			<div className="flex items-center gap-2">
				<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Proposed replan</span>
				{proposal.feedback && <span className="truncate text-xs text-muted-foreground">— “{proposal.feedback}”</span>}
			</div>
			<p className="text-sm text-muted-foreground">{proposal.feasibility}</p>
			<div className="flex flex-col gap-1 text-sm">
				{proposal.lessons.map((l) => {
					const before = current.get(l.id);
					const changed = !before ? "new" : before.targetDate !== l.targetDate || before.estimate.minutes !== l.estimate.minutes ? "changed" : null;
					return (
						<div key={l.id} className="flex flex-wrap items-baseline gap-x-3" data-testid={`proposal-lesson-${l.id}`}>
							<span className="font-medium">{l.title}</span>
							<span className="font-ui text-xs text-muted-foreground">
								{before && before.targetDate !== l.targetDate ? `${before.targetDate} → ` : ""}
								{l.targetDate}
							</span>
							<span className="font-ui text-xs text-muted-foreground" title={lessonMinutesBreakdown(l.estimate)}>
								~{fmtMinutes(l.estimate.minutes)}
							</span>
							{changed && <span className="font-ui text-[10px] uppercase tracking-wider text-amber-500">{changed}</span>}
						</div>
					);
				})}
				{view.lessons
					.filter((l) => l.status !== "done" && !proposal.lessons.some((p) => p.id === l.id))
					.map((l) => (
						<div key={l.id} className="flex items-baseline gap-3 text-muted-foreground line-through" data-testid={`proposal-dropped-${l.id}`}>
							{l.title}
						</div>
					))}
			</div>
			<div className="flex gap-2">
				<Button size="sm" data-testid="replan-accept" onClick={onAccept}>
					Accept replan
				</Button>
				<Button size="sm" variant="ghost" data-testid="replan-discard" onClick={onDiscard}>
					Discard
				</Button>
			</div>
		</section>
	);
}
