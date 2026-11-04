"use client";

import { useCallback, useRef, useState } from "react";
import { PenLineIcon, XIcon } from "lucide-react";
import { MAX_DRAWINGS, type DrawingAttachment, type DrawingStroke, type DrawingUpload } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { DrawingPad } from "@/components/drawing/drawing-pad";
import { rememberLocalDrawing } from "@/components/drawing/pad-state";
import { exportDrawingPng } from "@/components/drawing/strokes";

/**
 * A field's drawings (2026-11-04): up to MAX_DRAWINGS per submission,
 * each kept editable (strokes) beside its PNG export. The pen button
 * opens a new page; a chip reopens its page; Done with a blank page
 * attaches nothing (and clearing an existing one removes its chip).
 */
export interface DrawingAttachmentsApi {
	drawings: DrawingAttachment[];
	/** Mirrors `drawings` for submits resuming after an await. */
	ref: React.RefObject<DrawingAttachment[]>;
	editing: string | null;
	openNew: () => void;
	openExisting: (id: string) => void;
	finish: (strokes: DrawingStroke[]) => void;
	remove: (id: string) => void;
	clear: () => void;
	/** Put a set back (a refused send restoring its draft). */
	replace: (drawings: DrawingAttachment[]) => void;
}

let attachmentSeq = 0;

export function useDrawingAttachments(initial?: DrawingAttachment[]): DrawingAttachmentsApi {
	const [drawings, setDrawingsState] = useState<DrawingAttachment[]>(() => initial ?? []);
	const ref = useRef<DrawingAttachment[]>(drawings);
	// "new" = a fresh page; otherwise the attachment id being edited.
	const [editing, setEditing] = useState<string | null>(null);
	const setDrawings = useCallback((next: DrawingAttachment[]) => {
		ref.current = next;
		setDrawingsState(next);
	}, []);
	const openNew = useCallback(() => {
		if (ref.current.length < MAX_DRAWINGS) setEditing("new");
	}, []);
	const openExisting = useCallback((id: string) => setEditing(id), []);
	const editingRef = useRef(editing);
	editingRef.current = editing;
	const finish = useCallback(
		(strokes: DrawingStroke[]) => {
			const target = editingRef.current;
			setEditing(null);
			const exported = strokes.length > 0 ? exportDrawingPng(strokes) : null;
			const current = ref.current;
			if (target === "new" || target === null) {
				if (!exported || current.length >= MAX_DRAWINGS) return;
				setDrawings([...current, { id: `d${++attachmentSeq}`, strokes, ...exported }]);
				return;
			}
			setDrawings(
				exported
					? current.map((d) => (d.id === target ? { ...d, strokes, ...exported } : d))
					: current.filter((d) => d.id !== target),
			);
		},
		[setDrawings],
	);
	const remove = useCallback((id: string) => setDrawings(ref.current.filter((d) => d.id !== id)), [setDrawings]);
	const clear = useCallback(() => setDrawings([]), [setDrawings]);
	return { drawings, ref, editing, openNew, openExisting, finish, remove, clear, replace: setDrawings };
}

/** The wire form of a field's drawings — also registers each export for
 *  its optimistic thumbnail (pad-state's local keys). */
export function drawingUploads(drawings: readonly DrawingAttachment[]): DrawingUpload[] | undefined {
	if (drawings.length === 0) return undefined;
	for (const d of drawings) rememberLocalDrawing(d);
	return drawings.map((d) => ({ data: d.png }));
}

/** The pen button: opens a fresh page; disabled at the cap. */
export function DrawButton({ api, className }: { api: DrawingAttachmentsApi; className?: string }) {
	const full = api.drawings.length >= MAX_DRAWINGS;
	return (
		<Hint label={full ? `Up to ${MAX_DRAWINGS} drawings per submission` : "Draw"}>
			<button
				type="button"
				aria-label="Draw"
				aria-disabled={full}
				data-testid="draw-button"
				onClick={() => {
					if (!full) api.openNew();
				}}
				className={cn(
					"flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
					className ?? "size-9 rounded-[6px]",
				)}
			>
				<PenLineIcon className="size-4" />
			</button>
		</Hint>
	);
}

/** The attached drawings as thumbnail chips: click reopens, × removes. */
export function DrawingChips({ api, className }: { api: DrawingAttachmentsApi; className?: string }) {
	if (api.drawings.length === 0) return null;
	return (
		<div data-testid="drawing-chips" className={cn("flex flex-wrap gap-1.5", className)}>
			{api.drawings.map((d, i) => (
				<div key={d.id} data-testid="drawing-chip" className="group relative">
					<button
						type="button"
						aria-label={`Edit drawing ${i + 1}`}
						onClick={() => api.openExisting(d.id)}
						className="block h-12 w-16 overflow-hidden rounded-md border border-border bg-white transition-colors hover:border-primary/60"
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, not an optimizable asset */}
						<img src={`data:image/png;base64,${d.png}`} alt={`Drawing ${i + 1}`} className="size-full object-contain" />
					</button>
					<button
						type="button"
						aria-label={`Remove drawing ${i + 1}`}
						data-testid="drawing-chip-remove"
						onClick={() => api.remove(d.id)}
						className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
					>
						<XIcon className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}

/** The open pad for whichever page is being edited (nothing otherwise). */
export function DrawingPadHost({ api, context, contextLabel }: { api: DrawingAttachmentsApi; context?: string; contextLabel?: string }) {
	if (api.editing === null) return null;
	const existing = api.editing === "new" ? undefined : api.drawings.find((d) => d.id === api.editing);
	return (
		<DrawingPad
			key={api.editing}
			initialStrokes={existing?.strokes ?? []}
			context={context}
			contextLabel={contextLabel}
			onDone={api.finish}
		/>
	);
}
