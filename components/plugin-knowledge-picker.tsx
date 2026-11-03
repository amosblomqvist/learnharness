"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GraphSnapshot, PluginKnowledgePickerProps } from "@/src/core";
import { ChainTableOverlay } from "@/components/chain-table";
import { NodePickerControl } from "@/components/composer-actions";
import { HostDialog } from "@/components/host-dialog";
import { InteractionLayerOwner, useInteractionLayer, useInteractionLayers, useOptionalInteractionLayers, type InteractionLayer, type OpeningLease } from "@/components/interaction-layers";
import { HostContentRootContext, HostRouteLifetimeContext, type HostRouteLifetime } from "./host-content-root";

/** One replaceable selector slot in the shared controller, not a private stack. */
const PICKER_SLOT = "knowledge-picker";
const PICKER_LAYER = "knowledge-picker";
interface PickerOrigin {
	pane: HTMLElement | null;
	route: HostRouteLifetime | null;
	owner: InteractionLayer | null;
	modal: boolean;
}

/** A local view, never a modal: sidebar and native page chrome remain available. */
function PanePicker({ origin, openingLease, onClose, children }: {
	origin: PickerOrigin; openingLease: OpeningLease; onClose: () => "closed"; children: ReactNode;
}) {
	const controller = useInteractionLayers();
	const root = useRef<HTMLDivElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const entered = useRef(false);
	const focusInitial = useCallback(() => {
		if (controller.getTopLayer()?.id !== PICKER_LAYER) return;
		const search = root.current?.querySelector<HTMLElement>('input[aria-label="Search nodes"]');
		if (search && controller.isElementEligible(search)) search.focus({ preventScroll: true });
	}, [controller]);
	// Snapshot authority before registration cleanup; covered/expired views do
	// not return focus into an old route or steal it from a newer interaction.
	useLayoutEffect(() => () => {
		if (origin.route?.signal.aborted || controller.getTopLayer()?.id !== PICKER_LAYER) return;
		const generation = controller.getGeneration() + 1;
		const revision = controller.getFocusRevision();
		queueMicrotask(() => {
			if (!origin.route?.signal.aborted) controller.restoreFocus(null, generation, revision, openingLease);
		});
	}, [controller, origin, openingLease]);
	const layer = useInteractionLayer({
		id: PICKER_LAYER, kind: "view", enabled: true, ownerId: origin.owner?.id ?? null,
		rootRef: root, portalRef: popup, onClose, focusInitial, openingLease,
	});
	useEffect(() => {
		if (!layer.isTop || entered.current) return;
		entered.current = true; focusInitial();
	}, [layer.isTop, focusInitial]);
	return createPortal(<InteractionLayerOwner.Provider value={layer.id}>
		<div ref={root} role="region" aria-label="Pick nodes" data-plugin-knowledge-picker-pane=""
			className="absolute inset-0" style={{ zIndex: 100 + layer.order }}>
			{children}
			<div ref={popup} data-interaction-popup-host={layer.id}
				className="pointer-events-none absolute inset-0 z-50 [&>*]:pointer-events-auto" />
		</div>
	</InteractionLayerOwner.Provider>, origin.pane!);
}

