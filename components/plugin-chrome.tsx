"use client";

import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { EllipsisIcon, PuzzleIcon } from "lucide-react";
import type { PluginAction, PluginActionContext } from "@/src/core";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { usePlugins } from "@/components/plugins";
import { useSidebar } from "@/components/sidebar";
import { useInteractionLayers } from "@/components/interaction-layers";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";

export interface PlacedPluginAction {
	key: string;
	pluginId: string;
	action: PluginAction;
	busy: boolean;
}

/** Registration is not placement. View targets always belong to the placing plugin. */
export function placedPluginActions(plugins: readonly FrontendPlugin[], context: PluginActionContext): PlacedPluginAction[] {
	return plugins.flatMap(plugin => {
		if (!plugin.info.enabled || plugin.phase !== "active") return [];
		return plugin.placements.flatMap(placement => {
			if (placement.location !== context.placement) return [];
			if (placement.location === "top-bar") {
				if (context.placement !== "top-bar") return [];
				if (context.surface === "session" && !placement.sessions?.includes(context.kind)) return [];
				if (context.surface === "plugin-view" && (context.pluginId !== plugin.info.id || !placement.views?.includes(context.viewId))) return [];
			}
			const action = plugin.actions.find(item => item.id === placement.actionId);
			return action ? [{ key: `${plugin.info.id}/${placement.id}`, pluginId: plugin.info.id, action, busy: plugin.actionBusy.includes(action.id) }] : [];
		});
	});
}

export function pluginActionDisabled(action: PluginAction, context: PluginActionContext): boolean {
	// Plugin callbacks are trusted, but a broken predicate must not break host chrome.
	try { return typeof action.disabled === "function" ? action.disabled(context) : action.disabled === true; }
	catch { return true; }
}

function ActionIcon({ action }: { action: PluginAction }) {
	return action.icon
		? <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: action.icon }} />
		: <PuzzleIcon aria-hidden="true" className="size-4 shrink-0" />;
}

function ActionButton({ item, context, captureContext, className, iconOnly = false, menuItem = false, onRun }: {
	item: PlacedPluginAction;
	context: PluginActionContext;
	captureContext?: () => PluginActionContext | undefined;
	className: string;
	iconOnly?: boolean;
	menuItem?: boolean;
	onRun?: () => void;
}) {
	const { manager } = usePlugins();
	return <Hint label={item.action.name} side={context.placement === "graph" ? "right" : "bottom"}>
		<button type="button" role={menuItem ? "menuitem" : undefined} data-plugin-action={item.key} title={item.action.name} aria-label={item.action.name}
			disabled={item.busy || pluginActionDisabled(item.action, context)} aria-busy={item.busy || undefined}
			className={`${className} disabled:pointer-events-none disabled:opacity-40`}
			onClick={() => { void manager?.runAction(item.pluginId, item.action, () => { const captured = captureContext ? captureContext() : context; if (captured) onRun?.(); return captured; }); }}>
			<ActionIcon action={item.action} />
			{!iconOnly && <span className="min-w-0 truncate">{item.action.name}</span>}
		</button>
	</Hint>;
}

const SIDEBAR_CONTEXT = { placement: "sidebar", surface: "sidebar" } as const;
const GRAPH_CONTEXT = { placement: "graph", surface: "graph" } as const;
const SIDEBAR_BUTTON = "flex min-w-0 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const TOP_BUTTON = "flex h-9 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** Core teaching/practice children lead the same row-major grid as placed actions. */
export function PluginSidebarActions({ children }: { children: ReactNode }) {
	const { snapshot } = usePlugins();
	const actions = placedPluginActions(snapshot.plugins, SIDEBAR_CONTEXT);
	const count = Children.count(children) + actions.length;
	return <div data-testid="sidebar-actions" className={`lh-plugin-scroll mx-3 mb-2 grid max-h-[10.25rem] shrink-0 gap-1.5 overflow-y-auto ${count >= 6 ? "grid-cols-2" : "grid-cols-1"}`}>
		{children}
		{actions.map(item => <ActionButton key={item.key} item={item} context={SIDEBAR_CONTEXT} className={SIDEBAR_BUTTON} />)}
	</div>;
}

export function PluginGraphActions() {
	const { snapshot } = usePlugins();
	const { open } = useSidebar();
	const actions = placedPluginActions(snapshot.plugins, GRAPH_CONTEXT);
	if (!actions.length) return null;
	// Only buttons intercept canvas input. Wheel events over a button still
	// bubble to this scroll container; transparent gaps target the canvas.
	return <div data-testid="plugin-graph-actions" aria-label="Plugin graph actions"
		className={`lh-plugin-scroll lh-no-drag pointer-events-none absolute bottom-0 left-0 z-10 flex w-[3.25rem] flex-col gap-2 overflow-y-auto p-2 ${open ? "top-0" : "lh-plugin-graph-closed top-11"}`}>
		{actions.map(item => <ActionButton key={item.key} item={item} context={GRAPH_CONTEXT} iconOnly
			className="pointer-events-auto flex size-9 shrink-0 items-center justify-center rounded-xl border bg-card/85 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent hover:text-foreground" />)}
	</div>;
}

