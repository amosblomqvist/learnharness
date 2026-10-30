"use client";

import { useRef, useState } from "react";
import type { ImportChoices, ImportPreview } from "@/src/core";
import { SettingsGroup } from "./controls";

export function LessonImport({ onInstalled }: { onInstalled: () => void }) {
	const input = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [choices, setChoices] = useState<ImportChoices>({});
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const button = "rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40";
	async function install(chosen: File, reviewed: ImportPreview, decisions: ImportChoices) {
		const form = new FormData(); form.set("file", chosen); form.set("action", "install");
		form.set("revision", reviewed.revision); form.set("choices", JSON.stringify(decisions)); form.set("acknowledged", "true");
		const res = await fetch("/api/lesson-import", { method: "POST", body: form });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error ?? "Import failed");
		setPreview(null); setFile(null); setChoices({});
		setNotice(`Imported: ${body.installed.length} new or updated lessons. Identical lessons were not duplicated.`);
		onInstalled();
	}
	async function run(chosen: File, reviewed?: ImportPreview) {
		setWorking(true); setError(""); setNotice("");
		try {
			if (chosen.size > 32 * 1024 * 1024) throw new Error("Choose a file no larger than 32 MiB");
			if (reviewed) { await install(chosen, reviewed, choices); return; }
			setPreview(null); setChoices({}); setFile(chosen);
			const form = new FormData(); form.set("file", chosen); form.set("action", "preview");
			const res = await fetch("/api/lesson-import", { method: "POST", body: form });
			const body = await res.json() as ImportPreview & { error?: string };
			if (!res.ok) throw new Error(body.error ?? "Import failed");
			if (body.blockers.length || body.chats.some(c => c.kind === "conflict")) setPreview(body);
			else await install(chosen, body, {});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Import failed");
			setPreview(null); setChoices({}); setFile(null);
		} finally { setWorking(false); }
	}
	return <SettingsGroup label="Import">
		<p className="text-xs text-muted-foreground">ZIP imports lessons and graph; JSON imports one lesson without a graph. Continue with your local model settings. Import starts no model requests. External files are not supported; some dependencies may be missing. Up to 32 MiB total, 16 MB per file.</p>
		<fieldset disabled={working} className="min-w-0 space-y-3">
			<input ref={input} type="file" accept=".zip,.json,application/zip,application/json" aria-label="Import file" hidden onChange={e => {
				const chosen = e.target.files?.[0]; e.target.value = "";
				if (chosen) void run(chosen);
			}} />
			<button type="button" className={button} onClick={() => input.current?.click()}>Import</button>
			{preview && <div className="space-y-3 text-xs">
				{preview.chats.filter(c => c.kind === "conflict").map(c => <label key={c.id} className="block break-words">Version for {c.title}<select className="ml-2 rounded-sm border border-border bg-background p-1" value={choices[c.id] ?? ""} onChange={e => {
					setChoices({ ...choices, [c.id]: e.target.value as "local" | "incoming" });
				}}><option value="" disabled>Choose a version…</option><option value="local">Keep local version</option><option value="incoming">Use imported version</option></select></label>)}
				{preview.chats.some(c => c.kind === "conflict") && <p>Both originals are kept locally.</p>}
				{preview.blockers.map((b, i) => <p key={i} role="alert">Cannot import: {b}</p>)}
				{!preview.blockers.length && <button type="button" className={button} disabled={preview.chats.some(c => c.kind === "conflict" && !choices[c.id])} onClick={() => { if (file) void run(file, preview); }}>Import selected versions</button>}
			</div>}
		</fieldset>
		{working && <p role="status" className="text-xs">Importing…</p>}
		{error && <p role="alert" className="text-xs">{error}</p>}
		{notice && <p role="status" className="text-xs">{notice}</p>}
	</SettingsGroup>;
}
