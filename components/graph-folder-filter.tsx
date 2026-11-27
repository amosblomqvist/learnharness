"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FolderIcon, FunnelIcon } from "lucide-react";
import { graphFolderCheck, toggleGraphFolder, type SourceFolder, type SourceOrganization } from "@/src/core";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useInteractionLayers, type CloseReason } from "@/components/interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { Hint } from "@/components/ui/hint";
import { TreeCheckbox } from "@/components/tree-presentation";
import { cn } from "@/lib/utils";

/**
 * The graph's folder filter (approved plan): VIEW ONLY. Ticked folders of the
 * shared source organization narrow what the canvas shows; nothing in the
 * graph or the organization changes. The choice is remembered per device;
 * deleted folders silently drop out of it.
 */

const STORAGE_KEY = "lh.graph.folder-filter.v1";

export function useGraphFolderSelection(organization: SourceOrganization | undefined) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		try {
			const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
			if (Array.isArray(raw)) setSelected(new Set(raw.filter((id): id is string => typeof id === "string")));
		} catch { /* corrupt → no filter */ }
	}, []);
	const save = useCallback((next: ReadonlySet<string>) => {
		setSelected(next);
		try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* storage denied */ }
	}, []);
	// Drop folders deleted since (only once the organization is known).
	useEffect(() => {
		if (!organization) return;
		const existing = new Set(organization.folders.map((f) => f.id));
		if ([...selected].some((id) => !existing.has(id))) save(new Set([...selected].filter((id) => existing.has(id))));
	}, [organization, selected, save]);
	return { selected, setSelected: save };
}

export function GraphFolderFilterControl({ organization, listed, selected, onChange }: {
	organization: SourceOrganization;
	/** Folders containing graph material (subtree). */
	listed: ReadonlySet<string>;
	selected: ReadonlySet<string>;
	onChange: (next: ReadonlySet<string>) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const enterAt = useRef<"first" | "last" | null>(null);
	const interactions = useInteractionLayers();
	const close = useCallback((reason: CloseReason) => {
		if (reason === "escape") triggerRef.current?.focus({ preventScroll: true });
		setOpen(false);
	}, []);
	const popupLayer = usePopoverDismiss(rootRef, open, close, { layerRootRef: panelRef });
	const controls = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-folder-filter-control]:not(:disabled)") ?? []);
	useLayoutEffect(() => {
		if (!open || !enterAt.current) return;
		const options = controls();
		(options.at(enterAt.current === "first" ? 0 : -1) ?? panelRef.current)?.focus();
		enterAt.current = null;
	}, [open]);
	const walk = (event: KeyboardEvent<HTMLDivElement>) => {
		const { key } = event;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		if (!open ? !interactions.isElementEligible(triggerRef.current) : !interactions.isElementEligible(panelRef.current)) return;
		event.preventDefault();
		event.stopPropagation();
		if (!open) {
			enterAt.current = key === "End" || key === "ArrowUp" ? "last" : "first";
			setOpen(true);
			return;
		}
		const options = controls();
		if (!options.length) return;
		const current = options.indexOf(event.target as HTMLElement);
		const delta = key === "ArrowDown" ? 1 : -1;
		const start = current < 0 ? (delta === 1 ? -1 : 0) : current;
		const index = key === "Home" ? 0 : key === "End" ? options.length - 1 : (start + delta + options.length) % options.length;
		options[index]?.focus();
	};
	const active = new Set([...selected].filter((id) => listed.has(id)));
	// Count CHOICES, not folders: a ticked folder's ticked subfolders came with
	// it. One choice → its name on the button; several → how many (owner polish).
	const choices = organization.folders.filter((f) => active.has(f.id) && !(f.parentId !== null && active.has(f.parentId)));
	const activeCount = choices.length;
	const soleName = activeCount === 1 ? choices[0]!.name : null;
	const collator = useMemo(() => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }), []);
	const childrenOf = (parentId: string | null): SourceFolder[] => organization.folders
		.filter((f) => f.parentId === parentId && listed.has(f.id))
		.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
	const renderLevel = (parentId: string | null, depth: number): ReactNode => childrenOf(parentId).map((folder) => {
		const check = graphFolderCheck(organization, selected, folder.id, listed);
		return (
			<div key={folder.id}>
				<label data-testid={`graph-folder-option-${folder.id}`} className="flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-accent has-[:focus-visible]:bg-accent"
					style={{ paddingLeft: 8 + depth * 18 }}>
					<TreeCheckbox data-folder-filter-control checked={check.checked} indeterminate={check.indeterminate}
						aria-label={`Show folder ${folder.name}`}
						onChange={(e) => onChange(toggleGraphFolder(organization, selected, folder.id, e.target.checked, listed))} />
					<FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate text-xs">{folder.name}</span>
				</label>
				{renderLevel(folder.id, depth + 1)}
			</div>
		);
	});
	return (
		<div ref={rootRef} className="lh-no-drag relative" onKeyDown={walk}>
			<Hint label={activeCount > 0 ? "Graph filtered by folder" : "Show folders"} side="bottom">
				<button
					type="button"
					ref={triggerRef}
					aria-expanded={open}
					aria-label={soleName !== null ? `Folder filter: ${soleName}` : activeCount > 0 ? `Folder filter: ${activeCount} selected` : "Folder filter"}
					data-testid="graph-folder-filter"
					data-active={activeCount > 0}
					onClick={(event) => {
						if (!open && event.detail === 0) enterAt.current = "first";
						setOpen(!open);
					}}
					className={cn(
						"flex h-9 items-center gap-1.5 rounded-xl transition-colors hover:bg-accent",
						activeCount > 0
							? "border border-primary/60 bg-card/85 px-2.5 text-foreground shadow-lg backdrop-blur"
							: cn("w-[38px] justify-center", open ? "text-foreground" : "text-muted-foreground hover:text-foreground"),
					)}
				>
					<FunnelIcon aria-hidden="true" className={cn("size-4 shrink-0", activeCount > 0 && "text-primary")} />
					{soleName !== null
						? <span data-testid="graph-folder-filter-name" className="max-w-40 truncate text-xs">{soleName}</span>
						: activeCount > 0 && <span className="text-xs tabular-nums">{activeCount}</span>}
				</button>
			</Hint>
			{open && (
				<div ref={panelRef} role="group" aria-label="Show folders" tabIndex={-1} data-testid="graph-folder-filter-panel" style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }}
					className="absolute left-0 top-full mt-2 flex max-h-[60vh] w-64 flex-col rounded-xl border bg-card/85 p-2 shadow-lg backdrop-blur">
					<div className="mb-1 flex items-center justify-between gap-2 px-2">
						<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Show folders</span>
						{activeCount > 0 && (
							<button type="button" data-testid="graph-folder-filter-clear" data-folder-filter-control onClick={() => {
								// This button disappears once cleared; keep focus inside the popup.
								(panelRef.current?.querySelector<HTMLElement>("input[data-folder-filter-control]") ?? panelRef.current)?.focus();
								onChange(new Set());
							}}
								className="text-[10px] text-muted-foreground transition-colors hover:text-foreground">Show all</button>
						)}
					</div>
					<div className="overflow-y-auto">
						{listed.size === 0
							? <p className="px-2 py-1 text-xs text-muted-foreground">No folders contain graph material yet.</p>
							: renderLevel(null, 0)}
					</div>
				</div>
			)}
		</div>
	);
}
