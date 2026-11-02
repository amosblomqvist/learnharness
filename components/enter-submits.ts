"use client";

/**
 * ENTER SUBMITS — regardless of where focus is (owner round 6, 2026-10-05).
 * The dictation reality: the learner dictates into the dock's field without
 * ever focusing it, so Enter must submit from ANYWHERE — body focus, a
 * scroll, a stray link. The field's own Enter handler still fires first
 * when it IS focused (this listener sits at the window level, bubble's last
 * stop) — one law, two entry points, no double submit (the focused field's
 * handler claims the event via its own keydown; this hook skips typing
 * surfaces entirely).
 *
 * What the window listener refuses to touch:
 * - typing surfaces (input/textarea/select/contenteditable) — the focused
 *   surface owns its Enter (the dock field, the composer, settings);
 * - modified Enter (⇧↵ is a newline, ⌘/Ctrl↵ belongs to the surface).
 *
 * BUTTONS — the pointer/keyboard split (owner, keyboard round 2026-10-10):
 * a mouse click on a transcript control (a thinking toggle, a copy button)
 * leaves focus ON that button; the learner's next Enter must SUBMIT, not
 * re-activate the toggle — the report that born this rule. But two button
 * populations keep native Enter-activates:
 *   1. KEYBOARD-focused buttons — :focus-visible means focus arrived by
 *      keyboard (the arrow-walked menus; Tab is dead app-wide, so this
 *      only happens inside overlays);
 *   2. buttons inside an OPEN OVERLAY — menus walk focus with arrows and
 *      Enter activates the walked button natively (menu-shell's contract),
 *      dialogs are their own surfaced layer (the ONE-ESC LAW's layers).
 * The pointer-clicked transcript button fails both tests → Enter is ours
 * (preventDefault also suppresses the browser's default activation, so
 * the toggle does not fire underneath the submit).
 *
 * The submit callbacks self-guard (empty thinking / canSubmit) — this hook
 * never checks answer validity, only focus honesty.
 */

import { useEffect, useRef, type RefObject } from "react";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { isTypingSurface } from "@/src/core";

/** Overlay roots whose buttons keep native Enter (hand-rolled menus mark
 *  themselves data-lh-menu; Radix poppers/dialogs carry their own attrs). */
const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

/** Pure decision, exported for pins: does a focused BUTTON keep native
 *  Enter (true) or does Enter belong to submit (false)? */
export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	// Keyboard-walked focus: the menu arrows landed here — Enter activates.
	// (Guarded: a selector engine without the pseudo — linkedom in the
	// test harness — degrades to "not keyboard focus", never throws on
	// every Enter.)
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// unsupported pseudo — treat as pointer focus
	}
	// Inside an open overlay: the overlay owns its keys.
	return !!el.closest(OVERLAY_ROOTS);
}

/** Mount-scoped: while the dock is mounted (a problem/question is active),
 *  plain Enter anywhere outside a typing surface or button submits it. */
export function useEnterSubmits(submit: () => void, scopeRef?: RefObject<HTMLElement | null>): void {
	const controller = useOptionalInteractionLayers();
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.defaultPrevented) return;
			if (!isInteractionScopeEligible(scopeRef ? scopeRef.current : document.body, controller)) return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [controller, scopeRef]);
}
