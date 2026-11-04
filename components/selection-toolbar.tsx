"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { Button } from "./ui/button";
import { captureSelection, type CapturedSelection } from "./selection-text";
import {
	isSelectionRectVisible, observeSelectionActions, resolveSelectionActionPosition,
	type RectLike, type SelectionActionPoint,
} from "./selection-actions";

/** One button on the toolbar. Cite is the first; side questions adds more. */
export interface SelectionAction {
	id: string;
	label: string;
	ariaLabel: string;
	icon: LucideIcon;
	/** A reason the action can't run for this selection (e.g. "Shorten
	 *  selection"): shown instead of the label, button disabled. */
	disabledLabel?: (capture: CapturedSelection) => string | null;
	visible: (capture: CapturedSelection) => boolean;
	/** Return true when handled: the selection clears and the toolbar closes. */
	onSelect: (capture: CapturedSelection) => boolean;
}

export function runSelectionAction(action: SelectionAction, capture: CapturedSelection): boolean {
	if (action.disabledLabel?.(capture)) return false;
	return action.onSelect(capture);
}

export function SelectionToolbarButtons({ capture, actions, onDone }: {
	capture: CapturedSelection;
	actions: readonly SelectionAction[];
	onDone: () => void;
}) {
	return (
		<>
			{actions.filter((action) => action.visible(capture)).map((action) => {
				const disabled = action.disabledLabel?.(capture) ?? null;
				const Icon = action.icon;
				return (
					<Button
						key={action.id}
						type="button"
						size="xs"
						variant="outline"
						disabled={disabled !== null}
						aria-label={disabled ?? action.ariaLabel}
						className="bg-popover shadow-md dark:bg-popover dark:hover:bg-accent"
						// Keep the learner's selection alive through the click.
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => { if (runSelectionAction(action, capture)) onDone(); }}
					>
						<Icon aria-hidden="true" className="size-3.5" />
						{disabled ?? action.label}
					</Button>
				);
			})}
		</>
	);
}

/** Clip rects of every scrolling ancestor between a node and the viewport. */
function clipsFor(node: Node, viewport: HTMLElement): RectLike[] {
	const clips: RectLike[] = [viewport.getBoundingClientRect()];
	for (let element = node.parentElement; element && element !== viewport; element = element.parentElement) {
		const style = getComputedStyle(element);
		const clipX = style.overflowX !== "visible";
		const clipY = style.overflowY !== "visible";
		if (!clipX && !clipY) continue;
		const bounds = element.getBoundingClientRect();
		const left = bounds.left + element.clientLeft;
		const top = bounds.top + element.clientTop;
		clips.push({
			left: clipX ? left : -Infinity,
			right: clipX ? left + element.clientWidth : Infinity,
			top: clipY ? top : -Infinity,
			bottom: clipY ? top + element.clientHeight : Infinity,
		});
	}
	return clips;
}

/** Is any selected line box actually on screen (e.g. not scrolled away
 *  inside a code block's hidden overflow)? */
function selectionVisible(range: Range, viewport: HTMLElement): boolean {
	const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
	let node: Node | null = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer : walker.nextNode();
	for (; node; node = walker.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		const slice = document.createRange();
		slice.selectNodeContents(node);
		if (node === range.startContainer) slice.setStart(node, range.startOffset);
		if (node === range.endContainer) slice.setEnd(node, range.endOffset);
		if (!slice.toString().trim()) continue;
		const clips = clipsFor(node, viewport);
		if (Array.from(slice.getClientRects()).some((line) => isSelectionRectVisible(line, clips))) return true;
	}
	return false;
}

/** The floating toolbar over a tutor-text selection inside `viewport`. */
export function SelectionToolbar({ viewport, actions }: { viewport: HTMLElement | null; actions: readonly SelectionAction[] }) {
	const [state, setState] = useState<{ capture: CapturedSelection; position: SelectionActionPoint } | null>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	const observerRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
	const actionsRef = useRef(actions);
	actionsRef.current = actions;

	// Clamp inside the window once the real size is known, before paint.
	useLayoutEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar || !state) return;
		const rect = toolbar.getBoundingClientRect();
		toolbar.style.left = `${Math.max(8, Math.min(state.position.x, window.innerWidth - rect.width - 8))}px`;
		toolbar.style.top = `${Math.max(8, Math.min(state.position.y, window.innerHeight - rect.height - 8))}px`;
	}, [state]);

	useEffect(() => {
		if (!viewport) return;
		const clear = () => setState(null);
		const update = (pointer: SelectionActionPoint | null) => {
			const capture = captureSelection(viewport, window.getSelection());
			if (!capture || !actionsRef.current.some((action) => action.visible(capture))) { clear(); return; }
			const viewportRect = viewport.getBoundingClientRect();
			if (!isSelectionRectVisible(capture.range.getBoundingClientRect(), [viewportRect]) || !selectionVisible(capture.range, viewport)) { clear(); return; }
			const lines = Array.from(capture.range.getClientRects());
			const onText = pointer !== null && lines.some((line) =>
				pointer.x >= line.left - 8 && pointer.x <= line.right + 8 && pointer.y >= line.top - 8 && pointer.y <= line.bottom + 8);
			setState({
				capture,
				position: resolveSelectionActionPosition({
					bounds: viewportRect,
					selectionRect: lines.at(-1) ?? capture.range.getBoundingClientRect(),
					pointer: onText ? pointer : null,
					viewport: { width: window.innerWidth, height: window.innerHeight },
				}),
			});
		};
		const observer = observeSelectionActions({
			element: viewport,
			getActionElement: () => toolbarRef.current,
			restoreAfterScroll: true,
			onSelection: update,
			onDismiss: clear,
		});
		observerRef.current = observer;
		// Tab from the transcript reaches the toolbar first.
		const focusToolbar = (event: KeyboardEvent) => {
			const toolbar = toolbarRef.current;
			if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented) return;
			if (!toolbar || toolbar.contains(event.target as Node)) return;
			const first = toolbar.querySelector<HTMLButtonElement>("button:not([disabled])");
			if (!first) return;
			event.preventDefault();
			event.stopPropagation();
			first.focus({ preventScroll: true });
		};
		document.addEventListener("keydown", focusToolbar, true);
		document.addEventListener("selectionchange", observer.selectionChanged);
		return () => {
			document.removeEventListener("keydown", focusToolbar, true);
			document.removeEventListener("selectionchange", observer.selectionChanged);
			observer.dispose();
			observerRef.current = null;
		};
	}, [viewport]);

	if (!state) return null;
	const done = () => {
		window.getSelection()?.removeAllRanges();
		observerRef.current?.cancel();
		setState(null);
	};
	return createPortal(
		<div
			ref={toolbarRef}
			role="toolbar"
			aria-label="Selection actions"
			data-testid="selection-toolbar"
			className="fixed z-50 flex max-w-[calc(100vw-1rem)] gap-1"
			style={{ left: state.position.x, top: state.position.y }}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					observerRef.current?.cancel();
					setState(null);
				}
			}}
		>
			<SelectionToolbarButtons capture={state.capture} actions={actions} onDone={done} />
		</div>,
		document.body,
	);
}
