"use client";

/**
 * THE TOP BAR (owner standardization ruling, 2026-09-29): one element,
 * every surface — the same mechanics ALWAYS. Born from the chains-overlay
 * incident: its hand-rolled bar broke every rule at once (wrong height,
 * wrong title size, whole-bar no-drag so window drags fell through to
 * text selection, no sidebar reopen, traffic lights over content). The
 * law: whenever a surface has a top bar, it renders THIS component —
 * never a bespoke header.
 *
 * Mechanics baked in (the chat-session bar's proven pattern):
 * - h-15 (60px) — matches the sidebar's wordmark band, one border line.
 * - lh-drag — the window-drag band. NATIVE interactive children
 *   (button/input/a/…) carve out AUTOMATICALLY via the globals.css auto
 *   carve-out rule (owner standardization ruling, 2026-09-29 night) —
 *   "draggable anywhere that is not a clickable element" is structural,
 *   not per-child discipline; manual lh-no-drag is only for clickable
 *   non-natives (spans/divs with onClick).
 * - select-none — dragging never highlights the title.
 * - SidebarToggle FIRST — the sidebar reopen when closed, with its
 *   Electron traffic-light gutter (lh-closed-toggle).
 * - border-b border-border px-3, gap-3 rhythm.
 *
 * The consumer brings the title (font-title text-3xl tracking-tight) and
 * any right-side controls. THE TITLE LAW (owner round 11, 2026-10-05):
 * the serif title names a session or a registered plugin view (plugin UI
 * ruling, 2026-11-01); chrome-less creation surfaces (home, both /chat/new
 * drafts) and the chain table render NO title.
 * `drag={false}` is the one escape hatch —
 * chat's rename mode (app-region:drag would eat the mousedown that
 * exits the input; owner ask).
 *
 * THE OVERLAY TWIN OF THE MASK LAW (owner, 2026-09-29 night): app-region
 * subtraction resolves by DOM order, not z-index — a surface containing
 * a TopBar that COVERS other content (a full-bleed overlay) must be the
 * LAST child of its container, or later no-drag elements punch dead
 * zones through the bar (the chains-overlay bug: the graph chrome's
 * no-drag column killed drag over the counts/search/close area).
 */

import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar";

export function TopBar({
	drag = true,
	onMouseDown,
	children,
}: {
	drag?: boolean;
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
}) {
	return (
		<header
			onMouseDown={onMouseDown}
			className={`${drag ? "lh-drag " : ""}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3`}
		>
			<SidebarToggle />
			{children}
		</header>
	);
}
