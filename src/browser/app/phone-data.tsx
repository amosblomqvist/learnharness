/**
 * Settings → Phone data (mobile Phase 1): on-device storage status, backup
 * to a zip, and restore from a backup or a zipped desktop data folder.
 * Restore replaces this phone's data (owner decision) after a confirm, and
 * saves a backup of the current data first.
 *
 * Phase 4: "Your files" — the files the agent can find and read when the
 * learner mentions them (owner: managed here, ../files.ts).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { applyRestore, backupFileName, DESKTOP_DATA_FOLDER, exportBackup, planRestore } from "../backup.ts";
import { addFile, listAddedFiles, removeAddedFile, type AddedFile } from "../files.ts";
import { flushPersistence } from "../persist.ts";

function download(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = Object.assign(document.createElement("a"), { href: url, download: name });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** iOS: the share sheet ("Save to Files") is the reliable way to keep a
 *  file from a home-screen app; elsewhere a plain download. */
async function saveFile(blob: Blob, name: string): Promise<void> {
	const file = new File([blob], name, { type: "application/zip" });
	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file] });
			return;
		} catch (err) {
			if ((err as Error).name === "AbortError") throw err;
		}
	}
	download(blob, name);
}

function formatBytes(n: number): string {
	if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PhoneDataSection() {
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [storage, setStorage] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const [files, setFiles] = useState<AddedFile[]>(() => listAddedFiles());

	const addFiles = async (picked: File[]) => {
		setBusy(true);
		try {
			const saved: string[] = [];
			for (const f of picked) saved.push(addFile(f.name, new Uint8Array(await f.arrayBuffer())));
			await flushPersistence();
			setFiles(listAddedFiles());
			setStatus(`Added ${saved.length === 1 ? `“${saved[0]}”` : `${saved.length} files`}.`);
		} catch (err) {
			setStatus(`Could not add files: ${(err as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (name: string) => {
		if (!window.confirm(`Remove “${name}” from this phone?`)) return;
		removeAddedFile(name);
		await flushPersistence();
		setFiles(listAddedFiles());
		setStatus(`Removed “${name}”.`);
	};

	useEffect(() => {
		void (async () => {
			const [estimate, persisted] = await Promise.all([
				navigator.storage?.estimate?.().catch(() => null),
				navigator.storage?.persisted?.().catch(() => false),
			]);
			const used = estimate?.usage !== undefined ? `${formatBytes(estimate.usage)} used` : "usage unknown";
			setStorage(`${used} · ${persisted ? "protected from automatic clean-up" : "the browser may clear it if storage runs low"}`);
		})();
	}, []);

	const backup = async () => {
		setBusy(true);
		setStatus("Preparing backup…");
		try {
			await flushPersistence();
			const { blob, files } = await exportBackup();
			await saveFile(blob, backupFileName());
			setStatus(`Backup saved (${files} files, ${formatBytes(blob.size)}).`);
		} catch (err) {
			setStatus((err as Error).name === "AbortError" ? "Backup cancelled." : `Backup failed: ${(err as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	const restore = async (file: File) => {
		setBusy(true);
		setStatus("Reading zip…");
		try {
			const plan = await planRestore(new Uint8Array(await file.arrayBuffer()));
			const ok = window.confirm(
				`Replace ALL learning data on this phone with “${file.name}” (${plan.sessions} sessions, ${plan.files.length} files)?\n\n` +
					(plan.added ? `Your added files are replaced by the ${plan.added.length} in the zip. ` : "Your added files are kept. ") +
					"A backup of the current data is saved first. Your API keys are kept.",
			);
			if (!ok) {
				setStatus("Restore cancelled — nothing changed.");
				return;
			}
			setStatus("Saving a backup of the current data…");
			await flushPersistence();
			const current = await exportBackup();
			download(current.blob, backupFileName().replace("backup", "backup-before-restore"));
			setStatus("Restoring…");
			applyRestore(plan);
			await flushPersistence();
			setStatus("Restored. Reloading…");
			location.assign("/");
		} catch (err) {
			setStatus(`Restore failed — nothing changed: ${(err as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-4 text-sm" data-testid="phone-data">
			<p className="text-muted-foreground">
				Your sessions, knowledge graph and settings are stored only on this device{storage ? ` — ${storage}` : ""}.
			</p>

			<div className="flex flex-col gap-2" data-testid="phone-files">
				<p className="text-xs uppercase tracking-widest text-muted-foreground">Your files</p>
				<p className="text-xs text-muted-foreground">
					Notes, PDFs and images the teacher can find and read when you mention them in a lesson (“use my optics notes”).
				</p>
				{files.length > 0 && (
					<ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
						{files.map((f) => (
							<li key={f.name} className="flex items-center justify-between gap-2 px-3 py-2" data-testid="phone-file">
								<span className="min-w-0 truncate">{f.name}</span>
								<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
									{formatBytes(f.size)}
									<button
										type="button"
										className="rounded px-2 py-1 hover:bg-accent hover:text-foreground"
										aria-label={`Remove ${f.name}`}
										disabled={busy}
										onClick={() => void remove(f.name)}
									>
										Remove
									</button>
								</span>
							</li>
						))}
					</ul>
				)}
				<Button type="button" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="phone-add-files">
					Add files…
				</Button>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					data-testid="phone-add-files-input"
					onChange={(e) => {
						const picked = [...(e.target.files ?? [])];
						e.target.value = "";
						if (picked.length > 0) void addFiles(picked);
					}}
				/>
			</div>

			<div className="flex flex-col gap-2">
				<Button type="button" variant="outline" disabled={busy} onClick={() => void backup()} data-testid="phone-backup">
					Save a backup (.zip)
				</Button>
				<p className="text-xs text-muted-foreground">
					Uses the same folder layout as the desktop app’s data folder, with your added files in a <code>files</code> folder beside it. API keys are never included.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()} data-testid="phone-restore">
					Restore from a backup or desktop data…
				</Button>
				<input
					ref={input}
					type="file"
					accept=".zip,application/zip"
					hidden
					data-testid="phone-restore-input"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) void restore(file);
					}}
				/>
				<p className="text-xs text-muted-foreground">
					Replaces everything on this phone. To bring your desktop sessions over, zip the desktop app’s <code>data</code> folder — macOS:{" "}
					<code>{DESKTOP_DATA_FOLDER.mac}</code>, Windows: <code>{DESKTOP_DATA_FOLDER.windows}</code>, Linux:{" "}
					<code>{DESKTOP_DATA_FOLDER.linux}</code> — and pick the zip here.
				</p>
			</div>

			<p className="text-xs text-muted-foreground">
				LearnHarness is free software under the AGPL-3.0.{" "}
				<a className="underline" href={__LH_SOURCE_URL__} target="_blank" rel="noreferrer">
					Source code
				</a>
			</p>

			{status && (
				<p role="status" className="text-xs" data-testid="phone-data-status">
					{status}
				</p>
			)}
		</div>
	);
}
