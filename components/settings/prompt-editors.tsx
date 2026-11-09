"use client";

import { useEffect, useRef, useState } from "react";
import { diffPromptText, pairPromptDiffRows, type PromptDiffRow, type PromptEditorId, type PromptEditorVersion } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";

type PromptData = {
	editors: Record<PromptEditorId, { text: string; defaultText: string }>;
	history: PromptEditorVersion[];
	migrationNotice: boolean;
};

const EDITORS: { id: PromptEditorId; label: string; description: string; usedBy: string }[] = [
	{ id: "common", label: "Common", description: "Shared guidance for every learning role.", usedBy: "Prober, Teacher, and Practice" },
	{ id: "proberTeacherShared", label: "Prober and Teacher shared", description: "Guidance shared by Prober and Teacher. Practice does not use it.", usedBy: "Prober and Teacher" },
	{ id: "prober", label: "Prober", description: "Guides how LearnHarness checks what you understand.", usedBy: "Prober" },
	{ id: "teacher", label: "Teacher", description: "Guides how LearnHarness explains concepts and leads a lesson.", usedBy: "Teacher" },
	{ id: "practice", label: "Practice", description: "Guides practice sessions and feedback.", usedBy: "Practice" },
];

function monthKey(date: Date): string {
	return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function promptLineCount(text: string): number {
	let count = 1;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
	return count;
}

function promptLineAt(text: string, position: number): number {
	let line = 1;
	for (let index = 0; index < position; index++) if (text.charCodeAt(index) === 10) line++;
	return line;
}



export function PromptEditors() {
	const [data, setData] = useState<PromptData | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Partial<Record<PromptEditorId, string>>>({});
	const [status, setStatus] = useState<Partial<Record<PromptEditorId, string>>>({});
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [editing, setEditing] = useState<PromptEditorId | null>(null);
	const [viewing, setViewing] = useState<PromptEditorId | null>(null);
	const [comparison, setComparison] = useState<{ version: PromptEditorVersion; currentText: string } | null>(null);
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
		clearTimeout(timers.current[editor]);
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
	const activeEditor = EDITORS.find(({ id }) => id === editing);
	const activeViewer = EDITORS.find(({ id }) => id === viewing);
	const deleteSelected = () => {
		void historyAction("DELETE", { versionIds: selected })
			.then(() => setSelected([]))
			.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not delete history"));
	};
	const restore = (version: PromptEditorVersion): boolean => {
		if (!window.confirm("Restore this saved prompt?")) return false;
		clearTimeout(timers.current[version.editor]);
		delete pendingSaves.current[version.editor];
		revisions.current[version.editor] = (revisions.current[version.editor] ?? 0) + 1;
		setDrafts((old) => ({ ...old, [version.editor]: undefined }));
		void (async () => {
			await queues.current[version.editor]?.catch(() => {});
			await historyAction("POST", { editor: version.editor, versionId: version.id });
		})().catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not restore prompt"));
		return true;
	};
	const closeEditor = () => setEditing(null);
	const closeComparison = () => setComparison(null);
	const compareVersion = (version: PromptEditorVersion) => {
		setComparison({ version, currentText: drafts[version.editor] ?? data.editors[version.editor].text });
	};

	return <div className="flex flex-col gap-5 font-sans">
		{data.migrationNotice && <p role="status" className="rounded border border-border bg-muted p-2 text-xs text-muted-foreground">
			We moved your saved prompt edits into the new editors. Review each prompt section because the prompt order changed.
		</p>}
		<section aria-label="Prompt editors" className="flex flex-col gap-3">
			<div>
				<h3 className="text-sm font-medium">Prompt instructions</h3>
				<p className="mt-1 text-xs text-muted-foreground">Choose a section to edit. Changes save automatically.</p>
			</div>
			{EDITORS.map(({ id, label, description, usedBy }) => {
				const customized = (drafts[id] ?? data.editors[id].text) !== data.editors[id].defaultText;
				return <article key={id} data-testid={`prompt-editor-${id}`} className="flex items-center gap-4 rounded-md border border-border p-3">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<h4 className="text-sm font-medium">{label}</h4>
							<span className="text-[11px] text-muted-foreground">{customized ? "Customized" : "Default"}</span>
							{status[id] && <span role="status" className="text-[11px] text-muted-foreground">{status[id]}</span>}
						</div>
						<p className="mt-1 text-xs text-muted-foreground">{description}</p>
						<p className="mt-1 text-[11px] text-muted-foreground/70">Used by {usedBy}</p>
					</div>
					<div className="flex shrink-0 gap-2">
						<Button type="button" size="sm" variant="ghost" aria-label={`View ${label} instructions`} onClick={() => setViewing(id)}>View</Button>
						<Button type="button" size="sm" variant="outline" aria-label={`Edit ${label} instructions`} onClick={() => setEditing(id)}>Edit</Button>
					</div>
				</article>;
			})}
		</section>

		{activeEditor && <PromptEditDialog
			editor={activeEditor}
			text={drafts[activeEditor.id] ?? data.editors[activeEditor.id].text}
			defaultText={data.editors[activeEditor.id].defaultText}
			status={status[activeEditor.id] ?? ""}
			onChange={(text) => change(activeEditor.id, text)}
			onReset={() => {
				if (window.confirm(`Restore the default ${activeEditor.label} prompt?`)) {
					change(activeEditor.id, data.editors[activeEditor.id].defaultText);
				}
			}}
			onClose={closeEditor}
		/>}
		{activeViewer && <PromptViewDialog
			editor={activeViewer}
			text={drafts[activeViewer.id] ?? data.editors[activeViewer.id].text}
			onClose={() => setViewing(null)}
		/>}


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
							const emptyLabel = version.text.length === 0 ? " · Empty" : "";
							return <div key={version.id} className="flex flex-col gap-1 rounded border border-border p-2 text-xs">
								<label className="flex items-center gap-2">
									<input type="checkbox" checked={selected.includes(version.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, version.id] : old.filter((id) => id !== version.id))} />
									{label}{emptyLabel} · {new Date(version.savedAt).toLocaleString()}
								</label>
								<div className="flex gap-3">
									<button type="button" onClick={() => compareVersion(version)} className="underline">Compare with current</button>
									<button type="button" onClick={() => restore(version)} className="underline">Restore</button>
									<button type="button" onClick={() => {
										void historyAction("DELETE", { versionIds: [version.id] })
											.then(() => setSelected((old) => old.filter((id) => id !== version.id)))
											.catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not delete history"));
									}} className="underline">Delete</button>
								</div>
							</div>;
						})}
					</div>
				</details>;
			})}
		</section>

		{comparison && <PromptCompareDialog
			version={comparison.version}
			currentText={comparison.currentText}
			onRestore={() => {
				if (restore(comparison.version)) closeComparison();
			}}
			onClose={closeComparison}
		/>}
	</div>;
}

