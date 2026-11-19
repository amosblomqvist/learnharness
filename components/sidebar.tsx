"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteFolderDialog, DeleteSessionDialog, folderDeleteCopy, type DeleteDialogCopy } from "@/components/delete-session-dialog";
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
import { buildSessionTree, flattenSessionTree, folderDeletionScope, placementOf, type FolderDeletionScope, type SessionTreeNode } from "@/src/core";
import { useSourceDirectory } from "@/components/source-directory";
import { NewFolderRow, SidebarFolderRow, SidebarFolderRule, SIDEBAR_COMPACT_ROW, sidebarNameFont, sidebarRail, sidebarRowBox, useOpenFolders, useSidebarDrop } from "@/components/sidebar-folders";
import { useAppearance } from "@/components/settings/appearance";
import { SourceDragRow } from "@/components/source-folder-tree";
import { OverlayScrollArea } from "@/components/overlay-scroll";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";
import { kbdEventForAction } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { PluginWidgets } from "@/components/plugins";
import { PluginSidebarActions } from "@/components/plugin-chrome";
import { HostContentRootContext, HostRouteLifetimeProvider } from "@/components/host-content-root";
import { isInteractionScopeEligible } from "@/components/plugin-input-focus";
import { InteractionLayersProvider, useInteractionLayers, useOptionalInteractionLayers } from "@/components/interaction-layers";
import { StartupMessage, type StartupMessageOffer } from "@/components/startup-message";

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
			takeStartupMessage?: () => Promise<StartupMessageOffer | null>;
			dismissStartupMessage?: (id: string) => Promise<boolean>;
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
	depth = 0,
	compact = false,
}: {
	chat: ChatListItem;
	compact?: boolean;
	active: boolean;
	onOpen: () => void;
	/** Folder depth in the sidebar tree (0 = unfiled). */
	depth?: number;
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
			data-session-id={chat.id}
			className={cn(
				"relative flex w-full items-center gap-2 pr-3 text-left hover:bg-accent",
				compact ? SIDEBAR_COMPACT_ROW : "py-2",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-inset ring-border",
			)}
			style={{ paddingLeft: sidebarRowBox(depth).paddingLeft }}
		>
			<SessionStatus busy={chat.busy || chat.compacting} />
			<span className="min-w-0 flex-1">
				<span className={cn("block truncate", sidebarNameFont(compact))}>{chat.title}</span>
				{!compact && <span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>}
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
 *  The row retains the list's density mid-edit. */
export function RenameRow({ chat, onCommit, onCancel, depth = 0, compact = false }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void; depth?: number; compact?: boolean }) {
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
			className={cn("relative flex w-full items-center bg-accent pr-3", compact ? SIDEBAR_COMPACT_ROW : "py-2")}
			style={{ paddingLeft: sidebarRowBox(depth).paddingLeft }}
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
					className={cn("w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none", compact ? sidebarNameFont(true) : "lh-input")}
				/>
				{!compact && <span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>}
			</span>
		</div>
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
export type SessionKindFilter = "teach" | "all" | "practice";
const KIND_FILTER_KEY = "lh:session-kind-filter";

function SessionsSidebar() {
	const { appearance: { compactSessionList } } = useAppearance();
	const interactions = useInteractionLayers();
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
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

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. FOLDERS
	 * (approved plan): the list is the shared source organization's tree;
	 * the type filter still narrows sessions first, search keeps matching
	 * titles only, and each tree level ranks by match while searching.
	 * Outside search every level orders by recent activity. Any active
	 * filter or search hides folders without matches. */
	const { directory, failure: folderFailure, clearFailure: clearFolderFailure, reportFailure: reportFolderFailure, change: changeFolders } = useSourceDirectory(open);
	const organization = directory?.organization;
	const { openFolders, setOpen: setFolderOpen } = useOpenFolders();
	const searching = query.trim() !== "";
	// Search shows every folder open; collapsing one there affects only that
	// search, never the remembered open/closed state.
	const [searchFolds, setSearchFolds] = useState<{ query: string; ids: ReadonlySet<string> }>({ query: "", ids: new Set() });
	const searchFolded = useCallback((id: string) => searchFolds.query === query && searchFolds.ids.has(id), [searchFolds, query]);
	const isFolderOpen = useCallback((id: string) => searching ? !searchFolded(id) : openFolders.has(id), [searching, searchFolded, openFolders]);
	const toggleFolder = useCallback((id: string) => {
		if (searching) {
			setSearchFolds((previous) => {
				const ids = new Set(previous.query === query ? previous.ids : []);
				if (ids.has(id)) ids.delete(id); else ids.add(id);
				return { query, ids };
			});
			return;
		}
		setFolderOpen(id, !openFolders.has(id));
	}, [searching, query, openFolders, setFolderOpen]);
	const tree = useMemo(() => {
		if (!chats) return null;
		const include = kindFilter === "all" ? undefined : (c: ChatListItem) => (c.kind ?? "teach") === kindFilter;
		return buildSessionTree(chats, organization, { query, include });
	}, [chats, kindFilter, organization, query]);
	const rows = useMemo(() => tree && flattenSessionTree(tree, isFolderOpen), [tree, isFolderOpen]);
	// The keyboard walk follows the visible session rows in tree order.
	const shown = useMemo(() => rows?.flatMap((r) => r.type === "session" ? [r.session] : []) ?? null, [rows]);

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const d = (await res.json()) as { chats: ChatListItem[] };
			setChats(d.chats);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

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
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh]);

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
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE SEARCH OWNS THE
	   WALK: ↑/↓ cycle the filtered list (wrap — "cycle"), Enter opens the
	   walked row, or the FIRST match when nothing is walked (owner,
	   2026-10-10 — the quick-open pattern: ⌘⇧F, type, Enter, done). The
	   Alt+↑/↓/↵ global cycle was RETIRED the same round: barely used,
	   felt laggy. The selection is a row index into `shown`, so the walk
	   follows whatever the query + kind filter leave. Mouse and keyboard
	   coexist: hovering doesn't claim, a click or an open clears the
	   selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
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

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxFolderId(null);
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
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
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

	// Keep the kbd-selected row in view.
	const kbdId = kbdIndex === null ? null : shown?.[kbdIndex]?.id ?? null;
	useEffect(() => {
		if (kbdId === null) return;
		listRef.current?.querySelector(`[data-session-id="${CSS.escape(kbdId)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [kbdId]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	/* ── Folders (approved plan): drag to move, right-click a folder for
	   Rename / New subfolder / Delete. ── */
	const folderDrop = useSidebarDrop(organization, changeFolders);
	const [creatingFolder, setCreatingFolder] = useState<{ parentId: string | null } | null>(null);
	const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
	const [ctxFolderId, setCtxFolderId] = useState<string | null>(null);
	const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string; copy: DeleteDialogCopy; scope: FolderDeletionScope } | null>(null);
	const folderAnchorRef = useRef<HTMLElement | null>(null);
	const openFolderContext = (e: React.MouseEvent<HTMLButtonElement>, id: string) => {
		e.preventDefault();
		folderAnchorRef.current = e.currentTarget;
		setCtxChatId(null);
		setCtxFolderId(id);
	};
	useEffect(() => {
		if (ctxFolderId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!interactions.isElementEligible(document.querySelector<HTMLElement>('[data-testid="folder-context-menu"]'))) return;
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (folderAnchorRef.current?.contains(target)) return;
			setCtxFolderId(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [ctxFolderId, interactions]);
	// A folder deletion's success: the session Delete's, for every session
	// that went (list patch, home if the open one died, graph refetch).
	const onFolderDeleted = useCallback(({ deletedChatIds, graphRevision }: { deletedChatIds: string[]; graphRevision: number }) => {
		setDeletingFolder(null);
		const gone = new Set(deletedChatIds);
		setChats((prev) => (prev ? prev.filter((c) => !gone.has(c.id)) : prev));
		const openId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
		if (openId !== null && gone.has(openId)) router.push("/");
		window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
	}, [pathname, router]);
	// The folder Delete (owner, 2026-11-18): the folder, its subfolders and
	// every session inside go — practice sessions hidden by the type filter
	// included — after the session dialog's confirmation; imported notes
	// inside move to the parent. A folder without sessions goes at once.
	const deleteFolder = (id: string) => {
		if (!directory) return;
		const organization = directory.organization;
		const folder = organization.folders.find((f) => f.id === id);
		const scope = folderDeletionScope(directory, id);
		if (!folder || !scope) return;
		setCtxFolderId(null);
		clearFolderFailure();
		if (scope.chatIds.length === 0) {
			void fetch(`/api/graph/sources/folders/${encodeURIComponent(id)}?mode=preserve-graph`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(scope),
			})
				.then(async (res) => { if (!res.ok) reportFolderFailure(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not delete the folder (${res.status}).`); })
				.catch(() => reportFolderFailure("Could not delete the folder — network error."));
			return;
		}
		const copy = folderDeleteCopy({
			sessions: scope.chatIds.length,
			subfolders: scope.folderIds.length - 1,
			notes: scope.noteIds.length,
			parentName: folder.parentId === null ? null : organization.folders.find((f) => f.id === folder.parentId)?.name ?? null,
		});
		setDeletingFolder({ id, name: folder.name, copy, scope });
	};

	const renderTree = (nodes: SessionTreeNode<ChatListItem>[], depth: number): React.ReactNode => nodes.map((node, index) => {
		if (node.type === "session") {
			const c = node.session;
			const placedIn = organization ? placementOf(organization, c.id)?.folderId ?? null : null;
			return (
				<SourceDragRow key={c.id} kind="source" id={c.id} name={c.title} enabled={Boolean(organization) && renamingId !== c.id}
					className="relative" style={{ marginLeft: sidebarRowBox(depth).marginLeft }} {...folderDrop.dropProps(placedIn)}>
					{renamingId === c.id ? (
						<RenameRow
							chat={c}
							depth={depth}
							compact={compactSessionList}
							onCommit={(next) => void commitRename(c.id, next)}
							onCancel={() => setRenamingId(null)}
						/>
					) : (
						<SessionRow
							chat={c}
							depth={depth}
							compact={compactSessionList}
							active={pathname === `/chat/${c.id}`}
							kbdSelected={kbdId === c.id}
							onOpen={() => {
								setKbdIndex(null);
								router.push(`/chat/${c.id}`);
							}}
							onContextMenu={(e) => openContext(e, c)}
						/>
					)}
				</SourceDragRow>
			);
		}
		const folder = node.folder;
		const folderOpen = isFolderOpen(folder.id);
		const creatingHere = creatingFolder?.parentId === folder.id;
		const contentsShown = folderOpen && (node.children.length > 0 || creatingHere);
		return (
			<div key={folder.id} data-testid={`sidebar-folder-branch-${folder.id}`} className="relative" {...folderDrop.dropProps(folder.id)}>
				{/* Adjacent folders share one rule. Expanded folders use the
				    same outer rules, with no line under the folder heading. */}
				{nodes[index - 1]?.type !== "folder" && <SidebarFolderRule depth={depth} edge="top" />}
				{/* Keep the guide joined to the bottom rule below the last item. */}
				{contentsShown && (
					<div aria-hidden="true" data-testid={`sidebar-folder-thread-${folder.id}`} className="pointer-events-none absolute top-[23px] bottom-0 w-px bg-border/50"
						style={{ left: sidebarRail(depth) }} />
				)}
				<SidebarFolderRow
					folder={folder}
					depth={depth}
					open={folderOpen}
					compact={compactSessionList}
					draggable={Boolean(organization)}
					dropActive={folderDrop.dropTarget === folder.id}
					renaming={renamingFolderId === folder.id}
					onToggle={() => toggleFolder(folder.id)}
					onContextMenu={(e) => openFolderContext(e, folder.id)}
					onRename={(name) => changeFolders({ action: "rename-folder", id: folder.id, name })}
					onRenameDone={() => setRenamingFolderId(null)}
				/>
				{folderOpen && creatingHere && (
					<NewFolderRow depth={depth + 1} compact={compactSessionList} onDone={() => setCreatingFolder(null)}
						onCreate={(name) => changeFolders({ action: "create-folder", name, parentId: folder.id })} />
				)}
				{folderOpen && renderTree(node.children, depth + 1)}
				<SidebarFolderRule depth={depth} edge="bottom" />
			</div>
		);
	});

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
					<Hint label="Search sessions" action="sessions-search" side="bottom">
					<span className="relative flex-1">
						<Input
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								// The list reorders under the query every keystroke —
								// a stale walk index would point at the wrong row.
								setKbdIndex(null);
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
								const n = shown?.length ?? 0;
								if (n === 0) return;
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									// The rows move, not the caret.
									e.preventDefault();
									const dir = e.key === "ArrowDown" ? 1 : -1;
									setKbdIndex((i) =>
										i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n,
										);
									return;
								}
								if (e.key === "Enter") {
									const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
									if (!target) return;
									e.preventDefault();
									router.push(`/chat/${target.id}`);
									setKbdIndex(null);
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
					{organization && (
						<Hint label="Add folder" side="bottom">
							<button
								type="button"
								aria-label="Add folder"
								data-testid="sidebar-add-folder"
								onClick={() => setCreatingFolder({ parentId: null })}
								className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<FolderPlusIcon className="size-3.5" />
							</button>
						</Hint>
					)}
				</div>

				{/* The three-way filter, HEADING THE LIST (owner round 8b,
				    2026-10-05 — moved below the search): it scopes what the
				    list shows, so it sits directly above it as a caption row;
				    search stays the top muscle-memory target. Order: Teaching /
				    Practice / All — the real modes first, "All" as the escape
				    hatch on the right, mirroring the create-buttons above.
				    Persisted client-side. */}
				<div data-testid="session-kind-filter-band" className="pb-2">
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
				</div>

				{folderFailure && (
					<div role="alert" data-testid="sidebar-folder-error" className="mx-3 mt-2 flex items-start gap-2 text-xs text-error">
						<span className="min-w-0 flex-1">{folderFailure}</span>
						<button type="button" onClick={clearFolderFailure} className="shrink-0 text-muted-foreground hover:text-foreground">Dismiss</button>
					</div>
				)}

				{/* The bar overlays the rows (owner polish round): rules and
				    highlights run to the edge; it shows while scrolling/hovering. */}
				<OverlayScrollArea scrollRef={listRef} data-testid="session-list" className="flex flex-col" {...folderDrop.containerProps}>
					{(creatingFolder?.parentId === null || (rows !== null && rows.length > 0)) && (
						<div data-testid="session-rows">
							{creatingFolder?.parentId === null && (
								<NewFolderRow depth={0} compact={compactSessionList} onDone={() => setCreatingFolder(null)}
									onCreate={(name) => changeFolders({ action: "create-folder", name, parentId: null })} />
							)}
							{renderTree(tree ?? [], 0)}
						</div>
					)}
					{rows === null ? (
						<div className="px-4 py-4 text-xs text-muted-foreground">Loading…</div>
					) : rows.length === 0 && (
						<div className="px-4 py-4 text-xs text-muted-foreground">
							{query.trim() ? "No sessions match." : "No sessions yet."}
						</div>
					)}
					{/* Empty space below the list: drop here to move out of all folders. */}
					{organization && (
						<div data-testid="sidebar-root-drop" aria-label="Move outside folders" data-drop-active={folderDrop.dropTarget === null}
							className={cn("min-h-16 flex-1 transition-colors", folderDrop.dropTarget === null && "bg-accent/30")}
							{...folderDrop.dropProps(null)} />
					)}
				</OverlayScrollArea>

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

				{/* The folder menu (approved plan): Rename, New subfolder, Delete.
				    Delete only removes folders that are empty everywhere and
				    otherwise explains why, keeping the menu open. */}
				{ctxFolderId !== null && (
					<MenuShell onClose={() => { setCtxFolderId(null); return "closed"; }}
						anchorRef={folderAnchorRef}
						testid="folder-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						<button
							type="button"
							data-testid="folder-ctx-rename"
							onClick={() => { setRenamingFolderId(ctxFolderId); setCtxFolderId(null); }}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						<button
							type="button"
							data-testid="folder-ctx-new-subfolder"
							onClick={() => {
								const id = ctxFolderId;
								setCtxFolderId(null);
								if (searching) setSearchFolds((previous) => ({ query, ids: new Set([...(previous.query === query ? previous.ids : [])].filter((f) => f !== id)) }));
								else setFolderOpen(id, true);
								setCreatingFolder({ parentId: id });
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							New subfolder
						</button>
						<button
							type="button"
							data-testid="folder-ctx-delete"
							onClick={() => deleteFolder(ctxFolderId)}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete
						</button>
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>
				<DeleteFolderDialog
					folder={deletingFolder}
					onClose={() => setDeletingFolder(null)}
					onStale={(message) => {
						setDeletingFolder(null);
						reportFolderFailure(message);
					}}
					onDeleted={onFolderDeleted}
				/>
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
				<StartupMessage />
			</SettingsDialogProvider></InteractionLayersProvider>
		</HostContentRootContext.Provider>
		</HostRouteLifetimeProvider>
	);
}
