"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { kbdEventForAction, stepSessionMatch } from "@/src/core";
import { sessionFindRanges } from "@/components/session-find-dom";
import { findTranscriptMatches, transcriptSearchIndex, type TranscriptSearchCache, type TranscriptSearchMatch } from "./transcript-search";
import type { TranscriptRow } from "./transcript-rows";
import type { VirtualTranscriptHandle } from "./virtual-transcript";
import { scrollSessionTarget, type SessionScrollContext } from "@/components/session-navigation";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { hasLegacyInteractionForeground, isInteractionScopeEligible } from "./plugin-input-focus";

export const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";
const EMPTY_ROWS: readonly TranscriptRow[] = [];

/** ::highlight() rules live OUTSIDE globals.css on purpose: the PostCSS/
 *  Tailwind v4 pipeline rejects the Custom Highlight pseudo-element as a
 *  parse error, which downed the whole stylesheet. A tiny <style> element,
 *  injected once on first client mount, ships them verbatim. */
const FIND_STYLE_ID = "lh-session-find-style";
export function injectFindStyles(): void {
	if (document.getElementById(FIND_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 25%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--primary); color: var(--primary-foreground); }`;
	document.head.appendChild(style);
}

export function clearSessionFindHighlights(): void {
	if (typeof CSS === "undefined") return;
	CSS.highlights?.delete(SESSION_FIND_HIGHLIGHT);
	CSS.highlights?.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

function publishHighlights(ranges: readonly Range[], index: number): void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
	// Avoid a huge argument spread when a short query matches many times.
	const all = new Highlight();
	for (const range of ranges) all.add(range);
	CSS.highlights.set(SESSION_FIND_HIGHLIGHT, all);
	const active = new Highlight();
	active.priority = 1;
	if (ranges[index]) active.add(ranges[index]!);
	CSS.highlights.set(SESSION_FIND_ACTIVE_HIGHLIGHT, active);
}

/** One-Esc law: a surfaced menu/dialog/cheat sheet outranks this non-modal
 * bar, regardless of where focus happened to be left. Closed Radix exits
 * must not block Find once they have stopped being a surfaced layer. */
export function sessionFindHasForegroundLayer(doc: Document, scope?: HTMLElement | null): boolean {
	return hasLegacyInteractionForeground(doc, scope);
}

/** Mounted for the lifetime of ONE Chat (which is keyed by chatId). Closing
 * keeps the query/reading position; changing sessions resets all local state.
 * The bar lives outside scopeRef, so it never finds its own query or count. */
export function SessionFind({ scopeRef, scrollContextRef, rows = EMPTY_ROWS, virtualTranscriptRef }: {
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
	rows?: readonly TranscriptRow[];
	virtualTranscriptRef?: RefObject<VirtualTranscriptHandle | null>;
}) {
	const controller = useOptionalInteractionLayers();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [result, setResult] = useState({ index: -1, count: 0 });
	useEffect(injectFindStyles, []);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const indexRef = useRef(-1);
	const identityRef = useRef<string | null>(null);
	const lastQueryRef = useRef<string | null>(null);
	const searchCache = useRef<TranscriptSearchCache>(new Map());
	const searchIndex = useMemo(() => open ? transcriptSearchIndex(rows, searchCache.current) : [], [open, rows]);
	const matches = useMemo(() => findTranscriptMatches(searchIndex, query), [searchIndex, query]);
	type Match = TranscriptSearchMatch | { key: string; range: Range };
	const matchesRef = useRef<readonly Match[]>([]);
	const navigation = useRef(0);
	const queryRef = useRef(query);
	queryRef.current = query;
	const reveal = useCallback(async (match: Match | undefined) => {
		const request = ++navigation.current;
		const scope = scopeRef.current;
		if (!match || !scope) return;
		if ("range" in match) { scrollSessionTarget(match.range, scope, scrollContextRef.current); return; }
		const row = await virtualTranscriptRef?.current?.revealRow(match.rowIndex);
		if (!row || request !== navigation.current) return;
		const ranges = sessionFindRanges(row, queryRef.current);
		const range = ranges[match.occurrence];
		if (range) {
			publishHighlights(ranges, match.occurrence);
			scrollSessionTarget(range, scope, scrollContextRef.current);
		} else {
			// Plugin-rendered text may arrive after its row. The observer below
			// paints the highlight when it arrives; the row is already revealed.
			scrollSessionTarget(row, scope, scrollContextRef.current);
		}
	}, [scopeRef, scrollContextRef, virtualTranscriptRef]);

	const close = useCallback(() => {
		navigation.current++;
		clearSessionFindHighlights();
		setOpen(false);
		if (isInteractionScopeEligible(previousFocus.current, controller)) previousFocus.current!.focus({ preventScroll: true });
	}, [controller]);

	useEffect(() => {
		const onFind = () => {
			if (!isInteractionScopeEligible(scopeRef.current, controller)) return;
			if (!open) previousFocus.current = document.activeElement as HTMLElement | null;
			setOpen(true);
			// A second Mod+F focuses/selects the retained query, not a second bar.
			if (open) { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); }
		};
		window.addEventListener(kbdEventForAction("find"), onFind);
		return () => window.removeEventListener(kbdEventForAction("find"), onFind);
	}, [open, controller, scopeRef]);

	useEffect(() => {
		if (!open || !isInteractionScopeEligible(scopeRef.current, controller)) return;
		inputRef.current?.focus({ preventScroll: true });
		inputRef.current?.select();
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || controller?.isEscapeOwned(event) || !isInteractionScopeEligible(scopeRef.current, controller)) return;
			controller?.claimEscape(event);
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	}, [open, close, controller, scopeRef]);

	useEffect(() => {
		if (!open || !scopeRef.current) return;
		const scope = scopeRef.current;
		let frame: number | null = null;
		const refresh = (selectFirst: boolean) => {
			const ranges = sessionFindRanges(scope, query);
			// Only the active dock needs a DOM search. The transcript's global
			// count and navigation come from data, including every unmounted row.
			const dock = ranges.filter(range => !range.startContainer.parentElement?.closest("[data-virtual-transcript]"));
			const all: Match[] = [...matches, ...dock.map((range, index) => ({ key: `dock:${index}`, range }))];
			let index = selectFirst ? 0 : all.findIndex(match => match.key === identityRef.current);
			if (index < 0) index = Math.max(0, Math.min(indexRef.current, all.length - 1));
			if (!all.length) index = -1;
			matchesRef.current = all;
			indexRef.current = index;
			identityRef.current = all[index]?.key ?? null;
			setResult(old => old.index === index && old.count === all.length ? old : { index, count: all.length });
			const active = all[index];
			let activeRange: Range | undefined;
			if (active && "range" in active) activeRange = active.range;
			else if (active) {
				const row = scope.querySelector<HTMLElement>(`[data-transcript-row="${active.rowIndex}"]`);
				if (row) activeRange = sessionFindRanges(row, query)[active.occurrence];
			}
			publishHighlights(ranges, activeRange ? ranges.findIndex(range => range.startContainer === activeRange.startContainer && range.startOffset === activeRange.startOffset) : -1);
			if (selectFirst) void reveal(active);
		};
		// New queries start at the session's first match. Reopening the retained
		// query or receiving streamed content only refreshes; neither yanks scroll.
		refresh(lastQueryRef.current !== query);
		lastQueryRef.current = query;
		const schedule = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => { frame = null; refresh(false); });
		};
		const observer = new MutationObserver(schedule);
		observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state", "aria-expanded"] });
		window.addEventListener("resize", schedule);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			if (frame !== null) window.cancelAnimationFrame(frame);
			clearSessionFindHighlights();
		};
	}, [open, query, matches, scopeRef, scrollContextRef, reveal]);

	// Also clear on a session switch when Find was already closed.
	useEffect(() => clearSessionFindHighlights, []);

	const step = (direction: 1 | -1) => {
		const matches = matchesRef.current;
		const index = stepSessionMatch(indexRef.current, matches.length, direction);
		indexRef.current = index;
		identityRef.current = matches[index]?.key ?? null;
		setResult({ index, count: matches.length });
		void reveal(matches[index]);
	};

	if (!open) return null;
	const buttonClass = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
	return (
		<div
			role="search"
			aria-label="Session Find"
			data-testid="session-find"
			className="lh-no-drag flex h-10 shrink-0 items-center gap-2 border-b border-border px-6 font-ui text-sm"
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.stopPropagation(); // NEVER reach question/global Enter submits.
					if ((event.target as HTMLElement).tagName !== "INPUT" || event.nativeEvent.isComposing) return;
					event.preventDefault();
					step(event.shiftKey ? -1 : 1);
				} else if (event.key === "Escape") {
					if (!isInteractionScopeEligible(inputRef.current, controller)) return;
					controller?.claimEscape(event);
					event.preventDefault();
					event.stopPropagation();
					close();
				}
			}}
		>
			<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<input
				ref={inputRef}
				aria-label="Find in session"
				placeholder="Find in session…"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				spellCheck={false}
				className="lh-input min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
			/>
			<output aria-live="polite" data-testid="session-find-count" className="shrink-0 text-xs tabular-nums text-muted-foreground">
				{query ? `${result.index + 1}/${result.count}` : ""}
			</output>
			<button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" className={buttonClass}
				disabled={!result.count} onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>
				<ChevronUpIcon className="size-4" aria-hidden />
			</button>
			<button type="button" aria-label="Next match" title="Next match (Enter)" className={buttonClass}
				disabled={!result.count} onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>
				<ChevronDownIcon className="size-4" aria-hidden />
			</button>
			<button type="button" aria-label="Close Find" title="Close Find (Esc)" className={buttonClass} onClick={close}>
				<XIcon className="size-4" aria-hidden />
			</button>
		</div>
	);
}