function PromptEditDialog({
	editor,
	text,
	defaultText,
	status,
	onChange,
	onReset,
	onClose,
}: {
	editor: (typeof EDITORS)[number];
	text: string;
	defaultText: string;
	status: string;
	onChange: (text: string) => void;
	onReset: () => void;
	onClose: () => void;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const gutterRef = useRef<HTMLDivElement>(null);
	const [rendered, setRendered] = useState(false);
	const [activeLine, setActiveLine] = useState(1);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || dialog.open) return;
		dialog.showModal();
		dialog.querySelector("textarea")?.focus();
		return () => { if (dialog.open) dialog.close(); };
	}, []);

	return <dialog
		ref={dialogRef}
		data-prompt-editor-dialog
		data-testid="prompt-editor-dialog"
		aria-labelledby="prompt-editor-title"
		onCancel={(event) => { event.preventDefault(); onClose(); }}
		className="fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-card p-0 text-foreground"
	>
		<header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border px-6 py-4">
			<div className="min-w-0 flex-1">
				<h2 id="prompt-editor-title" className="text-lg font-medium">Edit {editor.label} instructions</h2>
				<p className="mt-1 text-sm text-muted-foreground">{editor.description} Used by {editor.usedBy}.</p>
			</div>
			<MarkdownModeSwitch rendered={rendered} onChange={setRendered} />
			<Button type="button" size="sm" variant="outline" disabled={text === defaultText} onClick={onReset}>Restore default</Button>
			<Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
		</header>
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
			{rendered
				? <div aria-label="Rendered prompt preview" className="min-h-0 flex-1 overflow-auto rounded-sm border border-border bg-background p-4">
					<MessageResponse>{text}</MessageResponse>
				</div>
				: <div className="flex min-h-0 flex-1 overflow-hidden rounded-sm border border-border bg-background">
					<div ref={gutterRef} aria-hidden="true" data-testid="prompt-line-numbers" className="shrink-0 overflow-hidden border-r border-border/60 px-2 py-4 text-right font-mono text-sm leading-relaxed text-muted-foreground/60">
						{Array.from({ length: promptLineCount(text) }, (_, index) => <div key={index} className={index + 1 === activeLine ? "bg-accent/60 text-foreground" : ""}>{index + 1}</div>)}
					</div>
					<Textarea
						wrap="off"
						aria-label={`${editor.label} prompt text`}
						value={text}
						onChange={(event) => {
							onChange(event.target.value);
							setActiveLine(promptLineAt(event.target.value, event.target.selectionStart));
						}}
						onClick={(event) => setActiveLine(promptLineAt(text, event.currentTarget.selectionStart))}
						onKeyUp={(event) => setActiveLine(promptLineAt(text, event.currentTarget.selectionStart))}
						onSelect={(event) => setActiveLine(promptLineAt(text, event.currentTarget.selectionStart))}
						onScroll={(event) => {
							if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
						}}
						className="min-h-0 min-w-0 flex-1 resize-none rounded-none border-0 bg-background p-4 font-mono text-sm leading-relaxed text-foreground shadow-none outline-none focus-visible:ring-0"
					/>
				</div>}
			<footer className="flex shrink-0 flex-wrap items-center gap-4 text-xs">
				<p className="text-muted-foreground">Changes save automatically.</p>
				<span role="status" className="text-muted-foreground">{status}</span>
			</footer>
		</div>
	</dialog>;
}
function PromptViewDialog({
	editor,
	text,
	onClose,
}: {
	editor: (typeof EDITORS)[number];
	text: string;
	onClose: () => void;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || dialog.open) return;
		dialog.showModal();
		dialog.querySelector<HTMLButtonElement>("[data-prompt-view-close]")?.focus();
		return () => { if (dialog.open) dialog.close(); };
	}, []);

	return <dialog
		ref={dialogRef}
		data-prompt-view-dialog
		aria-labelledby="prompt-view-title"
		onCancel={(event) => { event.preventDefault(); onClose(); }}
		className="fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-card p-0 text-foreground"
	>
		<header className="flex shrink-0 items-center gap-4 border-b border-border px-6 py-4">
			<div className="min-w-0 flex-1">
				<h2 id="prompt-view-title" className="text-lg font-medium">View {editor.label} instructions</h2>
				<p className="mt-1 text-sm text-muted-foreground">{editor.description} Used by {editor.usedBy}.</p>
			</div>
			<Button type="button" size="sm" variant="outline" data-prompt-view-close onClick={onClose}>Close</Button>
		</header>
		<div aria-label="Rendered prompt preview" className="min-h-0 flex-1 overflow-auto p-6">
			<MessageResponse>{text}</MessageResponse>
		</div>
	</dialog>;
}

