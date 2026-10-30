"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import type { CourseLessonContext } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The course-lesson card (courses plan, 2026-10-30): message[0] of a
 * session started from a course lesson — the graph-context card's
 * sibling. Scaffolding, collapsed by default; expand reveals the lesson
 * goal, its neighbors in the course, and the guide summary the model
 * received. Links back to the course page.
 */
export function CourseLessonCard({ data }: { data: CourseLessonContext }) {
	const [open, setOpen] = useState(false);
	if (!data) return null;
	return (
		<div data-testid="course-lesson-card" className="my-1">
			<button
				type="button"
				data-testid="course-lesson-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Course lesson</span>
				<span className="min-w-0 flex-1 truncate">
					{data.lessonTitle} · {data.courseTitle}
				</span>
			</button>
			{open && (
				<div data-testid="course-lesson-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs leading-relaxed">
					<div>
						<span className="font-medium text-foreground/80">Lesson goal</span>
						<span className="text-muted-foreground"> — {data.lessonGoal}</span>
					</div>
					{data.buildsOn.length > 0 && (
						<div className="text-muted-foreground">Builds on: {data.buildsOn.join("; ")}</div>
					)}
					{data.leadsInto.length > 0 && (
						<div className="text-muted-foreground">Leads into: {data.leadsInto.join("; ")}</div>
					)}
					<div className="whitespace-pre-wrap text-muted-foreground">{data.guideSummary}</div>
					<Link href={`/course/${data.courseId}`} className="inline-block text-foreground/80 underline underline-offset-2 hover:text-foreground">
						Open course
					</Link>
				</div>
			)}
		</div>
	);
}
