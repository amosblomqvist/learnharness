"use client";

import { useRef, type MouseEvent, type PointerEvent } from "react";

/** A synthesized click may target the backdrop even when a drag began
 * inside the dialog. Require both endpoints of the same primary gesture.
 * Capture observes inside/portaled interactions even if they stop bubbling;
 * it never prevents their own button, menu, or selection behavior. */
export function useBackdropDismiss(onDismiss: () => void) {
	const gesture = useRef<{
		pointerId: number;
		backdrop: HTMLDivElement;
		released: boolean;
	} | null>(null);

	return {
		onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
			gesture.current = event.isPrimary && event.button === 0 && event.target === event.currentTarget
				? { pointerId: event.pointerId, backdrop: event.currentTarget, released: false }
				: null;
			// Touch can implicitly capture the pointer on press. Let release
			// target the actual hit element, not a backdrop left behind.
			if (gesture.current && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		},
		onPointerUpCapture(event: PointerEvent<HTMLDivElement>) {
			const press = gesture.current;
			gesture.current = press && press.pointerId === event.pointerId &&
				event.isPrimary && event.button === 0 && event.target === event.currentTarget &&
				press.backdrop === event.currentTarget
				? { ...press, released: true }
				: null;
		},
		onPointerCancelCapture() {
			gesture.current = null;
		},
		onClickCapture(event: MouseEvent<HTMLDivElement>) {
			const press = gesture.current;
			gesture.current = null;
			if (press?.released && press.backdrop === event.currentTarget &&
				event.button === 0 && event.target === event.currentTarget) {
				// This render's callback preserves current busy guards and props.
				onDismiss();
			}
		},
	};
}
