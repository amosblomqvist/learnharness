"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and ✕ all close. Modal-only — /settings redirects, so
 *   nothing links into a dead surface.
 * - Left section nav in the app's mono chrome, with small decorative
 *   Lucide icons for the built-in sections; active = bg-accent. Icons
 *   inherit the row's color, without a separate palette.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
	type RefObject,
} from "react";
import { BotIcon, KeyIcon, KeyboardIcon, PaletteIcon, PlugIcon, PuzzleIcon, SettingsIcon, WaypointsIcon, type LucideIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useInteractionLayers, type CloseOutcome } from "@/components/interaction-layers";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { Hint } from "@/components/ui/hint";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { PluginsSection } from "./plugins-section.tsx";
import { PluginSettingsPage } from "./plugin-settings-page.tsx";
import { usePlugins } from "@/components/plugins";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";

/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys", label: "Providers", icon: KeyIcon },
	{ id: "agent", label: "Agent", icon: BotIcon },
	{ id: "appearance", label: "Appearance", icon: PaletteIcon },
	{ id: "graph", label: "Graph", icon: WaypointsIcon },
	{ id: "keyboard", label: "Keyboard", icon: KeyboardIcon, hint: "Stored on this device" },
	{ id: "general", label: "General", icon: SettingsIcon },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"] | "plugins" | "core-plugins" | `plugin:${string}`;

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });
// Authority belongs to the persistent Settings host, not a particular field or
// open/close lifetime: a delayed response must not roll back a newer ACK.
interface SettingsWriteOrder {
	issued: number;
	acknowledged: number;
	record?: UserSettings;
	fileAccessError?: string | null;
	listeners: Set<(record: UserSettings, fileAccessError: string | null) => void>;
}
const WriteOrderContext = createContext<RefObject<SettingsWriteOrder> | null>(null);

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const interactions = useInteractionLayers();
	const layerId = useId();
	const writeOrder = useRef<SettingsWriteOrder>({ issued: 0, acknowledged: 0, listeners: new Set() });
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const [navigationRequest, setNavigationRequest] = useState(0);
	const open = useCallback((section?: string, row?: string) => {
		// Returning to this singleton is a bounded request, not a forced pop.
		// Controlled layers may accept closure before React commits it.
		if (interactions.getLayer(layerId) && interactions.popTo(layerId) !== "closed") return;
		interactions.invalidateOpening();
		setNavigationRequest(request => request + 1);
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, [interactions, layerId]);
	const close = useCallback((): CloseOutcome => { setShow(false); return "closed"; }, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	useEffect(() => {
		const onPluginSettings = (event: Event) => {
			const pluginId: unknown = (event as CustomEvent<unknown>).detail;
			if (typeof pluginId === "string") open(`plugin:${pluginId}`);
		};
		window.addEventListener("lh:open-plugin-settings", onPluginSettings);
		return () => window.removeEventListener("lh:open-plugin-settings", onPluginSettings);
	}, [open]);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><WriteOrderContext.Provider value={writeOrder}><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={close} initialSection={landOn} initialRow={landOnRow} navigationRequest={navigationRequest} layerId={layerId} />
			)}
		</DialogContext.Provider></WriteOrderContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
	navigationRequest,
	layerId,
}: {
	onClose: () => CloseOutcome;
	initialSection: SectionId;
	navigationRequest: number;
	layerId: string;
	/** The keys-section row to unfold (see DialogContext above). */
	initialRow: string | null;
}) {
	// Keep the original visual frame and plain dim backdrop. The shared
	// untransformed boundary also contains this modal's portaled menus.
	return <SettingsDialogBody onClose={onClose} initialSection={initialSection}
		initialRow={initialRow} navigationRequest={navigationRequest}
		renderFrame={frame => <HostDialog open layerId={layerId} ownerId={null}
			onClose={onClose} frame={frame} aria-label="Settings"
			backdropProps={{
				className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80",
				"data-testid": "settings-backdrop",
			}}>{frame.props.children}</HostDialog>} />;
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
	navigationRequest = 0,
	renderFrame,
}: {
	onClose: () => void;
	/** The runtime supplies the shared modal shell; standalone SSR retains the frame. */
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
	initialSection?: SectionId;
	/** Repeated opens must retarget even when the requested section is unchanged. */
	navigationRequest?: number;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const inheritedWriteOrder = useContext(WriteOrderContext);
	const standaloneWriteOrder = useRef<SettingsWriteOrder>({ issued: 0, acknowledged: 0, listeners: new Set() });
	const writeOrder = inheritedWriteOrder ?? standaloneWriteOrder;
	const { snapshot } = usePlugins();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [fileAccessError, setFileAccessError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	// A deep-link fired while the dialog is ALREADY open (first exercised by
	// the wave-6 embedding picker's "Add a provider key first…" link — the
	// picker itself died with wave 7, the mechanism is general) changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection, navigationRequest]);

	const enabledPlugins = snapshot.plugins.filter(plugin => plugin.info.enabled);
	const activePluginId = active.startsWith("plugin:") ? active.slice("plugin:".length) : null;
	const activePlugin = enabledPlugins.find(plugin => plugin.info.id === activePluginId);
	// Keep a deep link pending while discovery loads. Once discovery settles,
	// disabled/uninstalled destinations return to management, never stale DOM.
	const missingPlugin = activePluginId !== null && !activePlugin && !snapshot.loading;
	const management = snapshot.plugins.find(plugin => plugin.info.id === activePluginId)?.info.origin === "core" ? "core-plugins" : "plugins";
	useEffect(() => {
		if (missingPlugin) setActive(management);
	}, [missingPlugin, management]);
	const selected = missingPlugin ? management : active;
	const navSections: { id: SectionId; label: string; icon?: LucideIcon }[] = [
		...SECTIONS,
		{ id: "core-plugins", label: "Core plugins", icon: PlugIcon },
		{ id: "plugins", label: "Community plugins", icon: PuzzleIcon },
		...enabledPlugins.map(plugin => ({ id: `plugin:${plugin.info.id}` as const, label: plugin.info.manifest?.name ?? plugin.info.id })),
	];

	// A save may finish after its original dialog closes. Publish its
	// acknowledged snapshot to whichever Settings instance is mounted now.
	useEffect(() => {
		const authority = writeOrder.current;
		const apply = (record: UserSettings, fileAccessError: string | null) => {
			setRecord(record);
			setFileAccessError(fileAccessError);
		};
		authority.listeners.add(apply);
		return () => { authority.listeners.delete(apply); };
	}, [writeOrder]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT.
	// A GET started before a newer acknowledged save cannot roll it back.
	useEffect(() => {
		const authority = writeOrder.current;
		const acknowledgedAtRead = authority.acknowledged;
		let alive = true;
		const applyLoaded = (loaded: UserSettings | null, fileAccessError: string | null = null) => {
			if (!alive) return;
			const unchanged = authority.acknowledged === acknowledgedAtRead;
			setRecord(unchanged ? loaded : authority.record ?? loaded);
			setFileAccessError(unchanged ? fileAccessError : authority.fileAccessError ?? null);
		};
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null; fileAccessError?: string }) =>
				applyLoaded(body.settings ?? { version: CURRENT_SETTINGS_VERSION }, body.fileAccessError ?? null),
			)
			.catch(() => applyLoaded(null));
		return () => { alive = false; };
	}, [writeOrder]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		): Promise<boolean> => {
			const ticket = ++writeOrder.current.issued;
			setError(null);
			try {
				const res = await fetch(`/api/settings/${section}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const detail = (await res.json().catch(() => ({}))) as {
						error?: string;
					};
					if (ticket === writeOrder.current.issued) setError(`${section}: ${detail.error ?? res.status}`);
					return false;
				}
				// Only the acknowledged record is canonical: never substitute the
				// request body, including when normalization leaves the old value.
				const reply = (await res.json().catch(() => null)) as { settings?: UserSettings; fileAccessError?: string } | null;
				const stored = reply?.settings;
				if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== 1 ||
					!stored[section] || typeof stored[section] !== "object" || Array.isArray(stored[section])) {
					if (ticket === writeOrder.current.issued) setError(`${section}: Could not confirm saved settings. Your input has been kept.`);
					return false;
				}
				if (ticket >= writeOrder.current.acknowledged) {
					writeOrder.current.acknowledged = ticket;
					writeOrder.current.record = stored;
					writeOrder.current.fileAccessError = reply?.fileAccessError ?? null;
					for (const apply of writeOrder.current.listeners) apply(stored, writeOrder.current.fileAccessError);
					// Every accepted response is a full canonical record, including
					// appearance saved by an earlier, still-pending section request.
					onAppearanceChange(stored.appearance);
				}
				notifySettingsSaved(section);
				return true;
			} catch (error) {
				if (ticket === writeOrder.current.issued) setError(`${section}: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		},
		[onAppearanceChange, writeOrder],
	);

	const frame = (
		<div
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			className="settings-dialog-pop flex h-[620px] max-h-[85vh] w-[920px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 className="font-title text-2xl tracking-tight">Settings</h2>
				<Hint
						// Esc closes through the shared interaction owner.
						label="Close"
						binding="escape"
						side="left"
					>
						<button
					type="button"
					aria-label="Close settings"
					data-testid="settings-close"
					className="ml-auto size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onClose}
				>
					<svg
						viewBox="0 0 16 16"
						className="mx-auto size-3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
				</button>
					</Hint>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* Left nav — mono labels and theme-inherited decorative icons,
					    active = bg-accent. */}
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className="flex min-h-0 w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2"
				>
					{navSections.map((s, index) => (
						<div key={s.id} className="shrink-0">
							{index === SECTIONS.length && <hr className="my-2 border-border" />}
							<button
								type="button"
								data-testid={`settings-nav-${s.id}`}
								aria-current={selected === s.id}
								className={`flex w-full items-center gap-2 break-words rounded-sm px-3 py-1.5 text-left font-ui text-sm transition-colors ${
									selected === s.id
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground"
								}`}
								onClick={() => setActive(s.id)}
							>
								{s.icon && <s.icon aria-hidden="true" focusable="false" className="size-3.5 shrink-0" />}
								<span className="min-w-0">{s.label}</span>
							</button>
							{s.id === "plugins" && <hr className="my-2 border-border" />}
						</div>
					))}
				</nav>

				{/* Content column — one section at a time, this scrolls — and
				    LOCKS while any MenuShell is open (owner ruling: no
				    scrolling with a dropdown down; MenuShell announces
				    open/close, the count keeps overlap honest). The lock
				    intercepts wheel/touch instead of hiding the scrollbar —
				    nothing may shift when the lock engages. */}
				<div
					ref={contentRef}
					className="min-w-0 flex-1 overflow-y-auto"
					data-testid="settings-content"
				>
					{error && !activePluginId && selected !== "plugins" && selected !== "core-plugins" && (
						<p
							role="alert"
							className="m-4 rounded-sm border border-error/40 px-3 py-2 text-xs text-error"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{selected === "plugins" || selected === "core-plugins" ? <PluginsSection origin={selected === "core-plugins" ? "core" : "community"} onOpenSettings={pluginId => setActive(`plugin:${pluginId}`)} />
						: activePlugin ? <PluginSettingsPage key={`${activePlugin.info.id}/${activePlugin.info.revision}`} plugin={activePlugin} />
							: activePluginId !== null ? <p role="status" className="px-6 py-5 text-xs text-muted-foreground">Loading plugins…</p>
								: record === undefined ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Loading settings…
						</p>
					) : record === null ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Settings could not be loaded — refresh to retry.
						</p>
					) : (
						<div>
							{active === "general" && (
								<SettingsSection
									title="General"
									testid="section-general"
								>
									<UpdateSettings
										autoUpdate={record.general?.autoUpdate ?? true}
										onAutoUpdateChange={(on) =>
											void write("general", { ...record.general, autoUpdate: on })
										}
									/>
								</SettingsSection>
							)}
							{active === "keys" && (
								<SettingsSection title="Providers" testid="section-keys">
									<KeysSection initialRow={initialRow ?? undefined} />
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection
									title="Agent"
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										fileAccessError={fileAccessError}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection
									title="Appearance"
									testid="section-appearance"
								>
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection
									title="Graph"
									testid="section-graph"
								>
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											write("graph", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "keyboard" && (
								<SettingsSection
									title="Keyboard"
									hint="Stored on this device"
									testid="section-keyboard"
								>
									<KeyboardSection />
								</SettingsSection>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}
