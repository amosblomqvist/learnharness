"use client";

import {
	createContext, useContext, useId, useLayoutEffect, useRef, useState,
	useSyncExternalStore, type ReactNode, type RefObject,
} from "react";

import { capturePluginQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys";

export type LayerKind = "modal" | "popup" | "view";
export type CloseReason = "escape" | "backdrop" | "outside" | "return-to" | "action" | "dismiss";
export type CloseOutcome = "closed" | "blocked" | "handled-without-close" | "pending";
export type LayerId = string;
export interface InteractionLayer {
	id: LayerId;
	kind: LayerKind;
	ownerId?: LayerId | null;
	rootRef: RefObject<HTMLElement | null>;
	onClose?: (reason: CloseReason) => CloseOutcome | void;
	/** Owned popup container outside the visual/clipping frame. Views opt in;
	 * native views without a portalRef retain their existing body portals. */
	portalRef?: RefObject<HTMLElement | null>;
	/** Popup origin, for its own explicit thinking/model shortcut only. */
	anchorRef?: RefObject<HTMLElement | null>;
	focusInitial?: () => void;
	/** Optional exclusive opening authority, checked before registering DOM. */
	openingLease?: OpeningLease;
	order: number;
}
export interface OpeningIntent {
	readonly generation: number;
	readonly sequence: number;
	readonly opener: HTMLElement | null;
}
export interface OpeningLease {
	owns(): boolean;
	/** Ready only after the exact accepted predecessor has unregistered. */
	ready(): boolean;
	/** Claim synchronously before setting controlled open state. */
	activate(): boolean;
	release(): void;
}
interface OpeningLeaseState {
	lease: OpeningLease;
	slot: string;
	sequence: number;
	opener: HTMLElement | null;
	onRevoke: () => void;
	notified: boolean;
	exposed: boolean;
	phase: "pending" | "claimed" | "mounted" | "revoked";
	generation: number;
	retiring: Set<InteractionLayer>;
	layer?: InteractionLayer;
}
interface EscapeSnapshot { owner: InteractionLayer | null; claimed: boolean; dispatched: boolean }
type KeyEvent = KeyboardEvent | { nativeEvent: KeyboardEvent };
const nativeEvent = (event: KeyEvent): KeyboardEvent => "nativeEvent" in event ? event.nativeEvent : event;

/** DOM-only eligibility. No browser access during module initialization/SSR. */
export function isInteractionElementVisible(element: HTMLElement | null): element is HTMLElement {
	if (!element?.isConnected) return false;
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
		const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
		if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
	}
	return !element.matches(":disabled, [disabled], [aria-disabled='true'], input[type='hidden']");
}

