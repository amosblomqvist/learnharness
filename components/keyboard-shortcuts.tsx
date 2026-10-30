"use client";

/**
 * Keyboard shortcuts (shortcut wave A, 2026-09-17) — the single document-level
 * keydown listener. Owns the pieces that belong to no surface in particular:
 *
 * - Tab is DEAD: browser tab-focus navigation is abandoned by owner decision
 *   (2026-09-17). Tab is suppressed everywhere (preventDefault, no-op) and
 *   Shift+Tab cycles the thinking level instead.
 * - Esc is a layered dismiss: topmost popover first (popovers stopPropagation
 *   on their own Esc — usePopoverDismiss + ModelControl), then dictation
 *   CANCEL (discard the transcript, owner 2026-09-17 round 3), then stop
 *   read aloud, then abort of an in-flight turn.
 * - Global actions dispatch lh:kbd-<action> window events; surfaces that are
 *   mounted listen (the lh:chat-renamed pattern). A surface that isn't
 *   mounted simply doesn't listen — an F2 on the graph view is a no-op, not
 *   an error. Actions live in src/core/keyboard.ts (registry + persisted
 *   overrides), the ONE table the settings milestone will render as its
 *   editor.
 *
 * Listeners attach at the WINDOW level (bubble's last stop) so every
 * component-level handler — popovers' own Esc, the composer's Esc — gets the
 * event first and can claim it with stopPropagation.
 */

import { useEffect, useRef, useState } from "react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useRouter } from "next/navigation";
import {
	actionForBinding,
	bindingForAction,
	eventBinding,
	formatBinding,
	isTypingSurface,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
} from "@/src/core";
import { isDictationActive } from "@/components/dictation";
import { runEscFallback } from "@/components/esc-fallback";
import { readAloudPlayer } from "@/components/read-aloud";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";

// Re-exported for the contract pin (tests/keyboard-toggle-sidebar.test.ts):
// the dispatcher composes event names through the ONE helper — a second
// spelling here is how the ⌘B bug happened.
export { kbdEventForAction };

export function KeyboardShortcuts() {
	const router = useRouter();
	const [cheatOpen, setCheatOpen] = useState(false);
	const { open: openSettings } = useSettingsDialog();

	// Router + cheat + settings state inside a ref so the keydown listener
	// (attached once) never goes stale.
	const handlersRef = useRef<{
		router: ReturnType<typeof useRouter>;
		setCheatOpen: (v: boolean) => void;
		openSettings: () => void;
	}>({ router, setCheatOpen, openSettings });
	handlersRef.current = { router, setCheatOpen, openSettings };

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// ── Tab is dead (owner, 2026-09-17): preventDefault even when
			// nothing is bound to it — browser tab-focus is abandoned, and
			// the default action runs after dispatch, so suppressing it here
			// works from any focus.
			if (e.key === "Tab") {
				e.preventDefault();
				if (e.shiftKey) window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking"));
				// Plain Tab cycles the active surface's text fields (owner,
				// keyboard round 2026-10-06) — forward-only, wrapping; each
				// composer-bearing page answers with its own chain. The quiz
				// dock's rows↔thinking claim stops propagation at document
				// level, so a claimed Tab never reaches this dispatch.
				else if (!e.metaKey && !e.ctrlKey && !e.altKey)
					window.dispatchEvent(new CustomEvent("lh:kbd-cycle-fields"));
				return;
			}

			if (e.key === "Escape") {
				// Our own overlay is the topmost layer.
				if (cheatOpen) {
					setCheatOpen(false);
					e.preventDefault();
					return;
				}
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): one
				// Esc, one action, on the topmost active layer. Field-level
				// handlers claim at their element (focus in a field: the
				// field's action); every SURFACED layer (popovers, plan,
				// overlays, dialogs) claims at the DOCUMENT level, which
				// fires before this window listener — so reaching here means
				// NOTHING is surfaced and no field is focused. This chain is
				// the fallback, bottom-up: dictation (a live capture, not a
				// surface — it survives Esc that closes a plan or overlay),
				// then stop read aloud (audio playing — consumes the Esc, so
				// the turn is NOT aborted), then abort the turn (a
				// server-side turn has no client request to abort — the
				// abort seam in Chat decides what's honestly stoppable,
				// layered by escAbortTarget). Order: esc-fallback.ts.
				runEscFallback(e, {
					isDictationActive,
					player: readAloudPlayer(),
					dispatch: (name) => window.dispatchEvent(new CustomEvent(name)),
				});
				return;
			}

			// ── Registry dispatch.
			const action = actionForBinding(eventBinding(e));
			if (!action) return;

			// The input guard: inside a typing surface only mod/alt combos
			// fire (they never type a character). Bare keys — "?" included —
			// pass through so the field keeps them. Tab already returned above.
			if (isTypingSurface(e) && !(e.metaKey || e.ctrlKey || e.altKey)) return;

			// Dispatch: global commands we own run here; surface commands
			// ride the window event for the mounted surface to catch.
			switch (action) {
				case "new-session":
					handlersRef.current.router.push("/chat/new");
					break;
				case "open-settings":
					// Settings-app wave: the dialog is the surface, the URL is
					// gone — /settings redirects to the draft shell.
					handlersRef.current.openSettings();
					break;
				case "jump-graph":
					handlersRef.current.router.push("/");
					break;
				case "cheat-sheet":
					handlersRef.current.setCheatOpen(true);
					break;
				case "find":
					// The mounted surface owns Find (session text / graph nodes).
					// Claim Mod+F so Chromium's whole-window finder cannot open too.
					e.preventDefault();
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
					break;
				default:
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cheatOpen]);

	return <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />;
}

/** The ? overlay — the registry rendered as a table (grouped by scope).
 *  Until the settings milestone ships an editor, this is how shortcuts
 *  stay discoverable. */
function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);
	if (!open) return null;
	const scopes = ["global", "chat", "graph"] as const;
	const scopeLabels: Record<(typeof scopes)[number], string> = {
		global: "Global",
		chat: "Chat",
		graph: "Graph view",
	};
	return (
		<div
			data-testid="cheat-sheet"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			{...backdropDismiss}
		>
			<div
				className="max-h-[80vh] w-full max-w-[36rem] overflow-y-auto rounded-xl border bg-card p-5 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-baseline justify-between">
					<span className="text-sm font-medium text-card-foreground">Keyboard shortcuts</span>
					<span className="text-xs text-muted-foreground">Esc to close</span>
				</div>
				{scopes.map((scope) => {
					const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
					if (actions.length === 0) return null;
					return (
						<div key={scope} className="mb-4">
							<div className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
								{scopeLabels[scope]}
							</div>
							<div className="flex flex-col gap-1">
								{actions.map((a) => (
									<div key={a.id} className="flex items-center justify-between gap-4 text-sm">
										<span className="text-muted-foreground">{a.label}</span>
										<kbd className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-card-foreground">
											{formatBinding(bindingForAction(a.id))}
										</kbd>
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
