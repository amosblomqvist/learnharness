"use client";

import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { PluginTreeContent, PluginTreeProps, PluginTreeRow, PluginUiCallback, PluginUiContent } from "@/src/core";
import { TreeCell, TreeCheckbox, TreeDisclosure, TreeGuide, TreeHeader, TreeRow, TreeSelectionSpacer, TreeSeparator, treeBranchLayout } from "./tree-presentation";
import { navigateTreeRows } from "./tree-navigation";
import { useOptionalInteractionLayers, isInteractionElementVisible } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/** Private widget validation: validate the full controlled update before mounting. */
export function validatePluginTree(tree: PluginTreeProps): void {
	const columns = new Set<string>();
	for (const column of tree.columns ?? []) {
		if (typeof column.key !== "string" || columns.has(column.key)) throw new TypeError("Tree column keys must be unique strings.");
		columns.add(column.key);
		if (typeof column.width === "number" ? !Number.isFinite(column.width) || column.width < 0 : typeof column.width !== "string" || !column.width.trim()) {
			throw new TypeError("Tree column width must be a finite nonnegative number or a nonblank CSS width string.");
		}
	}
	const rows = new Set<string>();
	const visit = (entries: readonly PluginTreeRow[]) => {
		for (const row of entries) {
			if (typeof row.key !== "string" || rows.has(row.key)) throw new TypeError("Tree row keys must be globally unique strings.");
			rows.add(row.key);
			if (row.children) visit(row.children);
		}
	};
	visit(tree.rows);
}

function Content({ value, renderContent }: { value: PluginTreeContent; renderContent: (content: PluginUiContent) => ReactNode }) {
	return typeof value === "string" ? value : renderContent(value);
}

