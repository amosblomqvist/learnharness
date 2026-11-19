"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import type { ChatDeleteMode, ThemeMode } from "@/src/core";
import { DumbbellIcon, FolderPlusIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem, ChatListResponse } from "@/src/core";
import { kbdEventForAction } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { PluginWidgets } from "@/components/plugins";
import { PluginSidebarActions } from "@/components/plugin-chrome";
import { createSidebarRefresh } from "@/components/sidebar-refresh";
import { buildSidebarFolderView, enterKbdChat, nextKbdChat, SidebarFolderTree } from "@/components/sidebar-folder-tree";
import {
	createFolderWriter,
	folderPath,
	MoveTargetDialog,
	NewFolderDialog,
	planCreateFolder,
	planMoveChat,
	postFolderCommand,
	type FolderPlan,
	type SidebarOrganization,
	useSidebarDrag,
} from "@/components/sidebar-folder-actions";
import { SourceDragRow } from "@/components/source-folder-tree";
import { HostContentRootContext, HostRouteLifetimeProvider } from "@/components/host-content-root";
import { isInteractionScopeEligible } from "@/components/plugin-input-focus";
import { InteractionLayersProvider, useInteractionLayers, useOptionalInteractionLayers } from "@/components/interaction-layers";

/**
 * Toggleable sidebar — NOT a modal drawer: no backdrop, no focus theft. It
 * sits inline next to the content and can stay open while working in a
 * session. Open state persists across pages (provider lives in the root
 * layout) and across reloads (localStorage).
 */

const STORAGE_KEY = "lh:sidebar-open";

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * sidebar would squeeze the page below the 640px window floor (the two
 * numbers compose: 640 + 288 sidebar = 928), so it auto-closes — and
 * auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.lh.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";
import type { UpdateState } from "@/components/settings/update-settings.tsx";
import { FilePathDropZone } from "@/components/file-path-drop-zone";
const SIDEBAR_AUTOCLOSE = 928;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		lh?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			/** Resolve an OS-backed File without copying/uploading its contents. */
			getPathForFile?: (file: File) => string;
			/** Choose one original directory path, without reading its contents. */
			chooseAttachmentFolder?: () => Promise<string | null>;
			/** External Next desktop-dev uses the server's web connections. */
			subscriptionTransport?: "desktop" | "web";
			openSubscriptionBrowser?: (action: string) => Promise<void>;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			expandWindow: () => void;
			/** Native chrome follows the active theme (theme wave): main sets
			 *  themeSource and repaints the window background / overlay. */
			setAppearance?: (a: { mode: ThemeMode; background: string }) => void;
			/** The zoom truth (owner round 7): subscribes to "lh:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			/** Observational update events and a snapshot for late subscribers. */
			onUpdateStatus?: (cb: (status: UpdateState) => void) => () => void;
			getUpdateState?: () => Promise<UpdateState>;
			/** Explicit manual check also downloads and stages available updates. */
			checkForUpdates?: () => Promise<void>;
			installUpdate?: () => void;
			onOpenSettings?: (cb: (section: string) => void) => () => void;
		};
	}
}

const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys"); // cover changes missed before this root-lifetime subscription
		return off;
	}, []);
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpen] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .lh-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("lh-electron");
			document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
		}

		// THE ZOOM TRUTH (owner round 7, 2026-10-05): ⌘±/⌘0 zoom the UI
		// (Electron zoomFactor) while the native traffic lights stay
		// physical-fixed — the CSS gutter lengths divide by this factor so
		// their RENDERED size never moves. getZoom covers the first-paint
		// race; every later change arrives as an lh:zoom push.
		const setZoomVar = (factor: number) =>
			document.documentElement.style.setProperty("--lh-zoom", String(factor));
		const off = window.lh?.onZoom?.(setZoomVar);
		void window.lh?.getZoom?.().then(setZoomVar);

		const stored = localStorage.getItem(STORAGE_KEY);
		// Default: open (first run introduces the sidebar).
		setOpen(stored === null ? true : stored === "1");
		setMounted(true);
		return () => off?.();
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		// Opening while narrow (auto-closed, or the user's own closed-at-
		// narrow): ask the shell to widen to the threshold — the resize
		// listener flips `narrow` and the sidebar appears. The preference
		// persists like any other open, so a restart at a narrow width
		// still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(STORAGE_KEY, "0");
			setOpen(true);
			window.lh?.expandWindow();
			return;
		}
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, [narrow, open]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "lh:toggle-sidebar" while the dispatcher sent
	// "lh:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion lh-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-9 mr-0 lh-closed-toggle",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
