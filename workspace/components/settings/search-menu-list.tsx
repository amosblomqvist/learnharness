"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fuzzyScore } from "@/src/core";

/** The model picker's search, arrow-walk, row styling and scrolling machine.
 * Models and dictation languages supply only their catalog and row content.
 * The caller owns the shared MenuShell and dismissal behavior. */
export function SearchMenuList<T>({
	items, itemKey, searchTerms, compare, prioritize, isSelected, onPick, renderItem,
	searchTestid, listTestid, optionTestid, placeholder, ariaLabel, loading, empty,
	disabled = false,
}: {
	items: readonly T[] | undefined;
	itemKey: (item: T) => string;
	searchTerms: (item: T) => string[];
	compare?: (a: T, b: T) => number;
	/** Optional grouping key: items it answers true for sort ahead of the
	 *  rest, fuzzy rank still deciding within each group (a stable partition,
	 *  never a filter — nothing is hidden). */
	prioritize?: (item: T) => boolean;
	isSelected: (item: T) => boolean;
	onPick: (item: T) => void;
	renderItem: (item: T) => ReactNode;
	searchTestid: string;
	listTestid: string;
	optionTestid: (item: T) => string;
	placeholder: string;
	ariaLabel?: string;
	loading?: string;
	empty: string;
	disabled?: boolean;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => { searchRef.current?.focus(); }, []);
	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = (items ?? [])
		.map((item) => ({ item, score: fuzzyScore(query, ...searchTerms(item)) }))
		.filter((result) => result.score !== null)
		.sort(
			(a, b) =>
				(prioritize ? Number(prioritize(b.item)) - Number(prioritize(a.item)) : 0) ||
				b.score! - a.score! ||
				(compare?.(a.item, b.item) ?? 0),
		)
		.map(({ item }) => item);

	return <>
		<input
			type="text"
			ref={searchRef}
			data-testid={searchTestid}
			aria-label={ariaLabel}
			value={query}
			disabled={disabled}
			onChange={(event) => { setQuery(event.target.value); setMenuIdx(null); }}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					if (disabled || results.length === 0) return;
					setMenuIdx((i) => event.key === "ArrowDown"
						? Math.min((i ?? -1) + 1, results.length - 1)
						: Math.max((i ?? results.length) - 1, 0));
				} else if (event.key === "Enter") {
					const chosen = results[menuIdx ?? 0];
					if (!disabled && chosen !== undefined) {
						event.preventDefault();
						event.stopPropagation();
						onPick(chosen);
					}
				}
			}}
			placeholder={placeholder}
			className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
		/>
		{!items && loading && <div className="px-2 py-3 text-center text-muted-foreground">{loading}</div>}
		{items && results.length === 0 && <div className="px-2 py-3 text-center text-muted-foreground">{empty}</div>}
		<ul ref={listRef} data-testid={listTestid} className="flex max-h-72 flex-col overflow-y-auto px-1">
			{results.map((item, i) => <li key={itemKey(item)}>
				<button
					type="button"
					data-testid={optionTestid(item)}
					data-idx={i}
					disabled={disabled}
					onClick={() => onPick(item)}
					className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
						i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
					}${isSelected(item) && i !== menuIdx ? " bg-muted/60" : ""}`}
				>{renderItem(item)}</button>
			</li>)}
		</ul>
	</>;
}
