"use client";

/**
 * One open/closed store for every collapsible kind in DISCLOSURES (your
 * thinking, Why, agent thinking). Each block starts at its kind's
 * Appearance "Start expanded" setting; a click toggles just that block.
 * A keyboard toggle sets every block of the kind, mounted now or later,
 * for this page load only: nothing persists, so a reload returns to the
 * setting. A changed setting replaces any keyboard set for its kind.
 */

import { useEffect, useState } from "react";
import { DISCLOSURE_KINDS, type DisclosureKind } from "@/src/core";
import { useAppearance } from "@/components/settings/appearance";

type Listener = (open: boolean) => void;

const keyboardSets: Partial<Record<DisclosureKind, boolean>> = {};
const listeners = Object.fromEntries(
	DISCLOSURE_KINDS.map((kind) => [kind, new Set<Listener>()]),
) as Record<DisclosureKind, Set<Listener>>;

function setAll(kind: DisclosureKind, open: boolean) {
	for (const listener of listeners[kind]) listener(open);
}

export function toggleAllDisclosures(kind: DisclosureKind, expandByDefault: boolean): void {
	const open = !(keyboardSets[kind] ?? expandByDefault);
	keyboardSets[kind] = open;
	setAll(kind, open);
}

export function applyExpandByDefault(kind: DisclosureKind, open: boolean): void {
	delete keyboardSets[kind];
	setAll(kind, open);
}

export function useDisclosure(kind: DisclosureKind) {
	const expandByDefault = useAppearance().appearance.expandByDefault[kind];
	const [open, setOpen] = useState(() => keyboardSets[kind] ?? expandByDefault);
	useEffect(() => {
		const subscribed = listeners[kind];
		subscribed.add(setOpen);
		// A keyboard set that landed between this block's render and its
		// subscription would otherwise be missed.
		const set = keyboardSets[kind];
		if (set !== undefined) setOpen(set);
		return () => {
			subscribed.delete(setOpen);
		};
	}, [kind]);
	return [open, setOpen] as const;
}
