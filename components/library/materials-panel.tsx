"use client";

import { useState } from "react";
import { LibraryIcon, LoaderCircleIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatAttachmentsSnapshot } from "@/src/core";
import { LibraryPicker } from "./library-picker";
import { FileStatus, FormatGlyph, ItemGlyph, TagBadge } from "./library-shared";

/**
 * THE MATERIALS PANEL (course library wave, owner ruling 2026-10-29: view
 * + attach/detach only — uploading, tagging, and reorganizing live on the
 * Library page). A right-hand drawer in the chat view: the attached items,
 * every file they put in scope with its import/summary state, the picker,
 * and per-item detach.
 */
export function MaterialsPanel({
	snapshot,
	reading,
	error,
	onSetAttachments,
	onClose,
}: {
	snapshot: ChatAttachmentsSnapshot | null;
	/** Summaries are being written — the next turn waits for them. */
	reading: boolean;
	error: string | null;
	onSetAttachments: (ids: string[]) => void;
	onClose: () => void;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const attachments = snapshot?.attachments ?? [];
	return (
		<aside
			data-testid="materials-panel"
			aria-label="Course materials"
			className="flex w-80 shrink-0 flex-col border-l border-border bg-background"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
				<LibraryIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				<span className="flex-1 text-xs uppercase tracking-widest text-muted-foreground">Materials</span>
				<Button variant="ghost" size="icon-xs" aria-label="Close materials" onClick={onClose}>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
			<MaterialsPanelBody
				snapshot={snapshot}
				reading={reading}
				error={error}
				onDetach={(id) => onSetAttachments(attachments.filter((a) => a !== id))}
				onOpenPicker={() => setPickerOpen(true)}
			/>
			<LibraryPicker
				open={pickerOpen}
				initial={attachments}
				onClose={() => setPickerOpen(false)}
				onConfirm={(ids) => {
					setPickerOpen(false);
					onSetAttachments(ids);
				}}
				confirmLabel="Save"
			/>
		</aside>
	);
}

/** The panel's pure body (SSR pins). */
export function MaterialsPanelBody({
	snapshot,
	reading,
	error,
	onDetach,
	onOpenPicker,
}: {
	snapshot: ChatAttachmentsSnapshot | null;
	reading: boolean;
	error: string | null;
	onDetach: (id: string) => void;
	onOpenPicker: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			{!snapshot && !error && <p className="text-xs text-muted-foreground">Loading…</p>}
			{reading && (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="materials-reading">
					<LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />
					Summarizing new materials — your next message waits for this.
				</p>
			)}
			{snapshot && snapshot.items.length === 0 && (
				<p className="text-xs text-muted-foreground" data-testid="materials-empty">
					Nothing attached. Attach course folders or files and the teacher will plan from the lectures and work toward the quizzes and
					tests.
				</p>
			)}
			{snapshot && snapshot.items.length > 0 && (
				<ul className="flex flex-col gap-1" data-testid="materials-items">
					{snapshot.items.map((item) => (
						<li key={item.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/40">
							<ItemGlyph item={{ kind: item.kind }} />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm" title={item.path}>
									{item.name}
								</span>
								{item.kind === "folder" && (
									<span className="block text-[11px] text-muted-foreground">
										{item.fileCount} file{item.fileCount === 1 ? "" : "s"}
									</span>
								)}
							</span>
							{item.tag && <TagBadge tag={item.tag} />}
							<Button variant="ghost" size="icon-xs" aria-label={`Detach ${item.name}`} title="Detach" onClick={() => onDetach(item.id)}>
								<XIcon aria-hidden="true" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<Button variant="outline" size="sm" data-testid="materials-attach" onClick={onOpenPicker} className="self-start">
				<PaperclipIcon aria-hidden="true" />
				Attach…
			</Button>
			{snapshot && snapshot.files.length > 0 && (
				<div className="border-t border-border/60 pt-3">
					<p className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">In scope ({snapshot.files.length})</p>
					<ul className="flex flex-col gap-1" data-testid="materials-files">
						{snapshot.files.map((f) => (
							<li key={f.id} className="flex items-center gap-2 px-1.5 py-0.5">
								<FormatGlyph format={f.format} className="size-3.5" />
								<span className="min-w-0 flex-1 truncate text-xs" title={f.path}>
									{f.name}
								</span>
								<FileStatus status={f.status} summary={f.summary} />
								{f.tag && <TagBadge tag={f.tag} />}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
