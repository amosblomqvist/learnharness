"use client";
import { useEffect, useState } from "react";
import { SettingsSection, Toggle } from "./controls.tsx";

interface Status {
	enabled: boolean; configured: boolean; profile: string;
	user: { id: string; name: string | null; email: string | null } | null;
	syncing: boolean; lastSynced: string | null; error: string | null; deferred: number; pendingSignIn: boolean;
}
const button = "rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed";
export function LabsSection() {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			try {
				const response = await fetch("/api/labs/cloud", { cache: "no-store" });
				if (!response.ok) throw new Error("Labs could not be loaded. Reopen settings to retry.");
				const next = await response.json() as Status;
				if (alive) setStatus(next);
			} catch (error) { if (alive) setError(error instanceof Error ? error.message : "Labs could not be loaded."); }
			finally { if (alive) timer = setTimeout(() => { void load(); }, 3000); }
		}
		void load();
		return () => { alive = false; clearTimeout(timer); };
	}, []);
	async function control(op: string, enabled?: boolean) {
		setBusy(true); setError(null);
		// Reserve a browser tab synchronously to avoid popup blocking. Electron's
		// existing window-open handler opens it in the system browser instead.
		const desktop = ["win32", "darwin", "linux"].includes(window.lh?.platform ?? "");
		const popup = op === "signIn" && !desktop ? window.open("about:blank", "_blank") : null;
		if (popup) popup.opener = null;
		try {
			const response = await fetch("/api/labs/cloud", { method: "POST", headers: { "Content-Type": "application/json", "x-learnharness-cloud": "1" }, body: JSON.stringify({ op, enabled }) });
			const body = await response.json() as Status & { error?: string; redirect?: string };
			if (!response.ok) throw new Error(body.error ?? "Could not update the cloud connection.");
			if (body.redirect) {
				const target = new URL(body.redirect);
				if (target.origin !== "https://accounts.google.com") throw new Error("Unexpected sign-in destination.");
				if (popup) { popup.opener = null; popup.location.href = target.href; }
				else if (desktop) window.open(target.href, "_blank", "noopener,noreferrer");
				else throw new Error("Allow popups for LearnHarness, then try Google sign-in again.");
			} else {
				setStatus(body);
				if (status && status.profile !== body.profile) window.location.assign("/");
			}
		} catch (error) { popup?.close(); setError(error instanceof Error ? error.message : "Could not update the cloud connection."); }
		finally { setBusy(false); }
	}
	return <SettingsSection title="Labs" hint="Experimental features. Enable only the features you want to try." testid="section-labs">
		<div className="mt-5 space-y-4 text-sm">
			<div className="flex items-center justify-between gap-4">
				<div><h3>Google account &amp; thread sync</h3><p className="mt-1 text-xs text-muted-foreground">Keep your threads available across computers with the same Google account.</p></div>
				<Toggle label="Enable Google account and thread sync" checked={status?.enabled ?? false} disabled={busy || !status} onChange={enabled => { void control("enable", enabled); }} />
			</div>
			{!status && !error && <p role="status" className="text-xs text-muted-foreground">Loading Labs…</p>}
			{status?.enabled && <div className="space-y-3 border-t border-border pt-4">
				<p className="text-xs text-muted-foreground">Sign-in is optional. Your first connection uploads existing local threads. The most recently updated version wins if computers edit the same thread.</p>
				{!status.configured ? <p role="status" className="text-xs text-muted-foreground">Google sign-in needs setup. Configure LH_CONVEX_URL and the Convex Google OAuth credentials using docs/cloud-sync.md, then restart LearnHarness.</p>
					: status.user ? <>
						<p data-testid="labs-account">{status.user.name ?? "Google account"}{status.user.email && <span className="block text-xs text-muted-foreground">{status.user.email}</span>}</p>
						<p role="status" className="text-xs text-muted-foreground">{status.syncing ? "Syncing threads…" : status.deferred ? "Waiting for active sessions or newer changes…" : status.lastSynced ? `Last synced ${new Date(status.lastSynced).toLocaleTimeString()}` : "Waiting to sync…"}</p>
						<div className="flex gap-2"><button type="button" className={button} disabled={busy || status.syncing} onClick={() => { void control("sync"); }}>Sync now</button><button type="button" className={button} disabled={busy || status.syncing} onClick={() => { void control("signOut"); }}>Sign out</button></div>
					</> : <div className="flex items-center gap-3"><button type="button" className={button} disabled={busy || status.pendingSignIn} onClick={() => { void control("signIn"); }}>Sign in with Google</button>{status.pendingSignIn && <><span role="status" className="text-xs text-muted-foreground">Complete sign-in in your browser.</span><button type="button" className={button} disabled={busy} onClick={() => { void control("cancel"); }}>Cancel</button></>}</div>}
				<p className="text-xs text-muted-foreground">Knowledge graph, app preferences, provider keys, and installed plugins stay on this computer. Signing out returns to your local library; account threads remain cached for reconnection.</p>
			</div>}
			{(error ?? status?.error) && <p role="alert" className="text-xs text-error">{error ?? status?.error}</p>}
		</div>
	</SettingsSection>;
}
