"use client";

import { useEffect, useState } from "react";
import { SettingsGroup } from "./controls";

type Status = { enabled: boolean; pairingActive: boolean; devices: { id: string; name: string; online: boolean }[] };
type Pairing = { connection: string; qr: string; expires: number };
async function request(action: string, extra = {}, signal?: AbortSignal) {
	const res = await fetch("/api/lesson-lan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }), signal });
	const body = await res.json(); if (!res.ok) throw new Error(body.error ?? "Could not connect devices"); return body;
}
export function LessonLan() {
	const [status, setStatus] = useState<Status>();
	const [pairing, setPairing] = useState<Pairing>();
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const [unavailable, setUnavailable] = useState(false);
	useEffect(() => {
		if (busy) return;
		const controller = new AbortController(); let polling = false;
		async function poll() {
			if (polling) return;
			polling = true;
			try {
				const value: Status = await request("status", {}, AbortSignal.any([controller.signal, AbortSignal.timeout(900)]));
				if (!controller.signal.aborted) {
					setStatus(value); setUnavailable(false);
					if (!value.pairingActive) setPairing(undefined);
				}
			} catch {
				if (!controller.signal.aborted) {
					setUnavailable(true);
					setStatus(previous => previous && ({ ...previous, devices: previous.devices.map(device => ({ ...device, online: false })) }));
				}
			} finally { polling = false; }
		}
		void poll(); const timer = setInterval(() => void poll(), 1000);
		return () => { clearInterval(timer); controller.abort(); };
	}, [busy]);
	async function run(action: string, extra = {}) {
		setBusy(true); setError("");
		try {
			const value = await request(action, extra);
			if (action !== "pair") setStatus(value);
			if (action === "start" || action === "pair") {
				setPairing(action === "pair" ? value : await request("pair"));
				setStatus(previous => previous && ({ ...previous, pairingActive: true }));
			} else if (action === "stop") setPairing(undefined);
		} catch (e) { setError(e instanceof Error ? e.message : "Could not connect devices"); }
		finally { setBusy(false); }
	}
	const button = "rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40";
	return <SettingsGroup label="Connect a device">
		<fieldset disabled={busy || !status} className="min-w-0 space-y-3">
			<div className="flex flex-wrap gap-2">
				<button type="button" className={button} onClick={() => void run(status?.enabled ? "pair" : "start")}>{status?.devices.length ? "Connect another device" : "Connect a device"}</button>
				{status?.enabled && <button type="button" className={button} onClick={() => void run("stop")}>Turn off</button>}
			</div>
			{status?.enabled && pairing && status.pairingActive && <div className="space-y-2">
				{/* Generated locally; never use a remote QR service. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={pairing.qr} width={320} height={320} alt="Scan to connect a device" className="max-w-full rounded-sm" />
				<p className="text-xs text-muted-foreground">Expires in 5 minutes. Keep this QR private.</p>
				<details className="text-xs"><summary>Use a connection string</summary><textarea aria-label="Connection string" readOnly value={pairing.connection} className="mt-2 w-full break-all rounded-sm border border-border bg-background p-2" /></details>
			</div>}
			{status?.devices.map(device => <div key={device.id} className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-2 text-xs">
				<span className="flex min-w-0 items-center gap-2"><span role="img" aria-label={device.online ? "Online" : "Offline"} className={`size-2 shrink-0 rounded-full ${device.online ? "bg-green-500" : "bg-red-500"}`} /><span className="min-w-0 break-words">{device.name}</span></span>
				<button type="button" className={button} onClick={() => void run("revoke", { id: device.id })}>Disconnect</button>
			</div>)}
		</fieldset>
		{(error || unavailable) && <p role="alert" className="mt-3 text-xs">{error || "Device connection unavailable."}</p>}
	</SettingsGroup>;
}
