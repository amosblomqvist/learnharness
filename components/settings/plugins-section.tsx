"use client";

import { Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

export const PLUGIN_TRUST_WARNING = "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.";

export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const core = origin === "core";
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	return <SettingsSection title={core ? "Core plugins" : "Community plugins"} testid={core ? "section-core-plugins" : "section-plugins"}>
		{!core && <>
		<p className="font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		{snapshot.directory && <div><p className="text-xs text-muted-foreground">Plugins directory</p><code className="mt-1 block break-all text-xs select-text">{snapshot.directory}</code></div>}
		<div><Button variant="outline" size="sm" disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
			{snapshot.refreshing ? "Refreshing…" : "Refresh plugins"}
		</Button></div>
		<details data-testid="plugin-install-help" className="text-xs text-muted-foreground">
			<summary className="cursor-pointer text-foreground">How to install a plugin</summary>
			<ol className="mt-2 list-decimal space-y-2 pl-5">
				<li>Place the built package in the writable plugins directory as <code>&lt;plugin-id&gt;/dist/manifest.json</code>, with its bundles and assets inside <code>dist/</code>.</li>
				<li>Select Refresh plugins, then enable the plugin. New plugins are disabled by default.</li>
				<li>Restart LearnHarness after changing loaded code. Refresh discovers packages; it does not hot-reload code.</li>
				<li>Keep persistent <code>data/</code> beside <code>dist/</code> and preserve it when updating. Optional source files also live beside <code>dist/</code>.</li>
			</ol>
		</details>
		<div data-testid="plugin-authoring-help" className="space-y-2 border-t border-border/60 pt-3">
			<h3 className="text-xs uppercase tracking-widest">Build a plugin</h3>
			<p className="font-prose text-sm text-muted-foreground">Download the complete authoring skill for your coding agent, including documentation, examples and API types.</p>
			<Button variant="outline" size="sm" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">Download authoring skill</a></Button>
			<p className="text-xs text-muted-foreground">Extract the ZIP and give your coding agent the whole <code>learnharness-plugins/</code> folder. Ask it to read <code>SKILL.md</code>, or place the whole folder in its supported skills directory. Nothing is installed automatically.</p>
		</div>
		{snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		</>}
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
			: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? "No Core plugins available." : "No community plugins installed."}</p>
				: plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin}
					onSettings={() => onOpenSettings?.(plugin.info.id)} />)}
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
				<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
			</div>
		</SettingsRow>
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
	</div>;
}
