import type { PluginSurfaceTarget } from "@/src/core";
import type { InteractionLayersController } from "./interaction-layers";

/** Private, live view-instance registry. Tokens carry no serializable routing data. */
export interface SessionSurfaceBoundary {
	target: PluginSurfaceTarget;
	body: HTMLElement;
	stack: HTMLElement | null;
	signal: AbortSignal;
	controller: InteractionLayersController;
	remembered: WeakMap<HTMLElement, HTMLElement>;
}
const boundaries = new WeakMap<PluginSurfaceTarget, SessionSurfaceBoundary>();

export function registerSessionSurfaceBoundary(body: HTMLElement, signal: AbortSignal, controller: InteractionLayersController): SessionSurfaceBoundary {
	const target = Object.freeze({}) as PluginSurfaceTarget;
	const boundary: SessionSurfaceBoundary = { target, body, stack: null, signal, controller, remembered: new WeakMap() };
	boundaries.set(target, boundary);
	signal.addEventListener("abort", () => boundaries.delete(target), { once: true });
	return boundary;
}

export function findSessionSurfaceBoundary(target: PluginSurfaceTarget | undefined): SessionSurfaceBoundary | undefined {
	if (!target) return;
	const boundary = boundaries.get(target);
	return boundary && !boundary.signal.aborted && boundary.body.isConnected ? boundary : undefined;
}

export function requireSessionSurfaceBoundary(target: PluginSurfaceTarget): SessionSurfaceBoundary {
	const boundary = findSessionSurfaceBoundary(target);
	if (!boundary?.stack?.isConnected) throw new Error("Surface target is no longer active");
	return boundary;
}
