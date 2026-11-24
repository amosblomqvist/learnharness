"use client";

import { useEffect, useState } from "react";
import { SmartphoneIcon, CopyIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import type { MobileAccessStatus } from "@/lib/mobile-access";
import { mobileStatus, mobileCommand, announceMobileStatus, copyText } from "@/components/mobile-runtime";
import { MobileLinkQr } from "@/components/mobile-link-qr";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, Toggle } from "./controls";

export function MobileAccessSettings() {
	const [status, setStatus] = useState<MobileAccessStatus>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [size, setSize] = useState("phone");
	const [copied, setCopied] = useState<string>();
	useEffect(() => { let live = true; void mobileStatus().then(value => { if (live) { setStatus(value); announceMobileStatus(value); } }).catch(() => { if (live) setError("Mobile Access status could not be loaded."); }); return () => { live = false; }; }, []);
	const command = async (op: string, fields?: Record<string, unknown>) => {
		setBusy(true); setError("");
		try { const next = await mobileCommand(op, fields); setStatus(next); announceMobileStatus(next); }
		catch (failure) { setError(failure instanceof Error ? failure.message : "Mobile Access could not be changed."); }
		finally { setBusy(false); }
	};
	const copy = async (label: string, value: string) => {
		if (await copyText(value)) setCopied(label); else setError("Could not copy. Select and copy the text below.");
	};
	return <SettingsGroup label="Mobile Access" testid="mobile-access-settings">
		<SettingsRow label="Use LearnHarness on your iPhone" hint="Your PC runs the models and keeps your learning data. Keep the desktop app open and Tailscale connected on both devices.">
			<Toggle checked={status?.enabled ?? false} disabled={busy || !status?.available} label="Enable Mobile Access" onChange={enabled => { void command("enable", { enabled }); }} />
		</SettingsRow>
		<p role="status" className="text-xs text-muted-foreground">{status?.message ?? "Checking Mobile Access…"}</p>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{status?.available && <div className="mt-2 flex flex-col gap-3">
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" disabled={busy} onClick={() => { void command("refresh"); }}><RefreshCwIcon className="size-4" />Check connection</Button>
				{status.url && <Button variant="outline" size="sm" onClick={() => { void copy("link", status.url!); }}>{copied === "link" ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}Copy private link</Button>}
				{status.directUrl && <Button variant="outline" size="sm" onClick={() => { void copy("direct", status.directUrl!); }}>{copied === "direct" ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}Copy direct link</Button>}
			</div>
			{status.url && <a className="break-all rounded-lg border bg-background px-3 py-3 text-sm select-all" href={status.url} target="_blank" rel="noreferrer">{status.url}</a>}
			{status.directUrl && <div className="flex flex-col gap-1">
				<div className="flex flex-wrap items-start gap-3">
					<MobileLinkQr link={status.directUrl} testid="mobile-direct-link-qr" />
					<a className="min-w-0 flex-1 break-all rounded-lg border bg-background px-3 py-3 text-sm select-all" href={status.directUrl} target="_blank" rel="noreferrer" data-testid="mobile-direct-link">{status.directUrl}</a>
				</div>
				<p className="text-xs text-muted-foreground">Direct link: works with Tailscale DNS off on the phone. It uses HTTP inside Tailscale&apos;s encrypted connection, so the browser may call it not secure.</p>
			</div>}
			{status.enabled && !status.serving && status.setupCommand && <details className="rounded-lg border p-3 text-xs">
				<summary className="cursor-pointer">Set up Tailscale HTTPS</summary>
				<p className="mt-3 text-muted-foreground">Run this command on the PC. It uses its own port and keeps other Tailscale sites running.</p>
				<code className="my-3 block break-all select-all">{status.setupCommand}</code>
				<Button variant="outline" size="sm" onClick={() => { void copy("setup", status.setupCommand!); }}>{copied === "setup" ? "Copied" : "Copy setup command"}</Button>
			</details>}
			{status.enabled && !status.directUrl && status.directSetupCommand && <details className="rounded-lg border p-3 text-xs">
				<summary className="cursor-pointer">Set up a direct link without Tailscale DNS</summary>
				<p className="mt-3 text-muted-foreground">Run this command on the PC, then check the connection. The link uses the PC&apos;s Tailscale IP address, so the phone doesn&apos;t need Tailscale DNS.</p>
				<code className="my-3 block break-all select-all">{status.directSetupCommand}</code>
				<Button variant="outline" size="sm" onClick={() => { void copy("direct-setup", status.directSetupCommand!); }}>{copied === "direct-setup" ? "Copied" : "Copy setup command"}</Button>
			</details>}
			{!status.remote && <div className="mt-1 flex flex-wrap items-center gap-2">
				<select aria-label="Phone viewport size" className="min-h-10 rounded-lg border bg-background px-3 text-sm" value={size} onChange={event => setSize(event.target.value)}>
					<option value="compact">Compact · 320 × 568</option><option value="phone">Phone · 390 × 844</option><option value="large">Large · 430 × 932</option>
				</select>
				<Button variant="outline" size="sm" disabled={busy} onClick={() => { void command("preview", { size }); }}><SmartphoneIcon className="size-4" />Open phone viewport</Button>
				<p className="w-full text-xs text-muted-foreground">Connected to your workspace. Resize the window to try other widths or landscape; Tailscale is optional for this window.</p>
			</div>}
			{status.remote && <p className="text-xs text-muted-foreground">Account sign-ins that need a PC browser open there. You can keep using existing model connections here.</p>}
		</div>}
	</SettingsGroup>;
}
