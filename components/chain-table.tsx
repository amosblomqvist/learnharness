"use client";

/**
 * THE CHAIN TABLE (chains overlay; owner refinements round 2, 2026-09-29):
 * every reasoning chain of the graph in one FULL-BLEED surface — the blur
 * + translucent background IS the surface, no inner card. The top bar is
 * THE shared TopBar (standardization ruling: one element, every surface —
 * h-15, lh-drag with carve-outs, select-none, sidebar reopen, traffic-
 * light gutter; born from this overlay's hand-rolled bar breaking every
 * rule at once). The overlay (z-40) covers home's floating header while
 * open, so the TopBar's own SidebarToggle is the reopen path.
 *
 * HIERARCHY (three levels, one click each): CLUSTER (the birth session —
 * a chat or a notes file; a chain lives where its CONCLUSION was born,
 * owner ruling) → REASONING CHAIN → PROPOSITION STATEMENTS. Expanding a
 * chain reveals its members' statement text directly — names live in the
 * chain line, never twice; a singleton reveals its one statement in one
 * click. Everything starts collapsed. PROMINENT indentation carries the
 * structure (owner ruling: chains deep under folders, statements deeper)
 * — the ONLY lines are the horizontal separators between cluster groups
 * (vertical column hairlines removed with them, owner ruling: "anything
 * else is better without them").
 *
 * THE CHAIN LINE: every proposition name is a faint-outlined CHIP
 * with the LOGIC as the connectives (owner rulings, 2026-09-30):
 * premises join with the LaTeX LAND (∧) and the conclusion separates
 * by the LaTeX IMPLICATION (⟹) — `A ∧ B ⟹ C`, never the misleading
 * `A → B → C`. The glyphs are REAL KaTeX renders (components/
 * latex-glyph.tsx — the app's math engine, never SVGs), PROMINENT in
 * the theme foreground (white), not dim gray. A lonely chip (no
 * premises) carries no glyph — it reads as a standalone proposition;
 * "(no premises)" survives only as the row's aria-label.
 *
 * SORTING: all three columns sortable (owner ruling — "consistency is
 * key"): Name (A→Z), Props (largest-first), Created (newest-first);
 * click toggles asc/desc; a SMALL chevron marks the active header. Sort
 * orders cluster rows AND chains within.
 *
 * SELECTION never shifts layout (owner ruling): a floating bottom bar —
 * the Google-Photos pattern — appears only when something is selected,
 * showing the agents' ACTUAL input (chainsForSelection over the flat
 * node-id selection: a premise without its conclusion counts as the
 * singleton it becomes) + Clear. DELETE (owner,
 * 2026-09-29 night: "this is really the view deletion should be done
 * in") rides the same bar FENCED at the right end — divider + the
 * destructive red pair — and opens the SAME full-death confirm dialog
 * the canvas uses (multi-selections list their names + the unioned
 * impact); this ends the overlay's read-only stance: it is the graph's
 * MANAGEMENT surface now. The fuzzy
 * search (names, aliases, statements) filters chains grouped +
 * auto-expanded under their clusters (non-matching clusters hide; the
 * collapsed view returns on clear).
 *
 * Read-only toward the graph.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	DumbbellIcon,
	BookIcon,
	BookOpenIcon,
	FolderPlusIcon,
	Trash2Icon,
	ListTreeIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { chainsForSelection, folderEntryCheck, toggleSourceEntries, formatChainLine, fuzzyScore, sourceFileLabel } from "@/src/core";
import type { GraphChain, GraphNode, SourceDirectory, SourceEntry, SourceFolder, SourceEntrySelection } from "@/src/core";
import { EditableSourceName, SourceDragRow, sourceNameMatches, SourceFolderTree, type OrganizationChange } from "./source-folder-tree";
import { chainRow, useChainNavigation } from "./chain-navigation";
import { useServerEvent, useServerResync } from "./server-events";
import { TopBar } from "@/components/top-bar";
import { DeleteSourceDialog } from "@/components/delete-source-dialog";
import { LatexGlyph } from "@/components/latex-glyph";

/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
	col: ChainSortCol;
	/** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
	dir: 1 | -1;
}

/** A cluster's chains share the conclusion's birth (owner ruling). This
 *  record is assembled per render from the visible chains. */
interface ClusterGroup {
	key: string;
	birth: string | null;
	label: string | null;
	kind: "chat" | "notes" | null;
	chains: ReturnType<typeof chainsForSelection>;
	nodeIds: string[];
	newestCreatedAt: string;
}

/** The table's pure body — exported for SSR pins (the render-suite
 *  discipline). All state (query, sort, selection, expansion) arrives
 *  via props; the overlay wrapper below owns it. */
