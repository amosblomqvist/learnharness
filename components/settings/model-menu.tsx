"use client";
/**
 * The model menu (extracted 2026-09-20 from model-picker.tsx, owner ask:
 * the agent settings' role selects use the EXACT same dropdown as the
 * chat model selector — same look, same machine). The fuzzy search +
 * arrow-walk + Enter pick machine lives here once; each mount owns only
 * the popover shell (positioning, outside-click, Esc — the chat control
 * opens UP from the bottom bar, the settings rows open DOWN inside the
 * dialog).
 *
 * The appearance wave (2026-09-26) added the reading-font picker over the
 * same machine: FontMenuList (families instead of models, plus the
 * always-offerable DEFAULT row and a custom-family escape input).
 *
 * Keyboard machine (owner polish, 2026-09-17): focus STAYS in the search
 * field — ↑/↓ walk the filtered results (clamped, no wrap), Enter picks
 * the walked row (or the first result when nothing is walked).
 * stopPropagation keeps these keys out of every other listener while the
 * menu is open.
 */

import { useEffect, useRef, useState } from "react";
import type { ModelCatalogEntry } from "@/src/core";
import { CLAUDE_CODE_PROVIDER, CUSTOM_PROVIDER, fuzzyScore, subscriptionLabel } from "@/src/core";
import { formatTokens } from "@/components/usage-format";
import { SearchMenuList } from "./search-menu-list";

function priceLabel(cost: ModelCatalogEntry["cost"]): string {
	if (!cost) return "Unpriced";
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(cost.input)}/${fmt(cost.output)}`;
}

/** The model dropdown body — fuzzy search + ranked list. `models ===
 *  undefined` is the catalog-loading state; an empty result list gets
 *  its own quiet line. */
export function ModelMenuList({
	models,
	effectiveId,
	effectiveProvider,
	onPick,
	footer,
	vision,
}: {
	/** The full catalog — undefined while it loads. */
	models: ModelCatalogEntry[] | undefined;
	/** Currently effective id (the row gets the quiet highlight). */
	effectiveId: string | undefined;
	/** The effective id's provider (model-slots wave: the catalog
	 *  federates multiple providers and ids can collide across them —
	 *  the highlight must match BOTH coordinates or it lands on the
	 *  wrong row). */
	effectiveProvider?: string;
	/** Receives the chosen entry. */
	onPick: (entry: ModelCatalogEntry) => void;
	/** Quiet footer note under the list (context-specific). */
	footer?: string;
	/** Vision slot: only image-capable models are selectable — plus every
	 *  custom-endpoint model, whose capability the endpoint may not report.
	 *  Image-capable ones float to the top. */
	vision?: boolean;
}) {
	// Vision slot: built-ins must report image input; custom-endpoint models
	// stay selectable (the endpoint may not report a modality). Image-capable
	// ones float to the top of the list.
	const visionItems = vision
		? models?.filter((m) => m.input.includes("image") || m.provider === CUSTOM_PROVIDER.id)
		: models;
	return (
		<>
			<SearchMenuList
				items={visionItems}
				itemKey={(m) => `${m.provider}/${m.id}`}
				searchTerms={(m) => [m.provider, m.id, m.name]}
				compare={(a, b) => a.id.localeCompare(b.id)}
				prioritize={vision ? (m) => m.input.includes("image") : undefined}
				isSelected={(m) => m.id === effectiveId && m.provider === (effectiveProvider ?? m.provider)}
				onPick={onPick}
				searchTestid="model-search"
				listTestid="model-list"
				optionTestid={(m) => `model-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
				placeholder="Search models…"
				loading="Loading models…"
				empty="No models match."
				renderItem={(m) => <>
					<span className="flex items-center justify-between gap-2">
						<span className="truncate text-card-foreground">{m.name}</span>
						<span className="shrink-0 tabular-nums text-muted-foreground" title={m.provider === CLAUDE_CODE_PROVIDER ? "Billing is determined by your Claude Code configuration; LearnHarness does not estimate it." : subscriptionLabel(`${m.provider}:${m.id}`) ? "Subscription connection" : m.cost ? "USD per 1M tokens in/out" : "Price unavailable"}>
							{m.provider === CLAUDE_CODE_PROVIDER ? "CLI billing" : subscriptionLabel(`${m.provider}:${m.id}`) ?? priceLabel(m.cost)}
						</span>
					</span>
					<span className="flex items-center justify-between gap-2 text-muted-foreground">
						<span className="truncate">{subscriptionLabel(`${m.provider}:${m.id}`) ? `${subscriptionLabel(`${m.provider}:${m.id}`)} (subscription)` : m.provider} · {m.id}</span>
						<span className="shrink-0 tabular-nums">{m.contextWindow === null ? "—" : formatTokens(m.contextWindow)}</span>
					</span>
				</>}
			/>
			{footer && (
				<div className="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>
			)}
		</>
	);
}

