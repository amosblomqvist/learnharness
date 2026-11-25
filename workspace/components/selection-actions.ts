/**
 * WHEN AND WHERE A SELECTION TOOLBAR SHOWS (2026-10-31; semantics follow
 * T3 Code's selection actions, MIT). A pointer gesture reports after the
 * mouse is released — 500 ms later for double/triple clicks, so the
 * selection can finish growing — and a frame after that, once layout has
 * settled. Keyboard selection reports on selectionchange. Escape, blur,
 * resize, a new press and scrolling dismiss; with restoreAfterScroll the
 * toolbar comes back once scrolling settles.
 */

export type SelectionActionPoint = { x: number; y: number };
export type RectLike = { left: number; top: number; right: number; bottom: number };
export type SelectionDismissReason = "interaction" | "cancel";

const EDGE = 8;
const MULTI_CLICK_SETTLE_MS = 500;
const SCROLL_SETTLE_MS = 150;

export function resolveSelectionActionPosition({ bounds, selectionRect, pointer, viewport }: {
	bounds: RectLike;
	selectionRect: RectLike | null;
	pointer: SelectionActionPoint | null;
	viewport: { width: number; height: number };
}): SelectionActionPoint {
	const preferred = pointer
		?? (selectionRect ? { x: selectionRect.right, y: selectionRect.bottom + 4 } : { x: bounds.right - 140, y: bounds.top + 12 });
	const minX = Math.max(bounds.left, 0) + EDGE;
	const maxX = Math.min(bounds.right, viewport.width) - EDGE;
	const minY = Math.max(bounds.top, 0) + EDGE;
	const maxY = Math.min(bounds.bottom, viewport.height) - EDGE;
	return {
		x: Math.min(Math.max(preferred.x, minX), Math.max(minX, maxX)),
		y: Math.min(Math.max(preferred.y, minY), Math.max(minY, maxY)),
	};
}

export function isSelectionRectVisible(rect: RectLike, clips: readonly RectLike[]): boolean {
	let { left, top, right, bottom } = rect;
	for (const clip of clips) {
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	return right > left && bottom > top;
}

export function observeSelectionActions({ element, getActionElement, restoreAfterScroll, onSelection, onDismiss }: {
	element: HTMLElement;
	getActionElement: () => HTMLElement | null;
	restoreAfterScroll: boolean;
	onSelection: (pointer: SelectionActionPoint | null) => void;
	onDismiss: (reason: SelectionDismissReason) => void;
}): { selectionChanged: () => void; cancel: () => void; dispose: () => void } {
	const view = element.ownerDocument.defaultView!;
	const document = element.ownerDocument;
	let pointerDown = false;
	let gesture = false;
	let shown = false;
	let timer: number | undefined;
	let frame: number | undefined;
	let scrollTimer: number | undefined;

	const clearPending = () => {
		if (timer !== undefined) view.clearTimeout(timer);
		if (frame !== undefined) view.cancelAnimationFrame(frame);
		timer = frame = undefined;
	};
	const schedule = (delay: number, pointer: SelectionActionPoint | null) => {
		clearPending();
		timer = view.setTimeout(() => {
			timer = undefined;
			frame = view.requestAnimationFrame(() => {
				frame = undefined;
				shown = true;
				onSelection(pointer);
			});
		}, delay);
	};
	const dismiss = (reason: SelectionDismissReason) => {
		clearPending();
		shown = false;
		onDismiss(reason);
	};
	const onAction = (target: EventTarget | null) => {
		const action = getActionElement();
		return !!action && target instanceof view.Node && action.contains(target);
	};

	const pointerDownCapture = (event: PointerEvent) => {
		if (onAction(event.target)) { clearPending(); return; }
		if (shown || timer !== undefined) dismiss("interaction");
		pointerDown = true;
		const target = event.target as Element | null;
		gesture = event.button === 0 && !event.defaultPrevented && element.contains(target) && !target?.closest("button, [role=button]");
	};
	const mouseUp = (event: MouseEvent) => {
		pointerDown = false;
		if (!gesture || event.button !== 0) return;
		gesture = false;
		schedule(event.detail >= 2 ? MULTI_CLICK_SETTLE_MS : 0, { x: event.clientX, y: event.clientY });
	};
	const keyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") { if (shown || timer !== undefined) dismiss("cancel"); return; }
		pointerDown = false;
	};
	const cancel = () => { if (shown || timer !== undefined) dismiss("cancel"); };
	const contextMenu = () => dismiss("interaction");
	const focusIn = (event: FocusEvent) => { if (shown && !onAction(event.target)) dismiss("interaction"); };
	const scroll = () => {
		if (pointerDown) return; // autoscroll while dragging keeps the gesture
		const wasShown = shown;
		if (shown || timer !== undefined) dismiss("cancel");
		if (!restoreAfterScroll || !wasShown) return;
		if (scrollTimer !== undefined) view.clearTimeout(scrollTimer);
		scrollTimer = view.setTimeout(() => { scrollTimer = undefined; schedule(0, null); }, SCROLL_SETTLE_MS);
	};

	document.addEventListener("pointerdown", pointerDownCapture, true);
	document.addEventListener("mouseup", mouseUp, true);
	document.addEventListener("keydown", keyDown, true);
	document.addEventListener("focusin", focusIn, true);
	element.addEventListener("contextmenu", contextMenu);
	element.addEventListener("scroll", scroll, true);
	view.addEventListener("pointercancel", cancel);
	view.addEventListener("blur", cancel);
	view.addEventListener("resize", cancel);

	return {
		selectionChanged() {
			if (pointerDown) { if (shown) dismiss("cancel"); return; }
			if (timer === undefined && frame === undefined) schedule(0, null);
		},
		cancel() { clearPending(); shown = false; },
		dispose() {
			clearPending();
			if (scrollTimer !== undefined) view.clearTimeout(scrollTimer);
			document.removeEventListener("pointerdown", pointerDownCapture, true);
			document.removeEventListener("mouseup", mouseUp, true);
			document.removeEventListener("keydown", keyDown, true);
			document.removeEventListener("focusin", focusIn, true);
			element.removeEventListener("contextmenu", contextMenu);
			element.removeEventListener("scroll", scroll, true);
			view.removeEventListener("pointercancel", cancel);
			view.removeEventListener("blur", cancel);
			view.removeEventListener("resize", cancel);
		},
	};
}