function PromptCompareDialog({

	version,
	currentText,
	onRestore,
	onClose,
}: {
	version: PromptEditorVersion;
	currentText: string;
	onRestore: () => void;
	onClose: () => void;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [rendered, setRendered] = useState(false);
	const [layout, setLayout] = useState<"split" | "unified">("unified");
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || dialog.open) return;
		dialog.showModal();
		dialog.querySelector<HTMLButtonElement>("[data-prompt-comparison-close]")?.focus();
		return () => { if (dialog.open) dialog.close(); };
	}, []);
	const rows = diffPromptText(version.text, currentText);
	const pairs = pairPromptDiffRows(rows);
	const added = rows.filter((row) => row.kind === "added").length;
	const removed = rows.filter((row) => row.kind === "removed").length;
	const label = EDITORS.find((editor) => editor.id === version.editor)?.label ?? version.editor;
	const savedAt = new Date(version.savedAt).toLocaleString();
	

	return <dialog
		ref={dialogRef}
		data-prompt-comparison-dialog
		data-testid="prompt-comparison-dialog"
		aria-labelledby="prompt-comparison-title"
		onCancel={(event) => { event.preventDefault(); onClose(); }}
		className="fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-card p-0 text-foreground"
	>
		<header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border px-6 py-4">
			<div className="min-w-0 flex-1">
				<h2 id="prompt-comparison-title" className="text-lg font-medium">Compare {label} prompts</h2>
				<p className="mt-1 text-xs text-muted-foreground">{removed} removed · {added} added</p>
			</div>
			<MarkdownModeSwitch rendered={rendered} onChange={setRendered} />
			{!rendered && <DiffLayoutSwitch layout={layout} onChange={setLayout} />}
			<Button type="button" size="sm" variant="outline" data-prompt-comparison-close onClick={onClose}>Close</Button>
		</header>
		<div className="shrink-0 border-b border-border bg-muted px-4 py-3 text-xs font-medium">
			Saved version · {savedAt}{version.text.length === 0 ? " · Empty" : ""} compared with Current prompt
		</div>
		{added === 0 && removed === 0 && <p role="status" className="border-b border-border px-6 py-2 text-xs text-muted-foreground">These prompts are identical.</p>}
		{rendered
			? <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
				<div aria-label="Saved prompt rendered as Markdown" className="overflow-auto border-r border-border p-6">
					<MessageResponse>{version.text}</MessageResponse>
				</div>
				<div aria-label="Current prompt rendered as Markdown" className="overflow-auto p-6">
					<MessageResponse>{currentText}</MessageResponse>
				</div>
			</div>
			: layout === "unified"
				? <div aria-label={`Unified raw Markdown changes to ${label} prompt`} className="min-h-0 flex-1 overflow-auto font-mono text-sm leading-6">
					<table className="w-full min-w-[720px] table-fixed border-collapse">
						<tbody>
							{rows.map((row, index) => {
								const removedRow = row.kind === "removed";
								const addedRow = row.kind === "added";
								const background = addedRow ? "bg-green-500/10" : removedRow ? "bg-red-500/10" : "";
								const color = addedRow ? "text-green-400" : removedRow ? "text-red-400" : "text-muted-foreground";
								return <tr key={index} className="border-b border-border/40 align-top">
									<td className="w-11 select-none border-r border-border/40 px-2 text-right text-muted-foreground/60">{row.oldLine ?? ""}</td>
									<td className="w-11 select-none border-r border-border/40 px-2 text-right text-muted-foreground/60">{row.newLine ?? ""}</td>
									<td className={`w-7 select-none px-1 text-center ${background} ${color}`}>{addedRow ? "+" : removedRow ? "−" : ""}</td>
									<td className={`max-w-0 p-0 ${background} ${color}`}>
										<pre className="whitespace-pre-wrap break-words px-2">{row.parts.map((part, partIndex) =>
											<span key={partIndex} className={part.changed ? `rounded-sm ${addedRow ? "bg-green-400/30" : "bg-red-400/30"} font-semibold` : ""}>{part.text}</span>,
										)}</pre>
									</td>
								</tr>;
							})}
						</tbody>
					</table>
				</div>
				: <div aria-label={`Split raw Markdown comparison for ${label} prompt`} className="min-h-0 flex-1 overflow-auto font-mono text-sm leading-6">
					<table className="w-full min-w-[1000px] table-fixed border-collapse">
						<thead className="sticky top-0 z-10 bg-muted text-left text-xs font-sans">
							<tr>
								<th scope="col" className="border-b border-r border-border px-3 py-2">Saved version</th>
								<th scope="col" className="border-b border-border px-3 py-2">Current prompt</th>
							</tr>
						</thead>
						<tbody>
							{pairs.map((pair, index) => <tr key={index} className="border-b border-border/40 align-top">
								<DiffCell row={pair.old} side="old" />
								<DiffCell row={pair.current} side="current" />
							</tr>)}
						</tbody>
					</table>
				</div>}
		<footer className="shrink-0 border-t border-border px-6 py-3 text-xs text-muted-foreground">
			{rendered
				? "Rendered view shows both full prompts."
				: layout === "unified"
					? "Removed lines are red and start with −. Added lines are green and start with +. Changed words have a brighter highlight."
					: "Saved prompt is on the left. Current prompt is on the right. Changed words have a brighter highlight."}
		</footer>
	</dialog>;
}

