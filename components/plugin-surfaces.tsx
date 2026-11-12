"use client";

import { useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { PluginSurfaceTarget } from "@/src/core";
import { useInteractionLayers } from "./interaction-layers";
import { findSurfaceBoundary, registerSurfaceBoundary } from "./plugin-surface-targets";

/** A re-entered (even hide-retained) view always receives a fresh target. */
export function usePageSurfaceBoundary({ active, viewKey, bodyRef }: {
	active: boolean;
	viewKey: string;
	bodyRef: RefObject<HTMLElement | null>;
}): PluginSurfaceTarget | undefined {
	const controller = useInteractionLayers();
	const [current, setCurrent] = useState<{ viewKey: string; target: PluginSurfaceTarget }>();
	useLayoutEffect(() => {
		if (!active || !bodyRef.current) return;
		const lifetime = new AbortController();
		const boundary = registerSurfaceBoundary(bodyRef.current, lifetime.signal, controller);
		setCurrent({ viewKey, target: boundary.target });
		return () => lifetime.abort();
	}, [active, viewKey, bodyRef, controller]);
	return active && current?.viewKey === viewKey && findSurfaceBoundary(current.target) ? current.target : undefined;
}

/** Floating page chrome shares only its own plugin surfaces' integer rank.
 * Callers render it after the body; newer pane pickers keep their higher rank. */
export function useSurfaceChromeStyle(target: PluginSurfaceTarget | undefined): CSSProperties | undefined {
	const controller = useInteractionLayers();
	const layers = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
	const boundary = findSurfaceBoundary(target);
	let order = 0;
	for (const layer of layers) {
		const root = layer.rootRef.current;
		if (root?.hasAttribute("data-plugin-session-surface") && boundary?.stack?.contains(root)) order = Math.max(order, layer.order);
	}
	return order ? { zIndex: 100 + order } : undefined;
}

/** Geometry and coverage for page views, without a separate stacking context.
 * Frames share the host main pane's isolated paint stratum with pane pickers;
 * global body dialogs remain above it even when a view opens asynchronously. */
export function SurfaceRegion({ target, children }: { target: PluginSurfaceTarget | undefined; children?: ReactNode }) {
	const controller = useInteractionLayers();
	const [stack, setStack] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const boundary = findSurfaceBoundary(target);
		if (!boundary || !stack) return;
		boundary.stack = stack;
		const retained = new Map<HTMLElement, { inert: string | null; hidden: string | null }>();
		const restore = (element: HTMLElement) => {
			const original = retained.get(element);
			if (!original) return;
			for (const [name, value] of [["inert", original.inert], ["aria-hidden", original.hidden]] as const) {
				if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
			}
			retained.delete(element);
		};
		const reconcile = () => {
			const views = controller.getSnapshot().filter(layer => layer.kind === "view" && !!layer.rootRef.current && stack.contains(layer.rootRef.current));
			const foreground = views.at(-1)?.rootRef.current;
			const covered = new Set<HTMLElement>();
			if (foreground) {
				for (const child of boundary.body.children) if (child !== stack && child instanceof HTMLElement) covered.add(child);
				for (const view of views) if (view.rootRef.current && view.rootRef.current !== foreground) covered.add(view.rootRef.current);
			}
			for (const element of retained.keys()) if (!covered.has(element)) restore(element);
			for (const element of covered) {
				if (!retained.has(element)) retained.set(element, { inert: element.getAttribute("inert"), hidden: element.getAttribute("aria-hidden") });
				element.setAttribute("inert", "");
				element.setAttribute("aria-hidden", "true");
			}
		};
		const remember = (event: FocusEvent) => {
			const element = event.target;
			if (!(element instanceof HTMLElement)) return;
			const owner = controller.ownerOf(element)?.rootRef.current;
			boundary.remembered.set(owner && stack.contains(owner) ? owner : boundary.body, element);
		};
		boundary.body.addEventListener("focusin", remember);
		const focused = boundary.body.ownerDocument.activeElement;
		if (focused instanceof HTMLElement && boundary.body.contains(focused)) boundary.remembered.set(boundary.body, focused);
		const unsubscribe = controller.subscribe(reconcile);
		reconcile();
		return () => {
			unsubscribe();
			boundary.body.removeEventListener("focusin", remember);
			if (boundary.stack === stack) boundary.stack = null;
			for (const element of retained.keys()) restore(element);
		};
	}, [target, stack, controller]);
	return <div ref={setStack} data-session-surface-region="" className="pointer-events-none absolute inset-0">
		{children}
		<div data-session-surface-mounts="" style={{ display: "contents" }} />
	</div>;
}
