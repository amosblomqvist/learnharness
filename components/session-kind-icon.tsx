"use client";

/**
 * Session-kind chrome shared by the sidebar, home and the draft view
 * (session/record kinds stage C, owner C1/C3): a plugin kind's optional SVG
 * icon (puzzle fallback, the plugin-action rule) and the live kind catalog.
 */

import { useMemo } from "react";
import { PuzzleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlugins } from "@/components/plugins";
import { kindCatalog, type KindCatalog } from "@/components/session-kind-catalog";

export function SessionKindIcon({ icon, label, className }: { icon?: string; label?: string; className?: string }) {
	return icon
		? <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("inline-flex shrink-0 items-center justify-center [&>svg]:size-full", className)} dangerouslySetInnerHTML={{ __html: icon }} />
		: <PuzzleIcon aria-label={label} aria-hidden={label ? undefined : true} className={cn("shrink-0", className)} />;
}

/** The live catalog over the plugin snapshot (empty without a provider). */
export function useKindCatalog(): KindCatalog {
	const { snapshot } = usePlugins();
	return useMemo(() => kindCatalog(snapshot), [snapshot]);
}
