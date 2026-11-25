import { useEffect, type RefObject } from "react";
import { useInteractionLayer, useInteractionLayers, type CloseReason } from "./interaction-layers";

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
	close: (reason: CloseReason) => void,
	options?: { layerRootRef?: RefObject<HTMLElement | null>; ownerId?: string },
) {
	const controller = useInteractionLayers();
	const panel = options?.layerRootRef ?? rootRef;
	const layer = useInteractionLayer({ kind: "popup", enabled: open, rootRef: panel, anchorRef: rootRef, ownerId: options?.ownerId,
		onClose: (reason) => { close(reason); return "closed"; } });
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!controller.isElementEligible(panel.current)) return;
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close("outside");
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, close, rootRef, panel, controller]);
	return layer;
}