function sessionMeta(chat: ChatListItem): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt)}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) {
		return `Problem waiting · ${timeAgo(chat.updatedAt)}`;
	}
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			<SessionStatus busy={chat.busy || chat.compacting} />
			<span className="min-w-0 flex-1">
				{/* Titles are the learner's/teacher's WORDS — Source Sans 3, the
				    same voice the words were typed in (every input is lh-prose);
				    the meta line below stays JetBrains Mono (machine data). One
				    rule, finally applied to the picker too (owner, typography
				    round): mono = chrome, Source Sans = human words. */}
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
				<span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
			{/* The dumbbell rides the FAR RIGHT (owner round 6, 2026-10-05) —
			    was left of the name; right-aligned keeps the titles flush with
			    the teaching rows and reads cleaner. */}
			{(chat.kind ?? "teach") === "practice" && (
				<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Practice session" />
			)}
		</button>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const interactions = useOptionalInteractionLayers();
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-2"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							if (interactions && !interactions.isElementEligible(e.currentTarget)) return;
							interactions?.claimEscape(e);
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</div>
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
export type SessionKindFilter = "teach" | "all" | "practice";
const KIND_FILTER_KEY = "lh:session-kind-filter";

/** Stable empty organization for the folder dialogs while the snapshot's
 *  organization is null (the store refused the read): the dialogs stay
 *  mounted with only "Outside folders" as a target, and every submit
 *  re-plans against the live ref which reports the list as unavailable. */
const EMPTY_ORGANIZATION: SidebarOrganization = { folders: [], placements: {} };