/** The thinking-level dropdown body — the levels this model actually
 *  supports, ✓ on the effective one. Same shape as the chat selector's. */
export function ThinkingMenuList({
	levels,
	effectiveLevel,
	onPick,
	empty,
	footer,
}: {
	levels: string[];
	effectiveLevel: string | undefined;
	onPick: (level: string) => void;
	/** Shown instead of the list when there are no levels. */
	empty?: string;
	footer?: string;
}) {
	return (
		<>
			{levels.length === 0 ? (
				<div className="px-2 py-3 text-center text-muted-foreground">{empty ?? "No thinking levels."}</div>
			) : (
				levels.map((level) => (
					<button
						key={level}
						type="button"
						data-testid={`thinking-option-${level}`}
						onClick={() => onPick(level)}
						className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
							level === effectiveLevel ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
						}`}
					>
						<span>{level}</span>
						{level === effectiveLevel && <span aria-hidden>✓</span>}
					</button>
				))
			)}
			{footer && (
				<div className="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>
			)}
		</>
	);
}

/** The provider-picker dropdown body (keys wave-5 polish, 2026-09-21:
 *  the owner wanted the Add-provider control to match the app's dropdown
 *  language) — the same fuzzy-search + arrow-walk + Enter machine over
 *  the pi-ai provider table. Rows read: provider label, its env var in
 *  quiet mono on the right. */
export function ProviderMenuList({
	providers,
	onPick,
}: {
	providers: { id: string; envVar: string; label: string }[];
	onPick: (provider: { id: string; envVar: string; label: string }) => void;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = providers
		.map((p) => ({ p, s: fuzzyScore(query, p.id, p.envVar, p.label) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.p.id.localeCompare(b.p.id))
		.map((r) => r.p);

	return (
		<>
			<input
				ref={searchRef}
				data-testid="provider-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (results.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, results.length - 1)
								: Math.max((i ?? results.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = results[menuIdx ?? 0];
						if (chosen) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen);
						}
					}
				}}
				placeholder="Search providers…"
				className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{results.length === 0 && (
				<div className="px-2 py-3 text-center text-muted-foreground">No providers match.</div>
			)}
			<ul ref={listRef} data-testid="provider-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{results.map((p, i) => (
					<li key={p.id}>
						<button
							type="button"
							data-testid={`provider-option-${p.id.replace(/[^a-z0-9-]/gi, "_")}`}
							data-idx={i}
							onClick={() => onPick(p)}
							className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
								i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
							}`}
						>
							<span className="truncate text-card-foreground">{p.label}</span>
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.envVar}</span>
						</button>
					</li>
				))}
			</ul>
		</>
	);
}

/** The reading-font dropdown's row set — the SAME fuzzy + arrow-walk +
 *  Enter machine over font families (appearance wave, 2026-09-26). The
 *  DEFAULT row (null) is a candidate like any family: it matches empty
 *  and "source"/"sans"/"default" queries, so an unfiltered list opens
 *  with the default first and a searched list drops it honestly — Enter
 *  can never pick a row that isn't on screen. Pure — exported for
 *  tests. */
