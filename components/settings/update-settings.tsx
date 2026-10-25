"use client";
/**
 * Settings → General: the version and the update controls (owner
 * 2026-10-25, modeled on Obsidian's General page). Two rows:
 *
 *   Version 0.3.7                              [Check for updates]
 *   <status line> · Release notes
 *   Automatic updates                                    [toggle]
 *
 * The state lives in the shell (electron/update-state.cjs): read once on
 * mount, then every "lh:update-status" push. The button spins while a
 * check or download runs and turns into Restart once an update is staged.
 * Quiet like Obsidian — an automatic check that finds nothing says
 * nothing — but errors show their raw message: that text is the only
 * diagnostic a user can hand back.
 *
 * No updater (browser, `next dev`, unpackaged shell): the version row
 * alone, no button, no toggle — neither would do anything.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Mirrors electron/update-state.cjs. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	error: string | null;
	manual: boolean;
};

/** Build-time, from package.json (next.config.ts env). */
export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";

export const AUTO_UPDATE_HINT = "Turn this off to prevent the app from checking for updates.";

/** The status line under the version — null when there is nothing to say. */
export function updateStatusText(state: UpdateState | null): string | null {
	switch (state?.status) {
		case "downloaded":
			return `A new version (${state.version ?? "update"}) is ready to be installed.`;
		case "up-to-date":
			return "You're up to date.";
		case "error":
			return `Couldn't check for updates: ${state.error}`;
		default:
			return null;
	}
}

export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	// null = no updater to talk to (no bridge, or the shell says disabled).
	const [state, setState] = useState<UpdateState | null>(null);

	useEffect(() => {
		const lh = window.lh;
		if (!lh?.getUpdateState) return;
		let live = true;
		void lh.getUpdateState().then((s) => { if (live) setState(s); });
		const off = lh.onUpdateStatus?.((s) => setState(s));
		return () => { live = false; off?.(); };
	}, []);

	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = updateStatusText(state);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;

	return (
		<>
			<SettingsRow
				label={`Version ${version || "unknown"}`}
				hint={
					status || releaseNotes ? (
						<>
							{status && <span className="block" data-testid="update-status">{status}</span>}
							{releaseNotes && (
								<a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">
									Release notes
								</a>
							)}
						</>
					) : undefined
				}
				testid="row-version"
			>
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>
						Restart
					</Button>
				) : (
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						data-testid="update-check"
						disabled={busy}
						aria-busy={busy}
						onClick={() => void window.lh?.checkForUpdates?.()}
					>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label="Automatic updates" hint={AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label="auto update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}
