"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "./top-bar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SetupDialog } from "./setup-dialog";
import { SessionStarter } from "./start-session";
import { selectedModelUnavailable, useModelSetup } from "./setup-cta";
import { materialKey, studyMaterialsPrompt, type MaterialConnections, type MaterialEntry, type MaterialSource, type StudyMaterial } from "@/src/core";

async function request<T>(body: object): Promise<T> {
	const response = await fetch("/api/materials", { method: "POST", headers: { "Content-Type": "application/json", "x-learnharness-materials": "1" }, body: JSON.stringify(body) });
	const result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Could not load materials.");
	return result;
}
const names = { obsidian: "Obsidian", notion: "Notion", zotero: "Zotero" };

export function MaterialLibrary() {
	const router = useRouter(), starter = useRef(new SessionStarter());
	const { catalog, configured, zeroKeys } = useModelSetup(false);
	const [setupOpen, setSetupOpen] = useState(false);
	const [connections, setConnections] = useState<MaterialConnections>();
	const [root, setRoot] = useState(""), [token, setToken] = useState(""), [zotero, setZotero] = useState(false);
	const [source, setSource] = useState<MaterialSource>("obsidian");
	const [folders, setFolders] = useState<string[]>([]);
	const folder = folders.at(-1) ?? "";
	const [search, setSearch] = useState(""), [query, setQuery] = useState("");
	const [entries, setEntries] = useState<MaterialEntry[]>([]), [nextCursor, setNextCursor] = useState<string>();
	const [selected, setSelected] = useState<MaterialEntry[]>([]), [prepared, setPrepared] = useState<StudyMaterial[]>([]);
	const [topic, setTopic] = useState(""), [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
	const generation = useRef(0);
	useEffect(() => {
		let alive = true;
		void request<MaterialConnections>({ op: "status" }).then(value => { if (alive) { setConnections(value); setRoot(value.obsidianRoot); setZotero(value.zoteroEnabled); } }).catch(error => { if (alive) setError(error.message); });
		return () => { alive = false; };
	}, []);
	useEffect(() => {
		if (!connections) return;
		const serial = ++generation.current;
		setEntries([]); setNextCursor(undefined); setLoading(true); setError(undefined);
		void request<{ entries: MaterialEntry[]; nextCursor?: string }>({ op: "list", source, folder, query }).then(result => {
			if (generation.current === serial) { setEntries(result.entries); setNextCursor(result.nextCursor); }
		}).catch(error => { if (generation.current === serial) setError(error.message); }).finally(() => { if (generation.current === serial) setLoading(false); });
		return () => { generation.current++; };
	}, [connections, source, folder, query]);
	const save = async (clearNotion = false) => {
		setBusy(true); setError(undefined);
		try { const value = await request<MaterialConnections>({ op: "configure", obsidianRoot: root, zoteroEnabled: zotero, ...(token ? { notionToken: token } : {}), ...(clearNotion ? { clearNotion: true } : {}) });
			if (value.obsidianRoot !== connections?.obsidianRoot) { setSelected(current => current.filter(item => item.source !== "obsidian")); if (source === "obsidian") setFolders([]); }
			setConnections(value); setRoot(value.obsidianRoot); setToken(""); setPrepared([]); }
		catch (error) { setError((error as Error).message); } finally { setBusy(false); }
	};
	const toggle = (entry: MaterialEntry) => {
		const key = materialKey(entry); setPrepared([]);
		setSelected(current => current.some(item => materialKey(item) === key) ? current.filter(item => materialKey(item) !== key) : current.length < 8 ? [...current, entry] : current);
	};
	const prepare = async () => {
		setBusy(true); setError(undefined);
		try { setPrepared((await request<{ materials: StudyMaterial[] }>({ op: "prepare", materials: selected.map(({ source, id }) => ({ source, id })) })).materials); }
		catch (error) { setError((error as Error).message); } finally { setBusy(false); }
	};
	const start = async () => {
		if (busy || !prepared.length) return;
		const strong = catalog?.slots.strong?.model;
		if (!configured || zeroKeys || selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) { setSetupOpen(true); return; }
		setBusy(true); setError(undefined);
		try { router.push(await starter.current.start({ title: studyMaterialsPrompt(topic, prepared) }, fetch, JSON.stringify(catalog?.slots.strong))); }
		catch (error) { setError((error as Error).message); setBusy(false); }
	};
	return <main className="flex h-dvh min-w-0 flex-col [&_button]:text-base" data-testid="material-library">
		<TopBar><h1 className="min-w-0 truncate font-ui text-xl font-semibold">Study materials</h1></TopBar>
		<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-5 sm:p-6">
				<details className="rounded-md border bg-card p-5" open={!connections || (!connections.obsidianRoot && !connections.notionConfigured && !connections.zoteroEnabled)}>
					<summary className="cursor-pointer text-base font-semibold">Connections</summary>
					<div className="mt-4 grid gap-4 md:grid-cols-2">
						<label className="grid gap-2 text-base">Obsidian vault folder<Input aria-label="Obsidian vault folder" className="min-h-11" value={root} onChange={event => setRoot(event.target.value)} placeholder="Absolute path on this computer" /></label>
						<label className="grid gap-2 text-base">Notion integration token {connections?.notionConfigured && "(saved)"}<Input aria-label="Notion integration token" className="min-h-11" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder={connections?.notionConfigured ? "Leave blank to keep the saved token" : "Read-content integration token"} /></label>
						<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-[var(--lh-accent)]" checked={zotero} onChange={event => setZotero(event.target.checked)} />Use Zotero on this computer (port 23119)</label>
						<p className="text-sm text-muted-foreground">Share selected pages with your Notion integration. For Zotero, allow local API access in its Advanced settings. Original sources stay read-only.</p>
					</div>
					<div className="mt-4 flex flex-wrap items-center gap-3"><Button className="min-h-11" disabled={busy} onClick={() => void save()}>Save connections</Button>{connections?.notionConfigured && <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => void save(true)}>Disconnect Notion</Button>}<a className="text-sm underline" href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer">Manage Notion integrations</a></div>
				</details>
				<section className="min-w-0 rounded-md border bg-card p-5" aria-label="Choose study materials">
					<div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Material source">{(Object.keys(names) as MaterialSource[]).map(value => <Button key={value} className="min-h-11" variant={source === value ? "outline" : "ghost"} aria-pressed={source === value} disabled={busy} onClick={() => { setSource(value); setFolders([]); setSearch(""); setQuery(""); }}>{names[value]}</Button>)}</div>
					<form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setQuery(search); }}><Input aria-label="Search material titles" className="min-h-11 min-w-36 flex-1" value={search} onChange={event => setSearch(event.target.value)} placeholder={source === "notion" ? "Search shared page titles" : "Search this folder or collection"} /><Button className="min-h-11" variant="outline" disabled={busy || loading}>Search</Button>{folder && <Button type="button" className="min-h-11" variant="ghost" disabled={busy} onClick={() => { setFolders(current => current.slice(0, -1)); setQuery(""); setSearch(""); }}>Back</Button>}</form>
					<div className="mt-4 flex items-center justify-between gap-4 text-sm text-muted-foreground"><span className="min-w-0 truncate" title={folder}>{folder || names[source]}</span><span className="shrink-0">{selected.length}/8 selected</span></div>
					{loading && <p role="status" className="py-5 text-sm text-muted-foreground">Loading materials…</p>}
					<div className="mt-3 divide-y divide-border">{entries.map(entry => <div key={materialKey(entry)} className="flex min-h-14 items-center gap-3 py-3">
						{entry.kind === "folder" ? <Button className="min-h-11 min-w-0 flex-1 justify-start truncate" variant="ghost" onClick={() => { setFolders(current => [...current, entry.id]); setQuery(""); setSearch(""); }}>↳ {entry.title}</Button> : <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"><input type="checkbox" className="size-4 shrink-0 accent-[var(--lh-accent)]" checked={selected.some(item => materialKey(item) === materialKey(entry))} disabled={busy || (selected.length >= 8 && !selected.some(item => materialKey(item) === materialKey(entry)))} onChange={() => toggle(entry)} /><span className="min-w-0"><span className="block break-words font-prose text-base">{entry.title}</span><span className="block text-sm text-muted-foreground">{entry.description}</span></span></label>}
					</div>)}</div>
					{!loading && !entries.length && !error && <p className="py-5 text-sm text-muted-foreground">No documents in this location. Check Connections or choose another folder.</p>}
					{nextCursor && <Button className="mt-4 min-h-11" variant="outline" disabled={loading || busy} onClick={() => {
						const serial = generation.current; setLoading(true);
						void request<{ entries: MaterialEntry[]; nextCursor?: string }>({ op: "list", source, folder, query, cursor: nextCursor }).then(result => { if (serial === generation.current) { setEntries(current => [...current, ...result.entries]); setNextCursor(result.nextCursor); } }).catch(error => { if (serial === generation.current) setError(error.message); }).finally(() => { if (serial === generation.current) setLoading(false); });
					}}>Load more</Button>}
				</section>
				{selected.length > 0 && <section className="rounded-md border bg-card p-5" aria-label="Selected materials"><h2 className="text-lg font-semibold">Your selection</h2><ul className="mt-3 space-y-2">{selected.map(item => <li key={materialKey(item)} className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 break-words"><span className="block">{item.title}</span><span className="block text-muted-foreground">{names[item.source]}</span></span><Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(item)}>Remove</Button></li>)}</ul></section>}
				{prepared.length > 0 && <section className="rounded-md border bg-card p-5" aria-label="Review extracted content"><h2 className="text-lg font-semibold">Review the content to be used</h2>{prepared.map(item => <details key={materialKey(item)} className="mt-4"><summary className="cursor-pointer font-prose text-base">{item.title}<span className="ml-2 text-sm text-muted-foreground">({item.text.length.toLocaleString()} characters)</span></summary><p className="mt-2 break-all text-sm text-muted-foreground">{item.origin}</p>{item.notices.map(notice => <p key={notice} role="note" className="mt-2 text-sm text-warning">{notice}</p>)}<pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-4 font-prose text-base leading-relaxed">{item.text}</pre></details>)}</section>}
				{error && <p role="alert" className="break-words rounded-md border border-error/40 p-4 text-sm text-error">{error}</p>}
			</div>
		</div>
		<footer className="shrink-0 overflow-y-hidden border-t bg-background [scrollbar-gutter:stable]"><div className="mx-auto flex max-w-5xl flex-wrap items-end gap-3 px-10 py-4 sm:px-11"><label className="grid min-w-40 flex-1 gap-2 text-base">What would you like to learn?<Input aria-label="Learning goal" className="min-h-11 text-base md:text-base" value={topic} onChange={event => setTopic(event.target.value)} placeholder="Optional focus or exam goal" /></label>{prepared.length ? <Button className="min-h-11" disabled={busy} onClick={() => void start()}>Start learning from selection</Button> : <Button className="min-h-11" disabled={busy || !selected.length} onClick={() => void prepare()}>{busy ? "Reading selection…" : "Review selected materials"}</Button>}</div></footer>
		<SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} onDone={() => setSetupOpen(false)} />
	</main>;
}
