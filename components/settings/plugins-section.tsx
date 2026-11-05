"use client";

import { Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

export const PLUGIN_TRUST_WARNING = "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.";

export function PluginsSection({ onOpenSettings }: { onOpenSettings?: (pluginId: string) => void }) {
	const { manager, snapshot } = usePlugins();
	return <SettingsSection title="Plugins" testid="section-plugins">
		<p className="font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		<p className="text-xs text-muted-foreground">Plugins are disabled by default. Place a plugin’s built package in its dist/ folder inside the writable plugins directory, then refresh. Optional source files and persistent data/ live alongside dist/.</p>
		{snapshot.directory && <div><p className="text-xs text-muted-foreground">Plugins directory</p><code className="mt-1 block break-all text-xs select-text">{snapshot.directory}</code></div>}
		<div><Button variant="outline" size="sm" disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
			{snapshot.refreshing ? "Refreshing…" : "Refresh plugins"}
		</Button></div>
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
			: snapshot.plugins.length === 0 ? <p className="text-xs text-muted-foreground">No plugins installed.</p>
				: snapshot.plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin}
					onSettings={() => onOpenSettings?.(plugin.info.id)} />)}
	</SettingsSection>;
}

function PluginRow({ plugin, onSettings }: { plugin: FrontendPlugin; onSettings: () => void }) {
	const { manager, snapshot } = usePlugins();
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	return <div className="border-t border-border/60 pt-3" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={[info.manifest?.version, plugin.busy ? "Saving…" : plugin.error ? "Error" : plugin.phase === "loading" ? "Loading…" : info.enabled ? "Enabled" : "Disabled"].filter(Boolean).join(" · ")}>
			<div className="flex shrink-0 items-center gap-2">
				{info.enabled && <button type="button" aria-label={`Settings for ${name}`} title={`Settings for ${name}`}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onSettings}><Settings className="size-3.5" aria-hidden="true" /></button>}
				<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
			</div>
		</SettingsRow>
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
	</div>;
}
