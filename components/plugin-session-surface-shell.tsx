"use client";

import { useCallback, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { InteractionLayerOwner, useInteractionLayer, type CloseOutcome } from "./interaction-layers";
import type { SessionSurfaceBoundary } from "./plugin-session-surface-targets";

interface SurfaceRuntime {
	signal: AbortSignal;
	report(error: unknown): void;
	dispose(): void;
}
const EDITABLE_FIELDS = "input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='password'], input[type='number'], textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']";

function enterRegion(boundary: SessionSurfaceBoundary, root: HTMLElement, remembered = false) {
	const { controller } = boundary;
	if (boundary.signal.aborted || !controller.isElementEligible(root)) return;
	const active = root.ownerDocument.activeElement;
	if (active instanceof HTMLElement && root.contains(active) && controller.isElementEligible(active)) return;
	const previous = remembered ? boundary.remembered.get(root) : undefined;
	if (previous && controller.isElementEligible(previous)) { previous.focus({ preventScroll: true }); return; }
	for (const field of root.querySelectorAll<HTMLElement>(EDITABLE_FIELDS)) {
		if (field.matches("[readonly], [aria-readonly='true']") || !controller.isElementEligible(field)) continue;
		field.focus({ preventScroll: true }); return;
	}
	const heading = root.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,[role='heading']");
	if (heading && controller.isElementEligible(heading)) {
		if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
		heading.focus({ preventScroll: true });
	} else {
		if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
		root.focus({ preventScroll: true });
	}
}

/** A view, not a modal: no trap, global hiding, viewport portal or scroll lock. */
export function PluginSessionSurface({ title, onClose, runtime, boundary, opener, children }: {
	title: string;
	onClose?: () => void | Promise<void>;
	runtime: SurfaceRuntime;
	boundary: SessionSurfaceBoundary;
	opener: HTMLElement | null;
	children: ReactNode;
}) {
	const root = useRef<HTMLDivElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const headingId = useId();
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
	// covered disposal and a departing native view have no return authority.
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
		// Stack siblings share only the native owner, never another surface's
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
		<div ref={root} data-plugin-session-surface="" data-interaction-layer={layer.id}
			role="region" aria-labelledby={headingId} style={{ display: "contents" }}>
			<div data-plugin-session-surface-frame=""
				className="pointer-events-auto absolute inset-0 flex min-h-0 flex-col bg-background/80 p-4 backdrop-blur-sm"
				style={{ zIndex: 100 + layer.order }}>
			<div className="mb-2 flex shrink-0 items-center gap-2">
				<h2 id={headingId} tabIndex={-1} className="text-sm font-medium outline-none">{title}</h2>
				<button type="button" onClick={close} aria-label="Close" title="Close"
					className="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 w-full flex-1">{children}</div>
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