/** Ordered interaction state only: no domain cancellation, navigation or writes. */
export function createInteractionLayers() {
	let layers: readonly InteractionLayer[] = [];
	let generation = 0;
	let focusRevision = 0;
	let intentSequence = 0;
	const listeners = new Set<() => void>();
	const escapes = new WeakMap<KeyboardEvent, EscapeSnapshot>();
	const closing = new Set<LayerId>();
	const slots = new Map<string, OpeningLeaseState>();
	const leaseStates = new WeakMap<OpeningLease, OpeningLeaseState>();
	const proposals = new Set<OpeningLeaseState>();
	const slotRequests = new Map<string, number>();
	const slotFocusAuthority = new Map<string, number>();
	let reservationSequence = 0;
	const emit = () => { for (const listener of listeners) listener(); };
	const publish = () => { layers = [...layers]; emit(); };
	let postCleanupQueued = false;
	const notifyAfterRetirementCleanup = () => {
		if (postCleanupQueued) return;
		postCleanupQueued = true;
		queueMicrotask(() => {
			postCleanupQueued = false;
			// Registration cleanup precedes the modal's aria/inert cleanup.
			// Reconcile once after the whole synchronous React commit, without
			// advancing or exempting any generation. Never poll/queue navigation.
			if ([...slots.values()].some(state => (state.phase === "pending" || state.phase === "claimed") && ownsLease(state))) publish();
		});
	};
	const retainRetirement = (state: OpeningLeaseState) => state.retiring.size > 0 || !!(state.layer && layers.includes(state.layer));
	const revoke = (state: OpeningLeaseState, notify: boolean) => {
		state.phase = "revoked";
		// Keep only an exact retiring-registration tombstone. A rapid next
		// reservation must still wait when controlled close has not committed.
		if (slots.get(state.slot) === state && !retainRetirement(state)) slots.delete(state.slot);
		// A rejected synchronous proposal was never returned to its caller:
		// it has no work to cancel, and calling it before reserve returns can
		// access an uninitialized caller lease binding.
		if (notify && state.exposed && !state.notified) { state.notified = true; state.onRevoke(); }
	};
	const ownsLease = (state: OpeningLeaseState) => slots.get(state.slot) === state && state.phase !== "revoked" &&
		(state.phase === "mounted" || state.generation === generation);
	const changed = (kind: "register" | "unregister", changedLayer: InteractionLayer) => {
		// z-index accepts integers only. Re-rank declaratively after ordering
		// changes instead of inventing fractional/per-surface foreground values.
		layers.forEach((layer, index) => { layer.order = index + 1; });
		generation++;
		for (const state of new Set([...slots.values(), ...proposals])) {
			if (kind === "unregister" && state.retiring.delete(changedLayer)) {
				// Exempt this exact accepted predecessor only, never descendants
				// or another layer which happens to reuse the same ID.
				state.generation = generation;
				notifyAfterRetirementCleanup();
				if (state.phase === "revoked" && slots.get(state.slot) === state && !retainRetirement(state)) slots.delete(state.slot);
			} else if (kind === "unregister" && state.layer === changedLayer) {
				revoke(state, false);
			} else if (state.phase === "pending" || state.phase === "claimed") {
				revoke(state, true);
			}
		}
		emit();
	};
	const get = (id: LayerId) => layers.find(layer => layer.id === id);
	const activeModal = () => [...layers].reverse().find(layer => layer.kind === "modal") ?? null;
	const belongsTo = (id: LayerId, ancestorId: LayerId): boolean => {
		const seen = new Set<LayerId>();
		let layer = get(id);
		while (layer && !seen.has(layer.id)) {
			if (layer.id === ancestorId) return true;
			seen.add(layer.id);
			layer = layer.ownerId ? get(layer.ownerId) : undefined;
		}
		return false;
	};
	const eligible = (id: LayerId) => {
		if (!get(id)) return false;
		const modal = activeModal();
		return !modal || belongsTo(id, modal.id);
	};
	const top = () => [...layers].reverse().find(layer => eligible(layer.id)) ?? null;
	const ownerOf = (element: Element | null): InteractionLayer | null => {
		for (let node = element; node; node = node.parentElement) {
			const layer = [...layers].reverse().find(candidate => candidate.rootRef.current === node);
			if (layer) return layer;
		}
		return null;
	};
	const elementEligible = (element: HTMLElement | null) => {
		if (!isInteractionElementVisible(element)) return false;
		const owner = ownerOf(element);
		if (owner && !eligible(owner.id)) return false;
		const modal = activeModal();
		if (modal && !(owner && belongsTo(owner.id, modal.id))) return false;
		const foreground = top();
		// A popup owns explicit keyboard actions while open; covered fields
		// in its otherwise-active modal must not receive global commands.
		if (foreground?.kind === "popup" && !(owner && belongsTo(owner.id, foreground.id))) return false;
		return true;
	};
	const requestClose = (id: LayerId, reason: CloseReason): CloseOutcome => {
		const layer = get(id);
		if (!layer) return "closed";
		if (closing.has(id)) return "pending";
		if (!layer.onClose) return "blocked";
		closing.add(id);
		try {
			const outcome = layer.onClose(reason);
			return outcome ?? (!get(id) ? "closed" : "handled-without-close");
		} finally { closing.delete(id); }
	};
	const snapshotEscape = (event: KeyEvent): EscapeSnapshot => {
		const key = nativeEvent(event);
		let snapshot = escapes.get(key);
		if (!snapshot) {
			snapshot = { owner: top(), claimed: false, dispatched: false };
			escapes.set(key, snapshot);
		}
		return snapshot;
	};
	const store = {
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => layers,
		getServerSnapshot: () => EMPTY_LAYERS,
		getGeneration: () => generation,
		getFocusRevision: () => focusRevision,
		observeFocus() { focusRevision++; },
		getLayer: get,
		getTopLayer: top,
		getActiveModal: activeModal,
		belongsTo,
		ownerOf,
		isLayerEligible: eligible,
		isElementEligible: elementEligible,
		/** Narrow opt-in for a popup's own originating control. Never use this
		 * to authorize general field cycling or commands into covered fields. */
		isPopupOrigin(element: HTMLElement | null): boolean {
			if (!isInteractionElementVisible(element)) return false;
			const foreground = top();
			if (foreground?.kind !== "popup") return false;
			const anchor = foreground.anchorRef?.current;
			if (!anchor || !isInteractionElementVisible(anchor)) return false;
			const owner = ownerOf(anchor);
			if (owner && !eligible(owner.id)) return false;
			const modal = activeModal();
			if (modal && !(owner && belongsTo(owner.id, modal.id))) return false;
			return element === anchor || element.contains(anchor);
		},
		register(input: Omit<InteractionLayer, "order">) {
			const opening = input.openingLease && leaseStates.get(input.openingLease);
			// A superseded React render must not register at all, even when its
			// replacement uses the same ID in the same controlled-state batch.
			if (input.openingLease && (!opening || !ownsLease(opening) || opening.phase !== "claimed" ||
				opening.retiring.size > 0 || (opening.opener && !elementEligible(opening.opener)))) return () => {};
			if (get(input.id)) throw new Error(`Interaction layer already registered: ${input.id}`);
			const layer = { ...input, order: layers.length + 1 };
			layers = [...layers, layer];
			// React mounts child layout effects first. An owner registered in the
			// same commit belongs below its already-registered owned children.
			const childIndex = layers.findIndex(candidate => candidate !== layer && belongsTo(candidate.id, layer.id));
			if (childIndex >= 0) {
				layers = [...layers.slice(0, childIndex), layer, ...layers.slice(childIndex, -1)];
			}
			if (opening) { opening.layer = layer; opening.phase = "mounted"; }
			changed("register", layer);
			return () => {
				if (get(input.id) !== layer) return;
				layers = layers.filter(candidate => candidate !== layer);
				changed("unregister", layer);
			};
		},
		update(id: LayerId, input: Partial<Omit<InteractionLayer, "id" | "order">>) {
			const layer = get(id);
			if (!layer) return;
			// Keep the lifetime identity used by unregister/event snapshots.
			Object.assign(layer, input);
			layers = [...layers];
			emit();
		},
		requestClose,
		popTo(id: LayerId): CloseOutcome {
			const targetIndex = layers.findIndex(layer => layer.id === id);
			if (targetIndex < 0) return "blocked";
			// A single bounded traversal, even when controlled React state commits later.
			const above = layers.slice(targetIndex + 1).reverse();
			for (const layer of above) {
				const outcome = requestClose(layer.id, "return-to");
				if (outcome !== "closed") return outcome;
			}
			return "closed";
		},
		beginOpening(opener?: HTMLElement | null): OpeningIntent {
			const current = typeof document === "undefined" ? null : document.activeElement;
			const invokingElement = opener === undefined && current?.nodeType === 1 ? current as HTMLElement : opener;
			return { generation, sequence: ++intentSequence, opener: invokingElement ?? null };
		},
		isOpeningCurrent(intent: OpeningIntent) {
			return intent.generation === generation && intent.sequence === intentSequence &&
				(!intent.opener || elementEligible(intent.opener));
		},
		reserveOpening(slot: string, options: { opener?: HTMLElement | null; onRevoke: () => void }): OpeningLease | null {
			const previous = slots.get(slot);
			const current = typeof document === "undefined" ? null : document.activeElement;
			const opener = options.opener === undefined && current?.nodeType === 1 ? current as HTMLElement : options.opener ?? null;
			const sequence = ++reservationSequence;
			slotRequests.set(slot, sequence);
			const retiring = new Set(previous?.retiring);
			const previousLayer = previous?.layer && layers.includes(previous.layer) ? previous.layer : undefined;
			if (previousLayer) retiring.add(previousLayer);
			let state: OpeningLeaseState;
			const ready = () => ownsLease(state) && (state.phase === "mounted" ||
				(state.retiring.size === 0 && (!state.opener || elementEligible(state.opener))));
			const lease: OpeningLease = {
				owns: () => ownsLease(state),
				ready,
				activate() {
					if (!ready()) return false;
					if (state.phase === "pending") { state.phase = "claimed"; publish(); }
					return ownsLease(state);
				},
				release() { if (state.phase !== "revoked") { revoke(state, false); publish(); } },
			};
			state = { lease, slot, sequence, opener, onRevoke: options.onRevoke, notified: false, exposed: false,
				phase: "pending", generation, retiring };
			leaseStates.set(lease, state);
			// Observe synchronous close callbacks too: only the exact old
			// registration's removal is expected during this proposal.
			proposals.add(state);
			try {
				if (previousLayer && previous?.phase !== "revoked") {
					const outcome = requestClose(previousLayer.id, "dismiss");
					if (outcome !== "closed") { revoke(state, false); return null; }
				}
				if (state.phase === "revoked" || slotRequests.get(slot) !== sequence) { revoke(state, false); return null; }
				slots.set(slot, state);
				slotFocusAuthority.set(slot, sequence);
				if (previous) revoke(previous, true);
				publish();
				if (!ownsLease(state)) return null;
				state.exposed = true;
				return lease;
			} finally { proposals.delete(state); }
		},
		invalidateOpening() {
			intentSequence++;
			for (const state of new Set([...slots.values(), ...proposals])) {
				if (state.phase === "pending" || state.phase === "claimed") revoke(state, true);
			}
			publish();
		},
		getPortalContainer(anchor?: Element | null, ownerId?: LayerId | null): HTMLElement | null {
			let owner = ownerId ? get(ownerId) : ownerOf(anchor ?? null);
			const seen = new Set<LayerId>();
			while (owner && !seen.has(owner.id)) {
				if (owner.kind === "modal") return owner.portalRef?.current ?? owner.rootRef.current;
				if (owner.kind === "view" && owner.portalRef?.current) return owner.portalRef.current;
				seen.add(owner.id);
				owner = owner.ownerId ? get(owner.ownerId) : undefined;
			}
			return anchor?.ownerDocument.body ?? (typeof document === "undefined" ? null : document.body);
		},
		captureKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") snapshotEscape(event);
			capturePluginQuestionKey(event);
			if (event.key === "Tab") event.preventDefault();
		},
		getEventOwner(event: KeyEvent): InteractionLayer | null { return snapshotEscape(event).owner; },
		isEscapeOwned(event: KeyEvent): boolean {
			const snapshot = snapshotEscape(event);
			return !!snapshot.owner || snapshot.claimed;
		},
		claimEscape(event: KeyEvent) {
			const snapshot = snapshotEscape(event);
			snapshot.claimed = true;
			nativeEvent(event).preventDefault();
		},
		dispatchEscape(event: KeyboardEvent): CloseOutcome | null {
			const snapshot = snapshotEscape(event);
			if (snapshot.dispatched) return null;
			snapshot.dispatched = true;
			if (event.defaultPrevented || snapshot.claimed || pluginQuestionKeySuppressed(event)) return null;
			if (!snapshot.owner) return null;
			snapshot.claimed = true;
			event.preventDefault();
			// Never fall through to an owner exposed by this same event.
			if (get(snapshot.owner.id) !== snapshot.owner) return "closed";
			return requestClose(snapshot.owner.id, "escape");
		},
		/** Return only while this exact closing generation still owns focus. */
		restoreFocus(opener: HTMLElement | null, expectedGeneration: number, expectedFocusRevision = focusRevision, openingLease?: OpeningLease) {
			if (generation !== expectedGeneration || focusRevision !== expectedFocusRevision) return false;
			if (openingLease) {
				const opening = leaseStates.get(openingLease);
				if (!opening || slotFocusAuthority.get(opening.slot) !== opening.sequence) return false;
				// An async/cached handoff mounts only after its predecessor is gone.
				// Return to the click-time invoker, not body/a detached old field
				// which happened to be active when the new portal finally mounted.
				opener = opening.opener;
			}
			if (elementEligible(opener)) { opener!.focus({ preventScroll: true }); return true; }
			const active = activeModal();
			active?.focusInitial?.();
			return !!active;
		},
	};
	return store;
}
const EMPTY_LAYERS: readonly InteractionLayer[] = [];
export type InteractionLayersController = ReturnType<typeof createInteractionLayers>;
const LayersContext = createContext<InteractionLayersController | null>(null);
export const InteractionLayerOwner = createContext<LayerId | null>(null);