/** Count whole buttons only; reserve the overflow trigger whenever any do not fit. */
export function fitPluginTopBarActions(widths: readonly number[], available: number, gap = 4, trigger = 36): number {
	const all = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
	if (all <= available) return widths.length;
	let used = trigger, count = 0;
	for (const width of widths) {
		if (used + gap + width > available) break;
		used += gap + width; count++;
	}
	return count;
}

/** Draft notifications refresh action predicates, not the owning session transcript. */
export function PluginSessionTopBarActions({ readContext, captureContext, refreshRef }: {
	readContext: () => Extract<PluginActionContext, { placement: "top-bar"; surface: "session" }> | undefined;
	captureContext: () => PluginActionContext | undefined;
	refreshRef: RefObject<(() => void) | null>;
}) {
	const [, refresh] = useState(0);
	useLayoutEffect(() => {
		const notify = () => refresh(value => value + 1);
		refreshRef.current = notify;
		return () => { if (refreshRef.current === notify) refreshRef.current = null; };
	}, [refreshRef]);
	// Each render needs a new context: its lazy view getter caches a snapshot.
	const context = readContext();
	return context ? <PluginTopBarActions context={context} captureContext={captureContext} /> : null;
}

export function PluginTopBarActions({ context, captureContext }: { context: Extract<PluginActionContext, { placement: "top-bar" }>; captureContext?: () => PluginActionContext | undefined }) {
	const { snapshot } = usePlugins();
	const actions = placedPluginActions(snapshot.plugins, context);
	const root = useRef<HTMLDivElement>(null);
	const probes = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const [visible, setVisible] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const interactions = useInteractionLayers();
	const count = Math.min(visible, actions.length);
	const excess = actions.slice(count);
	const signature = actions.map(item => `${item.key}:${item.action.name}`).join("|");

	useLayoutEffect(() => {
		const host = root.current;
		const header = host?.closest("header");
		if (!host || !header || !probes.current) return;
		let active = true;
		const measure = () => {
			if (!active || !probes.current) return;
			const style = getComputedStyle(header);
			const siblings = Array.from(header.children).filter(child => child !== host) as HTMLElement[];
			const gap = parseFloat(style.columnGap) || 0;
			let available = header.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - gap * siblings.length;
			let title: HTMLElement | undefined;
			for (const sibling of siblings) {
				if (sibling.hasAttribute("data-plugin-chrome-title")) { title = sibling; continue; }
				const css = getComputedStyle(sibling);
				const width = Number(css.flexGrow) > 0 ? parseFloat(css.minWidth) || 0 : sibling.getBoundingClientRect().width;
				available -= width + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
			}
			// Long titles may truncate, but never take the only overflow trigger's slot.
			if (title) available -= Math.min(title.scrollWidth, Math.max(0, available - 36));
			const widths = Array.from(probes.current!.children).map(child => child.getBoundingClientRect().width);
			setVisible(fitPluginTopBarActions(widths, Math.max(36, available)));
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		observer?.observe(header);
		for (const sibling of Array.from(header.children)) if (sibling !== host) observer?.observe(sibling);
		window.addEventListener("resize", measure);
		void document.fonts?.ready.then(measure);
		return () => { active = false; observer?.disconnect(); window.removeEventListener("resize", measure); };
	}, [signature]);

	useEffect(() => {
		if (!excess.length) setMenuOpen(false);
	}, [excess.length]);

	useEffect(() => {
		if (!menuOpen) return;
		const dismiss = (event: PointerEvent) => {
			const popup = interactions.getTopLayer();
			if (popup?.kind !== "popup" || popup.anchorRef?.current !== trigger.current || !interactions.isElementEligible(popup.rootRef.current)) return;
			const target = event.target as Node;
			if (!root.current?.contains(target) && !popup.rootRef.current?.contains(target)) setMenuOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => { document.removeEventListener("pointerdown", dismiss); };
	}, [menuOpen, interactions]);

	if (!actions.length) return null;
	return <div ref={root} data-testid="plugin-top-bar-actions" className="lh-no-drag relative flex shrink-0 items-center gap-1">
		{/* Off-flow intrinsic probes never create focus targets or drag-mask holes. */}
		<div ref={probes} aria-hidden="true" className="pointer-events-none invisible fixed left-0 top-0 flex w-max gap-1">
			{actions.map(item => <span key={item.key} className={TOP_BUTTON}><ActionIcon action={item.action} /><span className="min-w-0 truncate">{item.action.name}</span></span>)}
		</div>
		{actions.slice(0, count).map(item => <ActionButton key={item.key} item={item} context={context} captureContext={captureContext} className={TOP_BUTTON} />)}
		{excess.length > 0 && <Hint label="More plugin actions" side="bottom"><button ref={trigger} type="button" title="More plugin actions" aria-label="More plugin actions"
			aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}
			className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><EllipsisIcon className="size-4" /></button></Hint>}
		{menuOpen && excess.length > 0 && <MenuShell anchorRef={trigger} testid="plugin-top-bar-menu" onClose={(reason) => { setMenuOpen(false); if (reason === "escape") trigger.current?.focus(); return "closed"; }} preferredSide="down" align="right"
			menuClass="lh-no-drag w-64 rounded-xl border border-border bg-popover p-1 shadow-lg">
			<div role="menu" aria-label="More plugin actions">
			{excess.map(item => <ActionButton key={item.key} item={item} context={context} captureContext={captureContext} menuItem onRun={() => setMenuOpen(false)}
				className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground" />)}
			</div>
		</MenuShell>}
	</div>;
}
