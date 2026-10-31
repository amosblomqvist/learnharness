"use client";

import Link from "next/link";
import { PluginMountPoint, usePlugins } from "@/components/plugins";
import { SidebarToggle } from "@/components/sidebar";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Button } from "@/components/ui/button";

export function PluginViewScreen({ pluginId, viewId }: { pluginId: string; viewId: string }) {
	const { snapshot } = usePlugins();
	const { open } = useSettingsDialog();
	const plugin = snapshot.plugins.find(item => item.info.id === pluginId);
	const view = plugin?.views.find(item => item.id === viewId);
	const loading = snapshot.loading || plugin?.phase === "loading";
	const unavailable = !plugin ? "Plugin is not installed." : !plugin.info.enabled ? "This plugin is disabled." : "This plugin view is not available.";
	return <div className="flex h-dvh min-w-0 flex-col">
		<header className="lh-drag flex h-15 shrink-0 items-center gap-3 border-b border-border px-4">
			<SidebarToggle />
			<h1 className="truncate font-title text-2xl tracking-tight">{view?.name ?? plugin?.info.manifest?.name ?? "Plugin"}</h1>
			<Button variant="ghost" size="sm" className="lh-no-drag ml-auto text-xs" onClick={() => open("plugins")}>Plugin settings</Button>
		</header>
		{snapshot.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{snapshot.error}</p>}
		{plugin?.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{plugin.error}</p>}
		{loading ? <p role="status" className="px-5 py-4 text-xs text-muted-foreground">Loading plugin…</p>
			: view && plugin?.info.enabled ? <PluginMountPoint key={`${pluginId}/${viewId}/${plugin.info.revision}`} pluginId={pluginId} mount={view.mount} label={view.name} />
				: <div className="px-5 py-4 text-sm text-muted-foreground"><p>{unavailable}</p><Link href="/" className="mt-3 inline-block underline">Back to home</Link></div>}
	</div>;
}
