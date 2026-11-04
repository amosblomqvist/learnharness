"use client";

import { FileTextIcon, XIcon, BookOpenIcon, GraduationCapIcon } from "lucide-react";
import type { DocumentAttachmentMeta } from "@/src/core";

export function DocumentBadge({
	doc,
	onRemove,
}: {
	doc: Pick<DocumentAttachmentMeta, "id" | "fileName" | "category" | "summary">;
	onRemove?: () => void;
}) {
	const isLecture = doc.category === "lecture";
	return (
		<div
			className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
				isLecture
					? "border-blue-500/30 bg-blue-50/50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
					: "border-amber-500/30 bg-amber-50/50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
			}`}
		>
			{isLecture ? (
				<BookOpenIcon className="size-3 shrink-0" />
			) : (
				<GraduationCapIcon className="size-3 shrink-0" />
			)}
			<span className="max-w-[140px] truncate font-medium" title={doc.fileName}>
				{doc.fileName}
			</span>
			{doc.summary?.pageOrSlideCount ? (
				<span className="text-[10px] opacity-75">
					({doc.summary.pageOrSlideCount} {isLecture ? "p/slide" : "p"})
				</span>
			) : null}
			{onRemove && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
					title="Xóa tài liệu này"
				>
					<XIcon className="size-3" />
				</button>
			)}
		</div>
	);
}

export function DocumentBadgeList({
	docs,
	onRemove,
}: {
	docs: readonly Pick<DocumentAttachmentMeta, "id" | "fileName" | "category" | "summary">[];
	onRemove?: (id: string) => void;
}) {
	if (docs.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 py-1">
			{docs.map((doc) => (
				<DocumentBadge
					key={doc.id}
					doc={doc}
					onRemove={onRemove ? () => onRemove(doc.id) : undefined}
				/>
			))}
		</div>
	);
}
