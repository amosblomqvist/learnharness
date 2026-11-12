import type { PluginSurfaceTarget } from "@/src/core";
import type { InteractionLayersController } from "./interaction-layers";

/** Private, live view-instance registry. Tokens carry no serializable routing data. */
export interface SurfaceBoundary {
	target: PluginSurfaceTarget;
	body: HTMLElement;
	stack: HTMLElement | null;
	signal: AbortSignal;
	controller: InteractionLayersController;
	remembered: WeakMap<HTMLElement, HTMLElement>;
}
const boundaries = new WeakMap<PluginSurfaceTarget, SurfaceBoundary>();
const currentPages = new WeakMap<Document, SurfaceBoundary>();

export function registerSurfaceBoundary(body: HTMLElement, signal: AbortSignal, controller: InteractionLayersController): SurfaceBoundary {
	const target = Object.freeze({}) as PluginSurfaceTarget;
	// Child DOM is committed before page layout effects, while a view's mount
	// callback may run before SurfaceRegion's target-driven follow-up effect.
	// Bind only this body's already-mounted direct region and its mount slot.
	const HtmlElement = body.ownerDocument.defaultView?.HTMLElement;
	const stack = Array.from(body.children).find((child): child is HTMLElement =>
		!!HtmlElement && child instanceof HtmlElement && child.isConnected && child.hasAttribute("data-session-surface-region") &&
		Array.from(child.children).some(mount => mount instanceof HtmlElement && mount.hasAttribute("data-session-surface-mounts")));
	const boundary: SurfaceBoundary = { target, body, stack: stack ?? null, signal, controller, remembered: new WeakMap() };
	if (signal.aborted) return boundary;
	boundaries.set(target, boundary);
	currentPages.set(body.ownerDocument, boundary);
	signal.addEventListener("abort", () => {
		boundaries.delete(target);
		if (currentPages.get(body.ownerDocument) === boundary) currentPages.delete(body.ownerDocument);
	}, { once: true });
	return boundary;
}

export function findSurfaceBoundary(target: PluginSurfaceTarget | undefined): SurfaceBoundary | undefined {
	if (!target) return;
	const boundary = boundaries.get(target);
	return boundary && !boundary.signal.aborted && boundary.body.isConnected ? boundary : undefined;
}

/** Capture the active page once; never fall back to an older retained page. */
export function findCurrentSurfaceBoundary(document: Document): SurfaceBoundary | undefined {
	return findSurfaceBoundary(currentPages.get(document)?.target);
}

export function requireSurfaceBoundary(target: PluginSurfaceTarget | undefined): SurfaceBoundary {
	const boundary = findSurfaceBoundary(target);
	if (!boundary?.stack?.isConnected) throw new Error("Surface target is no longer active");
	return boundary;
}
