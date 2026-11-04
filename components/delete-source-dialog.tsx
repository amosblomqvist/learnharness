"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "./backdrop-dismiss";
import type { SourceEntry, SourceFolder } from "@/src/core";

export function DeleteSourceBody({ sources, folders, deleteSessions, onDeleteSessions, busy, failure, onClose, onRun }: {
	sources: SourceEntry[]; folders: SourceFolder[]; deleteSessions: boolean; onDeleteSessions: (checked: boolean) => void;
	busy: boolean; failure: string; onClose: () => void; onRun: () => void;
}) {
	const chats = sources.filter((s) => s.kind === "chat");
	const names = [...sources.map((s) => s.label ?? s.id), ...folders.map((f) => f.name)];
	return <div role="dialog" aria-modal="true" aria-label="Delete sources" data-testid="delete-source-dialog"
		onClick={(e) => e.stopPropagation()} className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
		<h2 className="text-sm font-semibold text-destructive">Delete selected sources and folders?</h2>
		<p className="mt-1.5 font-mono text-sm" data-testid="source-deletion-names">{names.slice(0, 8).join(", ")}{names.length > 8 ? `, and ${names.length - 8} more` : ""}</p>
		{sources.length > 0 && <p className="mt-2 text-sm text-muted-foreground" data-testid="source-deletion-contributions">
			Removes these sources’ contributions to propositions and reasoning chains. Knowledge supported by other sources survives; knowledge supported only by these sources is removed.
		</p>}
		<p className="mt-2 text-xs text-muted-foreground">Imported source records are removed, but original files on disk are never changed. Selected folders are removed only when empty; folders needed by kept sessions remain.</p>
		{chats.length > 0 && <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
			<input type="checkbox" data-testid="delete-source-sessions" checked={deleteSessions} disabled={busy}
				onChange={(e) => onDeleteSessions(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
			<span className="min-w-0"><span className="block text-sm">Also delete the {chats.length} selected {chats.length === 1 ? "session" : "sessions"}</span>
				<span className="mt-1 block text-xs text-muted-foreground">Unchecked, conversations stay in their current folders and can be extracted again. Either way, their graph contributions and extraction coverage are cleared. Checking this also permanently deletes their messages and background jobs.</span>
			</span>
		</label>}
		{failure && <p role="alert" data-testid="source-delete-failure" className="mt-3 text-xs text-foreground">{failure}</p>}
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" data-testid="source-delete-cancel" disabled={busy} onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">Cancel</button>
			<button type="button" data-testid="source-delete-confirm" disabled={busy} onClick={onRun} className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40">{busy ? "Deleting…" : failure ? "Try again" : "Delete"}</button>
		</div>
	</div>;
}

export function DeleteSourceDialog({ open, sources, folders, onDelete, onClose }: {
	open: boolean; sources: SourceEntry[]; folders: SourceFolder[]; onDelete: (deleteSessions: boolean) => Promise<void>; onClose: () => void;
}) {
	const [deleteSessions, setDeleteSessions] = useState(false), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
	useEffect(() => { if (!open) { setDeleteSessions(false); setBusy(false); setFailure(""); } }, [open]);
	const backdrop = useBackdropDismiss(() => { if (!busy) onClose(); });
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } };
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, busy, onClose]);
	if (!open) return null;
	const run = async () => {
		if (busy) return;
		setBusy(true); setFailure("");
		try { await onDelete(deleteSessions); onClose(); }
		catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	};
	return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
		<DeleteSourceBody sources={sources} folders={folders} deleteSessions={deleteSessions} onDeleteSessions={setDeleteSessions}
			busy={busy} failure={failure} onClose={onClose} onRun={() => { void run(); }} />
	</div>, document.body);
}