/** Native presentation and root-local row navigation; content keeps its own controls. */
export function PluginTree({ label, rows, header, columns = [], signal, onError, renderContent }: PluginTreeProps & {
	signal: AbortSignal;
	onError?: (error: unknown) => void;
	renderContent(content: PluginUiContent): ReactNode;
}) {
	const root = useRef<HTMLDivElement>(null);
	const controller = useOptionalInteractionLayers();
	const active = useRef<string | null>(null);
	const pendingEnter = useRef<string | null>(null);
	const readRows = () => [...(root.current?.querySelectorAll<HTMLElement>("[data-plugin-tree-row]") ?? [])]
		.filter(element => element.closest("[data-plugin-tree]") === root.current && isInteractionElementVisible(element))
		.map(element => ({ element, key: element.dataset.pluginTreeRow!, depth: Number(element.dataset.pluginTreeDepth),
			expanded: element.dataset.pluginTreeExpanded === undefined ? undefined : element.dataset.pluginTreeExpanded === "true" }));
	const highlight = (key: string | null, focus = false) => {
		const visible = readRows();
		for (const row of visible) row.element.removeAttribute("data-plugin-tree-active");
		const row = visible.find(row => row.key === key);
		active.current = row ? row.key : null;
		if (row) {
			row.element.dataset.pluginTreeActive = "true";
			if (focus && !signal.aborted && isInteractionScopeEligible(row.element, controller)) {
				row.element.focus({ preventScroll: true });
				row.element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			}
		}
	};
	const ownRow = (target: EventTarget | null) => {
		if (!(target instanceof Element) || target.closest("[data-plugin-tree]") !== root.current) return null;
		const row = target.closest<HTMLElement>("[data-plugin-tree-row]");
		return row?.closest("[data-plugin-tree]") === root.current ? row : null;
	};
	const ownControl = (row: HTMLElement, kind: "selection" | "disclosure") => [...row.querySelectorAll<HTMLElement>(`[data-plugin-tree-control="${kind}"]`)]
		.find(control => control.closest("[data-plugin-tree]") === root.current && control.closest("[data-plugin-tree-row]") === row);
	useLayoutEffect(() => {
		if (pendingEnter.current !== null) {
			const visible = readRows(), index = visible.findIndex(row => row.key === pendingEnter.current);
			const parent = visible[index], child = visible[index + 1];
			if (!parent || active.current !== pendingEnter.current || parent.element.ownerDocument.activeElement !== parent.element || !isInteractionScopeEligible(parent.element, controller)) pendingEnter.current = null;
			else if (parent.expanded) {
				pendingEnter.current = null;
				highlight(child && child.depth > parent.depth ? child.key : parent.key, true);
				return;
			}
		}
		highlight(active.current);
	});
	const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (signal.aborted || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
			!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key) || !isInteractionScopeEligible(root.current, controller)) return;
		const target = event.target instanceof Element ? event.target : null;
		if (!target || target.closest("[data-plugin-tree]") !== root.current) return;
		const row = ownRow(target);
		if ((target instanceof HTMLElement && target.isContentEditable) || target.closest('input:not([type="checkbox"]),textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]')) return;
		if (event.key === " ") {
			if (!row || (target !== row && target !== ownControl(row, "selection"))) return;
			const current = readRows().find(row => row.key === active.current);
			const checkbox = current && ownControl(current.element, "selection") as HTMLInputElement | undefined;
			if (!current || !checkbox || checkbox.disabled) return;
			event.preventDefault(); event.stopPropagation(); pendingEnter.current = null;
			checkbox.click(); highlight(current.key, true);
			return;
		}
		const result = navigateTreeRows(readRows(), active.current, event.key);
		if (result.key === undefined) return;
		event.preventDefault(); event.stopPropagation(); pendingEnter.current = result.enter ? result.key : null;
		highlight(result.key, true);
		if (result.toggle !== undefined) {
			const row = readRows().find(row => row.key === result.toggle);
			if (row) ownControl(row.element, "disclosure")?.click();
		}
	};
	const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (signal.aborted || !isInteractionScopeEligible(root.current, controller)) return;
		const target = event.target instanceof Element ? event.target : null;
		const row = ownRow(target);
		if (!target || !row) return;
		pendingEnter.current = null;
		if (event.defaultPrevented) return;
		const control = target.closest("button,input,textarea,select,a[href],[contenteditable]:not([contenteditable='false']),[tabindex],[role='button'],[role='checkbox'],[role='switch'],[role='slider'],[role='textbox'],[role='combobox'],[role='listbox'],[role='menuitem']");
		highlight(row.dataset.pluginTreeRow!, !control || control === row);
	};
	let selectionColumn = false;
	let disclosureColumn = false;
	const inspect = (entries: readonly PluginTreeRow[]) => {
		for (const row of entries) {
			if (row.selection) selectionColumn = true;
			if (row.disclosure || row.children?.length) disclosureColumn = true;
			if (row.children) inspect(row.children);
		}
	};
	inspect(rows);
	const invoke = (callback: PluginUiCallback<boolean>, value: boolean, disabled = false) => {
		if (signal.aborted || disabled) return;
		const report = (error: unknown) => { if (!signal.aborted) onError?.(error); };
		try { void Promise.resolve(callback(value)).catch(report); } catch (error) { report(error); }
	};
	const spacer = () => <span aria-hidden="true" className="h-5 w-3.5 shrink-0" />;
	const renderRows = (entries: readonly PluginTreeRow[], depth = 0): ReactNode => entries.map((row, index) => {
		const open = !row.disclosure || row.disclosure.expanded;
		const hasVisibleChildren = open && !!row.children?.length;
		return <div key={row.key} {...treeBranchLayout()}>
			<TreeRow depth={depth} data-plugin-tree-row={row.key} data-plugin-tree-depth={depth} data-plugin-tree-expanded={row.disclosure?.expanded ?? (row.children?.length ? true : undefined)} tabIndex={-1}
				className="outline-none [&>div]:text-sm [&>div]:font-medium data-[plugin-tree-active=true]:bg-accent/50" selectionColumn={selectionColumn}
				selection={row.selection && <TreeCheckbox data-plugin-tree-control="selection" aria-label={row.selection.label} checked={row.selection.checked} indeterminate={row.selection.indeterminate} disabled={row.selection.disabled}
					onChange={event => { invoke(row.selection!.onChange, event.currentTarget.checked, row.selection!.disabled); }} />}
				disclosure={row.disclosure ? <TreeDisclosure data-plugin-tree-control="disclosure" aria-label={row.disclosure.label} open={row.disclosure.expanded}
					onClick={() => { invoke(row.disclosure!.onChange, !row.disclosure!.expanded); }} /> : disclosureColumn ? spacer() : undefined}
				trailing={columns.map(column => <TreeCell key={column.key} data-plugin-tree-cell={column.key} align={column.align ?? "left"} style={{ width: column.width }} className="min-w-0 font-ui text-xs font-normal tabular-nums text-muted-foreground">
					{row.cells && Object.hasOwn(row.cells, column.key) && <Content value={row.cells[column.key]!} renderContent={renderContent} />}
				</TreeCell>)}>
				<Content value={row.content} renderContent={renderContent} />
			</TreeRow>
			{hasVisibleChildren && <><TreeGuide selectionColumn={selectionColumn} depth={depth} aria-hidden="true" />{renderRows(row.children!, depth + 1)}</>}
			{depth === 0 && index < entries.length - 1 && <TreeSeparator aria-hidden="true" />}
		</div>;
	});
	return <div ref={root} data-plugin-tree="" role="group" aria-label={label} className="min-w-0 w-full font-ui font-normal" onKeyDown={keyDown} onPointerDown={pointerDown}
		onFocus={event => {
			const row = ownRow(event.target);
			if (pendingEnter.current !== null && (event.target !== row || row?.dataset.pluginTreeRow !== pendingEnter.current)) pendingEnter.current = null;
			if (row) highlight(row.dataset.pluginTreeRow!);
		}}>
		{(header !== undefined || columns.length > 0) && <TreeHeader>
			{selectionColumn && <TreeSelectionSpacer />}
			{disclosureColumn && spacer()}
			<TreeCell grow className="min-w-0">{header !== undefined && <Content value={header} renderContent={renderContent} />}</TreeCell>
			{columns.map(column => <TreeCell key={column.key} data-plugin-tree-column={column.key} align={column.align ?? "left"} style={{ width: column.width }} className="min-w-0 font-ui text-xs font-normal">
				<Content value={column.header} renderContent={renderContent} />
			</TreeCell>)}
		</TreeHeader>}
		{renderRows(rows)}
	</div>;
}