/** The practice picker, controlled by a plugin; graph/source IO remains host-owned. */
export function PluginKnowledgePicker({ value, onChange, disabled, signal, onError }: PluginKnowledgePickerProps & {
	signal: AbortSignal;
	onError: (error: unknown) => void;
}) {
	const controller = useOptionalInteractionLayers();
	const pane = useContext(HostContentRootContext);
	const route = useContext(HostRouteLifetimeContext);
	const origin = useRef<PickerOrigin | null>(null);
	const detachOriginAbort = useRef<(() => void) | null>(null);
	const lease = useRef<OpeningLease | null>(null);
	const presented = useRef<OpeningLease | null>(null);
	const waitingForRetirement = useRef(false);
	const graphCache = useRef<GraphSnapshot | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const pending = useRef<AbortController | null>(null);
	const alive = useRef(false);
	const latest = useRef({ onChange, disabled, onError });
	latest.current = { onChange, disabled, onError };
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [open, setOpen] = useState(false);
	const cancelLoad = () => { pending.current?.abort(); pending.current = null; };
	const close = useCallback(() => {
		cancelLoad();
		detachOriginAbort.current?.(); detachOriginAbort.current = null;
		const owner = lease.current;
		origin.current = null;
		lease.current = null; presented.current = null; waitingForRetirement.current = false;
		owner?.release();
		if (alive.current) setOpen(false);
		return "closed" as const;
	}, []);
	const promote = useCallback(() => {
		const owner = lease.current;
		if (!alive.current || signal.aborted || latest.current.disabled || !graphCache.current || !owner?.owns() || presented.current === owner) return;
		if (!owner.ready()) { waitingForRetirement.current = true; return; }
		waitingForRetirement.current = false;
		if (owner.activate()) { presented.current = owner; setOpen(true); }
	}, [signal]);

	useLayoutEffect(() => {
		alive.current = true;
		// Only retry a graph-ready request waiting for its exact predecessor's
		// unregister barrier. Other UI changes revoke pending leases centrally.
		const unsubscribe = controller?.subscribe(() => {
			const source = origin.current;
			if (source && ((source.owner && controller.getLayer(source.owner.id) !== source.owner) || source.route?.signal.aborted)) { close(); return; }
			if (waitingForRetirement.current) promote();
		});
		const abort = () => { close(); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		return () => {
			alive.current = false;
			signal.removeEventListener("abort", abort); unsubscribe?.(); close();
		};
	}, [controller, signal, close, promote]);
	useEffect(() => { if (disabled) close(); }, [disabled, close]);

	const visible = open && !disabled && !signal.aborted && !!lease.current?.owns();
	const change = (ids: readonly string[]) => {
		if (!alive.current || signal.aborted || latest.current.disabled) return;
		try { void Promise.resolve(latest.current.onChange(ids)).catch(latest.current.onError); }
		catch (error) { latest.current.onError(error); }
	};
	const show = () => {
		if (!alive.current || signal.aborted || latest.current.disabled || pending.current) return;
		if (!controller) { latest.current.onError(new Error("Interaction layers require InteractionLayersProvider in AppShell (or the test fixture)")); return; }
		// React portals originate at the global widget host. Resolve actual DOM
		// ownership at invocation instead of inheriting that root's context.
		const invocationOwner = controller.ownerOf(trigger.current);
		let ancestor = invocationOwner;
		let modal = false;
		const seen = new Set<string>();
		while (ancestor && !seen.has(ancestor.id)) {
			seen.add(ancestor.id);
			if (ancestor.kind === "modal") { modal = true; break; }
			ancestor = ancestor.ownerId ? controller.getLayer(ancestor.ownerId) ?? null : null;
		}
		if (!modal && (!pane?.isConnected || !pane.contains(trigger.current) || !route || route.signal.aborted)) {
			latest.current.onError(new Error("Knowledge picker source is no longer in an active host pane")); return;
		}
		// Global dialogs own their own lifetime; the unrelated page behind a
		// modal may navigate without expiring its still-live picker.
		const source: PickerOrigin = { pane, route: modal ? null : route, owner: invocationOwner, modal };
		const owner: OpeningLease | null = controller.reserveOpening(PICKER_SLOT, { opener: trigger.current, onRevoke: () => {
			if (lease.current !== owner) return;
			cancelLoad(); detachOriginAbort.current?.(); detachOriginAbort.current = null;
			origin.current = null;
			lease.current = null; presented.current = null; waitingForRetirement.current = false;
			if (alive.current) setOpen(false);
		} });
		if (!owner) return;
		origin.current = source;
		const abortOrigin = () => { close(); };
		source.route?.signal.addEventListener("abort", abortOrigin, { once: true });
		detachOriginAbort.current = () => source.route?.signal.removeEventListener("abort", abortOrigin);
		lease.current = owner;
		if (graphCache.current) { promote(); return; }
		const request = new AbortController();
		pending.current = request;
		void (async () => {
			try {
				const response = await fetch("/api/graph", { signal: request.signal });
				if (!response.ok) throw new Error("Could not read knowledge graph.");
				const graph = await response.json() as GraphSnapshot;
				if (!alive.current || signal.aborted || request.signal.aborted || pending.current !== request || latest.current.disabled || !owner.owns()) return;
				graphCache.current = graph; setSnapshot(graph); promote();
			} catch (error) {
				if (alive.current && !signal.aborted && !request.signal.aborted && pending.current === request && owner.owns()) {
					close(); latest.current.onError(error);
				}
			} finally { if (pending.current === request) pending.current = null; }
		})();
	};

	const table = snapshot && <ChainTableOverlay
		open={visible} registerInteraction={false} pickerChrome
		nodes={snapshot.propositions} chains={snapshot.chains}
		sessions={snapshot.sessions} fileSources={snapshot.fileSources}
		onClose={close} selectMode controlledSelection={new Set(value)}
		onSelectionChange={(ids) => change([...ids])}
	/>;
	const source = origin.current;
	return <>
		<NodePickerControl count={new Set(value).size} onOpen={show} onClear={() => change([])} disabled={disabled} triggerRef={trigger} />
		{visible && source && (source.modal
			? <HostDialog open layerId={PICKER_LAYER} ownerId={source.owner?.id ?? null} openingLease={lease.current!}
				onClose={close} aria-label="Pick nodes" frame={<div className="absolute inset-0" />}>{table}</HostDialog>
			: <PanePicker origin={source} openingLease={lease.current!} onClose={close}>{table}</PanePicker>)}
	</>;
}
