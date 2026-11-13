"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * Dismissing hides this version for the mounted window only; the update
 * still installs on quit (autoInstallOnAppQuit) or via Settings.
 */

import { useState } from "react";
import { XIcon } from "lucide-react";
import { useUpdateState } from "@/components/settings/update-settings.tsx";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	const [dismissedVersion, setDismissedVersion] = useState<string | null>();
	if (ready?.status !== "downloaded" || ready.version === dismissedVersion) return null;
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
				<span className="text-muted-foreground"> — restart to finish installing.</span>
			</div>
			<button
				type="button"
				onClick={() => window.lh?.installUpdate?.()}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				Restart
			</button>
			<button
				type="button"
				aria-label="Dismiss update notification"
				onClick={() => setDismissedVersion(ready.version)}
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XIcon className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
