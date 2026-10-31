"use client";

import { useEffect, useState } from "react";
import type { ChatListItem, ExportMode, ExportPreview } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect } from "./controls";
import { LessonImport } from "./lesson-import";
import { LessonLan } from "./lesson-lan";

/** Ordinary LearnHarness exports. No Android renderer or connection is required. */
export function LessonTransfer() {
	const [reload, setReload] = useState(0);
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [ids, setIds] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [mode, setMode] = useState<ExportMode>("md");
	const [preview, setPreview] = useState<ExportPreview | null>(null);
	const [files, setFiles] = useState<number[]>([]);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	useEffect(() => {
		const abort = new AbortController();
		fetch("/api/chats", { signal: abort.signal, cache: "no-store" }).then(async r => {
			if (!r.ok) throw new Error("Could not load lessons");
			const body = await r.json() as { chats: ChatListItem[] };
			setChats(body.chats);
		}).catch(e => { if (!abort.signal.aborted) { setChats([]); setError(e instanceof Error ? e.message : "Could not load lessons"); } });
		return () => abort.abort();
	}, [reload]);
	function reset() { setPreview(null); setFiles([]); setNotice(""); setError(""); }
	async function run() {
		setWorking(true); setError(""); setNotice("");
		try {
			let reviewed = preview;
			if (mode === "zip" && !reviewed) {
				const res = await fetch("/api/lesson-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, mode, preview: true }) });
				const body = await res.json() as ExportPreview & { error?: string };
				if (!res.ok) throw new Error(body.error ?? "Export failed");
				reviewed = body; setPreview(body);
				// Source files stay opt-in. Only pause when there are actual files to choose.
				if (body.files.some(f => f.status === "available")) return;
			}
			const response = await fetch("/api/lesson-export", { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids, mode, preview: false, revision: reviewed?.revision, files }) });
			if (!response.ok) {
				const body = await response.json() as { error?: string };
				throw new Error(body.error ?? "Export failed");
			}
			const blob = await response.blob(), url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url; link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `lessons.${mode}`;
			document.body.append(link); link.click(); link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
			setNotice("Download requested. Your library was not changed.");
			setPreview(null); setFiles([]);
		} catch (e) { setPreview(null); setFiles([]); setError(e instanceof Error ? e.message : "Export failed"); }
		finally { setWorking(false); }
	}
	const button = "rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40";
	return <div data-testid="lesson-transfer" className="space-y-6">
		<LessonImport onInstalled={() => { reset(); setIds([]); setReload(n => n + 1); }} />
		<SettingsGroup label="Export">
			<fieldset disabled={working} className="min-w-0 space-y-3">
				<SettingsRow label="Format"><ThinSelect value={mode} ariaLabel="Export format" onChange={m => { reset(); setMode(m as ExportMode); }}>
					<option value="md">Markdown (.md)</option><option value="txt">Text (.txt)</option>
					<option value="json">Lesson JSON (.json)</option><option value="zip">Lessons and graph (.zip)</option>
				</ThinSelect></SettingsRow>
				<p className="text-xs text-muted-foreground">{mode === "md" || mode === "txt" ? "Readable transcript, without hidden solutions or model reasoning. Markdown and LaTeX notation are preserved." : mode === "json" ? "One original lesson, without a graph or files. Includes private history and hidden answers." : "Selected lessons and graph, including private history and hidden answers. External files are optional; some dependencies may be missing. Up to 32 MiB total, 16 MB per file."}</p>
				<label className="block text-xs">Find a lesson<input value={query} onChange={e => setQuery(e.target.value)} className="mt-1 block w-full rounded-sm border border-border bg-background px-2 py-1" /></label>
				<p className="text-xs text-muted-foreground">{ids.length} selected · up to 100</p>
				{chats === null ? <p role="status" className="text-xs">Loading lessons…</p> : <div className="max-h-56 space-y-2 overflow-y-auto">
					{chats.filter(c => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(c => <label key={c.id} className="flex items-start gap-2 text-xs">
						<input type="checkbox" checked={ids.includes(c.id)} disabled={!ids.includes(c.id) && ids.length >= 100} onChange={e => { reset(); setIds(e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id)); }} />
						<span className="min-w-0 break-words">{c.title || "Untitled session"}{c.kind === "practice" ? " · practice" : ""}{c.busy || c.compacting ? " · busy" : ""}</span>
					</label>)}
					{chats.length === 0 && <p className="text-xs">No lessons yet.</p>}
				</div>}
				{mode === "json" && ids.length > 1 && <p role="status" className="text-xs">Select one lesson for JSON, or choose ZIP for several.</p>}
				{mode === "zip" && preview?.files.some(f => f.status === "available") && <fieldset className="space-y-2 text-xs">
					<legend>Optional files — include only what you intend to share</legend>
					{preview.files.map((f, i) => <label key={i} className="flex items-start gap-2">
						<input type="checkbox" disabled={f.status !== "available"} checked={files.includes(i)} onChange={e => setFiles(e.target.checked ? [...files, i] : files.filter(n => n !== i))} />
						<span className="min-w-0 break-all">{f.path} · {f.status === "available" ? `${f.bytes} bytes` : f.status}</span>
					</label>)}
					<p>ZIPs containing files cannot currently be imported by these apps. Leave files unchecked for lesson transfer.</p>
				</fieldset>}
				<button type="button" className={button} disabled={!ids.length || (mode === "json" && ids.length !== 1)} onClick={() => void run()}>{working ? "Exporting…" : "Export"}</button>
			</fieldset>
			{error && <p role="alert" className="mt-3 text-xs">{error}</p>}
			{notice && <p role="status" className="mt-3 text-xs">{notice}</p>}
		</SettingsGroup>
		<LessonLan />
	</div>;
}
