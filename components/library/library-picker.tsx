"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, LibraryIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Button } from "@/components/ui/button";
import { effectiveTag, libraryChildren, type LibraryItem } from "@/src/core";
import { useLibrary } from "./library-client";
import { ItemGlyph, TagBadge, unitsText } from "./library-shared";

/**
 * THE ATTACH PICKER (course library wave, 2026-10-29): choose library
 * folders and files for a chat — from the Materials panel or the home /
 * draft composer. Checking a folder covers everything beneath it (its
 * descendants show as included and can't be picked separately). Confirm
 * returns the chosen ids in pick order — the attachment list as-is.
 */
export function LibraryPicker(props: {
	open: boolean;
	initial: readonly string[];
	onClose: () => void;
	onConfirm: (ids: string[]) => void;
	confirmLabel?: string;
}) {
	// Mounted only while open: no library fetch for a closed picker, and a
	// fresh selection (seeded from `initial`) every time it opens.
	return props.open ? <PickerDialog {...props} /> : null;
}

function PickerDialog({
	initial,
	onClose,
	onConfirm,
	confirmLabel = "Attach",
}: {
	initial: readonly string[];
	onClose: () => void;
	onConfirm: (ids: string[]) => void;
	confirmLabel?: string;
}) {
	const { snapshot, error } = useLibrary();
	const [picked, setPicked] = useState<string[]>(() => [...initial]);
	const backdrop = useBackdropDismiss(onClose);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const items = snapshot?.items ?? [];
	// Unknown ids (deleted since) drop out silently on confirm.
	const known = new Set(items.map((i) => i.id));

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Attach course materials"
				data-testid="library-picker"
				onClick={(e) => e.stopPropagation()}
				className="flex max-h-[80vh] w-[36rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold">Attach course materials</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					Pick folders or files. A folder brings everything inside it, including files added later.
				</p>
				<div className="mt-3 min-h-40 flex-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
					{error && <p className="p-2 text-sm text-destructive">{error}</p>}
					{!error && !snapshot && <p className="p-2 text-sm text-muted-foreground">Loading…</p>}
					{!error && snapshot && items.length === 0 && (
						<div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
							<LibraryIcon aria-hidden="true" className="size-5" />
							Your library is empty. Add files on the Library page first.
						</div>
					)}
					{items.length > 0 && (
						<PickerTree items={items} parentId={null} depth={0} picked={picked} coveredBy={null} onToggle={(id) =>
							setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
						} />
					)}
				</div>
				<div className="mt-4 flex items-center justify-between gap-2">
					<span className="text-xs text-muted-foreground">
						{picked.filter((id) => known.has(id)).length} selected
					</span>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={onClose}>
							Cancel
						</Button>
						<Button size="sm" data-testid="library-picker-confirm" onClick={() => onConfirm(picked.filter((id) => known.has(id)))}>
							{confirmLabel}
						</Button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** One tree level. `coveredBy` = a checked ancestor folder's id (its
 *  descendants render as included, not separately pickable). */
export function PickerTree({
	items,
	parentId,
	depth,
	picked,
	coveredBy,
	onToggle,
}: {
	items: readonly LibraryItem[];
	parentId: string | null;
	depth: number;
	picked: readonly string[];
	coveredBy: string | null;
	onToggle: (id: string) => void;
}) {
	const children = useMemo(() => libraryChildren(items, parentId), [items, parentId]);
	return (
		<ul className="flex flex-col">
			{children.map((item) => (
				<PickerRow key={item.id} items={items} item={item} depth={depth} picked={picked} coveredBy={coveredBy} onToggle={onToggle} />
			))}
		</ul>
	);
}

function PickerRow({
	items,
	item,
	depth,
	picked,
	coveredBy,
	onToggle,
}: {
	items: readonly LibraryItem[];
	item: LibraryItem;
	depth: number;
	picked: readonly string[];
	coveredBy: string | null;
	onToggle: (id: string) => void;
}) {
	const [open, setOpen] = useState(depth === 0);
	const checked = coveredBy !== null || picked.includes(item.id);
	const tag = effectiveTag(items, item.id);
	const hasChildren = item.kind === "folder" && items.some((i) => i.parentId === item.id);
	return (
		<li>
			<div className="flex items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-accent/50" style={{ paddingLeft: `${depth * 18 + 4}px` }}>
				<button
					type="button"
					aria-label={open ? "Collapse" : "Expand"}
					onClick={() => setOpen(!open)}
					className={`flex size-4 shrink-0 items-center justify-center text-muted-foreground ${hasChildren ? "" : "invisible"}`}
				>
					<ChevronRightIcon aria-hidden="true" className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
				</button>
				<input
					type="checkbox"
					data-testid={`pick-${item.id}`}
					checked={checked}
					disabled={coveredBy !== null}
					onChange={() => onToggle(item.id)}
					className="size-3.5 shrink-0 accent-primary"
					aria-label={`Attach ${item.name}`}
				/>
				<ItemGlyph item={item} open={open && item.kind === "folder"} />
				<span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
				{item.kind === "file" && <span className="shrink-0 text-[11px] text-muted-foreground">{unitsText(item)}</span>}
				{tag && <TagBadge tag={tag} inherited={!item.tag} />}
			</div>
			{open && hasChildren && (
				<PickerTree
					items={items}
					parentId={item.id}
					depth={depth + 1}
					picked={picked}
					coveredBy={coveredBy ?? (picked.includes(item.id) ? item.id : null)}
					onToggle={onToggle}
				/>
			)}
		</li>
	);
}
