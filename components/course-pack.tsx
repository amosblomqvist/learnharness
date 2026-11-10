"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChapterStatus, ChapterView, CoursePackSnapshot, CourseView, ReviewQueueItem } from "@/src/core";

const STATUS_LABEL: Record<ChapterStatus, string> = {
	not_started: "Not started",
	learning: "Learning",
	review_due: "Review due",
	mastered: "Mastered",
};

const GRADES = [
	{ grade: 1, label: "Again" },
	{ grade: 3, label: "Hard" },
	{ grade: 4, label: "Good" },
	{ grade: 5, label: "Easy" },
] as const;

export function CoursePack({ initial }: { initial: CoursePackSnapshot }) {
	const router = useRouter();
	const [pack, setPack] = useState(initial);
	const [localPath, setLocalPath] = useState("");
	const [extractGraph, setExtractGraph] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(initial.error ?? null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const preset = pack.presets[0];

	async function postJson(url: string, body: unknown, busyKey: string) {
		setBusy(busyKey);
		setError(null);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = (await response.json().catch(() => null)) as { error?: string; pack?: CoursePackSnapshot; warnings?: string[]; copied?: number; unchanged?: number; extracted?: number } | null;
			if (!response.ok || !data) {
				setError(data?.error ?? "The course request failed.");
				return null;
			}
			if (data.pack) setPack(data.pack);
			if (data.warnings) setWarnings(data.warnings);
			return data;
		} catch {
			setError("The course request failed. The server did not respond.");
			return null;
		} finally {
			setBusy(null);
		}
	}

	async function importNotes(body: Record<string, unknown>, busyKey: string) {
		const data = await postJson("/api/courses", body, busyKey);
		if (!data) return;
		const copied = data.copied ?? 0;
		const unchanged = data.unchanged ?? 0;
		setNote(copied === 0 && unchanged > 0 ? "No chapter files changed." : `Updated ${copied} ${copied === 1 ? "chapter" : "chapters"}.`);
	}

	async function openChapter(courseId: string, chapterId: string, kind: "teach" | "practice", conceptId?: string) {
		const data = await postJson(
			`/api/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(chapterId)}/open`,
			{ kind, ...(conceptId ? { conceptId } : {}) },
			`${kind}:${courseId}:${chapterId}:${conceptId ?? ""}`,
		);
		const opened = data as { id?: string; prompt?: string } | null;
		if (!opened?.id || !opened.prompt) return;
		if (!stashOpeningPrompt(opened.id, opened.prompt)) {
			setError("Could not keep the opening prompt in this tab.");
			return;
		}
		router.push(`/chat/${opened.id}`);
	}

	return (
		<div className="flex h-dvh min-h-0 flex-col">
			<TopBar>
				<p className="truncate text-xs uppercase tracking-widest text-muted-foreground">Courses</p>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6">
					<section className="flex flex-col gap-3">
						<h1 className="text-2xl text-foreground">Study a notes folder</h1>
						<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
							A course is a folder of numbered chapters, each with a Readme.md. Import it from your machine.
							The text is copied into this app&apos;s local data and is not committed to the repository.
						</p>
					</section>

					{error && (
						<p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
							{error}
						</p>
					)}
					{note && <p className="text-sm text-muted-foreground">{note}</p>}
					{warnings.length > 0 && (
						<ul className="list-disc pl-5 text-sm text-muted-foreground">
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					)}

					{preset && (
						<section className="flex flex-col gap-4 rounded-2xl border bg-card p-4">
							<div className="flex flex-col gap-1">
								<h2 className="text-lg text-foreground">{preset.title}</h2>
								<p className="text-sm leading-6 text-muted-foreground">{preset.summary}</p>
							</div>
							<label className="flex flex-col gap-2 text-xs uppercase tracking-wider text-muted-foreground">
								Local folder
								<Input
									data-testid="course-import-path"
									value={localPath}
									spellCheck={false}
									placeholder="C:\Users\you\src\system-design-notes"
									onChange={(event) => setLocalPath(event.target.value)}
								/>
							</label>
							<label className="flex items-start gap-2 text-sm text-muted-foreground">
								<input
									data-testid="course-extract-graph"
									type="checkbox"
									className="mt-1"
									checked={extractGraph}
									onChange={(event) => setExtractGraph(event.target.checked)}
								/>
								<span>Also extract propositions into the knowledge graph. This uses your model, once per changed chapter.</span>
							</label>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Button
									type="button"
									data-testid="course-import-local"
									disabled={busy !== null || localPath.trim().length === 0}
									onClick={() => void importNotes({ presetId: preset.id, localPath: localPath.trim(), extractGraph }, "import-local")}
								>
									{busy === "import-local" ? "Importing…" : "Import local folder"}
								</Button>
								<Button
									type="button"
									variant="outline"
									data-testid="course-import-download"
									disabled={busy !== null}
									onClick={() => void importNotes({ presetId: preset.id, download: true, extractGraph }, "import-download")}
								>
									{busy === "import-download" ? "Downloading…" : "Download from GitHub"}
								</Button>
							</div>
						</section>
					)}

					<section className="flex flex-col gap-3" data-testid="today-review">
						<h2 className="text-xs uppercase tracking-widest text-muted-foreground">Today&apos;s review</h2>
						{pack.today.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing is due. After you study a chapter, grade the recall. That schedules the next review.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{pack.today.map((item) => (
									<li key={`${item.courseId}:${item.chapterId}:${item.conceptId ?? "chapter"}`} className="rounded-xl border px-3 py-3">
										<ReviewRow item={item} busy={busy} onGrade={(grade) => void postJson(
											`/api/courses/${encodeURIComponent(item.courseId)}/chapters/${encodeURIComponent(item.chapterId)}/review`,
											{ grade, ...(item.conceptId ? { conceptId: item.conceptId } : {}) },
											`grade:${item.chapterId}:${item.conceptId ?? "chapter"}:${grade}`,
										)} onPractice={() => void openChapter(item.courseId, item.chapterId, "practice", item.conceptId ?? undefined)} />
									</li>
								))}
							</ul>
						)}
					</section>

					{pack.courses.length === 0 ? (
						<p className="text-sm text-muted-foreground">No course is imported yet.</p>
					) : (
						pack.courses.map((course) => (
							<CourseSection
								key={course.id}
								course={course}
								busy={busy}
								onReimport={() => void importNotes({ courseId: course.id, extractGraph }, `reimport:${course.id}`)}
								onOpen={(chapterId, kind, conceptId) => void openChapter(course.id, chapterId, kind, conceptId)}
								onGrade={(chapterId, grade, conceptId) => void postJson(
									`/api/courses/${encodeURIComponent(course.id)}/chapters/${encodeURIComponent(chapterId)}/review`,
									{ grade, ...(conceptId ? { conceptId } : {}) },
									`grade:${chapterId}:${conceptId ?? "chapter"}:${grade}`,
								)}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function ReviewRow({
	item,
	busy,
	onGrade,
	onPractice,
}: {
	item: ReviewQueueItem;
	busy: string | null;
	onGrade: (grade: number) => void;
	onPractice: () => void;
}) {
	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<p className="text-sm text-foreground">{item.label}</p>
				<p className="text-xs text-muted-foreground">{item.conceptId ? item.chapterTitle : item.courseTitle} · due {item.due}</p>
			</div>
			<div className="flex flex-wrap gap-2">
				{GRADES.map((choice) => (
					<Button key={choice.grade} type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onGrade(choice.grade)}>
						{choice.label}
					</Button>
				))}
				<Button type="button" size="sm" disabled={busy !== null} onClick={onPractice}>Practice</Button>
			</div>
		</div>
	);
}

function CourseSection({
	course,
	busy,
	onReimport,
	onOpen,
	onGrade,
}: {
	course: CourseView;
	busy: string | null;
	onReimport: () => void;
	onOpen: (chapterId: string, kind: "teach" | "practice", conceptId?: string) => void;
	onGrade: (chapterId: string, grade: number, conceptId?: string) => void;
}) {
	const origin = course.origin.kind === "local" ? course.origin.path : `${course.origin.repo}@${course.origin.ref}`;
	return (
		<section className="flex flex-col gap-3" data-testid="course-section">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<h2 className="text-lg text-foreground">{course.title}</h2>
					<p className="break-all text-xs text-muted-foreground">{origin}</p>
				</div>
				<Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onReimport}>
					{busy === `reimport:${course.id}` ? "Checking…" : "Check for updates"}
				</Button>
			</div>
			<ul className="flex flex-col gap-2">
				{course.chapters.map((chapter) => (
					<li key={chapter.id} data-testid="chapter-row" data-chapter-id={chapter.id} className="rounded-xl border px-3 py-3">
						<ChapterRow chapter={chapter} busy={busy} onOpen={(kind, conceptId) => onOpen(chapter.id, kind, conceptId)} onGrade={(grade, conceptId) => onGrade(chapter.id, grade, conceptId)} />
					</li>
				))}
			</ul>
		</section>
	);
}

function ChapterRow({
	chapter,
	busy,
	onOpen,
	onGrade,
}: {
	chapter: ChapterView;
	busy: string | null;
	onOpen: (kind: "teach" | "practice", conceptId?: string) => void;
	onGrade: (grade: number, conceptId?: string) => void;
}) {
	const activeConcepts = chapter.concepts.filter((concept) => !concept.retired);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<p className="text-sm text-foreground">{chapter.order.toString().padStart(2, "0")} · {chapter.title}</p>
					<p className="text-xs text-muted-foreground">
						<span data-testid="chapter-status" data-status={chapter.status}>{STATUS_LABEL[chapter.status]}</span>
						{chapter.present ? "" : " · removed upstream"}
						{chapter.inGraph ? " · in the knowledge graph" : ""}
						{chapter.imageCount > 0 ? ` · ${chapter.imageCount} ${chapter.imageCount === 1 ? "image" : "images"}` : ""}
						{chapter.due ? ` · next ${chapter.due}` : ""}
					</p>
					{chapter.graphError && <p className="mt-1 text-xs text-muted-foreground">{chapter.graphError}</p>}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button type="button" size="sm" data-testid="study-chapter" disabled={busy !== null || !chapter.present} onClick={() => onOpen("teach")}>Study</Button>
					<Button type="button" size="sm" variant="outline" data-testid="practice-chapter" disabled={busy !== null || !chapter.present} onClick={() => onOpen("practice")}>Practice</Button>
				</div>
			</div>
			<div className="flex flex-wrap gap-2">
				{GRADES.map((choice) => (
					<Button key={choice.grade} type="button" size="sm" variant="ghost" disabled={busy !== null} data-testid={`grade-${choice.label.toLowerCase()}`} onClick={() => onGrade(choice.grade)}>
						{choice.label}
					</Button>
				))}
			</div>
			{activeConcepts.length > 0 && (
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">{activeConcepts.length} headings</summary>
					<ul className="mt-2 flex flex-col gap-2">
						{activeConcepts.map((concept) => (
							<li key={concept.id} className="flex flex-col gap-2 rounded-md px-2 py-2 sm:flex-row sm:items-center sm:justify-between">
								<span className="text-foreground">{concept.title} <span className="text-xs text-muted-foreground">{STATUS_LABEL[concept.status]}</span></span>
								<span className="flex flex-wrap gap-2">
									<Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onGrade(4, concept.id)}>Good</Button>
									<Button type="button" size="sm" variant="ghost" disabled={busy !== null || !chapter.present} onClick={() => onOpen("practice", concept.id)}>Practice</Button>
								</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
