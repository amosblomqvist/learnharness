"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { bindingForAction, formatBinding, type KeyAction } from "@/src/core"
import { useLocale } from "@/lib/i18n/provider"

/**
 * The tooltip composition for icon and pill controls (tooltip wave, owner
 * 2026-09-25; subtlety round same day). The styled Radix tooltip carries
 * the label, with the control's shortcut appended in parentheses when
 * it has one ("Dictate (⌘D)") — the owner call: the em-dash suffix read
 * as too much air.
 *
 * The binding is override-aware: pass `action` for registry shortcuts (a
 * user rebind in Settings → Keyboard changes the suffix live), or
 * `binding` for surface-owned keys with no registry entry ("escape" for a
 * dialog close, "enter" for a form submit).
 *
 * children must be a single element able to take a ref (TooltipTrigger
 * asChild merges onto it — no wrapper DOM, no layout shift).
 */

interface HintProps {
	label: string
	/** Registry action whose LIVE binding is shown (override-aware). */
	action?: KeyAction
	/** Surface-owned binding ("escape", "enter") — keys the registry
	 *  deliberately doesn't dispatch (Esc closes the dialog itself; Enter
	 *  submits the form the button belongs to). */
	binding?: string
	side?: "top" | "bottom" | "left" | "right"
	children: React.ReactElement
}

/** The composition itself, pure — "Dictate" + ⌘D → "Dictate (⌘D)". Exported
 *  for the mechanism pins (tests/tooltip-mechanism.test.tsx). */
export function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action
		? formatBinding(bindingForAction(action))
		: binding
			? formatBinding(binding)
			: ""
	return live ? `${label} (${live})` : label
}

export function Hint({ label, action, binding, side = "top", children }: HintProps) {
	const { dir } = useLocale()
	// Physical sides mirror in RTL: a tooltip meant to sit toward the page edge
	// of its control must follow the control when the layout flips.
	const resolved = dir === "rtl" ? (side === "left" ? "right" : side === "right" ? "left" : side) : side
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side={resolved}>{hintText(label, action, binding)}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}