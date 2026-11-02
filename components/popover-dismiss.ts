import { usePaneCommand } from "@/components/workspace/pane-context";

import { useEffect, type RefObject } from "react";

/**
 * Close-on-dismissal for floating panels (graph chrome, 2026-09-17):
 * any pointerdown landing OUTSIDE the control's root closes it; Escape
 * closes it too. The root contains both the toggle button and the panel,
 * so clicks on the control's own button stay "inside" — its toggle keeps
 * working — while a click on a sibling chrome button counts as outside:
 * pointerdown closes the open panel first, then the sibling's click opens
 * its own. Two dropdowns can therefore never be open at once.
 */
export function usePopoverDismiss(
	rootRef: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void,
): void {
	const paneCommand = usePaneCommand();
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (!paneCommand()) return;
			if (e.key === "Escape") {
				// Claim the Esc (keyboard wave A): the window-level dismiss
				// chain must not ALSO stop dictation / abort a turn under
				// this popover. Popovers are the chain's topmost layer.
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close, rootRef]);
}
