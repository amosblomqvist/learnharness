"use client";

import { useEffect, useMemo, useState } from "react";
import { comparePluginVersions, type CatalogPlugin } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { Button } from "@/components/ui/button";

type Conversation = { issueUrl: string; thumbsUp: number; commentCount: number; comments: { author: string; body: string; createdAt: string; url: string }[] };

export function PluginCatalogBrowser() {
	const { manager, snapshot } = usePlugins();
	const [plugins, setPlugins] = useState<CatalogPlugin[]>([]);
	const [loading, setLoading] = useState(true);
	const [stale, setStale] = useState(false);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [feature, setFeature] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [conversation, setConversation] = useState<Conversation | null>(null);
	const [commentsError, setCommentsError] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [installError, setInstallError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/plugin-catalog", { signal: controller.signal }).then(async response => {
			if (!response.ok) throw Error("Catalog unavailable");
			return response.json();
		}).then(data => { setPlugins(data.catalog.plugins); setStale(data.stale); setLoading(false); })
			.catch(() => { if (!controller.signal.aborted) { setError("Could not load the plugin catalog."); setLoading(false); } });
		return () => controller.abort();
	}, []);

	useEffect(() => {
		if (!selected) { setConversation(null); return; }
		const controller = new AbortController();
		setConversation(null); setCommentsError("");
		void fetch(`/api/plugin-catalog/${encodeURIComponent(selected)}`, { signal: controller.signal })
			.then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error ?? "Comments unavailable"); return data; })
			.then(data => setConversation(data))
			.catch(error => { if (!controller.signal.aborted) setCommentsError(error instanceof Error ? error.message : "Comments unavailable"); });
		return () => controller.abort();
	}, [selected]);

	const features = useMemo(() => [...new Set(plugins.flatMap(plugin => plugin.features))].sort(), [plugins]);
	const visible = useMemo(() => plugins.filter(plugin => {
		const needle = query.trim().toLowerCase();
		return (!feature || plugin.features.includes(feature)) && (!needle || [plugin.name, plugin.summary, ...plugin.features].some(text => text.toLowerCase().includes(needle)));
	}), [plugins, feature, query]);

	async function install(plugin: CatalogPlugin) {
		setBusy(plugin.id); setInstallError(""); setNotice("");
		try {
			const response = await fetch(`/api/plugin-catalog/${encodeURIComponent(plugin.id)}`, { method: "POST" });
			const data = await response.json();
			if (!response.ok) throw Error(data.error ?? "Installation failed");
			await manager?.refresh();
			setNotice(`${plugin.name} ${plugin.version} installed. Enable it below. Restart LearnHarness after an update.`);
		} catch (error) { setInstallError(error instanceof Error ? error.message : "Installation failed"); }
		finally { setBusy(null); }
	}

	return <div className="space-y-4 border-t border-border/60 pt-4" data-testid="plugin-catalog-browser">
		<div>
			<h3 className="text-sm font-medium">Browse plugins</h3>
			<p className="mt-1 font-prose text-sm text-muted-foreground">Reviewed community listings from GitHub. Plugins run trusted local code with file and network access. Review each author and source before installing.</p>
		</div>
		{stale && <p role="status" className="text-xs text-muted-foreground">Showing the last saved catalog. Connect to GitHub to install or update.</p>}
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		{loading ? <p role="status" className="text-sm text-muted-foreground">Loading catalog…</p> : <>
			<div className="flex flex-wrap gap-2">
				<input aria-label="Search plugins" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search plugins" className="min-w-40 flex-1 rounded-sm border border-border bg-background px-2 py-1.5 text-sm" />
				<select aria-label="Filter by feature" value={feature} onChange={event => setFeature(event.target.value)} className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm">
					<option value="">All features</option>{features.map(value => <option key={value} value={value}>{value}</option>)}
				</select>
			</div>
			{plugins.length === 0 ? <p className="font-prose text-sm text-muted-foreground">No community plugins are listed yet. Authors can <a className="underline" href="https://github.com/amosblomqvist/learnharness/blob/main/plugin-catalog/README.md" target="_blank" rel="noopener noreferrer">submit a reviewed listing</a> through the project repository.</p>
				: visible.length === 0 ? <p className="text-sm text-muted-foreground">No plugins match your search.</p>
					: visible.map(plugin => {
						const installed = snapshot.plugins.find(item => item.info.id === plugin.id && item.info.origin === "community");
						const current = installed?.info.manifest?.version;
						const update = current && comparePluginVersions(plugin.version, current) > 0;
						const compatible = comparePluginVersions(process.env.LH_VERSION ?? "0.0.0", plugin.minAppVersion) >= 0;
						const canInstall = compatible && !stale && !busy && !installed?.info.enabled && (!current || update);
						return <div key={plugin.id} className="rounded-sm border border-border p-3">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div><h4 className="text-sm font-medium">{plugin.name}</h4><p className="font-prose text-sm text-muted-foreground">{plugin.summary}</p></div>
								<Button size="sm" disabled={!canInstall} onClick={() => void install(plugin)}>{busy === plugin.id ? "Installing…" : update ? "Update" : current ? "Installed" : "Install"}</Button>
							</div>
							<p className="mt-2 text-xs text-muted-foreground">Version {plugin.version} · Requires LearnHarness {plugin.minAppVersion}+{current ? ` · Installed ${current}` : ""}{!compatible ? " · Incompatible" : ""}</p>
							{installed?.info.enabled && update && <p className="mt-1 text-xs text-muted-foreground">Disable this plugin before updating, then restart LearnHarness.</p>}
							<div className="mt-2 flex flex-wrap gap-1">{plugin.features.map(value => <span key={value} className="rounded-sm bg-accent px-1.5 py-0.5 text-xs">{value}</span>)}</div>
							<div className="mt-3 flex flex-wrap gap-3 text-xs"><a href={plugin.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">Source</a><a href={plugin.releaseUrl} target="_blank" rel="noopener noreferrer" className="underline">Release ZIP</a><button type="button" className="underline" onClick={() => setSelected(selected === plugin.id ? null : plugin.id)}>{selected === plugin.id ? "Hide comments" : "Comments and ratings"}</button></div>
							{selected === plugin.id && <div className="mt-3 space-y-2 border-t border-border pt-3">
								{commentsError && <p role="alert" className="text-xs text-destructive">{commentsError}</p>}
								{!conversation && !commentsError && <p role="status" className="text-xs text-muted-foreground">Loading GitHub comments…</p>}
								{conversation && <><p className="text-xs">👍 {conversation.thumbsUp} · {conversation.commentCount} comments</p><a href={conversation.issueUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">Comment or recommend on GitHub</a>{conversation.comments.map((comment, index) => <div key={`${comment.url}-${index}`} className="rounded-sm bg-accent/40 p-2 text-xs"><p className="font-medium">{comment.author}</p><p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p></div>)}{conversation.commentCount > conversation.comments.length && <a href={conversation.issueUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">Read all comments on GitHub</a>}</>}
							</div>}
						</div>;
					})}
		</>}
		{installError && <p role="alert" className="text-xs text-destructive">{installError}</p>}
		{notice && <p role="status" className="text-xs">{notice}</p>}
	</div>;
}
