"use client";

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

export function dispatchFocusedPluginShortcut(action: string): boolean {
	const keys: Partial<Record<string, keyof PluginInputFocusHandlers>> = {
		"toggle-dictation": "toggleDictation",
		"open-model-picker": "cycleModel",
		"cycle-thinking": "cycleThinking",
	};
	const key = Object.hasOwn(keys, action) ? keys[action] : undefined;
	if (!key || typeof document === "undefined") return false;
	const focused = document.activeElement;
	if (!focused) return false;
	// Walk outward so a standalone control nested in a preset owns its
	// own matching action, while the preset can supply the other actions.
	for (let node: Element | null = focused; node; node = node.parentElement) {
		const handler = claims.get(node as HTMLElement)?.[key];
		if (handler) {
			handler();
			return true;
		}
	}
	return false;
}
