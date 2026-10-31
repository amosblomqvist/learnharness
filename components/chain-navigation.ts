"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { sessionFindHasForegroundLayer } from "./session-find";

export interface ChainNavigationRow { key: string; depth: number; expanded?: boolean }
export function chainRow(parts: string[], depth: number, expanded?: boolean) {
	return { "data-chain-nav-row": JSON.stringify(parts), "data-chain-nav-depth": depth,
		"data-chain-nav-expanded": expanded, tabIndex: -1 };
}
function parentIndices(rows: ChainNavigationRow[]): number[] {
	const ancestors: { depth: number; index: number }[] = [];
	return rows.map((row, index) => {
		let ancestor = ancestors.at(-1);
		while (ancestor && ancestor.depth >= row.depth) { ancestors.pop(); ancestor = ancestors.at(-1); }
		const parent = ancestor?.index ?? -1;
		ancestors.push({ depth: row.depth, index });
		return parent;
	});
}
/** Visible DOM order is the navigation order, including the current sort/filter.
 * Up/Down visit siblings, not every row of an expanded subtree. */
export function navigateChainRows(rows: ChainNavigationRow[], active: string | null, key: string): {
	key?: string; toggle?: string; enter?: boolean;
} {
	const first = rows[0];
	if (!first) return {};
	const index = rows.findIndex((row) => row.key === active);
	const row = rows[index];
	if (!row) return { key: first.key };
	const parents = parentIndices(rows), parent = parents[index] ?? -1;
	if (key === "ArrowLeft") {
		const target = rows[parent] ?? row;
		return { key: target.key, ...(target.expanded ? { toggle: target.key } : {}) };
	}
	if (key === "ArrowRight") {
		if (row.expanded === false) return { key: row.key, toggle: row.key, enter: true };
		const child = rows[index + 1];
		return { key: row.expanded && child && child.depth > row.depth ? child.key : row.key };
	}
	const siblings = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.depth === row.depth && parents[i] === parent);
	const position = siblings.findIndex(({ i }) => i === index);
	const next = Math.max(0, Math.min(siblings.length - 1, position + (key === "ArrowDown" ? 1 : -1)));
	return { key: siblings[next]?.r.key ?? row.key };
}

export function useChainNavigation(rootRef: RefObject<HTMLDivElement | null>, searchRef: RefObject<HTMLInputElement | null>, enabled: boolean) {
	const active = useRef<string | null>(null);
	const pendingEnter = useRef<string | null>(null);
	const pendingFocus = useRef<string | null>(null);
	const readRows = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-chain-nav-row]") ?? [])].map((element) => ({
		element, key: element.dataset.chainNavRow!, depth: Number(element.dataset.chainNavDepth),
		expanded: element.dataset.chainNavExpanded === undefined ? undefined : element.dataset.chainNavExpanded === "true",
	}));
	const highlight = (key: string | null, focus = false) => {
		const root = rootRef.current;
		root?.querySelectorAll<HTMLElement>("[data-chain-nav-active]").forEach((row) => row.removeAttribute("data-chain-nav-active"));
		const row = readRows().find((row) => row.key === key)?.element;
		active.current = row ? key : null;
		if (row) {
			row.dataset.chainNavActive = "true";
			if (focus) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest", inline: "nearest" }); }
		}
	};
	useLayoutEffect(() => {
		if (pendingFocus.current !== null && readRows().some((row) => row.key === pendingFocus.current)) {
			const key = pendingFocus.current; pendingFocus.current = null; highlight(key, true);
		} else if (pendingEnter.current !== null) {
			const rows = readRows(), index = rows.findIndex((row) => row.key === pendingEnter.current);
			const parent = rows[index], candidate = index >= 0 ? rows[index + 1] : undefined;
			const child = parent && candidate && candidate.depth > parent.depth ? candidate : undefined;
			const key = child?.key ?? pendingEnter.current;
			pendingEnter.current = null; highlight(key, true);
		} else highlight(active.current);
	});
	// Reattach with the current render's refs; handlers always read the visible
	// rows rather than maintaining a second, potentially stale hierarchy.
	useEffect(() => {
		if (!enabled) return;
		const root = rootRef.current;
		const onFind = () => {
			if (sessionFindHasForegroundLayer(document)) return;
			searchRef.current?.focus({ preventScroll: true }); searchRef.current?.select();
		};
		const onPointerDown = (event: PointerEvent) => {
			const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-chain-nav-row]") : null;
			if (row) highlight(row.dataset.chainNavRow!);
			else if (event.target instanceof Element && event.target.closest('[data-testid="source-root-drop"]')) {
				event.preventDefault(); // do not refocus the tabindex=-1 table after blur
				pendingEnter.current = null; pendingFocus.current = null; highlight(null);
				const focused = document.activeElement;
				if (focused && root?.contains(focused) && "blur" in focused) (focused as HTMLElement).blur();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) return;
			if (sessionFindHasForegroundLayer(document)) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target && !root?.contains(target) && target !== document.body && target !== document.documentElement) return;
			const fromSearch = target === searchRef.current;
			if (fromSearch ? event.key !== "ArrowDown" : target?.closest('input:not([type="checkbox"]),textarea,[contenteditable="true"]')) return;
			if (event.key === " ") {
				if (target?.closest('button,a[href],[role="button"]') && !target.closest("[data-chain-nav-row]")) return;
				const row = readRows().find((row) => row.key === active.current);
				const checkbox = row?.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
				if (!row || !checkbox || checkbox.disabled) return;
				event.preventDefault(); event.stopPropagation(); checkbox.click(); highlight(row.key, true);
				return;
			}
			const result = navigateChainRows(readRows(), fromSearch ? null : active.current, event.key);
			if (!result.key) return;
			event.preventDefault(); event.stopPropagation();
			highlight(result.key, true);
			if (result.toggle) {
				pendingEnter.current = result.enter ? result.key : null;
				readRows().find((row) => row.key === result.toggle)?.element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
			}
		};
		window.addEventListener("lh:kbd-find", onFind);
		document.addEventListener("keydown", onKeyDown);
		root?.addEventListener("pointerdown", onPointerDown);
		return () => { window.removeEventListener("lh:kbd-find", onFind); document.removeEventListener("keydown", onKeyDown); root?.removeEventListener("pointerdown", onPointerDown); };
	});
	useEffect(() => { if (enabled && !sessionFindHasForegroundLayer(document)) rootRef.current?.focus({ preventScroll: true }); }, [enabled, rootRef]);
	return { focusRow(parts: string[]) {
		const key = JSON.stringify(parts);
		if (readRows().some((row) => row.key === key)) highlight(key, true);
		else pendingFocus.current = key;
	} };
}
