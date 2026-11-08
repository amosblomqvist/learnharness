"use client";

import { useEffect, useRef, useState } from "react";
import { composePrompt, type PromptEditorId, type PromptEditorTexts, type PromptEditorVersion, type PromptRole } from "@/src/core";

type PromptData = {
	editors: Record<PromptEditorId, { text: string; defaultText: string }>;
	history: PromptEditorVersion[];
	migrationNotice: boolean;
};
type DiffLine = { kind: "same" | "added" | "removed"; text: string };

const EDITORS: { id: PromptEditorId; label: string }[] = [
	{ id: "prober", label: "Prober" },
	{ id: "teacher", label: "Teacher" },
	{ id: "practice", label: "Practice" },
	{ id: "proberTeacherShared", label: "Prober / Teacher shared" },
	{ id: "common", label: "Common" },
];
const ROLES: PromptRole[] = ["prober", "teacher", "practice"];

function monthKey(date: Date): string {
	return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function diffLines(before: string, after: string): DiffLine[] {
	const oldLines = before.split(/\r?\n/);
	const newLines = after.split(/\r?\n/);
	if (oldLines.length * newLines.length > 1_000_000) {
		let prefix = 0;
		while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
		let suffix = 0;
		while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
			oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
		return [
			...oldLines.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
			...oldLines.slice(prefix, oldLines.length - suffix).map((text) => ({ kind: "removed" as const, text })),
			...newLines.slice(prefix, newLines.length - suffix).map((text) => ({ kind: "added" as const, text })),
			...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: "same" as const, text })),
		];
	}
	const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			rows[i]![j] = oldLines[i] === newLines[j]
				? rows[i + 1]![j + 1]! + 1
				: Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			result.push({ kind: "same", text: oldLines[i]! });
			i++;
			j++;
		} else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) {
			result.push({ kind: "removed", text: oldLines[i++]! });
		} else {
			result.push({ kind: "added", text: newLines[j++]! });
		}
	}
	while (i < oldLines.length) result.push({ kind: "removed", text: oldLines[i++]! });
	while (j < newLines.length) result.push({ kind: "added", text: newLines[j++]! });
	return result;
}

