"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, SettingsSection, Toggle } from "./controls";

import { CatalogOperationStatus, CommunityPluginBrowser, pluginLinkClass } from "./community-plugin-browser";
import { communitySource } from "@/src/core";

export const PLUGIN_TRUST_WARNING = "Community plugins run unreviewed third-party code. They are not sandboxed and can read or change local files LearnHarness can access, including your chats and credentials, and make network requests. Only enable plugins you trust.";
export const PLUGIN_RESUME_NOTE = "Turning this on resumes any plugins you previously enabled.";

export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const core = origin === "core";
	const allowed = snapshot.communityEnabled === true;
	const modeBusy = snapshot.loading || snapshot.communityChanging || (!allowed && (snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)));
	const [confirming, setConfirming] = useState(false);
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	const installed = snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
		: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? "No Core plugins available." : "No community plugins installed."}</p>
			: plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin} onSettings={() => onOpenSettings?.(plugin.info.id)} />);
	return <SettingsSection title={core ? "Core plugins" : "Community plugins"} testid={core ? "section-core-plugins" : "section-plugins"}>
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{!core && <SettingsRow label="Allow community plugins" hint={allowed ? "On" : "Off"}>
			<Toggle label="Allow community plugins" checked={allowed} disabled={!manager || modeBusy} onChange={enabled => enabled ? setConfirming(true) : void manager?.setCommunityEnabled(false)} />
		</SettingsRow>}
		{!core && <p className="font-prose text-sm text-muted-foreground">{allowed ? PLUGIN_TRUST_WARNING : `${PLUGIN_TRUST_WARNING} ${PLUGIN_RESUME_NOTE}`}</p>}
		{!core && confirming && <CommunityOptInDialog allowed={allowed} busy={!manager || modeBusy} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void manager?.setCommunityEnabled(true); }} />}
		{!core && (!allowed || snapshot.communityChanging) && <CatalogOperationStatus operation={snapshot.catalogOperation} />}
		{!core && allowed && !snapshot.communityChanging && <>
		<BrowseControl />
		<details data-testid="plugin-install-help" className="text-xs text-muted-foreground">
			<summary className="w-fit cursor-pointer list-none text-muted-foreground underline underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">Manual installation</summary>
			<ol className="mt-2 list-decimal space-y-2 pl-5">
				<li>Clone or copy the plugin into the directory below, using its plugin ID as the folder name.</li>
				<li>For source projects, follow the repository’s dependency setup and run <code>npm run build</code>. Prebuilt packages already contain <code>dist/manifest.json</code> and need no build.</li>
				<li>Refresh the list, then enable the plugin. New plugins are disabled by default.</li>
				<li>Restart LearnHarness after changing loaded code. Preserve <code>data/</code> beside <code>dist/</code> when updating.</li>
			</ol>
		</details>
		<div data-testid="plugin-directory">
			<p className="text-xs text-muted-foreground">Plugins directory</p>
			<div className="mt-1 flex items-center gap-3">
				<code className="min-w-0 flex-1 break-all text-xs select-text">{snapshot.directory}</code>
				<Button variant="outline" size="icon-sm" aria-label="Refresh plugins" title="Refresh plugins" aria-busy={snapshot.refreshing}
					disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
					<RefreshCw aria-hidden="true" className={snapshot.refreshing ? "animate-spin" : undefined} />
				</Button>
			</div>
		</div>
		{snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		<SettingsGroup label="Installed" testid="group-installed-plugins">
			{installed}
		</SettingsGroup>
		</>}
		{core ? installed : <SettingsGroup label="Build a plugin" testid="plugin-authoring-help">
			<p className="font-prose text-sm text-muted-foreground">Download the authoring skill for your coding agent.</p>
			<div><Button variant="outline" size="sm" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">Download authoring skill</a></Button></div>
		</SettingsGroup>}
	</SettingsSection>;
}

// Opt-in is the only step that admits third-party code, so it is confirmed.
// Off stays one click. A change from another window closes the dialog.
function CommunityOptInDialog({ allowed, busy, onCancel, onConfirm }: { allowed: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
	useEffect(() => { if (allowed) onCancel(); }, [allowed, onCancel]);
	return <HostDialog open aria-label="Turn on community plugins" onClose={() => { onCancel(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
		frame={<div data-testid="community-opt-in-dialog" className="settings-dialog-pop mx-4 w-[32rem] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card p-5 shadow-xl" />}>
		<h2 className="text-sm font-semibold">Turn on community plugins?</h2>
		<p className="mt-2 font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING} {PLUGIN_RESUME_NOTE}</p>
		<div className="mt-4 flex justify-end gap-2">
			<Button type="button" variant="ghost" size="sm" data-testid="community-opt-in-cancel" onClick={onCancel}>Cancel</Button>
			<Button type="button" variant="outline" size="sm" data-testid="community-opt-in-confirm" disabled={busy} onClick={onConfirm}>Turn on community plugins</Button>
		</div>
	</HostDialog>;
}

// Off removes this subtree, including the open intent, even when the change
// originated in another window. Operation status lives in the window manager.
function BrowseControl() {
	const { manager, snapshot } = usePlugins();
	const [open, setOpen] = useState(false);
	return <>
		<div><Button variant="outline" size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>Browse</Button></div>
		{open ? <CommunityPluginBrowser onClose={() => setOpen(false)} operation={snapshot.catalogOperation} onInstall={offer => void manager?.installFromCatalog(offer)} />
			: <CatalogOperationStatus operation={snapshot.catalogOperation} />}
	</>;
}

function PluginRow({ plugin, onSettings }: { plugin: FrontendPlugin; onSettings: () => void }) {
	const { manager, snapshot } = usePlugins();
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	return <div className="border-t border-border/60 pt-3" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={[info.origin === "community" ? info.manifest?.version : undefined, plugin.busy ? "Saving…" : plugin.error ? "Error" : plugin.phase === "loading" ? "Loading…" : info.enabled ? "Enabled" : "Disabled"].filter(Boolean).join(" · ")}>
			<div className="flex shrink-0 items-center gap-2">
				{info.enabled && <button type="button" aria-label={`Settings for ${name}`} title={`Settings for ${name}`}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onSettings}><Settings className="size-3.5" aria-hidden="true" /></button>}
				<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (info.origin === "community" && snapshot.communityChanging) || (info.restartRequired && !info.enabled) || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
			</div>
		</SettingsRow>
		{info.origin === "community" && info.manifest && <p className="mt-1 text-xs text-muted-foreground">
			Declared author: {info.manifest.author || "Not provided"} · {info.repository ? <>Catalog source: <a className={pluginLinkClass} href={communitySource(info.repository)} target="_blank" rel="noreferrer">{info.repository}</a></> : "Local package · source not verified"}
		</p>}
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
	</div>;
}