function SessionsSidebar() {
	const interactions = useInteractionLayers();
	const { open, toggle } = useSidebar();
	const [snapshot, setSnapshot] = useState<ChatListResponse | null>(null);
	const chats = snapshot?.chats ?? null;
	const organization = snapshot?.organization ?? null;
	const dialogOrganization = organization ?? EMPTY_ORGANIZATION;
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<SessionKindFilter>("all");
	useEffect(() => {
		const stored = window.localStorage.getItem(KIND_FILTER_KEY);
		if (stored === "teach" || stored === "all" || stored === "practice") setKindFilter(stored);
	}, []);
	const setFilter = useCallback((f: SessionKindFilter) => {
		setKindFilter(f);
		window.localStorage.setItem(KIND_FILTER_KEY, f);
	}, []);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);

	/* The session list is a TREE of the shared folders carried by the same
	   snapshot. kindChats is the kind-filtered chat list (null until the
	   first snapshot); view is the rendered tree — buildSidebarFolderView
	   owns query matching, folder reveal and the visible-chat order the
	   keyboard walk follows. */
	const kindChats = useMemo(() => {
		if (!chats) return null;
		if (kindFilter === "all") return chats;
		return chats.filter((c) => (c.kind ?? "teach") === kindFilter);
	}, [chats, kindFilter]);

	/* Expansion state (owner decisions): manual expansion is a plain Set —
	   empty on load, every folder starts collapsed. While searching, branches
	   open by default and explicit collapses ride searchFolds, keyed to the
	   query text exactly like chain-table's folds — any query change resets
	   them, and clearing the query returns to the manual set untouched. */
	const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set<string>());
	const [searchFolds, setSearchFolds] = useState({ query: "", ids: new Set<string>() });
	useEffect(() => {
		setSearchFolds({ query, ids: new Set() });
	}, [query]);
	const foldedForQuery = useMemo(
		() => (searchFolds.query === query ? searchFolds.ids : new Set<string>()),
		[searchFolds, query],
	);
	const view = useMemo(
		() => (kindChats === null ? null : buildSidebarFolderView(kindChats, organization, query, expandedIds, foldedForQuery)),
		[kindChats, organization, query, expandedIds, foldedForQuery],
	);

	const toggleFolder = useCallback(
		(folderId: string) => {
			if (query.trim() === "") {
				setExpandedIds((prev) => {
					const next = new Set(prev);
					if (next.has(folderId)) next.delete(folderId);
					else next.add(folderId);
					return next;
				});
				return;
			}
			setSearchFolds((prev) => {
				const ids = new Set(prev.query === query ? prev.ids : []);
				if (ids.has(folderId)) ids.delete(folderId);
				else ids.add(folderId);
				return { query, ids };
			});
		},
		[query],
	);

	/* The list snapshot: GET /api/chats carries the chat list AND the
	   shared source organization in one payload, replaced whole on every
	   accepted read. createSidebarRefresh owns the sequence: one read at
	   a time, signals during a read queue ONE repeat, and invalidate()
	   (local edits) drops the answer already in flight. */
	const readSnapshot = useCallback(async (): Promise<ChatListResponse | null> => {
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			if (!res.ok) return null;
			const d = (await res.json()) as Partial<ChatListResponse> | null;
			if (typeof d !== "object" || d === null || !Array.isArray(d.chats)) return null;
			const org = d.organization;
			if (org === undefined) return null;
			if (org !== null) {
				const o = org as { folders?: unknown; placements?: unknown };
				if (typeof o !== "object" || o === null || !Array.isArray(o.folders) || typeof o.placements !== "object" || o.placements === null || Array.isArray(o.placements)) return null;
			}
			return { chats: d.chats, organization: org };
		} catch {
			// a transient failure keeps the last snapshot (readSnapshot → null)
			return null;
		}
	}, []);
	const acceptSnapshot = useCallback((result: ChatListResponse | null) => {
		if (result !== null) {
			setSnapshot(result);
			return;
		}
		// Whole-request failure: keep the previous snapshot with its local
		// edits; only a missing first snapshot falls back to empty.
		setSnapshot((prev) => prev ?? { chats: [], organization: null });
	}, []);
	const [sidebarRefresh] = useState(() => createSidebarRefresh(readSnapshot, acceptSnapshot));
	const invalidate = sidebarRefresh.invalidate;
	const refresh = useCallback(() => sidebarRefresh.request(), [sidebarRefresh]);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			invalidate();
			setSnapshot((prev) =>
				prev ? { ...prev, chats: prev.chats.map((c) => (c.id === id ? { ...c, title } : c)) } : prev,
			);
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [invalidate]);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;

	/* Folder writes: ONE writer serializes the sidebar's create/move
	   POSTs — a second submit while one is in flight is refused without
	   posting. afterWrite ALWAYS drops the in-flight read and re-requests
	   the snapshot (the tree renders only what GET /api/chats returns —
	   no client-side copy of the organization), and on success expands
	   the folder chain down to the write's parentId so the change is
	   visible: for create-folder that is the new folder's parent chain,
	   for move the target's. orgRef hands the once-created closures the
	   latest organization — the writer must not plan against a stale
	   render. */
	const orgRef = useRef<SidebarOrganization | null>(snapshot?.organization ?? null);
	orgRef.current = snapshot?.organization ?? null;
	const [folderWriter] = useState(() =>
		createFolderWriter({
			post: (command) => postFolderCommand(command),
			afterWrite: (command, result) => {
				invalidate();
				void refresh();
				if (!result.ok) return;
				const org = orgRef.current;
				if (org === null) return;
				const ids = folderPath(org, command.parentId);
				if (ids.length === 0) return;
				setExpandedIds((prev) => {
					const next = new Set(prev);
					for (const id of ids) next.add(id);
					return next;
				});
			},
		}),
	);

	/* Pre-send plans run against the freshest snapshot; the server stays
	   authoritative. skip (already at the target) and plan errors resolve
	   to the dialogs' string-or-null contract without a POST; only a
	   command reaches the writer. The single org-null guard stays
	   reachable: a dialog can be open when a snapshot with organization
	   null arrives. */
	const runPlan = useCallback(
		async (make: (org: SidebarOrganization) => FolderPlan): Promise<string | null> => {
			const org = orgRef.current;
			if (org === null) return "The folder list is unavailable.";
			const plan = make(org);
			if (plan.kind === "error") return plan.error;
			if (plan.kind !== "command") return null;
			const result = await folderWriter.write(plan.command);
			return result.ok ? null : result.error;
		},
		[folderWriter],
	);
	const createFolder = useCallback(
		(name: string, parentId: string | null) => runPlan((org) => planCreateFolder(org, name, parentId)),
		[runPlan],
	);
	const moveChat = useCallback(
		(chatId: string, parentId: string | null) =>
			runPlan((org) => planMoveChat(org, chatsRef.current ?? [], chatId, parentId)),
		[runPlan],
	);
	/* Chat drag & drop: the hook owns the gesture — dragChatId arms only
	   on a dragstart bubbled from this list's own SourceDragRow payload,
	   folder headers plus the Outside folders zone are the targets, and
	   a drop rides the same moveChat as the menu. */
	const drag = useSidebarDrag({
		organization,
		chats: kindChats ?? [],
		moveChat,
	});

	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					invalidate();
					setSnapshot((prev) =>
						prev ? { ...prev, chats: prev.chats.map((c) => (c.id === id ? { ...c, busy: true } : c)) } : prev,
					);
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			invalidate();
			setSnapshot((prev) =>
				prev ? { ...prev, chats: prev.chats.map((c) => (c.id === id ? { ...c, busy: false } : c)) } : prev,
			);
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh, invalidate]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. lh:turn-state +
	   lh:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	/* Chains publishes sources-changed after a folder or placement
	   write — the OPEN panel re-reads the snapshot on the same 250ms
	   debounce (a closed panel catches up on its next open fetch). */
	useServerEvent("sources-changed", () => {
		if (open) scheduleEventRefresh();
	});
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE
	   SEARCH OWNS THE WALK: ↑/↓ cycle the visible chats in tree order
	   (wrap — "cycle"), Enter opens the walked chat, or the FIRST visible
	   one when nothing is walked (owner, 2026-10-10 — the quick-open
	   pattern: ⌘⇧F, type, Enter, done). The Alt+↑/↓/↵ global cycle was
	   RETIRED the same round: barely used, felt laggy. The selection is a
	   CHAT ID into the view's visibleChatIds — chats inside collapsed
	   branches never join the walk, and a snapshot refresh can't slide the
	   highlight onto a neighbor row. Mouse and keyboard coexist: hovering
	   doesn't claim, a click or an open clears the selection. */
	const [kbdChatId, setKbdChatId] = useState<string | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);
	/* Folder dialogs: the create dialog is a boolean; the move dialog
	   holds the chat captured when the menu item was picked. */
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [moving, setMoving] = useState<ChatListItem | null>(null);
	const ctxChat = chats?.find((c) => c.id === ctxChatId) ?? null;

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxChatId(chat.id);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!interactions.isElementEligible(document.querySelector<HTMLElement>('[data-testid="session-context-menu"]'))) return;
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [ctxChatId, interactions]);

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then lh:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles), and announce the graph
	// revision so the graph view refetches (deletion is the one writer
	// the status poll can't see — no run ever transitions some→none).
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			invalidate();
			setSnapshot((prev) => {
				if (!prev) return prev;
				const chats = prev.chats.filter((c) => c.id !== id);
				if (!prev.organization) return { ...prev, chats };
				const placements = { ...prev.organization.placements };
				delete placements[id];
				return { ...prev, chats, organization: { ...prev.organization, placements } };
			});
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router, invalidate],
	);

	useEffect(() => {
		const onFocusSearch = () => {
			if (interactions.getActiveModal() || interactions.getTopLayer()?.kind === "popup") return;
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => { if (isInteractionScopeEligible(searchRef.current, interactions)) searchRef.current?.focus(); });
		};
		window.addEventListener("lh:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("lh:kbd-sessions-search", onFocusSearch);
	}, [open, toggle, interactions]);

	// Keep the kbd-selected chat row in view — folder buttons share the
	// list now, so the target is the row's own data attribute, not an index.
	useEffect(() => {
		if (kbdChatId === null) return;
		listRef.current
			?.querySelector(`[data-sidebar-chat="${CSS.escape(kbdChatId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdChatId]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0")}
			aria-hidden={!open}
		>
			<div className="flex h-full w-72 flex-col border-r bg-background">
				{/* LH wordmark — the owner's header; close toggle sits at the edge.
				    Merged chrome (2026-09-17): in Electron this band is the
				    window's drag surface and starts after the traffic lights
				    (.lh-lights-gutter); in the browser those classes are inert. */}
				<div className="lh-drag lh-lights-gutter flex items-center justify-between px-4 py-3">
					{/* The owner's mark (2026-09-17) replaces the "LH" text — still the
					    home link, still vertically centered by the band's items-center.
					    The 92px .lh-lights-gutter keeps it clear of the traffic lights
					    with the lights' own edge-inset as the gap. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Hint
						// Kept (owner, subtlety round 2026-09-25) but to the RIGHT
						// of the logo, carrying its real shortcut: ⌘G jumps to
						// the graph view (keyboard-shortcuts routes it to "/",
						// the same destination as this logo).
						label="Home"
						action="jump-graph"
						side="right"
					>
						<Link
							href="/"
							aria-label="Home"
							className="lh-no-drag flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
						>
							<LhMark className="size-6" />
						</Link>
					</Hint>
					<Hint label="Close sidebar" action="toggle-sidebar">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							onClick={toggle}
							className="lh-no-drag"
						>
							<PanelLeftCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>

				{/* Core doors always lead explicit plugin sidebar placements. */}
				<PluginSidebarActions>
					<button
						type="button"
						data-testid="new-session"
						title="Teaching"
						onClick={() => void newSession()}
						className="flex min-w-0 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3 shrink-0" />
						<span className="min-w-0 truncate">Teaching</span>
						<span className="sr-only">create a new teaching session</span>
					</button>
					<button
						type="button"
						data-testid="new-session-practice"
						title="Practice"
						onClick={() => router.push("/chat/new?mode=practice")}
						className="flex min-w-0 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DumbbellIcon className="size-3 shrink-0" />
						<span className="min-w-0 truncate">Practice</span>
						<span className="sr-only">create a new practice session</span>
					</button>
				</PluginSidebarActions>

				<div className="mx-3 mb-2 flex items-center gap-2">
					<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
					{/* New folder: only once the snapshot carries the
					    organization — with organization null the folders are
					    unknowable and the action stays hidden. */}
					{organization !== null && (
						<Hint label="New folder" side="bottom">
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="New folder"
								data-testid="new-folder"
								title="New folder"
								onClick={() => setNewFolderOpen(true)}
							>
								<FolderPlusIcon className="size-3.5" />
							</Button>
						</Hint>
					)}
					<Hint label="Search sessions" action="sessions-search" side="bottom">
					<span className="relative flex-1">
						<Input
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								// The list reorders under the query every keystroke —
								// a stale walk target would point at the wrong row.
								setKbdChatId(null);
							}}
							// THE SEARCH OWNS THE WALK (owner, 2026-10-10 — the
							// retired Alt+↑/↓/↵ cycle's successor): ↑/↓ cycle the
							// filtered rows (wrap), Enter opens the walked row —
							// or the FIRST match when nothing is walked (the
							// quick-open pattern) — then blurs (focus returns to
							// the app per the Enter law; the query stays for
							// re-searching). Esc leaves the search (owner,
							// keyboard wave): blur back to normal, and claim the
							// key so the window Esc chain (dictation / abort)
							// doesn't also fire.
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									if (!interactions.isElementEligible(e.currentTarget)) return;
									interactions.claimEscape(e);
									e.stopPropagation();
									e.currentTarget.blur();
									return;
								}
								// Modified keys belong to the surface (⇧↵ etc.).
								if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
								const ids = view?.visibleChatIds ?? [];
								if (ids.length === 0) return;
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									// The rows move, not the caret.
									e.preventDefault();
									const dir = e.key === "ArrowDown" ? 1 : -1;
									setKbdChatId((id) => nextKbdChat(ids, id, dir));
									return;
								}
								if (e.key === "Enter") {
									const target = enterKbdChat(ids, kbdChatId);
									if (!target) return;
									e.preventDefault();
									router.push(`/chat/${target}`);
									setKbdChatId(null);
									e.currentTarget.blur();
								}
							}}
							placeholder="Search…"
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
					</Hint>
				</div>

				{/* The three-way filter, HEADING THE LIST (owner round 8b,
				    2026-10-05 — moved below the search): it scopes what the
				    list shows, so it sits directly above it as a caption row;
				    search stays the top muscle-memory target. Order: Teaching /
				    Practice / All — the real modes first, "All" as the escape
				    hatch on the right, mirroring the create-buttons above.
				    Persisted client-side. */}
				<div className="mx-3 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="session-kind-filter">
					{(["teach", "practice", "all"] as const).map((f) => (
						<button
							key={f}
							type="button"
							data-testid={`kind-filter-${f}`}
							onClick={() => setFilter(f)}
							className={cn(
								"flex-1 rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors",
								kindFilter === f
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{f === "teach" ? "Teaching" : f === "all" ? "All" : "Practice"}
						</button>
					))}
				</div>

				{drag.error !== null && (
					<div role="alert" data-testid="sidebar-folder-error" className="mx-3 mb-1 text-xs text-error">
						{drag.error}
					</div>
				)}
				<div ref={listRef} className="flex-1 overflow-y-auto p-2" {...drag.containerProps}>
					{drag.dragChatId !== null && (
						<div
							data-testid="sidebar-root-drop"
							data-drop-active={String(drag.dropTarget === null)}
							{...drag.targetProps(null)}
							className={cn(
								"mb-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground",
								drag.dropTarget === null && "bg-accent/50",
							)}
						>
							Outside folders
						</div>
					)}
					{view === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : view.roots.length === 0 ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">
							{query.trim() ? "No sessions match." : "No sessions yet."}
						</div>
					) : (
						<SidebarFolderTree
							view={view}
							onToggleFolder={toggleFolder}
							drop={{ activeTarget: drag.dropTarget, targetProps: drag.targetProps }}
							renderChat={(c) => {
								/* Drag source: only a teaching chat in the
								   normal tree — a live organization, a blank
								   query and no rename in flight. Practice chats,
								   search results and the renamed row stay plain. */
								const row =
									renamingId === c.id ? (
										<RenameRow
											key={c.id}
											chat={c}
											onCommit={(next) => void commitRename(c.id, next)}
											onCancel={() => setRenamingId(null)}
										/>
									) : (
										<SessionRow
											key={c.id}
											chat={c}
											active={pathname === `/chat/${c.id}`}
											kbdSelected={c.id === kbdChatId}
											onOpen={() => {
												setKbdChatId(null);
												router.push(`/chat/${c.id}`);
											}}
											onContextMenu={(e) => openContext(e, c)}
										/>
									);
								const draggable =
									organization !== null &&
									query.trim() === "" &&
									(c.kind ?? "teach") !== "practice" &&
									renamingId !== c.id;
								return draggable ? (
									<SourceDragRow key={c.id} kind="source" id={c.id} name={c.title} enabled>
										{row}
									</SourceDragRow>
								) : (
									row
								);
							}}
						/>
					)}
				</div>

					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					<ActivitySection />

					{/* Settings entry (settings-app wave): same row language as
					    New session — quiet, bottom-pinned, opens the centered
					    dialog (also mod+, in the keyboard registry). */}
					<div className="px-3 pb-3 pt-1">
						<Hint label="Settings" action="open-settings" side="right">
							<button
								type="button"
								onClick={() => openSettings()}
								data-testid="settings-entry"
								className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<SettingsIcon className="size-3" />
								Settings
							</button>
						</Hint>
					</div>
				</div>

				{/* The context menu (wave 6 + the extraction-UX redesign): the
				    coverage block above, then exactly two management actions
				    (owner ruling — no more). MenuShell owns placement/focus/arrow
				    cycling; the dismissal effect above owns the contract. */}
				{ctxChatId !== null && (
					<MenuShell onClose={() => { setCtxChatId(null); return "closed"; }}
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						{/* The two management actions first, then the extraction block
						    (owner refinement round, 2026-09-24): Rename/Delete stay at the
						    top, the coverage numbers + Extract affordance sit below the
						    hairline — the block is info + a stateful affordance, the
						    actions above it. Fetched on menu open (the block mounts WITH
						    the menu); 409 = benign. Renders nothing on a failed read. */}
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{/* Move to folder…: teaching chats only — practice chats
						    always stay at the root, so the item would be a dead
						    end — and only once the snapshot carries the
						    organization (null = the folders are unknowable).
						    Directly after Rename, same row classes. */}
						{organization !== null && ctxChat !== null && (ctxChat.kind ?? "teach") !== "practice" && (
							<button
								type="button"
								data-testid="ctx-move-folder"
								onClick={() => {
									setCtxChatId(null);
									setMoving(ctxChat);
								}}
								className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
							>
								Move to folder…
							</button>
						)}
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
						<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
						<CoverageMenuBlock chatId={ctxChatId} />
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>

				{/* The folder dialogs — mounted only while open so each
				    opening is a fresh form; both read the live organization
				    snapshot for their target lists and writes ride the
				    single folderWriter. */}
				{newFolderOpen && (
					<NewFolderDialog
						organization={dialogOrganization}
						onClose={() => setNewFolderOpen(false)}
						onSubmit={createFolder}
					/>
				)}
				{moving !== null && (
					<MoveTargetDialog
						key={moving.id}
						chat={moving}
						organization={dialogOrganization}
						onClose={() => setMoving(null)}
						onSubmit={moveChat}
					/>
				)}
			</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	const [contentRoot, setContentRoot] = useState<HTMLElement | null>(null);
	const pathname = usePathname();
	return (
		<HostRouteLifetimeProvider pathname={pathname}>
		<HostContentRootContext.Provider value={contentRoot}>
			<InteractionLayersProvider><SettingsDialogProvider>
				<SessionsSidebar />
				<FilePathDropZone className="relative isolate min-w-0 flex-1" onContentRoot={setContentRoot}>{children}</FilePathDropZone>
				{/* The single document-level keydown listener (keyboard wave A) —
				    after the content in the tree, but it's window-level so order only
				    matters for the events it dispatches, never for DOM priority. */}
				<KeyboardShortcuts />
				<PluginWidgets />
			</SettingsDialogProvider></InteractionLayersProvider>
		</HostContentRootContext.Provider>
		</HostRouteLifetimeProvider>
	);
}
