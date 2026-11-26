"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Snapshot from electron/phone-access.cjs (via preload). */
type PhoneAccessStatus = {
	available: boolean;
	enabled?: boolean;
	running?: boolean;
	error?: string | null;
	port?: number;
	addresses?: string[];
	/** learnharness://pair?… with a one-time code; null while not running. */
	pairingLink?: string | null;
	codeExpiresAt?: number | null;
	devices?: { id: string; name: string; createdAt: number; lastSeenAt: number; connected: boolean }[];
};

export type PhoneAccessBridge = {
	status: () => Promise<PhoneAccessStatus>;
	setEnabled: (enabled: boolean) => Promise<PhoneAccessStatus>;
	newCode: () => Promise<PhoneAccessStatus>;
	revoke: (id: string) => Promise<PhoneAccessStatus>;
	onChange: (cb: () => void) => () => void;
};

/** True only in the desktop app with a local (or dev) server. */
export function phoneAccessBridge(): PhoneAccessBridge | undefined {
	return typeof window === "undefined" ? undefined : window.lh?.phoneAccess;
}

function usePhoneAccess(bridge: PhoneAccessBridge) {
	const [status, setStatus] = useState<PhoneAccessStatus | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const refresh = useCallback(() => {
		void bridge.status().then((next) => { setStatus(next); setFailure(null); }, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
	}, [bridge]);
	useEffect(() => {
		const off = bridge.onChange(refresh); // subscribe before the first read
		refresh();
		return off;
	}, [bridge, refresh]);
	// A shown code expires: fetch the next one when it does.
	useEffect(() => {
		if (!status?.codeExpiresAt) return;
		const timer = setTimeout(refresh, Math.max(1000, status.codeExpiresAt - Date.now() + 250));
		return () => clearTimeout(timer);
	}, [status?.codeExpiresAt, refresh]);
	const run = useCallback(async (action: () => Promise<PhoneAccessStatus>) => {
		try { setStatus(await action()); setFailure(null); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
	}, []);
	return { status, failure, run };
}

/** Black on white with a quiet zone, so cameras read it in dark mode too. */
function PairingQr({ link, size = 168 }: { link: string; size?: number }) {
	const [markup, setMarkup] = useState<{ link: string; svg: string } | null>(null);
	useEffect(() => {
		let live = true;
		void QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
			.then((svg) => { if (live) setMarkup({ link, svg }); }, () => { if (live) setMarkup(null); });
		return () => { live = false; };
	}, [link]);
	return (
		<div
			role="img"
			aria-label="Pairing QR code"
			data-testid="phone-access-qr"
			className="shrink-0 overflow-hidden rounded-md bg-white [&>svg]:block [&>svg]:size-full"
			style={{ width: size, height: size }}
			// The SVG comes from the qrcode encoder, not from user markup.
			dangerouslySetInnerHTML={markup?.link === link ? { __html: markup.svg } : undefined}
		/>
	);
}

function lastSeen(device: { lastSeenAt: number; connected: boolean }): string {
	if (device.connected) return "Connected now";
	const minutes = Math.round((Date.now() - device.lastSeenAt) / 60000);
	if (minutes < 1) return "Last used just now";
	if (minutes < 60) return `Last used ${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `Last used ${hours} h ago`;
	return `Last used ${new Date(device.lastSeenAt).toLocaleDateString()}`;
}

export function PhoneAccessSettings({ bridge }: { bridge: PhoneAccessBridge }) {
	const { status, failure, run } = usePhoneAccess(bridge);
	const [busy, setBusy] = useState(false);
	const toggle = (on: boolean) => {
		setBusy(true);
		void run(() => bridge.setEnabled(on)).finally(() => setBusy(false));
	};
	if (!status) return <p className="text-xs text-muted-foreground" role="status">{failure ?? "Loading…"}</p>;
	if (!status.available) {
		return <p className="text-xs text-muted-foreground">Phone access is available when this app runs its own server (not while connected to a self-hosted server).</p>;
	}
	const devices = status.devices ?? [];
	return (
		<div className="flex flex-col gap-4" data-testid="phone-access">
			<SettingsRow
				label="Phone access"
				hint="Use LearnHarness on your iPhone through this computer, over the same Wi-Fi. Keep the app open here while you use it."
			>
				<Toggle checked={!!status.enabled} disabled={busy} onChange={toggle} label="Phone access" />
			</SettingsRow>
			{(status.error || failure) && <p className="text-xs text-destructive" role="alert">{status.error ?? failure}</p>}
			{status.running && (
				status.addresses?.length && status.pairingLink ? (
					<div className="flex flex-wrap items-start gap-4">
						<PairingQr link={status.pairingLink} />
						<div className="flex min-w-48 flex-1 flex-col gap-2 text-xs text-muted-foreground">
							<p className="text-sm text-foreground">Pair a phone</p>
							<p>Scan this code with the iPhone camera or in the LearnHarness app. It works once and expires in 5 minutes.</p>
							<p className="font-mono">{status.addresses.map((address) => `${address}:${status.port}`).join(" · ")}</p>
							<div>
								<Button variant="outline" size="sm" onClick={() => void run(bridge.newCode)}>New code</Button>
							</div>
						</div>
					</div>
				) : (
					<p className="text-xs text-muted-foreground">Connect this computer to a Wi-Fi or wired network to pair a phone.</p>
				)
			)}
			<div className="flex flex-col gap-2">
				<p className="text-sm">Paired phones</p>
				{devices.length === 0 ? (
					<p className="text-xs text-muted-foreground">No phones paired yet.</p>
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-testid="phone-access-devices">
						{devices.map((device) => (
							<li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
								<div className="min-w-0">
									<p className="truncate text-sm">{device.name}</p>
									<p className="text-xs text-muted-foreground">{lastSeen(device)}</p>
								</div>
								<Button variant="outline" size="sm" onClick={() => void run(() => bridge.revoke(device.id))}>Revoke</Button>
							</li>
						))}
					</ul>
				)}
				<p className="text-xs text-muted-foreground">A paired phone can use your sessions, knowledge graph and settings until you revoke it.</p>
			</div>
		</div>
	);
}
