"use client";

import { RefreshCw, Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";
import { tr } from "@/src/core";

export const PLUGIN_TRUST_WARNING = tr("只启用你信任的插件。插件以受信任的本地代码运行，拥有广泛的文件与网络访问权限，且不在沙箱中运行。出错的插件可能需要重启 LearnHarness。", "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.");

export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const core = origin === "core";
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	return <SettingsSection title={core ? tr("核心插件", "Core plugins") : tr("社区插件", "Community plugins")} testid={core ? "section-core-plugins" : "section-plugins"}>
		{!core && <>
		<p className="font-prose text-sm text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		<details data-testid="plugin-install-help" className="text-xs text-muted-foreground">
			<summary className="w-fit cursor-pointer list-none text-muted-foreground underline underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">{tr("如何安装插件", "How to install a plugin")}</summary>
			<ol className="mt-2 list-decimal space-y-2 pl-5">
				<li>{tr("将插件克隆或复制到下方目录中，并以插件 ID 作为文件夹名称。", "Clone or copy the plugin into the directory below, using its plugin ID as the folder name.")}</li>
				<li>{tr(<>对于源码项目，请按仓库说明安装依赖并运行 <code>npm run build</code>。预构建的包已包含 <code>dist/manifest.json</code>，无需构建。</>, <>For source projects, follow the repository’s dependency setup and run <code>npm run build</code>. Prebuilt packages already contain <code>dist/manifest.json</code> and need no build.</>)}</li>
				<li>{tr("刷新列表，然后启用插件。新插件默认处于停用状态。", "Refresh the list, then enable the plugin. New plugins are disabled by default.")}</li>
				<li>{tr(<>修改已加载的代码后请重启 LearnHarness。更新时请保留与 <code>dist/</code> 同级的 <code>data/</code>。</>, <>Restart LearnHarness after changing loaded code. Preserve <code>data/</code> beside <code>dist/</code> when updating.</>)}</li>
			</ol>
		</details>
		<div data-testid="plugin-authoring-help" className="space-y-2 border-t border-border/60 pt-3">
			<h3 className="text-xs uppercase tracking-widest">{tr("开发插件", "Build a plugin")}</h3>
			<p className="font-prose text-sm text-muted-foreground">{tr("为你的编程智能体下载插件开发技能包。", "Download the authoring skill for your coding agent.")}</p>
			<Button variant="outline" size="sm" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">{tr("下载开发技能包", "Download authoring skill")}</a></Button>
		</div>
		<div data-testid="plugin-directory" className="border-t border-border/60 pt-3">
			<p className="text-xs text-muted-foreground">{tr("插件目录", "Plugins directory")}</p>
			<div className="mt-1 flex items-center gap-3">
				<code className="min-w-0 flex-1 break-all text-xs select-text">{snapshot.directory}</code>
				<Button variant="outline" size="icon-sm" aria-label={tr("刷新插件", "Refresh plugins")} title={tr("刷新插件", "Refresh plugins")} aria-busy={snapshot.refreshing}
					disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
					<RefreshCw aria-hidden="true" className={snapshot.refreshing ? "animate-spin" : undefined} />
				</Button>
			</div>
		</div>
		{snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		</>}
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">{tr("正在加载插件…", "Loading plugins…")}</p>
			: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? tr("暂无可用的核心插件。", "No Core plugins available.") : tr("尚未安装社区插件。", "No community plugins installed.")}</p>
				: plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin}
					onSettings={() => onOpenSettings?.(plugin.info.id)} />)}
	</SettingsSection>;
}

function PluginRow({ plugin, onSettings }: { plugin: FrontendPlugin; onSettings: () => void }) {
	const { manager, snapshot } = usePlugins();
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	return <div className="border-t border-border/60 pt-3" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={[info.origin === "community" ? info.manifest?.version : undefined, plugin.busy ? tr("保存中…", "Saving…") : plugin.error ? tr("出错", "Error") : plugin.phase === "loading" ? tr("加载中…", "Loading…") : info.enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")].filter(Boolean).join(" · ")}>
			<div className="flex shrink-0 items-center gap-2">
				{info.enabled && <button type="button" aria-label={tr(`${name} 设置`, `Settings for ${name}`)} title={tr(`${name} 设置`, `Settings for ${name}`)}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onSettings}><Settings className="size-3.5" aria-hidden="true" /></button>}
				<Toggle label={tr(`启用 ${name}`, `Enable ${name}`)} testid={tr<string | undefined>(`toggle-enable-${info.id}`, undefined)} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
			</div>
		</SettingsRow>
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
	</div>;
}
