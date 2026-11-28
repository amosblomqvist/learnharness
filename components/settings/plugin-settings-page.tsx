"use client";

import type { FrontendPlugin } from "@/components/plugin-manager";
import { PluginMountPoint } from "@/components/plugins";
import { PluginSettingsRows } from "@/components/plugin-ui-host";
import { SettingsSection } from "./controls";
import { tr } from "@/src/core";

/** Plugin persistence belongs to the registration; the host only presents it. */
export function PluginSettingsPage({ plugin }: { plugin: FrontendPlugin }) {
	const { info, settings } = plugin;
	const name = info.manifest?.name ?? info.id;
	return <SettingsSection title={name} testid={`section-plugin-${info.id}`}>
		{plugin.error && <p role="alert" className="break-words text-xs text-destructive">{plugin.error}</p>}
		{plugin.phase === "loading" ? <p role="status" className="text-xs text-muted-foreground">{tr("正在加载插件设置…", "Loading plugin settings…")}</p>
			: plugin.phase === "error" ? !plugin.error && <p role="alert" className="text-xs text-destructive">{tr("无法加载插件设置。", "Plugin settings could not be loaded.")}</p>
				: !settings ? <p className="text-xs text-muted-foreground">{tr("暂无可用设置。", "No settings available.")}</p>
					: typeof settings === "function" ? <PluginMountPoint pluginId={info.id} mount={settings} label={tr(`${name} 设置`, `${name} settings`)} />
						: <PluginSettingsRows schema={settings} />}
	</SettingsSection>;
}
