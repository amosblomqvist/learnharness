"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * No dismiss: a downloaded update installs on quit anyway
 * (autoInstallOnAppQuit); the banner is a courtesy, not a gate.
 */

import { useUpdateState } from "@/components/settings/update-settings.tsx";
import { useT } from "@/components/locale";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	const t = useT();
	if (ready?.status !== "downloaded") return null;
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">{ready.version == null ? t("LearnHarness update is ready") : t("LearnHarness {version} is ready", { version: ready.version })}</span>
				<span className="text-muted-foreground">{t(" — restart to finish installing.")}</span>
			</div>
			<button
				type="button"
				onClick={() => window.lh?.installUpdate?.()}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				{t("Restart")}
			</button>
		</div>
	);
}