function DiffLayoutSwitch({ layout, onChange }: { layout: "split" | "unified"; onChange: (layout: "split" | "unified") => void }) {
	return <div role="group" aria-label="Diff layout" className="flex shrink-0 items-center rounded-md border border-border p-0.5 text-xs">
		{(["split", "unified"] as const).map((option) => <button
			key={option}
			type="button"
			aria-pressed={layout === option}
			title={option === "split" ? "Show saved and current prompts side by side" : "Show additions and removals in one column"}
			onClick={() => onChange(option)}
			className={`rounded px-2 py-1 capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${layout === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
		>{option}</button>)}
	</div>;
}

function MarkdownModeSwitch({ rendered, onChange }: { rendered: boolean; onChange: (rendered: boolean) => void }) {
	return <div className="flex shrink-0 items-center gap-2 text-xs">
		<span className={rendered ? "text-muted-foreground" : "text-foreground"}>Raw Markdown</span>
		<button
			type="button"
			role="switch"
			aria-label="Render Markdown"
			aria-checked={rendered}
			onClick={() => onChange(!rendered)}
			className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${rendered ? "bg-primary" : "bg-muted-foreground/40"}`}
		>
			<span className={`size-4 rounded-full bg-background shadow transition-transform ${rendered ? "translate-x-4" : "translate-x-0"}`} />
		</button>
		<span className={rendered ? "text-foreground" : "text-muted-foreground"}>Rendered</span>
	</div>;
}

function DiffCell({ row, side }: { row: PromptDiffRow | null; side: "old" | "current" }) {
	const kind = row?.kind ?? "same";
	const background = kind === "added" ? "bg-green-500/10" : kind === "removed" ? "bg-red-500/10" : "";
	const color = kind === "added" ? "text-green-400" : kind === "removed" ? "text-red-400" : "text-muted-foreground";
	const marker = kind === "added" ? "+" : kind === "removed" ? "−" : "";
	const lineNumber = side === "old" ? row?.oldLine : row?.newLine;
	return <td className={`max-w-0 border-r border-border/40 p-0 ${background} ${color}`}>
		<div className="flex min-w-0">
			<span className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground/60">{lineNumber ?? ""}</span>
			<span className="w-5 shrink-0 select-none px-1 text-center">{marker}</span>
			<pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">{row ? row.parts.map((part, index) =>
				<span key={index} className={part.changed ? `rounded-sm ${kind === "added" ? "bg-green-400/30" : "bg-red-400/30"} font-semibold` : ""}>{part.text}</span>,
			) : " "}</pre>
		</div>
	</td>;
}

