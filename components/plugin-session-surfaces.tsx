"use client";

import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { PluginSurfaceTarget } from "@/src/core";
import { useInteractionLayers } from "./interaction-layers";
import { findSessionSurfaceBoundary, registerSessionSurfaceBoundary } from "./plugin-session-surface-targets";

/** A re-entered (even hide-retained) view always receives a fresh target. */
export function useSessionSurfaceBoundary({ active, viewKey, bodyRef }: {
	active: boolean;
	viewKey: string;
	bodyRef: RefObject<HTMLElement | null>;
}): PluginSurfaceTarget | undefined {
	const controller = useInteractionLayers();
	const [current, setCurrent] = useState<{ viewKey: string; target: PluginSurfaceTarget }>();
	useLayoutEffect(() => {
		if (!active || !bodyRef.current) return;
		const lifetime = new AbortController();
		const boundary = registerSessionSurfaceBoundary(bodyRef.current, lifetime.signal, controller);
		setCurrent({ viewKey, target: boundary.target });
		return () => lifetime.abort();
	}, [active, viewKey, bodyRef, controller]);
	return active && current?.viewKey === viewKey && findSessionSurfaceBoundary(current.target) ? current.target : undefined;
}

/** Common LOCAL paint stratum for native focuses and plugin surfaces. Global
 * modals retain their own higher stratum even when a view opens asynchronously. */
export function SessionSurfaceRegion({ target, children }: { target: PluginSurfaceTarget | undefined; children?: ReactNode }) {
	const controller = useInteractionLayers();
	const [stack, setStack] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const boundary = findSessionSurfaceBoundary(target);
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
	return <div ref={setStack} data-session-surface-region="" className="pointer-events-none absolute inset-0 z-40">
		{children}
		<div data-session-surface-mounts="" style={{ display: "contents" }} />
	</div>;
}
