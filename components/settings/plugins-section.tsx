"use client";

import { useState } from "react";
import Link from "next/link";
import { PluginMountPoint, usePlugins } from "@/components/plugins";
import { pluginViewPath, type FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

export const PLUGIN_TRUST_WARNING = "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.";

export function PluginsSection({ onOpenView }: { onOpenView?: () => void }) {
	const { manager, snapshot } = usePlugins();
	const [settingsFor, setSettingsFor] = useState<string | null>(null);
	return <SettingsSection title="Plugins" testid="section-plugins">
		<p className="font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		<p className="text-xs text-muted-foreground">Plugins are disabled by default. Install a plugin by placing its package folder in the writable plugins directory, then refresh.</p>
		{snapshot.directory && <div><p className="text-xs text-muted-foreground">Plugins directory</p><code className="mt-1 block break-all text-xs select-text">{snapshot.directory}</code></div>}
		<div><Button variant="outline" size="sm" disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
			{snapshot.refreshing ? "Refreshing…" : "Refresh plugins"}
		</Button></div>
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
			: snapshot.plugins.length === 0 ? <p className="text-xs text-muted-foreground">No plugins installed.</p>
				: snapshot.plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin} selected={settingsFor === plugin.info.id}
					onSettings={() => setSettingsFor(current => current === plugin.info.id ? null : plugin.info.id)} onOpenView={onOpenView} />)}
	</SettingsSection>;
}

function PluginRow({ plugin, selected, onSettings, onOpenView }: { plugin: FrontendPlugin; selected: boolean; onSettings: () => void; onOpenView?: () => void }) {
	const { manager, snapshot } = usePlugins();
	const [running, setRunning] = useState<string | null>(null);
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	const active = info.enabled && plugin.phase === "active";
	return <div className="border-t border-border/60 pt-3" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={[info.manifest?.version, plugin.busy ? "Saving…" : plugin.error ? "Error" : plugin.phase === "loading" ? "Loading…" : info.enabled ? "Enabled" : "Disabled"].filter(Boolean).join(" · ")}>
			<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
		</SettingsRow>
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
		{active && <div className="mt-2 flex flex-wrap gap-2">
			{plugin.views.map(view => <Link key={view.id} href={pluginViewPath(info.id, view.id)} onClick={onOpenView}
				className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs hover:bg-accent">{view.name}</Link>)}
			{plugin.actions.map(action => <Button key={action.id} variant="outline" size="sm" disabled={running !== null} onClick={() => {
				setRunning(action.id);
				void manager?.runAction(info.id, action).finally(() => setRunning(null));
			}}>{running === action.id ? `${action.name}…` : action.name}</Button>)}
			{plugin.settings && <Button variant="outline" size="sm" aria-expanded={selected} onClick={onSettings}>Settings</Button>}
		</div>}
		{active && selected && plugin.settings && <div className="mt-3 rounded-sm border border-border p-3">
			<PluginMountPoint key={`${info.id}/${info.revision}`} pluginId={info.id} mount={plugin.settings} label={`${name} settings`} />
		</div>}
	</div>;
}
