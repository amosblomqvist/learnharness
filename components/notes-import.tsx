"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { WaypointsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { IMPORT_ACCEPT } from "@/lib/notes-import-limits.ts";
import { useInteractionLayer, useInteractionLayers } from "@/components/interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { createNotesImportQueue, EMPTY_IMPORT_QUEUE, notesPath, type PendingNoteMove } from "./notes-import-queue";

export { MAX_IMPORT_BYTES } from "@/lib/notes-import-limits.ts";
export { notesPath } from "./notes-import-queue";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	previousPath?: string;
	outcome: "completed" | "skipped" | "confirm-move" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
	notice?: string;
}

/** Contributor's strict attribution: validate the complete response before
 * applying any row, even when several files have identical basenames. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Check the graph before retrying.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== notesPath(files[r.requestIndex]!)) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "skipped", "confirm-move", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed" || r.outcome === "skipped")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.outcome === "skipped" && typeof r.notice !== "string") throw invalid();
		if (r.outcome === "confirm-move" && (typeof r.previousPath !== "string" || !r.previousPath)) throw invalid();
		if (r.outcome === "completed" && !r.stats) throw invalid();
		if (!r.ok && r.outcome !== "confirm-move" && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider", "notice"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[], decision?: { moveFrom: string } | { keepCopy: true }): Promise<NotesImportResult[]> {
	const form = new FormData();
	if (files.length && files.every((file) => file.webkitRelativePath)) form.set("mode", "folder");
	if (decision) {
		if ("moveFrom" in decision) form.set("moveFrom", decision.moveFrom);
		else form.set("keepCopy", "true");
	}
	for (const file of files) {
		form.append("files", file);
		form.append("paths", notesPath(file));
	}
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Check the graph before retrying."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}${/[.!?]$/.test(detail) ? "" : "."} Check the graph before retrying.`);
	}
	return parseNotesImportResults(body, files);
}

// Client module singleton: shared by both home views and successive selections.
// SSR never appends Files, and uses the immutable empty server snapshot.
const pageImportQueue = createNotesImportQueue(postNotesImport);
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const snapshot = useSyncExternalStore(pageImportQueue.subscribe, pageImportQueue.getSnapshot, () => EMPTY_IMPORT_QUEUE);
	const latest = useRef(callbacks);
	latest.current = callbacks;
	const seenCompletion = useRef(snapshot.completion);
	useEffect(() => {
		if (seenCompletion.current !== snapshot.completion) {
			seenCompletion.current = snapshot.completion;
			latest.current.onFinish?.();
		}
	}, [snapshot.completion]);
	return {
		errors: snapshot.errors, notices: snapshot.notices, moves: snapshot.moves, importing: snapshot.importing,
		onImportFiles: (files: FileList | null) => {
			if (!files || files.length === 0) return;
			latest.current.onStart?.();
			pageImportQueue.append(Array.from(files));
		},
	};
}

/** PR198's shared Files / Folder native picker. Unlike the donor, it remains
 * available while work is running; later selections join the SAME queue. */
export function NotesImportControl({ importing, onImportFiles }: { importing: boolean; onImportFiles: (files: FileList | null) => void }) {
	const filesRef = useRef<HTMLInputElement>(null);
	const folderRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const hintId = useId();
	const onChange = (event: ChangeEvent<HTMLInputElement>) => {
		onImportFiles(event.target.files);
		event.target.value = "";
	};
	const rootRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();
	const popupLayer = useInteractionLayer({ kind: "popup", enabled: open, rootRef: panelRef, anchorRef: rootRef,
		onClose: () => { setOpen(false); return "closed"; } });
	const choices = [["Files", filesRef], ["Folder", folderRef]] as const;
	return (
		<div ref={rootRef} className="relative shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur"
			onBlur={(event) => { if (interactions.isElementEligible(panelRef.current) && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
			<input ref={filesRef} type="file" multiple accept={IMPORT_ACCEPT} className="hidden" onChange={onChange} />
			<input ref={folderRef} type="file" {...{ webkitdirectory: "" }} className="hidden" onChange={onChange} />
			<Hint label="Extract files into the graph" side="bottom">
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="import-notes"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
					<WaypointsIcon className="size-3" />{importing ? "Extracting…" : "Extract files…"}
				</button>
			</Hint>
			{open && (
				<div ref={panelRef} role="menu" aria-label="Extract files into the graph" aria-describedby={hintId} style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }} className="absolute right-0 top-full mt-1 w-52 rounded-lg border bg-card p-1 shadow-lg">
					<div role="none"><p id={hintId} className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">For lessons, attach material to a session instead.</p></div>
					{choices.map(([label, input]) => <button key={label} type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); input.current?.click(); }}>{label}</button>)}
				</div>
			)}
		</div>
	);
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => <p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-error">{error}</p>)}</>;
}
export function NotesImportNotices({ notices, moves }: { notices: readonly string[]; moves?: readonly PendingNoteMove[] }) {
	return <>
		{moves?.map((move) => <div key={move.index} role="group" aria-label={`Resolve import of ${move.to}`} className="max-w-sm rounded-lg border bg-card p-2 text-xs">
			<p className="break-words">“{move.to}” has the same contents as “{move.from}”. Did this file move?</p>
			<div className="mt-2 flex flex-wrap gap-1">
				{([["move", "Keep source history"], ["copy", "Extract as copy"], ["skip", "Skip file"]] as const).map(([choice, label]) =>
					<button key={choice} type="button" className="rounded border px-2 py-1 hover:bg-accent" onClick={() => move.choose(choice)}>{label}</button>)}
			</div>
		</div>)}
		{notices.map((notice, i) => <p key={i} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{notice}</p>)}
	</>;
}
