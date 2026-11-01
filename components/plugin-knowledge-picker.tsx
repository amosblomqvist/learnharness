"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GraphSnapshot, PluginKnowledgePickerProps } from "@/src/core";
import { ChainTableOverlay } from "@/components/chain-table";
import { NodePickerControl } from "@/components/composer-actions";
import { HostContentRootContext } from "@/components/host-content-root";
import { focusKnowledgePickerElement, useKnowledgePickerForeground, type KnowledgePickerLease } from "@/components/knowledge-picker-foreground";

/** The practice picker, controlled by a plugin; graph/source IO remains host-owned. */
export function PluginKnowledgePicker({ value, onChange, disabled, signal, onError }: PluginKnowledgePickerProps & {
	signal: AbortSignal;
	onError: (error: unknown) => void;
}) {
	const contentRoot = useContext(HostContentRootContext);
	const { store: foreground } = useKnowledgePickerForeground();
	const lease = useRef<KnowledgePickerLease | null>(null);
	const restoreFocus = useRef<KnowledgePickerLease | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const pending = useRef<AbortController | null>(null);
	const alive = useRef(false);
	const latest = useRef({ onChange, disabled, onError });
	latest.current = { onChange, disabled, onError };
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [open, setOpen] = useState(false);
	const cancelLoad = () => { pending.current?.abort(); pending.current = null; };
	const close = () => {
		cancelLoad();
		restoreFocus.current = lease.current?.canRestoreFocus() ? lease.current : null;
		lease.current?.release(); lease.current = null;
		setOpen(false);
	};

	useLayoutEffect(() => {
		alive.current = true;
		const abort = () => { cancelLoad(); lease.current?.release(); lease.current = null; setOpen(false); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		return () => { alive.current = false; signal.removeEventListener("abort", abort); cancelLoad(); lease.current?.release(); lease.current = null; };
	}, [signal]);
	useEffect(() => {
		if (disabled) { cancelLoad(); lease.current?.release(); lease.current = null; setOpen(false); }
	}, [disabled]);

	const visible = open && !disabled && !signal.aborted && !!contentRoot && !!lease.current?.owns();
	const keyboardActive = visible && !!lease.current?.isForeground();
	useEffect(() => {
		const previous = restoreFocus.current;
		restoreFocus.current = null;
		if (previous?.canRestoreFocus() && !document.querySelector('[data-lh-menu],[role="menu"]')) focusKnowledgePickerElement(trigger.current);
	});

	const change = (ids: readonly string[]) => {
		if (!alive.current || signal.aborted || latest.current.disabled) return;
		try { void Promise.resolve(latest.current.onChange(ids)).catch(latest.current.onError); }
		catch (error) { latest.current.onError(error); }
	};
	const show = () => {
		if (!alive.current || signal.aborted || latest.current.disabled) return;
		if (!contentRoot) { latest.current.onError(new Error("Knowledge picker requires a host content root.")); return; }
		if (!foreground) { latest.current.onError(new Error("Knowledge picker requires a foreground provider.")); return; }
		if (pending.current) return;
		const owner = foreground.reservePicker(() => { cancelLoad(); lease.current = null; restoreFocus.current = null; setOpen(false); });
		lease.current = owner;
		if (snapshot) { if (owner.activate()) setOpen(true); return; }
		const request = new AbortController();
		pending.current = request;
		void (async () => {
			try {
				const response = await fetch("/api/graph", { signal: request.signal });
				if (!response.ok) throw new Error("Could not read knowledge graph.");
				const graph = await response.json() as GraphSnapshot;
				if (!alive.current || signal.aborted || request.signal.aborted || pending.current !== request || latest.current.disabled || !owner.owns()) return;
				setSnapshot(graph);
				if (owner.activate()) setOpen(true);
			} catch (error) {
				if (alive.current && !signal.aborted && !request.signal.aborted && pending.current === request && owner.owns()) {
					owner.release(); lease.current = null; latest.current.onError(error);
				}
			} finally { if (pending.current === request) pending.current = null; }
		})();
	};

	return <>
		<NodePickerControl count={new Set(value).size} onOpen={show} onClear={() => change([])} disabled={disabled} triggerRef={trigger} />
		{snapshot && contentRoot && createPortal(<ChainTableOverlay
			open={visible}
			keyboardActive={keyboardActive}
			nodes={snapshot.propositions}
			chains={snapshot.chains}
			sessions={snapshot.sessions}
			fileSources={snapshot.fileSources}
			onClose={close}
			selectMode
			controlledSelection={new Set(value)}
			onSelectionChange={(ids) => change([...ids])}
		/>, contentRoot)}
	</>;
}