export function fontMenuResults(query: string, families: string[]): Array<string | null> {
	const scored = families
		.map((f) => ({ f, s: fuzzyScore(query, f) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.f.localeCompare(b.f))
		.map((r) => r.f);
	// The default row's searchable identity: the factory family + the
	// word "default" (the suffix it renders with).
	const defaultScore = fuzzyScore(query, "Source Sans 3", "default");
	if (query.trim() === "" || defaultScore !== null) return [null, ...scored];
	return scored;
}

/** The custom-family action row's decision (pure, 2026-09-26): a typed
 *  query that matches NO family becomes the "Use '<query>'" custom pick —
 *  a matching family is the better pick, so the action row only exists
 *  when there is nothing else to pick. Exported for tests. */
export function customFamilyFor(query: string, families: string[]): string | null {
	const trimmed = query.trim();
	if (trimmed === "") return null;
	return fontMenuResults(query, families).length === 0 ? trimmed : null;
}

/** The reading-font dropdown body — ONE search field (owner ask
 *  2026-09-26: "why two?"): the fuzzy machine filters the families, and
 *  when nothing matches, a "Use '<query>'" action row commits the typed
 *  text as a custom family — the old separate custom input is gone, the
 *  search field absorbed its job. `families === undefined` is the
 *  enumerating state; the curated fallback arrives as plain families with
 *  a footer that says so honestly. */
export function FontMenuList({
	families,
	effectiveFamily,
	onPick,
	footer,
}: {
	/** Enumerated font families (already deduped/sorted by the caller);
	 *  undefined while the enumeration runs. */
	families: string[] | undefined;
	/** The stored override (null = the factory Source Sans 3). */
	effectiveFamily: string | null;
	/** Receives the pick: a family string, or null for the default. */
	onPick: (family: string | null) => void;
	/** Quiet footer note under the list. */
	footer?: string;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = fontMenuResults(query, families ?? []);
	// The custom-family action row: only when a typed query matches
	// nothing (a matching family is the better pick). Enter picks it.
	const customFamily = customFamilyFor(query, families ?? []);
	const walkable: Array<string | null> = customFamily !== null ? ["__custom__"] : results;

	return (
		<>
			<input
				ref={searchRef}
				data-testid="font-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null); // new query → the walk restarts on Enter/↓
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (walkable.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, walkable.length - 1)
								: Math.max((i ?? walkable.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = walkable[menuIdx ?? 0];
						if (chosen !== undefined) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen === "__custom__" ? customFamily : chosen);
						}
					}
				}}
				placeholder="Search fonts…"
				className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{!families && <div className="px-2 py-3 text-center text-muted-foreground">Loading fonts…</div>}
			<ul ref={listRef} data-testid="font-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{families &&
					results.map((family, i) => {
						const isDefault = family === null;
						const effective = isDefault ? effectiveFamily === null : family === effectiveFamily;
						return (
							<li key={family ?? "__default"}>
								<button
									type="button"
									data-testid={isDefault ? "font-option-default" : `font-option-${family.replace(/[^a-z0-9-]/gi, "_")}`}
									data-idx={i}
									onClick={() => onPick(family)}
									className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
										i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
									}${effective && i !== menuIdx ? " bg-muted/60" : ""}`}
								>
									<span className="truncate text-card-foreground">{family ?? "Source Sans 3"}</span>
									<span className="shrink-0 text-muted-foreground">{isDefault ? "default" : effective && <span aria-hidden>✓</span>}</span>
								</button>
							</li>
						);
					})}
				{families && customFamily !== null && (
					<li>
						<button
							type="button"
							data-testid="font-option-custom"
							data-idx={0}
							onClick={() => onPick(customFamily)}
							className={`flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
								menuIdx === 0 ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
							}`}
						>
							<span className="truncate text-card-foreground">Use “{customFamily}”</span>
							<span className="shrink-0 text-muted-foreground">custom</span>
						</button>
					</li>
				)}
			</ul>
			{footer && <div className="px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>}
		</>
	);
}
