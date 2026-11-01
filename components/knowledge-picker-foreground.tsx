"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/** Internal ordering for the shared selector and its supported modal origins.
 * A lease snapshots activation versions at the click, not at fetch completion. */
export function createKnowledgePickerForegroundStore() {
	let revision = 0;
	let order = 0;
	let latestPickerClaim = 0;
	const listeners = new Set<() => void>();
	type Modal = { order: number; onSuspend?: () => void };
	type Picker = { order: number; active: boolean; origins: Map<Modal, number>; onSuperseded: () => void };
	const modals = new Set<Modal>();
	let picker: Picker | undefined;
	const publish = () => { revision++; for (const listener of listeners) listener(); };
	const suspended = (modal: Modal) => !!picker?.active && picker.origins.get(modal) === modal.order && modals.has(modal);
	const canRestoreFocus = (since: number) => ![...modals].some((modal) => !suspended(modal) && modal.order > since)
		&& !(picker && picker.order > since);
	const pickerForeground = (owner: Picker) => picker === owner && owner.active && ![...modals].some((modal) => !suspended(modal) && modal.order > owner.order);
	return {
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot() { return revision; },
		hasActivePicker() { return !!picker?.active; },
		isPickerForeground() { return !!picker && pickerForeground(picker); },
		cancelPicker() {
			if (!picker) return;
			const previous = picker; picker = undefined;
			latestPickerClaim = ++order;
			previous.onSuperseded(); publish();
		},
		createModal(onSuspend?: () => void) {
			const modal: Modal = { order: 0, onSuspend };
			return {
				activate() { modal.order = ++order; modals.add(modal); publish(); },
				close() { if (modals.delete(modal)) publish(); },
				isSuspended() { return suspended(modal); },
				canHandle() {
					return modals.has(modal) && !suspended(modal)
						&& ![...modals].some((other) => !suspended(other) && other.order > modal.order)
						&& !(picker?.active && picker.order > modal.order);
				},
				canRestoreFocus() { return canRestoreFocus(modal.order) && !picker?.active; },
			};
		},
		reservePicker(onSuperseded: () => void) {
			const previous = picker;
			const owner: Picker = { order: ++order, active: false, origins: new Map([...modals].map((modal) => [modal, modal.order])), onSuperseded };
			picker = owner;
			latestPickerClaim = owner.order;
			previous?.onSuperseded();
			publish();
			return {
				owns() { return picker === owner; },
				activate() {
					if (picker !== owner) return false;
					if (!owner.active) {
						owner.active = true;
						for (const modal of modals) if (suspended(modal)) modal.onSuspend?.();
						publish();
					}
					return true;
				},
				isForeground() { return pickerForeground(owner); },
				canRestoreFocus() { return latestPickerClaim === owner.order && (picker === owner || !picker) && canRestoreFocus(owner.order); },
				release() { if (picker === owner) { picker = undefined; publish(); } },
			};
		},
	};
}
export type KnowledgePickerForegroundStore = ReturnType<typeof createKnowledgePickerForegroundStore>;
export type KnowledgePickerLease = ReturnType<KnowledgePickerForegroundStore["reservePicker"]>;

const ForegroundContext = createContext<KnowledgePickerForegroundStore | null>(null);
const noSubscribe = () => () => {};
const zero = () => 0;
export function KnowledgePickerForegroundProvider({ children }: { children: ReactNode }) {
	const [store] = useState(createKnowledgePickerForegroundStore);
	return <ForegroundContext.Provider value={store}>{children}</ForegroundContext.Provider>;
}
export function useKnowledgePickerForeground() {
	const store = useContext(ForegroundContext);
	const revision = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? zero, zero);
	return { store, revision };
}

/** No focus through hidden/inert origins, disabled triggers, or detached content. */
export function focusKnowledgePickerElement(element: HTMLElement | null) {
	if (!element?.isConnected || element.matches(":disabled") || element.closest("[hidden],[inert]")) return;
	for (let current: HTMLElement | null = element; current; current = current.parentElement) {
		const style = element.ownerDocument.defaultView?.getComputedStyle?.(current);
		if (style?.display === "none" || style?.visibility === "hidden") return;
	}
	element.focus({ preventScroll: true });
}

/** Standalone settings/dialog renderers keep their legacy behavior without a host. */
export function useKnowledgePickerModal() {
	const { store, revision } = useKnowledgePickerForeground();
	const frame = useRef<HTMLDivElement>(null);
	const savedFocus = useRef<HTMLElement | null>(null);
	const [modal] = useState(() => store?.createModal(() => {
		const active = frame.current?.ownerDocument.activeElement;
		if (active instanceof HTMLElement && frame.current?.contains(active)) savedFocus.current = active;
	}));
	const suspended = modal?.isSuspended() ?? false;
	const wasSuspended = useRef(false);
	useLayoutEffect(() => {
		if (wasSuspended.current && !suspended && modal?.canRestoreFocus()) focusKnowledgePickerElement(savedFocus.current);
		wasSuspended.current = suspended;
	}, [suspended, revision, modal]);
	useLayoutEffect(() => () => modal?.close(), [modal]);
	return { frame, suspended, modal, store, canHandle: () => modal?.canHandle() ?? true };
}
export type KnowledgePickerModal = ReturnType<typeof useKnowledgePickerModal>;