export function InteractionLayersProvider({ children }: { children: ReactNode }) {
	const [controller] = useState(createInteractionLayers);
	useLayoutEffect(() => {
		const capture = (event: KeyboardEvent) => controller.captureKeyDown(event);
		const bubble = (event: KeyboardEvent) => { if (event.key === "Escape") controller.dispatchEscape(event); };
		const focus = () => controller.observeFocus();
		// Capture only observes Escape. Native Tab prevention never stops propagation.
		window.addEventListener("keydown", capture, true);
		document.addEventListener("keydown", bubble);
		document.addEventListener("focusin", focus, true);
		return () => {
			window.removeEventListener("keydown", capture, true);
			document.removeEventListener("keydown", bubble);
			document.removeEventListener("focusin", focus, true);
		};
	}, [controller]);
	return <LayersContext.Provider value={controller}>{children}</LayersContext.Provider>;
}

export function useOptionalInteractionLayers(): InteractionLayersController | null {
	return useContext(LayersContext);
}

export function useInteractionLayers(): InteractionLayersController {
	const controller = useOptionalInteractionLayers();
	if (!controller) throw new Error("Interaction layers require InteractionLayersProvider in AppShell (or the test fixture)");
	return controller;
}

export interface UseInteractionLayerOptions {
	id?: LayerId;
	kind: LayerKind;
	enabled: boolean;
	ownerId?: LayerId | null;
	rootRef: RefObject<HTMLElement | null>;
	onClose?: InteractionLayer["onClose"];
	portalRef?: InteractionLayer["portalRef"];
	anchorRef?: InteractionLayer["anchorRef"];
	focusInitial?: InteractionLayer["focusInitial"];
	openingLease?: OpeningLease;
}
export function useInteractionLayer(options: UseInteractionLayerOptions) {
	const controller = useInteractionLayers();
	const inheritedOwner = useContext(InteractionLayerOwner);
	const generatedId = useId();
	const id = options.id ?? generatedId;
	const latest = useRef(options);
	useLayoutEffect(() => { latest.current = options; });
	const { enabled, kind, rootRef } = options;
	const explicitOwner = options.ownerId;
	const openingLease = options.openingLease;
	useLayoutEffect(() => {
		if (!enabled) return;
		const anchorOwner = controller.ownerOf(latest.current.anchorRef?.current ?? null);
		const domOwner = controller.ownerOf(rootRef.current?.parentElement ?? null);
		const ownerId = explicitOwner === undefined ? anchorOwner?.id ?? domOwner?.id ?? inheritedOwner : explicitOwner;
		return controller.register({
			id, kind, rootRef, ownerId,
			onClose: reason => latest.current.onClose?.(reason),
			portalRef: latest.current.portalRef,
			anchorRef: latest.current.anchorRef,
			focusInitial: () => latest.current.focusInitial?.(),
			openingLease,
		});
	}, [controller, id, enabled, kind, rootRef, explicitOwner, inheritedOwner, openingLease]);
	const layers = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
	const layer = layers.find(candidate => candidate.id === id && candidate.rootRef === rootRef && candidate.openingLease === openingLease);
	return {
		id,
		active: !!layer && controller.isLayerEligible(id),
		isTop: !!layer && controller.getTopLayer()?.id === id,
		order: layer?.order ?? 0,
	};
}
