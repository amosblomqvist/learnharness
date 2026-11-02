"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GraphSnapshot, PluginKnowledgePickerProps } from "@/src/core";
import { ChainTableOverlay } from "@/components/chain-table";
import { NodePickerControl } from "@/components/composer-actions";
import { HostDialog } from "@/components/host-dialog";
import { useOptionalInteractionLayers, type OpeningLease } from "@/components/interaction-layers";

/** One replaceable selector slot in the shared controller, not a private stack. */
const PICKER_SLOT = "knowledge-picker";
const PICKER_LAYER = "knowledge-picker";

/** The practice picker, controlled by a plugin; graph/source IO remains host-owned. */
export function PluginKnowledgePicker({ value, onChange, disabled, signal, onError }: PluginKnowledgePickerProps & {
	signal: AbortSignal;
	onError: (error: unknown) => void;
}) {
	const controller = useOptionalInteractionLayers();
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
		const owner = lease.current;
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
		const unsubscribe = controller?.subscribe(() => { if (waitingForRetirement.current) promote(); });
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
		const owner: OpeningLease | null = controller.reserveOpening(PICKER_SLOT, { opener: trigger.current, onRevoke: () => {
			if (lease.current !== owner) return;
			cancelLoad(); lease.current = null; presented.current = null; waitingForRetirement.current = false;
			if (alive.current) setOpen(false);
		} });
		if (!owner) return;
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

	return <>
		<NodePickerControl count={new Set(value).size} onOpen={show} onClear={() => change([])} disabled={disabled} triggerRef={trigger} />
		{snapshot && <HostDialog open={visible} layerId={PICKER_LAYER} openingLease={lease.current ?? undefined}
			onClose={close} aria-label="Pick nodes" frame={<div className="absolute inset-0" />}>
			<ChainTableOverlay
				open={visible}
				registerInteraction={false}
				nodes={snapshot.propositions}
				chains={snapshot.chains}
				sessions={snapshot.sessions}
				fileSources={snapshot.fileSources}
				onClose={close}
				selectMode
				controlledSelection={new Set(value)}
				onSelectionChange={(ids) => change([...ids])}
			/>
		</HostDialog>}
	</>;
}
