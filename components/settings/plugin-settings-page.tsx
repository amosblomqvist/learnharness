"use client";

import type { FrontendPlugin } from "@/components/plugin-manager";
import { PluginMountPoint } from "@/components/plugins";
import { PluginSettingsRows } from "@/components/plugin-ui-host";
import { SettingsSection } from "./controls";
import { useT } from "@/components/i18n";

/** Plugin persistence belongs to the registration; the host only presents it. */
export function PluginSettingsPage({ plugin }: { plugin: FrontendPlugin }) {
	const t = useT();
	const { info, settings } = plugin;
	const name = info.manifest?.name ?? info.id;
	return <SettingsSection title={name} testid={`section-plugin-${info.id}`}>
		{plugin.error && <p role="alert" className="break-words text-xs text-destructive">{plugin.error}</p>}
		{plugin.phase === "loading" ? <p role="status" className="text-xs text-muted-foreground">{t("Loading plugin settings…")}</p>
			: plugin.phase === "error" ? !plugin.error && <p role="alert" className="text-xs text-destructive">{t("Plugin settings could not be loaded.")}</p>
				: !settings ? <p className="text-xs text-muted-foreground">{t("No settings available.")}</p>
					: typeof settings === "function" ? <PluginMountPoint pluginId={info.id} mount={settings} label={`${name} settings`} />
						: <PluginSettingsRows schema={settings} />}
	</SettingsSection>;
}
