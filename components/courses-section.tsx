"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { CourseListItem } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The sidebar's Courses section (courses plan, 2026-10-30): every course
 * with its derived progress (done/total), a Draft tag, and a dot when the
 * course is behind schedule. Push-refreshed like the session list:
 * courses-changed for list-shape writes, turn-settled / chats-changed
 * because a lesson's done-ness derives from its sessions. Height-capped so
 * the session list keeps the room.
 */
export function CoursesSection() {
	const [courses, setCourses] = useState<CourseListItem[] | null>(null);
	const pathname = usePathname();
	const router = useRouter();

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/courses", { cache: "no-store" });
			const d = (await res.json()) as { courses: CourseListItem[] };
			setCourses(d.courses);
		} catch {
			setCourses((prev) => prev ?? []);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("courses-changed", schedule);
	useServerEvent("chats-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerResync(() => void refresh());

	if (!courses || courses.length === 0) return null;
	return (
		<div className="mx-3 mb-3" data-testid="courses-section">
			<div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Courses</div>
			<div className="max-h-40 overflow-y-auto">
				{courses.map((c) => (
					<button
						key={c.id}
						type="button"
						data-testid={`course-row-${c.id}`}
						onClick={() => router.push(`/course/${c.id}`)}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
							pathname === `/course/${c.id}` ? "bg-accent text-foreground" : "text-muted-foreground",
						)}
					>
						{c.health === "behind" && (
							<span aria-label="Behind schedule" title="Behind schedule" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
						)}
						<span className="min-w-0 flex-1 truncate">{c.title}</span>
						{c.status === "draft" ? (
							<span className="shrink-0 rounded-sm border border-border px-1 text-[10px] uppercase tracking-wider">Draft</span>
						) : (
							<span className="shrink-0 font-ui text-[11px] tabular-nums">
								{c.doneCount}/{c.lessonCount}
							</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
