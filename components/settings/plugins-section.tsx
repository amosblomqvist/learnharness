"use client";

import { useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

import { CommunityPluginBrowser, pluginLinkClass } from "./community-plugin-browser";
import { communitySource } from "@/src/core";

export const PLUGIN_TRUST_WARNING = "Community plugins run unreviewed third-party code. They are not sandboxed and can read or change local files LearnHarness can access, including your chats and credentials, and make network requests. Only enable plugins you trust. Turning this on resumes any plugins you previously enabled.";

export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const [browse, setBrowse] = useState(false);
	const core = origin === "core";
	const allowed = snapshot.communityEnabled === true;
	const modeBusy = snapshot.loading || snapshot.communityChanging || (!allowed && (snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)));
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	return <SettingsSection title={core ? "Core plugins" : "Community plugins"} testid={core ? "section-core-plugins" : "section-plugins"}>
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{!core && <SettingsRow label="Allow community plugins" hint={allowed ? "On" : "Off"}>
			<Toggle label="Allow community plugins" checked={allowed} disabled={!manager || modeBusy} onChange={enabled => { setBrowse(false); void manager?.setCommunityEnabled(enabled); }} />
		</SettingsRow>}
		{!core && !allowed && <p className="font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>}
		{!core && allowed && browse && !snapshot.communityChanging && <CommunityPluginBrowser onBack={() => setBrowse(false)} onInstall={() => { void manager?.reload(); }} />}
		{(core || (allowed && !browse && !snapshot.communityChanging)) && <>
		{!core && <><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Installed</h3><Button variant="outline" size="sm" onClick={() => setBrowse(true)}>Browse</Button></div>
		<p className="text-xs text-muted-foreground">Community plugins are unreviewed and not sandboxed. Only enable plugins you trust.</p>
		<details data-testid="plugin-install-help" className="text-xs text-muted-foreground">
			<summary className="w-fit cursor-pointer list-none text-muted-foreground underline underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">Manual installation and authoring</summary>
			<ol className="mt-2 list-decimal space-y-2 pl-5">
				<li>Clone or copy the plugin into the directory below, using its plugin ID as the folder name.</li>
				<li>For source projects, follow the repository’s dependency setup and run <code>npm run build</code>. Prebuilt packages already contain <code>dist/manifest.json</code> and need no build.</li>
				<li>Refresh the list, then enable the plugin. New plugins are disabled by default.</li>
				<li>Restart LearnHarness after changing loaded code. Preserve <code>data/</code> beside <code>dist/</code> when updating.</li>
			</ol>
		<div data-testid="plugin-authoring-help" className="space-y-2 border-t border-border/60 pt-3">
			<h3 className="text-xs uppercase tracking-widest">Build a plugin</h3>
			<p className="font-prose text-sm text-muted-foreground">Download the authoring skill for your coding agent.</p>
			<Button variant="outline" size="sm" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">Download authoring skill</a></Button>
		</div>
		<div data-testid="plugin-directory" className="border-t border-border/60 pt-3">
			<p className="text-xs text-muted-foreground">Plugins directory</p>
			<div className="mt-1 flex items-center gap-3">
				<code className="min-w-0 flex-1 break-all text-xs select-text">{snapshot.directory}</code>
				<Button variant="outline" size="icon-sm" aria-label="Refresh plugins" title="Refresh plugins" aria-busy={snapshot.refreshing}
					disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
					<RefreshCw aria-hidden="true" className={snapshot.refreshing ? "animate-spin" : undefined} />
				</Button>
			</div>
		</div>
		</details>
		{snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		</>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
			: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? "No Core plugins available." : "No community plugins installed."}</p>
				: plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin}
					onSettings={() => onOpenSettings?.(plugin.info.id)} />)}
		</>}
	</SettingsSection>;
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
