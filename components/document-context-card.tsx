"use client";

import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, BookOpenIcon, GraduationCapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocumentAttachmentMeta } from "@/src/core";

export interface DocumentContextData {
	documents: DocumentAttachmentMeta[];
}

export function DocumentContextCard({ data }: { data: DocumentContextData }) {
	const [open, setOpen] = useState(false);
	const documents = data?.documents ?? [];

	const lectures = documents.filter((d) => d.category === "lecture");
	const exams = documents.filter((d) => d.category === "exam");

	const summaryParts: string[] = [];
	if (lectures.length > 0) {
		summaryParts.push(`${lectures.length} bài giảng/slide`);
	}
	if (exams.length > 0) {
		summaryParts.push(`${exams.length} đề thi/form đề`);
	}
	const summaryText = summaryParts.join(" · ") || `${documents.length} tài liệu`;

	return (
		<div data-testid="document-context-card" className="my-1.5">
			<button
				type="button"
				data-testid="document-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-left text-xs text-foreground/80 transition-colors hover:bg-primary/10 hover:text-foreground"
			>
				<ChevronRightIcon
					aria-hidden="true"
					className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
				/>
				<GraduationCapIcon className="size-4 shrink-0 text-primary" />
				<span className="font-medium text-foreground">Tài liệu học tập & Đề thi</span>
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					({summaryText})
				</span>
			</button>

			{open && (
				<div
					data-testid="document-context-body"
					className="mt-1 space-y-2.5 rounded-lg border border-dashed border-border/80 bg-card/60 p-3.5 text-xs shadow-xs"
				>
					{lectures.length > 0 && (
						<div>
							<div className="mb-1.5 flex items-center gap-1.5 font-semibold text-primary/90">
								<BookOpenIcon className="size-3.5" />
								<span>Tài liệu bài giảng của thầy cô:</span>
							</div>
							<div className="space-y-1 pl-4">
								{lectures.map((doc) => (
									<div key={doc.id} className="flex items-center gap-2 text-muted-foreground">
										<FileTextIcon className="size-3 shrink-0" />
										<span className="font-medium text-foreground">{doc.fileName}</span>
										{doc.summary?.pageOrSlideCount ? (
											<span className="text-[11px] text-muted-foreground/80">
												({doc.summary.pageOrSlideCount} trang/slide)
											</span>
										) : null}
									</div>
								))}
							</div>
						</div>
					)}

					{exams.length > 0 && (
						<div>
							<div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-500/90 dark:text-amber-400">
								<GraduationCapIcon className="size-3.5" />
								<span>Đề thi & Form đề thi các năm (Mục tiêu làm chủ):</span>
							</div>
							<div className="space-y-1 pl-4">
								{exams.map((doc) => (
									<div key={doc.id} className="flex items-center gap-2 text-muted-foreground">
										<FileTextIcon className="size-3 shrink-0" />
										<span className="font-medium text-foreground">{doc.fileName}</span>
										{doc.summary?.pageOrSlideCount ? (
											<span className="text-[11px] text-muted-foreground/80">
												({doc.summary.pageOrSlideCount} trang)
											</span>
										) : null}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
