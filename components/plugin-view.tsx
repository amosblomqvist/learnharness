"use client";

import Link from "next/link";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import { SurfaceRegion, usePageSurfaceBoundary } from "./plugin-surfaces";
import { PluginMountPoint, usePlugins } from "@/components/plugins";
import { SettingsIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { PluginTopBarActions } from "@/components/plugin-chrome";
import { usePluginShortcutPage } from "@/components/plugin-shortcuts";
import { Hint } from "@/components/ui/hint";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Button } from "@/components/ui/button";
import { tr } from "@/src/core";

export function PluginViewScreen({ pluginId, viewId }: { pluginId: string; viewId: string }) {
	const { snapshot } = usePlugins();
	const { open } = useSettingsDialog();
	const pathname = usePathname();
	const bodyRef = useRef<HTMLDivElement>(null);
	const viewPath = `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
	const surfaceTarget = usePageSurfaceBoundary({ active: pathname === viewPath, viewKey: viewPath, bodyRef });
	const plugin = snapshot.plugins.find(item => item.info.id === pluginId);
	const view = plugin?.views.find(item => item.id === viewId);
	const loading = snapshot.loading || plugin?.phase === "loading";
	usePluginShortcutPage(viewPath, () => view && plugin?.info.enabled && pathname === viewPath
		? { surface: "plugin-view", pluginId, viewId } : undefined);
	const unavailable = !plugin ? tr("插件未安装。", "Plugin is not installed.") : !plugin.info.enabled ? tr("此插件已停用。", "This plugin is disabled.") : tr("此插件视图不可用。", "This plugin view is not available.");
	return <div className="flex h-dvh min-w-0 flex-col">
		<TopBar>
			<h1 data-plugin-chrome-title className="min-w-0 truncate font-title text-3xl tracking-tight">{view?.name ?? plugin?.info.manifest?.name ?? tr("插件", "Plugin")}</h1>
			<div className="min-w-4 flex-1" aria-hidden="true" />
			<PluginTopBarActions context={{ placement: "top-bar", surface: "plugin-view", pluginId, viewId }} />
			<Hint label={tr("插件设置", "Plugin settings")} side="bottom">
				<Button variant="ghost" size="icon" aria-label={tr("插件设置", "Plugin settings")} title={tr("插件设置", "Plugin settings")} className="shrink-0" onClick={() => open(`plugin:${pluginId}`)}><SettingsIcon className="size-4" /></Button>
			</Hint>
		</TopBar>
		<div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<div data-plugin-view-scroll="" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
				{snapshot.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{snapshot.error}</p>}
				{plugin?.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{plugin.error}</p>}
				{loading ? <p role="status" className="px-5 py-4 text-xs text-muted-foreground">{tr("正在加载插件…", "Loading plugin…")}</p>
					: view && plugin?.info.enabled ? <PluginMountPoint key={`${pluginId}/${viewId}/${plugin.info.revision}`} pluginId={pluginId} mount={view.mount} label={view.name} />
						: <div className="px-5 py-4 text-sm text-muted-foreground"><p>{unavailable}</p><Link href="/" className="mt-3 inline-block underline">{tr("返回首页", "Back to home")}</Link></div>}
			</div>
			<SurfaceRegion target={surfaceTarget} />
		</div>
	</div>;
}
