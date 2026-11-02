"use client";

import { isInteractionElementVisible, type InteractionLayersController } from "./interaction-layers";

const FOREGROUND_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [data-testid="cheat-sheet"], [data-testid="chain-table-overlay"], [data-testid="mermaid-overlay"], [data-testid="plan-popup"]';

/** Legacy standalone fixtures have no provider. Never create a second store. */
export function hasLegacyInteractionForeground(doc: Document, scope?: HTMLElement | null): boolean {
	return Array.from(doc.querySelectorAll<HTMLElement>(FOREGROUND_ROOTS)).some(element => {
		if (element.contains(scope ?? null) || element.getAttribute("data-state") === "closed") return false;
		if (!isInteractionElementVisible(element)) return false;
		const style = doc.defaultView?.getComputedStyle?.(element) ?? element.style;
		return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
	});
}

/** Strict command scope: covered/hidden fields never receive Find, Enter or Tab. */
export function isInteractionScopeEligible(scope: HTMLElement | null, controller?: InteractionLayersController | null): boolean {
	if (!isInteractionElementVisible(scope)) return false;
	if (!controller) return !hasLegacyInteractionForeground(scope.ownerDocument, scope);
	if (!controller.isElementEligible(scope)) return false;
	const foreground = controller.getTopLayer();
	// Content views retain sidebar pointer access, but own content-area keys.
	if (foreground?.kind === "view") {
		const owner = controller.ownerOf(scope);
		if (!owner || !controller.belongsTo(owner.id, foreground.id)) return false;
	}
	return true;
}

/** ONLY model/thinking commands may address their own popup's origin. */
export function isInputShortcutScopeEligible(scope: HTMLElement | null, controller?: InteractionLayersController | null): boolean {
	return isInteractionScopeEligible(scope, controller) || !!controller?.isPopupOrigin(scope);
}

/** Only the currently focused plugin control can claim these shortcuts.
 * Merely mounting a widget never changes the core fallback. */
export type PluginInputShortcut = "toggle-dictation" | "open-model-picker" | "cycle-thinking";
export type PluginInputFocusHandlers = {
	toggleDictation?: () => void;
	cycleModel?: () => void;
	cycleThinking?: () => void;
};

const claims = new Map<HTMLElement, PluginInputFocusHandlers>();

export function claimPluginInputFocus(root: HTMLElement, handlers: PluginInputFocusHandlers): () => void {
	claims.set(root, handlers);
	return () => {
		if (claims.get(root) === handlers) claims.delete(root);
	};
}

export function dispatchFocusedPluginShortcut(action: string, controller?: InteractionLayersController | null): boolean {
	const keys: Partial<Record<string, keyof PluginInputFocusHandlers>> = {
		"toggle-dictation": "toggleDictation",
		"open-model-picker": "cycleModel",
		"cycle-thinking": "cycleThinking",
	};
	const key = Object.hasOwn(keys, action) ? keys[action] : undefined;
	if (!key || typeof document === "undefined") return false;
	const focused = document.activeElement;
	if (!focused) return false;
	const popupOriginAction = action === "open-model-picker" || action === "cycle-thinking";
	const eligible = (root: HTMLElement) => popupOriginAction
		? isInputShortcutScopeEligible(root, controller)
		: isInteractionScopeEligible(root, controller);
	// Walk outward so a standalone control nested in a preset owns its
	// own matching action, while the preset can supply the other actions.
	for (let node: Element | null = focused; node; node = node.parentElement) {
		const root = node as HTMLElement;
		const handler = claims.get(root)?.[key];
		if (handler && eligible(root)) {
			handler();
			return true;
		}
	}
	// Portaled popup focus is outside the widget DOM. Resolve only its own
	// origin profile, never a mounted core/background control.
	if (popupOriginAction && controller) {
		const origins = [...claims.keys()].filter(root => controller.isPopupOrigin(root));
		origins.sort((a, b) => a.contains(b) ? 1 : b.contains(a) ? -1 : 0);
		for (const root of origins) {
			const handler = claims.get(root)?.[key];
			if (handler) { handler(); return true; }
		}
	}
	return false;
}
