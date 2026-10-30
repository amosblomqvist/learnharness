"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileTextIcon, XIcon } from "lucide-react";
import { localDate } from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * New course (courses plan, 2026-10-30): a guide (upload OR paste), an
 * optional goal, a deadline, and free-text availability notes → Generate.
 * The planner runs inside the request (spinner + Cancel aborts it); the
 * result is a persisted DRAFT, reviewed on its own course page.
 */
export function CourseNew() {
	const router = useRouter();
	const [file, setFile] = useState<File | null>(null);
	const [pasted, setPasted] = useState("");
	const [goal, setGoal] = useState("");
	const [deadline, setDeadline] = useState("");
	const [notes, setNotes] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ message: string; courseId?: string } | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const today = localDate();

	const hasGuide = file !== null || pasted.trim().length > 0;
	const canGenerate = hasGuide && deadline >= today && !busy;

	async function generate() {
		const form = new FormData();
		if (file) form.set("file", file);
		else form.set("guideText", pasted);
		form.set("goal", goal);
		form.set("deadline", deadline);
		form.set("availabilityNotes", notes);
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/courses", { method: "POST", body: form, signal: controller.signal });
			const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; courseId?: string };
			if (!res.ok || !body.id) {
				setError({ message: body.error ?? "Couldn’t plan the course.", ...(body.courseId ? { courseId: body.courseId } : {}) });
				return;
			}
			router.push(`/course/${body.id}`);
		} catch (err) {
			if ((err as Error).name !== "AbortError") setError({ message: "Couldn’t reach the server." });
		} finally {
			abortRef.current = null;
			setBusy(false);
		}
	}

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="font-ui text-xs uppercase tracking-wider text-muted-foreground">New course</span>
			</TopBar>
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
					<section className="flex flex-col gap-2">
						<label className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Guide</label>
						{file ? (
							<div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="course-guide-file">
								<FileTextIcon className="size-4 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{file.name}</span>
								<button type="button" aria-label="Remove file" onClick={() => setFile(null)} className="text-muted-foreground hover:text-foreground">
									<XIcon className="size-4" />
								</button>
							</div>
						) : (
							<>
								<Textarea
									data-testid="course-guide-paste"
									value={pasted}
									onChange={(e) => setPasted(e.target.value)}
									placeholder="Paste your guide’s markdown here…"
									className="min-h-40 font-mono text-xs"
								/>
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<span>or</span>
									<Button type="button" variant="outline" size="xs" onClick={() => fileInputRef.current?.click()}>
										Upload a .md file
									</Button>
								</div>
							</>
						)}
						<input
							ref={fileInputRef}
							type="file"
							accept=".md,.markdown,.txt,text/markdown,text/plain"
							className="hidden"
							data-testid="course-guide-upload"
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) setFile(f);
								e.target.value = "";
							}}
						/>
					</section>

					<section className="flex flex-col gap-2">
						<label htmlFor="course-goal" className="font-ui text-xs uppercase tracking-wider text-muted-foreground">
							Goal <span className="normal-case tracking-normal text-muted-foreground/70">(optional — inferred from the guide if blank)</span>
						</label>
						<Input id="course-goal" data-testid="course-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Pass the exam on chapter 3" />
					</section>

					<section className="flex flex-col gap-2">
						<label htmlFor="course-deadline" className="font-ui text-xs uppercase tracking-wider text-muted-foreground">
							Deadline
						</label>
						<Input id="course-deadline" data-testid="course-deadline" type="date" min={today} value={deadline} onChange={(e) => setDeadline(e.target.value)} className="w-48" />
					</section>

					<section className="flex flex-col gap-2">
						<label htmlFor="course-notes" className="font-ui text-xs uppercase tracking-wider text-muted-foreground">
							Availability <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>
						</label>
						<Textarea
							id="course-notes"
							data-testid="course-notes"
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="e.g. Weekends only, about 2 hours each day"
							className="min-h-16"
						/>
					</section>

					<div className="flex items-center gap-3">
						{busy ? (
							<>
								<span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="course-planning">
									<BrailleSpinner /> Planning your course — this can take a minute…
								</span>
								<Button type="button" variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
									Cancel
								</Button>
							</>
						) : (
							<Button type="button" data-testid="course-generate" disabled={!canGenerate} onClick={() => void generate()}>
								Generate course
							</Button>
						)}
					</div>
					{error && (
						<p className="text-sm text-destructive" data-testid="course-error">
							{error.message}
							{error.courseId && (
								<>
									{" "}
									<Link href={`/course/${error.courseId}`} className="underline underline-offset-2">
										Open the draft
									</Link>
								</>
							)}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