export function ChainTableBody({
	nodes,
	chains: storedChains,
	sessions,
	fileSources,
	query,
	onQuery,
	sort,
	onSort,
	selection,
	expandedClusters,
	expandedChains,
	onToggleCluster,
	onToggleChain,
	onToggleNodes,
	onClear,
	onDelete,
	onClose,
	selectMode,
	onSelect,
	directory,
	onOrganizationChange,
	selectedFolders = new Set<string>(),
	selectedSources = new Set<string>(),
	onToggleSource = () => {},
	onToggleFolder = () => {},
	keyboardActive = true,
}: {
	keyboardActive?: boolean;
	directory?: SourceDirectory;
	onOrganizationChange?: OrganizationChange;
	selectedFolders?: ReadonlySet<string>;
	selectedSources?: ReadonlySet<string>;
	onToggleSource?: (id: string, next: boolean) => void;
	onToggleFolder?: (id: string, next: boolean) => void;
	nodes: GraphNode[];
	chains: GraphChain[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	query: string;
	onQuery: (v: string) => void;
	sort: ChainSort;
	onSort: (col: ChainSortCol) => void;
	selection: ReadonlySet<string>;
	expandedClusters: ReadonlySet<string>;
	expandedChains: ReadonlySet<string>;
	onToggleCluster: (key: string) => void;
	onToggleChain: (id: string) => void;
	/** Selection is ALWAYS a flat node-id set — cluster, chain, and single
	 *  proposition checks all reduce to this. */
	onToggleNodes: (ids: string[], next: boolean) => void;
	onClear: () => void;
	/** Opens the full-death confirm dialog (owner, 2026-09-29 night). */
	onDelete: () => void;
	onClose: () => void;
	/** PRACTICE SELECT (2026-10-04): the floating bar's confirm becomes
	 *  "Practice these" — no delete fence; the caller owns what the
	 *  selection becomes. */
	selectMode?: boolean;
	onSelect?: () => void;
}) {
	const [creatingFolder, setCreatingFolder] = useState(false);
	const tableRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const navigation = useChainNavigation(tableRef, searchRef, keyboardActive);
	// Searches still expand sources/folders by default, but explicit keyboard
	// or pointer collapses remain effective until the search changes.
	const [searchFolds, setSearchFolds] = useState({ query, ids: new Set<string>() });
	useEffect(() => { setSearchFolds({ query, ids: new Set() }); }, [query]);
	const foldedClusters = searchFolds.query === query ? searchFolds.ids : new Set<string>();
	const toggleCluster = (id: string) => {
		if (!query.trim()) { onToggleCluster(id); return; }
		setSearchFolds((previous) => {
			const ids = new Set(previous.query === query ? previous.ids : []);
			if (ids.has(id)) ids.delete(id); else ids.add(id);
			return { query, ids };
		});
	};
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const sourceRecords = useMemo(() => new Map(directory?.sources.map((s) => [s.id, s])), [directory]);
	const matchesSource = useCallback((birth: string) => sourceNameMatches(directory, birth,
		sourceRecords.get(birth)?.label ?? sessions[birth] ?? (fileSources[birth] === undefined ? null : sourceFileLabel(fileSources[birth])), query),
	[directory, sourceRecords, sessions, fileSources, query]);
	const chains = useMemo(() => chainsForSelection(nodes, storedChains), [nodes, storedChains]);
	const searching = query.trim() !== "";
	const allSourceNodes = useMemo(() => {
		const membership = new Map<string, Set<string>>();
		for (const chain of chains) {
			const birth = byId.get(chain.conclusion)?.provenance[0]?.chatId;
			if (!birth) continue;
			const members = membership.get(birth) ?? new Set<string>();
			for (const id of [...chain.premises, chain.conclusion]) members.add(id);
			membership.set(birth, members);
		}
		return membership;
	}, [chains, byId]);

	// The fuzzy filter: a chain is visible when ANY member matches on
	// name, aliases, or statement; chains rank by best member score.
	const visibleChains = useMemo(() => {
		if (!searching) return chains;
		const scored = chains
			.map((chain) => {
				const birth = byId.get(chain.conclusion)?.provenance[0]?.chatId;
				let best: number | null = birth && matchesSource(birth) ? 0 : null;
				for (const id of [...chain.premises, chain.conclusion]) {
					const node = byId.get(id);
					if (!node) continue;
					const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
					if (s === null) continue;
					if (best === null || s > best) best = s;
				}
				return best === null ? null : { chain, best };
			})
			.filter((r): r is { chain: (typeof chains)[number]; best: number } => r !== null);
		return scored
			.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
			.map(({ chain }) => chain);
	}, [chains, byId, query, searching, matchesSource]);

	// Group the visible chains by their CONCLUSION's birth (owner ruling).
	// Unlabeled births (provenance gone / never named) form one honest
	// muted group, sorted last under name-sort.
	const groups = useMemo(() => {
		const map = new Map<string, ClusterGroup>();
		for (const source of directory?.sources ?? []) {
			if (searching && !matchesSource(source.id)) continue;
			map.set(source.id, { key: source.id, birth: source.id, label: source.label,
				kind: source.kind === "missing" ? null : source.kind, chains: [], nodeIds: [], newestCreatedAt: "" });
		}
		for (const chain of visibleChains) {
			const conclusion = byId.get(chain.conclusion);
			const birth = conclusion?.provenance[0]?.chatId ?? null;
			const key = birth ?? "\0unlabeled";
			let group = map.get(key);
			if (!group) {
				const label = birth === null ? null : (sourceRecords.get(birth)?.label ?? sessions[birth] ?? (fileSources[birth] === undefined ? null : sourceFileLabel(fileSources[birth])));
				const kind =
					birth === null ? null : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;
				group = { key, birth, label, kind, chains: [], nodeIds: [], newestCreatedAt: "" };
				map.set(key, group);
			}
			group.chains.push(chain);
			for (const id of [...chain.premises, chain.conclusion]) {
				if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
				const createdAt = byId.get(id)?.createdAt ?? "";
				if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
			}
		}
		const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
		const list = [...map.values()];
		// Existing graph groups retain their newest-member date. Inventory-only
		// rows fall back to record dates; a re-import must not redraft old dates.
		for (const group of list) if (!group.newestCreatedAt && group.birth) group.newestCreatedAt = sourceRecords.get(group.birth)?.createdAt ?? "";
		// Sort law (owner ruling: all three columns sortable — consistency):
		// the active column orders BOTH cluster rows and chains within; name
		// is the universal tiebreak (asc). Unlabeled clusters sort last under
		// name-sort (￿ sentinel).
		const nameKey = (g: ClusterGroup) => g.label ?? "\uffff";
		const cmpName = (a: ClusterGroup, b: ClusterGroup) => collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
		const cmpProps = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length;
		const cmpCreated = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.newestCreatedAt.localeCompare(a.newestCreatedAt) : a.newestCreatedAt.localeCompare(b.newestCreatedAt);
		list.sort((a, b) =>
			sort.col === "created" ? cmpCreated(a, b) || cmpName(a, b) : sort.col === "props" ? cmpProps(a, b) || cmpName(a, b) : cmpName(a, b),
		);
		for (const group of list) {
			const chainName = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
			const chainSize = (chain: (typeof chains)[number]) => chain.premises.length + 1;
			const chainDate = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.createdAt ?? "";
			const cName = (a: (typeof chains)[number], b: (typeof chains)[number]) => collator.compare(chainName(a), chainName(b)) * (sort.col === "name" ? sort.dir : 1);
			const cProps = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainSize(b) - chainSize(a) : chainSize(a) - chainSize(b);
			const cDate = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainDate(b).localeCompare(chainDate(a)) : chainDate(a).localeCompare(chainDate(b));
			group.chains.sort((a, b) =>
				sort.col === "created" ? cDate(a, b) || cName(a, b) : sort.col === "props" ? cProps(a, b) || cName(a, b) : cName(a, b),
			);
		}
		return list;
	}, [visibleChains, byId, sessions, fileSources, sort, directory, sourceRecords, searching, matchesSource]);

	// The derived shape under the floating bar (the agents' ACTUAL input).
	const derived = useMemo(() => {
		const selectedNodes = [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
		return chainsForSelection(selectedNodes, storedChains);
	}, [selection, byId, storedChains]);

	const fullySelectedFolders = directory ? new Set([...selectedFolders].filter((id) => folderEntryCheck(directory, id, { sources: selectedSources, folders: selectedFolders }).checked)) : selectedFolders;
	const nameOf = (id: string) => byId.get(id)?.name ?? id;
	const dateOf = (id: string) => byId.get(id)?.createdAt.slice(0, 10) ?? "";
	const dirIcon = (col: ChainSortCol) =>
		sort.col !== col ? null : sort.dir === 1 ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />;

	return (
		<div ref={tableRef} tabIndex={-1} data-testid="chain-table" className="relative flex h-full min-h-0 flex-col outline-none [&_[data-chain-nav-active=true]]:bg-accent/50 [&_[data-chain-nav-row]]:outline-none [&_[data-chain-nav-row]]:scroll-mt-8 [&_[data-chain-nav-row]]:scroll-mb-16">
			{/* THE shared top bar (standardization ruling): drag mechanics,
			    sidebar reopen, traffic-light gutter — the same element as every
			    chat surface. NO TITLE (owner round 11, 2026-10-05): the serif
			    title register is RESERVED — it always names a session; the
			    chain table names nothing, so its bar carries counts + search +
			    close only. Search + close carve out with lh-no-drag (the mask
			    law: later in the DOM). */}
			<TopBar>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{chains.length} {chains.length === 1 ? "chain" : "chains"} · {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
				</span>
				{onOrganizationChange && <button type="button" aria-label="Add folder" data-testid="add-source-folder"
					onClick={() => setCreatingFolder(true)} className="lh-no-drag rounded-lg p-2 text-muted-foreground hover:bg-accent"><FolderPlusIcon className="size-4" /></button>}
				<div className="relative shrink-0">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						ref={searchRef}
						value={query}
						data-testid="chain-table-search"
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search nodes…"
						aria-label="Search nodes"
						spellCheck={false}
						className="lh-no-drag h-8 w-56 rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</div>
			<button
					type="button"
					data-testid="chain-table-close"
					onClick={onClose}
					aria-label="Close chains"
					className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</TopBar>

			{/* The list: NO per-row lines (owner ruling) — the ONLY horizontal
			    separators sit between cluster groups; the ALIGNMENT STAIRCASE
			    carries the hierarchy (owner round 4, "double the indentation":
			    two-column steps — chains pl-12 aligned with the folder icon,
			    statements pl-21 where a chain icon would sit).
			    All three columns sort, small chevron on active. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{/* The TOP rule (owner round 5: the table is framed — a line under
			    the header, a line under the last group, lines between groups). */}
				<div className="sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur">
					<button
						type="button"
						data-testid="sort-name"
						onClick={() => onSort("name")}
						aria-sort={sort.col === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex flex-1 items-center gap-1 text-left transition-colors hover:text-foreground"
					>
						Name {dirIcon("name")}
					</button>
					<button
						type="button"
						data-testid="sort-props"
						onClick={() => onSort("props")}
						aria-sort={sort.col === "props" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex w-14 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground"
					>
						Props {dirIcon("props")}
					</button>
					<button
						type="button"
						data-testid="sort-created"
						onClick={() => onSort("created")}
						aria-sort={sort.col === "created" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						className="flex w-20 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground"
					>
						Created {dirIcon("created")}
					</button>
				</div>

				{creatingFolder && onOrganizationChange && <div className="flex items-center px-3 py-2" data-testid="new-folder-row">
					<EditableSourceName name="" initiallyEditing onCancel={() => setCreatingFolder(false)}
						onSave={async (name) => {
						const id = await onOrganizationChange({ action: "create-folder", name, parentId: null });
						onQuery(""); if (id) navigation.focusRow(["folder", id]); setCreatingFolder(false);
					}} />
				</div>}
				{groups.length === 0 && (directory?.organization.folders.length ?? 0) === 0 && (
					<div data-testid="chain-table-nomatch" className="px-4 pt-3 text-xs text-muted-foreground">
						No matching chains.
					</div>
				)}

				<SourceFolderTree groups={groups} directory={directory} query={query} sort={sort} onAction={onOrganizationChange}
					sourceSelection={selectMode ? undefined : { sources: selectedSources, folders: selectedFolders }}
					expanded={expandedClusters} collapsedForSearch={foldedClusters} onToggleExpanded={toggleCluster} selection={selection} selectedFolders={selectedFolders}
					onToggleNodes={onToggleNodes} onToggleFolder={onToggleFolder} allowEmptySelection={!selectMode} allSourceNodes={allSourceNodes}
					renderSource={(group, depth) => {
					const open = searching ? !foldedClusters.has(group.key) : expandedClusters.has(group.key);
					const selectedCount = group.nodeIds.filter((id) => selection.has(id)).length;
					return (
						<div
							key={group.key}
							data-testid={`cluster-group-${group.key}`}
							// The horizontal rules (owner rulings, rounds 2 + 5): between
							// cluster groups AND under the last one — the table is framed
							// top (header) and bottom. Never on individual rows.
							className="relative border-b border-transparent"
							style={{ marginLeft: depth * 36 }}
						>
							{/* The TREE THREAD (owner rounds 5–6): a vertical guide at the
							    expander arrow's column (center 37px: pl-3 + checkbox 14 +
							    gap 4 + half the 14px expander), BRACKETED by checkbox
							    bottom edges — it starts at the cluster row's own checkbox
							    bottom (top-[23px], leaving the arrow's stroke a visible
							    gap, live-measured) and terminates exactly at the LAST
							    checkbox bottom (bottom-[8px] = 9px from the border box minus the 1px group rule, measured). */}
							{open && group.chains.length > 0 && (
								<div
									data-testid={`cluster-thread-${group.key}`}
									className="pointer-events-none absolute bottom-[8px] left-[37px] top-[23px] w-px bg-border/50"
								/>
							)}
							{/* The cluster row: birth-session group header. */}
							<SourceDragRow {...chainRow(["source", group.key], depth, open)} kind="source" id={group.key} name={group.label ?? "unlabeled"} enabled={Boolean(onOrganizationChange && group.birth)} className="flex items-center gap-1 px-3 py-1.5">
								<RowCheckbox
									disabled={selectMode ? group.nodeIds.length === 0 : !directory?.sources.some((s) => s.id === group.birth)}
									checked={selectMode ? selectedCount === group.nodeIds.length && group.nodeIds.length > 0 : group.birth !== null && selectedSources.has(group.birth)}
									indeterminate={selectMode ? selectedCount > 0 && selectedCount < group.nodeIds.length : false}
									onToggle={(next) => { if (selectMode) onToggleNodes(group.nodeIds, next); else if (group.birth) onToggleSource(group.birth, next); }}
									testid={`cluster-checkbox-${group.key}`}
									label={selectMode ? `Select everything born in ${group.label ?? "unlabeled"}` : `Select source ${group.label ?? "unlabeled"}`}
								/>
								<Expander open={open} onClick={() => toggleCluster(group.key)} testid={`cluster-toggle-${group.key}`} label={`Expand cluster ${group.label ?? "unlabeled"}`} />
								<button type="button" data-source-icon data-testid={`source-icon-${group.key}`} aria-expanded={open} aria-label={`Expand source ${group.label ?? "unlabeled"}`}
									onClick={() => toggleCluster(group.key)} className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
									{open ? <BookOpenIcon className="size-3.5 shrink-0" /> : <BookIcon className="size-3.5 shrink-0" />}
								</button>
								{onOrganizationChange && group.birth && group.kind !== null
									? <EditableSourceName name={group.label ?? ""} onSave={(name) => onOrganizationChange({ action: "rename-source", id: group.birth!, name })} />
									: <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.label ?? <span className="text-muted-foreground/60">unlabeled</span>}</span>}
								{group.kind === "notes" && <span className="text-[11px] uppercase tracking-widest text-muted-foreground/60">notes</span>}
								<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
									{group.nodeIds.length}
								</span>
								<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
									{group.newestCreatedAt.slice(0, 10)}
								</span>
							</SourceDragRow>

							{/* The chain rows — clearly indented under the folder
							    (owner ruling); visible only when the cluster is open
							    (searching auto-expands). */}
							{open &&
								group.chains.map((chain) => {
									const memberIds = [...chain.premises, chain.conclusion];
									const chainOpen = expandedChains.has(chain.id);
									const selectedInChain = memberIds.filter((id) => selection.has(id)).length;
									return (
										<div key={chain.id} data-testid={`chain-block-${chain.id}`} className="relative">
												{/* The chain's own thread (owner rounds 5–6): the same
												    bracket law one level down — at the chain arrow's column
												    (center 73px), from the chain row's checkbox bottom
												    (top-[22px]) to the LAST statement row's checkbox bottom
												    (bottom-[8px]) — live-measured anchors. */}
												{chainOpen && memberIds.length > 0 && (
													<div
														data-testid={`chain-thread-${chain.id}`}
														className="pointer-events-none absolute bottom-[8px] left-[73px] top-[22px] w-px bg-border/50"
													/>
												)}
											<div
												{...chainRow(["chain", group.key, chain.id], depth + 1, chainOpen)}
												data-testid={`chain-row-${chain.id}`}
												aria-label={formatChainLine(chain, Object.fromEntries([...byId.entries()].map(([id, n]) => [id, { name: n.name }])))}
												className="flex items-center gap-1 py-1 pl-12 pr-3"
											>
												{selectMode ? <RowCheckbox
													checked={selectedInChain === memberIds.length && memberIds.length > 0}
													indeterminate={selectedInChain > 0 && selectedInChain < memberIds.length}
													onToggle={(next) => onToggleNodes(memberIds, next)}
													testid={`chain-checkbox-${chain.id}`}
													label={`Select chain ${nameOf(chain.conclusion)}`}
												/> : <span aria-hidden="true" className="size-3.5 shrink-0" />}
												<Expander open={chainOpen} onClick={() => onToggleChain(chain.id)} testid={`chain-toggle-${chain.id}`} label={`Expand chain ${nameOf(chain.conclusion)}`} />
												{/* The chain line: proposition names as faint-outlined
												    chips. THE LOGIC IS THE PAYLOAD (owner rulings,
												    2026-09-30): premises join with the LaTeX LAND (∧),
												    the conclusion separates by the LaTeX IMPLICATION
												    (⟹) — `A ∧ B ⟹ C`, never the misleading `A → B →
												    C` — the glyphs render through KaTeX (the app's
												    math engine), PROMINENT in the theme foreground
												    (white), not the old dim gray. A lonely chip reads
												    as a standalone proposition (no glyphs at all);
												    the row's aria-label keeps the plain-text form. */}
												<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px] leading-tight">
													{memberIds.map((id, i) => {
														const isConclusion = i === memberIds.length - 1;
														return (
															<span key={id} className="flex items-center">
																{i > 0 && (isConclusion ? (
																	<LatexGlyph
																		cmd="\implies"
																		testid={`chain-implies-${chain.id}`}
																		className="px-1.5 text-foreground"
																	/>
																) : (
																	<LatexGlyph
																		cmd="\land"
																		testid={`chain-and-${chain.id}-${i}`}
																		className="px-1.5 text-foreground"
																	/>
																))}
																<span
																	data-testid={`prop-chip-${id}`}
																	className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5"
																>
																	{nameOf(id)}
																</span>
															</span>
														);
													})}
												</span>
												<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
													{memberIds.length}
												</span>
												<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
													{dateOf(chain.conclusion)}
												</span>
											</div>

											{/* The propositions — their STATEMENT text directly (owner
											    ruling: names live in the line; a singleton reveals its
											    one statement in one click). PLAIN rows: the derivation
											    is already encoded in the chain line — no conclusion
											    marker down here. Deepest indent. */}
											{chainOpen &&
												memberIds.map((id) => {
													const node = byId.get(id);
													if (!node) return null;
													return (
														<div
															key={id}
															{...chainRow(["prop", group.key, chain.id, id], depth + 2)}
															data-testid={`prop-row-${id}`}
															className="flex items-start gap-2 py-1 pl-21 pr-3"
														>
															{selectMode ? <RowCheckbox
																checked={selection.has(id)}
																onToggle={(next) => onToggleNodes([id], next)}
																testid={`prop-checkbox-${id}`}
																label={`Select node ${node.name}`}
															/> : <span aria-hidden="true" className="size-3.5 shrink-0" />}
															<span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
																{node.statement}
															</span>
															<span className="w-14 shrink-0" />
															<span className="w-20 shrink-0" />
														</div>
													);
												})}
										</div>
									);
								})}
							<div data-testid={`source-separator-${group.key}`} className="pointer-events-none absolute bottom-[-1px] right-0 border-b border-border/60" style={{ left: depth === 0 ? 0 : 1 }} />
						</div>
					);
				}} />
			</div>

			{/* The floating selection bar (owner ruling: never shifts layout —
			    the Google-Photos pattern). Appears only when something is
			    selected; floats over the table's bottom edge. */}
			{(selectMode ? selection.size > 0 : selectedSources.size > 0 || fullySelectedFolders.size > 0) && (
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-4">
					<div
						data-testid="chain-selection-bar"
						className="pointer-events-auto flex items-center gap-3 rounded-full border bg-card py-2 pl-4 pr-2 shadow-lg"
					>
						<span data-testid="chain-selected-summary" className="text-xs font-medium">
							{selectMode ? <>{selection.size} {selection.size === 1 ? "node" : "nodes"} → {derived.length} {derived.length === 1 ? "chain" : "chains"}</>
								: <>{selectedSources.size} {selectedSources.size === 1 ? "source" : "sources"}{fullySelectedFolders.size > 0 && ` · ${fullySelectedFolders.size} ${fullySelectedFolders.size === 1 ? "folder" : "folders"}`}</>}
						</span>
						<button
							type="button"
							data-testid="chain-clear"
							onClick={onClear}
							className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							Clear
						</button>
						{selectMode ? (
							<button
								type="button"
								data-testid="chain-practice-done"
								onClick={onSelect}
								aria-label={`Done picking — ${selection.size} ${selection.size === 1 ? "proposition" : "propositions"} selected`}
								className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80"
							>
								<DumbbellIcon aria-hidden="true" className="size-3.5" />
								Done
							</button>
						) : (
							<>
							{/* The danger fence (owner ruling): a divider quarantines
								    the destructive action at the bar's right end — the
								    safe actions and the kill switch never blend. The
								    full-death confirm dialog catches the misclick. */}
							<span data-testid="chain-danger-divider" aria-hidden="true" className="h-4 w-px bg-border/70" />
							<button
								type="button"
								data-testid="chain-delete"
								onClick={onDelete}
								aria-label="Delete selected sources and folders"
								className="flex items-center gap-1.5 rounded-full border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
							>
								<Trash2Icon aria-hidden="true" className="size-3.5" />
								Delete
							</button>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/** The rotating chevron — collapsed points right, expanded rotates down
 *  (owner ruling: the affordance must read on every expandable row). */
function Expander({ open, onClick, testid, label }: { open: boolean; onClick: () => void; testid: string; label: string }) {
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={onClick}
			aria-label={label}
			aria-expanded={open}
			className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
		>
			<ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
		</button>
	);
}

/** The checkbox — checked/indeterminate (partial chains/clusters); DOM
 *  property set via ref (React does not expose `indeterminate`). */
function RowCheckbox({
	checked,
	disabled = false,
	indeterminate = false,
	onToggle,
	testid,
	label,
}: {
	checked: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	onToggle: (next: boolean) => void;
	testid: string;
	label: string;
}) {
	return (
		<input
			type="checkbox"
			disabled={disabled}
			checked={checked}
			ref={(el) => {
				if (el) el.indeterminate = indeterminate;
			}}
			data-testid={testid}
			aria-label={label}
			onChange={(e) => onToggle(e.target.checked)}
			className="size-3.5 shrink-0 accent-primary"
		/>
	);
}

/** The graph view's overlay wrapper: owns query + sort + selection +
 *  expansion; mounts ABSOLUTE INSIDE the
 *  graph area, full-bleed (owner ruling: the translucent blurred surface
 *  IS the overlay — no inner card). Esc + the top-bar X dismiss (there
 *  is no backdrop margin to click anymore). Read-only toward the graph. */
export function ChainTableOverlay({
	open,
	nodes,
	chains: storedChains,
	sessions,
	fileSources,
	onClose,
	/** PRACTICE SELECT (owner vision, 2026-10-04): the selection is
	 *  PERSISTENT and caller-owned — when these props are present the
	 *  table is CONTROLLED (every check/clear/delete-prune reports up
	 *  immediately; the composer-side chip reflects it live). selectMode
	 *  only changes the floating bar: Done instead of the delete fence
	 *  (deleting while picking is a footgun). */
	selectMode,
	controlledSelection,
	onSelectionChange,
}: {
	open: boolean;
	nodes: GraphNode[];
	chains: GraphChain[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	onClose: () => void;
	selectMode?: boolean;
	controlledSelection?: ReadonlySet<string>;
	onSelectionChange?: (next: ReadonlySet<string>) => void;
}) {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ChainSort>({ col: "name", dir: 1 });
	const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedChains, setExpandedChains] = useState<ReadonlySet<string>>(() => new Set());
	const [deletion, setDeletion] = useState<{ sources: SourceEntry[]; folders: SourceFolder[] } | null>(null);
	const deleteOpen = deletion !== null;
	const [directory, setDirectory] = useState<SourceDirectory>();
	const [directoryFailure, setDirectoryFailure] = useState("");
	const [entrySelection, setEntrySelection] = useState<SourceEntrySelection>(() => ({ sources: new Set(), folders: new Set() }));
	useEffect(() => {
		if (!directory) return;
		setEntrySelection((previous) => {
			const sources = new Set([...previous.sources].filter((id) => directory.sources.some((s) => s.id === id)));
			const folders = new Set([...previous.folders].filter((id) => directory.organization.folders.some((f) => f.id === id)));
			return sources.size === previous.sources.size && folders.size === previous.folders.size ? previous : { sources, folders };
		});
	}, [directory]);
	const requestVersion = useRef(0);
	const mutationTail = useRef<Promise<unknown>>(Promise.resolve());
	const readDirectory = useCallback(async () => {
		const version = ++requestVersion.current;
		try {
			const response = await fetch("/api/graph/sources", { cache: "no-store" });
			if (!response.ok) throw new Error("Could not read source organization.");
			const body = await response.json() as SourceDirectory;
			if (version === requestVersion.current) { setDirectory(body); setDirectoryFailure(""); }
		} catch (error) { if (version === requestVersion.current) setDirectoryFailure(error instanceof Error ? error.message : String(error)); }
	}, []);
	useEffect(() => {
		if (open) void readDirectory();
		return () => { requestVersion.current++; };
	}, [open, readDirectory]);
	useServerEvent("sources-changed", () => { if (open) void readDirectory(); });
	useServerEvent("chats-changed", () => { if (open) void readDirectory(); });
	useServerResync(() => { if (open) void readDirectory(); });
	const changeOrganization: OrganizationChange = (action) => {
		// Serialize this page's edits, and invalidate older notify-then-fetch reads.
		const operation = mutationTail.current.catch(() => {}).then(async () => {
			try {
				const response = await fetch("/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
				const body = await response.json();
				if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save source organization.");
				requestVersion.current++;
				setDirectory(body as SourceDirectory);
				setDirectoryFailure("");
				if (action.action === "rename-source") {
					const entry = (body as SourceDirectory).sources.find((s) => s.id === action.id);
					window.dispatchEvent(new CustomEvent(entry?.kind === "chat" ? "lh:chat-renamed" : "lh:source-renamed", { detail: { id: action.id, title: action.name } }));
				}
				return typeof body.createdFolderId === "string" ? body.createdFolderId : undefined;
			} catch (error) { setDirectoryFailure(error instanceof Error ? error.message : String(error)); throw error; }
		});
		mutationTail.current = operation;
		return operation;
	};
	const selectedSources = new Set([...entrySelection.sources].filter((id) => directory?.sources.some((s) => s.id === id)));
	const selectedFolders = new Set([...entrySelection.folders].filter((id) => directory?.organization.folders.some((f) => f.id === id)));
	const fullySelectedFolders = new Set([...selectedFolders].filter((id) => directory && folderEntryCheck(directory, id, { sources: selectedSources, folders: selectedFolders }).checked));
	const toggleEntries = (kind: "source" | "folder", id: string, checked: boolean) => {
		if (directory) setEntrySelection((previous) => toggleSourceEntries(directory, previous, kind, id, checked));
	};

	// Controlled when the caller lifts the selection (the practice pick
	// set); internal (uncontrolled) otherwise — the delete flow's own.
	const selection = controlledSelection ?? internalSelection;
	const applySelection = (next: ReadonlySet<string>) => {
		if (onSelectionChange) onSelectionChange(next);
		else setInternalSelection(next);
	};

	// Esc dismisses (unless a dialog has focus — each dialog's own Esc
	// owns its layer; all listen on window, so the guards are explicit).
	useEffect(() => {
		if (!open || deleteOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// App Router delegates React events on document too: a child's
				// stopPropagation cannot silence a sibling document listener.
				if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('[data-testid="source-name-input"]'))) return;
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim
				// at the document level — the window chain (dictation →
				// abort) must not also act. One Esc, one action.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, deleteOpen, onClose]);

	if (!open) return null;

	const toggleNodes = (ids: string[], next: boolean) => {
		const s = new Set(selection);
		for (const id of ids) {
			if (next) s.add(id);
			else s.delete(id);
		}
		applySelection(s);
	};
	const toggleIn = (set: ReadonlySet<string>, id: string) => {
		const s = new Set(set);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		return s;
	};

	return (
		<>
			<div
				data-testid="chain-table-overlay"
				className="absolute inset-0 z-40 flex flex-col bg-background/80 backdrop-blur-sm"
			>
				{directoryFailure && <p role="alert" className="px-3 py-1 text-xs text-red-400">{directoryFailure}</p>}
				<ChainTableBody
					keyboardActive={!deleteOpen}
					directory={directory}
					onOrganizationChange={directory ? changeOrganization : undefined}
					selectedFolders={selectedFolders}
					selectedSources={selectedSources}
					onToggleSource={(id, next) => toggleEntries("source", id, next)}
					onToggleFolder={(id, next) => toggleEntries("folder", id, next)}
					nodes={nodes}
					chains={storedChains}
					sessions={sessions}
					fileSources={fileSources}
					query={query}
					onQuery={setQuery}
					sort={sort}
					onSort={(col) =>
						setSort((prev) =>
							prev.col === col
								? { col, dir: prev.dir === 1 ? -1 : 1 }
								: { col, dir: col === "name" ? 1 : -1 },
						)
					}
					selection={selection}
					expandedClusters={expandedClusters}
					expandedChains={expandedChains}
					onToggleCluster={(key) => setExpandedClusters((prev) => toggleIn(prev, key))}
					onToggleChain={(id) => setExpandedChains((prev) => toggleIn(prev, id))}
					onToggleNodes={toggleNodes}
					onClear={() => { if (selectMode) applySelection(new Set()); else setEntrySelection({ sources: new Set(), folders: new Set() }); }}
					onDelete={() => setDeletion({
						sources: directory?.sources.filter((s) => selectedSources.has(s.id)) ?? [],
						folders: directory?.organization.folders.filter((f) => fullySelectedFolders.has(f.id)) ?? [],
					})}
					onClose={onClose}
					selectMode={selectMode}
					onSelect={onClose}
				/>
			</div>
			{!selectMode && <DeleteSourceDialog open={deleteOpen}
				sources={deletion?.sources ?? []}
				folders={deletion?.folders ?? []}
				onClose={() => setDeletion(null)}
				onDelete={(deleteSessions) => {
					const operation = mutationTail.current.catch(() => {}).then(async () => {
						let graphRevision: number | undefined;
						try {
							const response = await fetch("/api/graph/sources", { method: "DELETE", headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ sourceIds: deletion?.sources.map((s) => s.id) ?? [], folderIds: deletion?.folders.map((f) => f.id) ?? [], deleteSessions }) });
							const body = await response.json();
							if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not delete sources.");
							graphRevision = body.graphRevision;
							requestVersion.current++; setDirectory(body as SourceDirectory); setDirectoryFailure("");
							setEntrySelection({ sources: new Set(), folders: new Set() });
						} finally {
							// A failed response can still follow partial disk writes.
							// Refresh graph content as well as the directory, in both home modes.
							void readDirectory();
							window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision } }));
						}
					});
					mutationTail.current = operation; return operation;
				}}
			/>}
		</>
	);
}