export function PromptEditors() {
	const [data, setData] = useState<PromptData | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Partial<Record<PromptEditorId, string>>>({});
	const [status, setStatus] = useState<Partial<Record<PromptEditorId, string>>>({});
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [compare, setCompare] = useState<Partial<Record<PromptEditorId, string>>>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const revisions = useRef<Partial<Record<PromptEditorId, number>>>({});
	const queues = useRef<Partial<Record<PromptEditorId, Promise<void>>>>({});
	const pendingSaves = useRef<Partial<Record<PromptEditorId, { text: string; revision: number }>>>({});
	const timers = useRef<Partial<Record<PromptEditorId, ReturnType<typeof setTimeout>>>>({});

	async function load(): Promise<void> {
		const response = await fetch("/api/settings/prompts");
		if (!response.ok) throw new Error(`Request failed (${response.status})`);
		setData(await response.json() as PromptData);
		setLoadError(null);
	}

	useEffect(() => {
		void load().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Request failed"));
		return () => {
			for (const { id } of EDITORS) {
				const pending = pendingSaves.current[id];
				if (!pending) continue;
				clearTimeout(timers.current[id]);
				delete pendingSaves.current[id];
				delete timers.current[id];
				save(id, pending.text, pending.revision);
			}
		};
	}, []);

	function save(editor: PromptEditorId, text: string, revision: number): void {
		const previous = queues.current[editor] ?? Promise.resolve();
		const pending = previous.catch(() => {}).then(async () => {
			if (revisions.current[editor] !== revision) return;
			setStatus((old) => ({ ...old, [editor]: "Saving…" }));
			try {
				const response = await fetch("/api/settings/prompts", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ editor, text }),
				});
				if (!response.ok) throw new Error(`Save failed (${response.status})`);
				const result = await response.json() as { editor: PromptEditorId; text: string; versionId: string | null; savedAt: string };
				if (revisions.current[editor] !== revision) return;
				setData((old) => old && ({
					...old,
					editors: { ...old.editors, [editor]: { ...old.editors[editor], text: result.text } },
					history: result.versionId
						? [{ id: result.versionId, editor, text: result.text, savedAt: result.savedAt }, ...old.history]
						: old.history,
				}));
				setDrafts((old) => ({ ...old, [editor]: undefined }));
				setStatus((old) => ({ ...old, [editor]: "Saved" }));
			} catch (error) {
				if (revisions.current[editor] === revision) {
					setStatus((old) => ({ ...old, [editor]: error instanceof Error ? error.message : "Save failed" }));
				}
			}
		});
		queues.current[editor] = pending;
	}

	function change(editor: PromptEditorId, text: string): void {
		const revision = (revisions.current[editor] ?? 0) + 1;
		revisions.current[editor] = revision;
		setDrafts((old) => ({ ...old, [editor]: text }));
		setStatus((old) => ({ ...old, [editor]: "Unsaved changes" }));
		pendingSaves.current[editor] = { text, revision };
		timers.current[editor] = setTimeout(() => {
			delete pendingSaves.current[editor];
			delete timers.current[editor];
			save(editor, text, revision);
		}, 600);
	}

	async function historyAction(method: "POST" | "DELETE", body: object): Promise<void> {
		setHistoryError(null);
		const response = await fetch("/api/settings/prompts/history", {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`Request failed (${response.status})`);
		await load();
	}

	if (!data) {
		return loadError
			? <div role="alert" className="flex flex-col gap-2 text-xs text-muted-foreground/70">
				<p>Prompt editors could not load: {loadError}</p>
				<button type="button" className="self-start underline" onClick={() => void load().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Request failed"))}>Retry</button>
			</div>
			: <p className="text-xs text-muted-foreground/70">Loading prompt editors…</p>;
	}

	const groups = new Map<string, PromptEditorVersion[]>();
	for (const version of data.history) {
		const key = monthKey(new Date(version.savedAt));
		groups.set(key, [...(groups.get(key) ?? []), version]);
	}
	const prompt = (role: PromptRole): string => {
		const texts = Object.fromEntries(EDITORS.map(({ id }) => [id, drafts[id] ?? data.editors[id].text])) as PromptEditorTexts;
		return composePrompt(role, texts);
	};
	const deleteSelected = () => {
		void historyAction("DELETE", { versionIds: selected })
			.then(() => setSelected([]))
			.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not delete history"));
	};
	const restore = (version: PromptEditorVersion) => {
		if (!window.confirm("Restore this saved prompt?")) return;
		clearTimeout(timers.current[version.editor]);
		delete pendingSaves.current[version.editor];
		revisions.current[version.editor] = (revisions.current[version.editor] ?? 0) + 1;
		setDrafts((old) => ({ ...old, [version.editor]: undefined }));
		void (async () => {
			await queues.current[version.editor]?.catch(() => {});
			await historyAction("POST", { editor: version.editor, versionId: version.id });
		})().catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not restore prompt"));
	};

	return <div className="flex flex-col gap-5">
		{data.migrationNotice && <p role="status" className="rounded border border-border bg-muted p-2 text-xs text-muted-foreground">
			We moved your saved prompt edits into the new editors. Review the final prompt previews because the prompt order changed.
		</p>}
		{EDITORS.map(({ id, label }) => <section key={id} data-testid={`prompt-editor-${id}`} className="flex flex-col gap-2">
			<label htmlFor={`prompt-${id}`} className="text-xs uppercase tracking-widest text-muted-foreground/70">{label}</label>
			<textarea
				id={`prompt-${id}`}
				aria-label={`${label} prompt`}
				value={drafts[id] ?? data.editors[id].text}
				onChange={(event) => change(id, event.target.value)}
				className="min-h-32 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
			/>
			<div className="flex items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground/70">{status[id]}</span>
				<button type="button" onClick={() => change(id, data.editors[id].defaultText)} className="text-xs underline">Reset to shipped default</button>
			</div>
		</section>)}

		{ROLES.map((role) => <details key={role}>
			<summary className="cursor-pointer text-sm">Final {role[0]!.toUpperCase() + role.slice(1)} prompt</summary>
			<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 text-xs">{prompt(role)}</pre>
		</details>)}

		<section aria-label="Prompt history" className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<h3 className="text-sm font-medium">Prompt history</h3>
				<button type="button" disabled={!selected.length} onClick={deleteSelected} className="text-xs underline">Delete selected</button>
				<button type="button" disabled={!data.history.length} onClick={() => {
					if (window.confirm("Clear all prompt history?")) {
						void historyAction("DELETE", {}).then(() => setSelected([]))
							.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not clear history"));
					}
				}} className="text-xs underline">Clear all history</button>
			</div>
			{historyError && <p role="alert" className="text-xs text-destructive">{historyError}</p>}
			{!data.history.length && <p className="text-xs text-muted-foreground/70">Saved prompt versions will appear here.</p>}
			{Array.from(groups, ([group, versions]) => {
				const ids = versions.map((version) => version.id);
				const allSelected = ids.every((id) => selected.includes(id));
				return <details key={group} open={expanded[group] ?? true} onToggle={(event) => {
					const isOpen = event.currentTarget.open;
					setExpanded((old) => ({ ...old, [group]: isOpen }));
				}}>
					<summary className="cursor-pointer text-xs font-medium">{group} ({versions.length})</summary>
					<div className="flex gap-3 py-2">
						<button type="button" className="text-xs underline" onClick={() => setSelected((old) => allSelected ? old.filter((id) => !ids.includes(id)) : [...new Set([...old, ...ids])])}>
							{allSelected ? "Deselect month" : "Select month"}
						</button>
						<button type="button" className="text-xs underline" onClick={() => {
							if (!window.confirm(`Delete all ${versions.length} versions from ${group}?`)) return;
							void historyAction("DELETE", { versionIds: ids })
								.then(() => setSelected((old) => old.filter((id) => !ids.includes(id))))
								.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not delete history"));
						}}>Delete month</button>
					</div>
					<div className="flex flex-col gap-2">
						{versions.map((version) => {
							const label = EDITORS.find((editor) => editor.id === version.editor)?.label ?? version.editor;
							const current = drafts[version.editor] ?? data.editors[version.editor].text;
							const isCompared = compare[version.editor] === version.id;
							return <div key={version.id} className="flex flex-col gap-1 rounded border border-border p-2 text-xs">
								<label className="flex items-center gap-2">
									<input type="checkbox" checked={selected.includes(version.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, version.id] : old.filter((id) => id !== version.id))} />
									{label} · {new Date(version.savedAt).toLocaleString()}
								</label>
								<div className="flex gap-3">
									<button type="button" onClick={() => setCompare((old) => ({ ...old, [version.editor]: isCompared ? undefined : version.id }))} className="underline">{isCompared ? "Hide comparison" : "Compare"}</button>
									<button type="button" onClick={() => restore(version)} className="underline">Restore</button>
									<button type="button" onClick={() => {
										void historyAction("DELETE", { versionIds: [version.id] })
											.then(() => setSelected((old) => old.filter((id) => id !== version.id)))
											.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not delete history"));
									}} className="underline">Delete</button>
								</div>
								{isCompared && <div aria-label={`Changes for ${label}`} className="max-h-48 overflow-auto rounded border border-border bg-background p-2 font-mono">
									{diffLines(version.text, current).map((line, index) => <div key={`${index}-${line.kind}`} className={line.kind === "added" ? "text-green-600" : line.kind === "removed" ? "text-red-600 line-through" : "text-muted-foreground"}>
										<span aria-hidden className="mr-2 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
										{line.text || " "}
									</div>)}
								</div>}
							</div>;
						})}
					</div>
				</details>;
			})}
		</section>
	</div>;
}
