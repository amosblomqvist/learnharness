"use client";

import { useCallback, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { InteractionLayerOwner, useInteractionLayer, type CloseOutcome } from "./interaction-layers";
import type { SurfaceBoundary } from "./plugin-surface-targets";
import type { PluginSurfaceProps } from "@/src/core";

interface SurfaceRuntime {
	signal: AbortSignal;
	report(error: unknown): void;
	dispose(): void;
}
const EDITABLE_FIELDS = "input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='password'], input[type='number'], textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']";

function enterRegion(boundary: SurfaceBoundary, root: HTMLElement, remembered = false) {
	const { controller } = boundary;
	if (boundary.signal.aborted || !controller.isElementEligible(root)) return;
	const active = root.ownerDocument.activeElement;
	if (active instanceof HTMLElement && root.contains(active) && controller.isElementEligible(active)) return;
	const previous = remembered ? boundary.remembered.get(root) : undefined;
	if (previous && controller.isElementEligible(previous)) { previous.focus({ preventScroll: true }); return; }
	// Opt-in content entry only. Owning-page/native return policy is unchanged.
	if (root.hasAttribute("data-plugin-session-surface")) {
		const marked = [...root.querySelectorAll<HTMLElement>("[data-plugin-initial-focus]")].find(element => controller.isElementEligible(element));
		if (marked) {
			marked.focus({ preventScroll: true });
			if (root.ownerDocument.activeElement === marked) return;
		}
	}
	for (const field of root.querySelectorAll<HTMLElement>(EDITABLE_FIELDS)) {
		if (field.matches("[readonly], [aria-readonly='true']") || !controller.isElementEligible(field)) continue;
		field.focus({ preventScroll: true }); return;
	}
	const heading = root.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,[role='heading']");
	if (heading && controller.isElementEligible(heading)) {
		if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
		heading.focus({ preventScroll: true });
	} else {
		// The semantic surface root is display:contents; focus its painted frame.
		const fallback = root.querySelector<HTMLElement>("[data-plugin-session-surface-frame]") ?? root;
		if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
		fallback.focus({ preventScroll: true });
	}
}

/** A view, not a modal: no trap, global hiding, viewport portal or scroll lock. */
export function PluginSurface({ pluginId, title, background = "dimmed", onClose, runtime, boundary, opener, children }: {
	pluginId?: string;
	title: string;
	background?: PluginSurfaceProps["background"];
	onClose?: () => void | Promise<void>;
	runtime: SurfaceRuntime;
	boundary: SurfaceBoundary;
	opener: HTMLElement | null;
	children: ReactNode;
}) {
	const root = useRef<HTMLDivElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const layerId = useId();
	const controller = boundary.controller;
	const closing = useRef(false);
	const entered = useRef(false);
	const close = (): CloseOutcome => {
		if (closing.current || runtime.signal.aborted) return "closed";
		closing.current = true;
		try { void Promise.resolve(onClose?.()).catch(runtime.report); } catch (error) { runtime.report(error); }
		runtime.dispose();
		return "closed";
	};
	const focusInitial = useCallback(() => {
		if (controller.getTopLayer()?.id === layerId && root.current) enterRegion(boundary, root.current);
	}, [boundary, controller, layerId]);
	// Capture authority BEFORE useInteractionLayer's registration cleanup. A
	// covered disposal and a departing page have no return authority.
	useLayoutEffect(() => () => {
		if (boundary.signal.aborted || controller.getTopLayer()?.id !== layerId) return;
		const generation = controller.getGeneration() + 1;
		const revision = controller.getFocusRevision();
		queueMicrotask(() => {
			if (boundary.signal.aborted || controller.getGeneration() !== generation || controller.getFocusRevision() !== revision) return;
			if (controller.isElementEligible(opener)) { opener!.focus({ preventScroll: true }); return; }
			const foreground = [...controller.getSnapshot()].reverse().find(layer => layer.kind === "view" && layer.rootRef.current && boundary.stack?.contains(layer.rootRef.current));
			const surviving = foreground?.rootRef.current ?? boundary.body;
			enterRegion(boundary, surviving, true);
		});
	}, [boundary, controller, layerId, opener]);
	const layer = useInteractionLayer({
		id: layerId, kind: "view", enabled: !runtime.signal.aborted && !boundary.signal.aborted,
		// Stack siblings share only the page owner, never another surface's
		// lifecycle (a menu/dialog may explicitly own a surface descendant).
		ownerId: controller.ownerOf(boundary.body)?.id ?? null,
		rootRef: root, portalRef: popup, onClose: close, focusInitial,
	});
	useLayoutEffect(() => {
		if (runtime.signal.aborted) return;
		if (boundary.signal.aborted || !boundary.stack?.isConnected || !boundary.body.isConnected) {
			runtime.report(new Error("Surface target is no longer active")); runtime.dispose(); return;
		}
		if (!layer.isTop || entered.current) return;
		entered.current = true;
		focusInitial();
	}, [boundary, runtime, layer.isTop, focusInitial]);
	return <InteractionLayerOwner.Provider value={layer.id}>
		<div ref={root} data-plugin-session-surface="" data-plugin-shortcut-owner={pluginId} data-interaction-layer={layer.id}
			role="region" aria-label={title} style={{ display: "contents" }}>
			<div data-plugin-session-surface-frame="" tabIndex={-1} aria-label={title}
				className={`pointer-events-auto absolute inset-0 flex min-h-0 flex-col overflow-hidden outline-none ${background === "opaque" ? "bg-background" : "bg-background/80 backdrop-blur-sm"}`}
				style={{ zIndex: 100 + layer.order }}>
			<div className="min-h-0 w-full flex-1 overflow-y-auto">{children}</div>
			<button type="button" onClick={close} aria-label="Close" title="Close"
				className="absolute right-2 top-2 z-10 size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				<svg viewBox="0 0 16 16" className="mx-auto size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
					<path d="M4 4l8 8M12 4l-8 8" />
				</svg>
			</button>
			</div>
			{/* Same INTEGER rank, after the frame: even passive z-50 tooltips
			    paint above this frame, while the host remains below newer views.
			    No transform: fixed-position popup geometry remains viewport-based. */}
			<div ref={popup} data-interaction-popup-host={layer.id}
				className="pointer-events-none [&>*]:pointer-events-auto"
				style={{ position: "absolute", inset: 0, zIndex: 100 + layer.order }} />
		</div>
	</InteractionLayerOwner.Provider>;
}
