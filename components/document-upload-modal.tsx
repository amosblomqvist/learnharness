"use client";

import { useState, useRef, type DragEvent } from "react";
import {
	UploadIcon,
	XIcon,
	FileTextIcon,
	BookOpenIcon,
	GraduationCapIcon,
	Loader2Icon,
	CheckCircle2Icon,
} from "lucide-react";
import type { DocumentAttachmentMeta, DocumentCategory } from "@/src/core";

export interface UploadModalProps {
	isOpen: boolean;
	onClose: () => void;
	/** If chatId is provided, uploads directly to that chat; otherwise uses /api/documents/parse */
	chatId?: string;
	onDocumentsAdded: (docs: DocumentAttachmentMeta[]) => void;
}

export function DocumentUploadModal({
	isOpen,
	onClose,
	chatId,
	onDocumentsAdded,
}: UploadModalProps) {
	const [category, setCategory] = useState<DocumentCategory>("lecture");
	const [isDragging, setIsDragging] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [successMsg, setSuccessMsg] = useState<string | null>(null);
	const [progressMsg, setProgressMsg] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	if (!isOpen) return null;

	const handleFiles = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setLoading(true);
		setError(null);
		setSuccessMsg(null);
		setProgressMsg(null);

		try {
			const fileList = Array.from(files);
			const endpoint = chatId ? `/api/chats/${chatId}/documents` : "/api/documents/parse";
			const allAdded: DocumentAttachmentMeta[] = [];

			for (let i = 0; i < fileList.length; i++) {
				const file = fileList[i]!;
				setProgressMsg(
					fileList.length > 1
						? `Đang tải lên và xử lý (${i + 1}/${fileList.length}): ${file.name}...`
						: `Đang trích xuất nội dung: ${file.name}...`,
				);

				const form = new FormData();
				form.append("category", category);
				form.append("files", file);

				const res = await fetch(endpoint, {
					method: "POST",
					body: form,
				});

				if (!res.ok) {
					const errData = await res.json().catch(() => ({}));
					throw new Error(errData.error || `Upload thất bại file "${file.name}" (HTTP ${res.status})`);
				}

				const data = await res.json();
				const added: DocumentAttachmentMeta[] = data.documents || [];
				allAdded.push(...added);
			}

			setSuccessMsg(`Đã tải lên và xử lý thành công ${allAdded.length} tài liệu!`);
			onDocumentsAdded(allAdded);
			setTimeout(() => {
				onClose();
				setSuccessMsg(null);
				setProgressMsg(null);
			}, 800);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const onDragOver = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragging(true);
	};

	const onDragLeave = () => {
		setIsDragging(false);
	};

	const onDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragging(false);
		void handleFiles(e.dataTransfer.files);
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
			<div className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-2xl transition-all">
				<div className="flex items-center justify-between pb-3 border-b">
					<div className="flex items-center gap-2">
						<UploadIcon className="size-5 text-primary" />
						<h2 className="text-base font-semibold">Tải lên Tài liệu & Đề thi</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-5" />
					</button>
				</div>

				<div className="mt-4 space-y-4">
					{/* Category selection */}
					<div>
						<label className="text-xs font-medium text-muted-foreground block mb-2">
							Chọn loại tài liệu bạn muốn tải:
						</label>
						<div className="grid grid-cols-2 gap-2">
							<button
								type="button"
								onClick={() => setCategory("lecture")}
								className={`flex items-center gap-2.5 rounded-xl border p-3 text-left text-xs transition-all ${
									category === "lecture"
										? "border-primary bg-primary/10 font-semibold text-primary shadow-xs"
										: "border-border hover:bg-accent/50 text-muted-foreground"
								}`}
							>
								<BookOpenIcon className="size-4 shrink-0" />
								<div>
									<div className="font-medium text-foreground">Tài liệu bài giảng</div>
									<div className="text-[11px] text-muted-foreground">Slide PowerPoint, giáo trình, bài giảng</div>
								</div>
							</button>

							<button
								type="button"
								onClick={() => setCategory("exam")}
								className={`flex items-center gap-2.5 rounded-xl border p-3 text-left text-xs transition-all ${
									category === "exam"
										? "border-amber-500 bg-amber-500/10 font-semibold text-amber-600 dark:text-amber-400 shadow-xs"
										: "border-border hover:bg-accent/50 text-muted-foreground"
								}`}
							>
								<GraduationCapIcon className="size-4 shrink-0" />
								<div>
									<div className="font-medium text-foreground">Đề thi / Form đề thi</div>
									<div className="text-[11px] text-muted-foreground">Đề thi các năm, bài tập mẫu, đề cương</div>
								</div>
							</button>
						</div>
					</div>

					{/* Drag and Drop Zone */}
					<div
						onDragOver={onDragOver}
						onDragLeave={onDragLeave}
						onDrop={onDrop}
						onClick={() => !loading && fileInputRef.current?.click()}
						className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
							isDragging
								? "border-primary bg-primary/5"
								: "border-border/80 hover:border-primary/60 hover:bg-accent/30"
						} ${loading ? "pointer-events-none opacity-60" : ""}`}
					>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept=".pdf,.pptx,.docx,.txt,.md"
							className="hidden"
							onChange={(e) => void handleFiles(e.target.files)}
						/>
						{loading ? (
							<div className="flex flex-col items-center gap-2 px-2">
								<Loader2Icon className="size-8 animate-spin text-primary" />
								<p className="text-xs font-medium text-foreground max-w-sm truncate">
									{progressMsg || "Đang trích xuất nội dung và phân tích tài liệu..."}
								</p>
							</div>
						) : successMsg ? (
							<div className="flex flex-col items-center gap-2 text-emerald-600 dark:text-emerald-400">
								<CheckCircle2Icon className="size-8" />
								<p className="text-xs font-medium">{successMsg}</p>
							</div>
						) : (
							<div className="flex flex-col items-center gap-2">
								<div className="rounded-full bg-accent p-3 text-muted-foreground">
									<FileTextIcon className="size-6 text-primary" />
								</div>
								<div>
									<p className="text-xs font-medium text-foreground">
										Kéo thả file vào đây hoặc <span className="text-primary underline">chọn từ máy</span>
									</p>
									<p className="mt-1 text-[11px] text-muted-foreground">
										Hỗ trợ PDF (.pdf), Slide PowerPoint (.pptx), Word (.docx), Văn bản (.txt, .md)
									</p>
								</div>
							</div>
						)}
					</div>

					{error && (
						<div className="rounded-lg bg-red-500/10 p-2.5 text-xs text-red-500">
							{error}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
