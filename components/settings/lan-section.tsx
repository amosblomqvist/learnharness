"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { LanState } from "@/components/sidebar";
import { SettingsRow, Toggle } from "./controls.tsx";

const noopSubscribe = () => () => {};

/** True only in the desktop window (preload bridge). The server snapshot is
 *  false so hydration matches and remote browsers never see the section. */
export function useHasLanBridge(): boolean {
	return useSyncExternalStore(noopSubscribe, () => Boolean(window.lh?.lan), () => false);
}

const inputClass = "h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60";

export const NO_PASSWORD_WARNING =
	"No password is set. Anyone on this network can use the agent (which can read files on this computer), your keys, and your learning data.";

type Lan = NonNullable<NonNullable<Window["lh"]>["lan"]>;

/** The panel, driven by an explicit bridge (tests pass a stub). */
export function LanPanel({ lan, initial = null }: { lan: Lan; initial?: LanState | null }) {
	const [state, setState] = useState<LanState | null>(initial);
	const [failure, setFailure] = useState<string | null>(null);
	const [port, setPort] = useState<string | null>(null);
	const [password, setPassword] = useState("");

	useEffect(() => {
		let live = true;
		lan.get().then((next) => live && setState(next), () => live && setFailure("Couldn’t read the LAN settings."));
		return () => { live = false; };
	}, [lan]);

	const run = (call: () => Promise<LanState>, after?: () => void) => {
		setFailure(null);
		call().then(
			(next) => { setState(next); after?.(); },
			(err: unknown) => setFailure(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "") : "That change failed."),
		);
	};

	if (!state) return <p className="text-xs text-muted-foreground/70">{failure ?? "Loading…"}</p>;
	const shownPort = port ?? String(state.port);
	const error = failure ?? state.error;

	return (
		<>
			<SettingsRow label="Allow access from other devices on this network" hint={state.running ? "On. Closing the app turns it off." : "Off"} testid="row-lan-enabled">
				<Toggle checked={state.enabled} label="LAN access" onChange={(on) => run(() => lan.setEnabled(on))} />
			</SettingsRow>
			{error && <p role="alert" className="text-xs text-red-500" data-testid="lan-error">{error}</p>}
			{state.enabled && !state.hasPassword && (
				<p role="alert" className="rounded-sm border border-amber-500/40 px-3 py-2 text-xs text-amber-500" data-testid="lan-warning">{NO_PASSWORD_WARNING}</p>
			)}
			<SettingsRow label="Port" hint="1024 to 65535. Changing it restarts LAN access." testid="row-lan-port">
				<span className="flex items-center gap-2">
					<input
						type="text" inputMode="numeric"
						min={1024}
						max={65535}
						value={shownPort}
						aria-label="LAN port"
						data-testid="lan-port"
						onChange={(e) => setPort(e.target.value)}
						className={`${inputClass} w-24`}
					/>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="lan-port-save" disabled={shownPort === String(state.port)} onClick={() => run(() => lan.setPort(Number(shownPort)), () => setPort(null))}>
						Save
					</Button>
				</span>
			</SettingsRow>
			{state.running && state.urls.length > 0 && (
				<div data-testid="lan-urls" className="text-xs">
					<p className="text-muted-foreground">Open one of these on another device:</p>
					<ul className="mt-1 flex flex-col gap-0.5 font-mono text-foreground">
						{state.urls.map((url) => <li key={url} className="select-text">{url}</li>)}
					</ul>
				</div>
			)}
			<SettingsRow label="Password" hint={state.hasPassword ? "A password is set. Changing or removing it signs every device out." : "Optional. Without one, anyone on the network gets in."} testid="row-lan-password">
				<span className="flex items-center gap-2">
					<input
						type="password"
						value={password}
						placeholder={state.hasPassword ? "New password" : "Password"}
						aria-label="LAN password"
						data-testid="lan-password"
						autoComplete="new-password"
						onChange={(e) => setPassword(e.target.value)}
						className={`${inputClass} w-40`}
					/>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="lan-password-save" disabled={!password} onClick={() => run(() => lan.setPassword(password), () => setPassword(""))}>
						{state.hasPassword ? "Change" : "Set"}
					</Button>
					{state.hasPassword && (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="lan-password-remove" onClick={() => run(() => lan.setPassword(null))}>
							Remove
						</Button>
					)}
				</span>
			</SettingsRow>
			<p className="text-xs text-muted-foreground/70">
				Use this only on a trusted network. The connection is plain HTTP, and the password is optional but recommended.
			</p>
		</>
	);
}

/** Renders nothing outside the desktop window. */
export function LanSection() {
	const has = useHasLanBridge();
	return has && window.lh?.lan ? <LanPanel lan={window.lh.lan} /> : null;
}
