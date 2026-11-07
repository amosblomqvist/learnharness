"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
	fuzzyScore,
	placementOf,
	type OrganizationAction,
	type SourceDirectory,
	type SourceOrganization,
	type SourceTag,
} from "@/src/core";

export const tagControl = "rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent disabled:opacity-50";
export const tagInput = "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground";
export async function directoryRequest(
	action?: OrganizationAction,
): Promise<SourceDirectory & { createdFolderId?: string; createdTagId?: string }> {
	const r = await fetch(
		"/api/graph/sources",
		action
			? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) }
			: { cache: "no-store" },
	);
	const data = await r.json();
	if (!r.ok) throw new Error(data.error || "Could not load tags.");
	return data;
}
export function folderPath(state: SourceOrganization, id: string | null) {
	const parts: string[] = [];
	for (let f = state.folders.find(f => f.id === id); f; f = state.folders.find(p => p.id === f!.parentId))
		parts.unshift(f.name);
	return parts.join(" / ");
}
export function FolderOptions({ state, exclude = [] }: { state: SourceOrganization; exclude?: string[] }) {
	return (
		<>
			<option value="">Top level</option>
			{state.folders
				.filter(f => !exclude.includes(f.id))
				.map(f => (
					<option key={f.id} value={f.id}>
						{folderPath(state, f.id)}
					</option>
				))}
		</>
	);
}
export function TagMark({ tag }: { tag: SourceTag }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			{tag.symbol ? (
				<span aria-hidden style={{ color: tag.color }}>
					{tag.symbol}
				</span>
			) : (
				tag.color && (
					<span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
				)
			)}
			<span>{tag.name}</span>
		</span>
	);
}
export function LibraryDialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const el = ref.current;
		el?.showModal();
		return () => el?.close();
	}, []);
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			onCancel={e => {
				e.preventDefault();
				close();
			}}
			onClick={e => {
				if (e.target === e.currentTarget) {
					const r = e.currentTarget.getBoundingClientRect();
					if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
				}
			}}
			className="fixed inset-0 m-auto max-h-[85dvh] w-[32rem] max-w-[94vw] overflow-auto rounded-xl border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/55"
		>
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 id={titleId} className="text-lg font-semibold">
					{title}
				</h2>
				<button type="button" className={tagControl} onClick={close} aria-label="Close dialog">
					Close
				</button>
			</div>
			{children}
		</dialog>
	);
}
export function TagEditor({
	directory,
	tag,
	parentId,
	saved,
	cancel,
}: {
	directory: SourceDirectory;
	tag?: SourceTag;
	parentId: string | null;
	saved: (d: SourceDirectory, id: string) => void;
	cancel: () => void;
}) {
	const [name, setName] = useState(tag?.name ?? ""),
		[parent, setParent] = useState(tag?.parentId ?? parentId ?? "");
	const [color, setColor] = useState(tag?.color),
		[symbol, setSymbol] = useState(tag?.symbol ?? "");
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	async function save() {
		setBusy(true);
		setError("");
		try {
			const fields = { name: name.trim(), parentId: parent || null, color, symbol: symbol.trim() || undefined };
			const next = await directoryRequest(
				tag ? { action: "update-tag", id: tag.id, ...fields } : { action: "create-tag", ...fields },
			);
			saved(next, tag?.id ?? next.createdTagId!);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<form
			className="grid gap-3"
			onSubmit={e => {
				e.preventDefault();
				void save();
			}}
		>
			<label className="text-sm">
				Tag name
				<input autoFocus required value={name} onChange={e => setName(e.target.value)} className={tagInput} />
			</label>
			<label className="text-sm">
				Folder
				<select value={parent} onChange={e => setParent(e.target.value)} className={tagInput}>
					<FolderOptions state={directory.organization} />
				</select>
			</label>
			<label className="text-sm">
				Symbol (optional)
				<input value={symbol} onChange={e => setSymbol(e.target.value)} className={tagInput} />
			</label>
			<div className="flex items-center gap-2 text-sm">
				<label className="flex items-center gap-2">
					Color (optional)
					<input type="color" value={color ?? "#5b83b5"} onChange={e => setColor(e.target.value)} />
				</label>
				{color ? (
					<button type="button" className={tagControl} onClick={() => setColor(undefined)}>
						Clear color
					</button>
				) : (
					<button type="button" className={tagControl} onClick={() => setColor("#5b83b5")}>
						Use color
					</button>
				)}
			</div>
			{error && <p role="alert">{error}</p>}
			<div className="flex justify-end gap-2">
				<button className={tagControl} type="button" onClick={cancel}>
					Cancel
				</button>
				<button className={tagControl} disabled={busy || !name.trim()}>
					Save tag
				</button>
			</div>
		</form>
	);
}
export function TagChoices({
	directory,
	selected,
	mixed,
	toggle,
	onDirectory,
}: {
	directory: SourceDirectory;
	selected: string[];
	mixed?: string[];
	toggle: (id: string, checked: boolean) => void;
	onDirectory: (next: SourceDirectory) => void;
}) {
	const [query, setQuery] = useState(""),
		[creating, setCreating] = useState(false);
	if (creating)
		return (
			<TagEditor
				directory={directory}
				parentId={null}
				saved={(d, id) => {
					onDirectory(d);
					toggle(id, true);
					setCreating(false);
				}}
				cancel={() => setCreating(false)}
			/>
		);
	const tags = (directory.organization.tags ?? []).filter(
		t => fuzzyScore(query, t.name, folderPath(directory.organization, t.parentId)) !== null,
	);
	return (
		<div className="grid gap-2">
			<input
				aria-label="Find tags"
				placeholder="Find a tag…"
				value={query}
				onChange={e => setQuery(e.target.value)}
				className={tagInput}
			/>
			<div className="max-h-52 overflow-auto">
				{tags.map(t => (
					<label
						key={t.id}
						className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
					>
						<input
							type="checkbox"
							checked={selected.includes(t.id)}
							ref={el => {
								if (el) el.indeterminate = !!mixed?.includes(t.id);
							}}
							onChange={e => toggle(t.id, e.target.checked)}
						/>
						<TagMark tag={t} />
						<small className="ml-auto text-muted-foreground">{folderPath(directory.organization, t.parentId)}</small>
					</label>
				))}
			</div>
			<button type="button" className={tagControl} onClick={() => setCreating(true)}>
				Create tag
			</button>
		</div>
	);
}
export function SourceTagDialog({ ids, close, onSaved }: { ids: string[]; close: () => void; onSaved?: () => void }) {
	const [directory, setDirectory] = useState<SourceDirectory>(),
		[error, setError] = useState(""),
		[saving, setSaving] = useState(false);
	const [changes, setChanges] = useState<Record<string, boolean>>({});
	useEffect(() => {
		let active = true;
		void directoryRequest()
			.then(d => {
				if (active) setDirectory(d);
			})
			.catch(e => {
				if (active) setError(e.message);
			});
		return () => {
			active = false;
		};
	}, []);
	const selected: string[] = [],
		mixed: string[] = [];
	for (const tag of directory?.organization.tags ?? []) {
		const count = ids.filter(id => placementOf(directory!.organization, id)?.tagIds?.includes(tag.id)).length;
		if (changes[tag.id] === true || (changes[tag.id] === undefined && count === ids.length)) selected.push(tag.id);
		else if (changes[tag.id] === undefined && count > 0) mixed.push(tag.id);
	}
	async function save() {
		setSaving(true);
		try {
			await directoryRequest({
				action: "tag-sources",
				sourceIds: ids,
				add: Object.keys(changes).filter(id => changes[id]),
				remove: Object.keys(changes).filter(id => !changes[id]),
			});
			onSaved?.();
			close();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}
	return (
		<LibraryDialog title={ids.length > 1 ? `Tag ${ids.length} items` : "Edit tags"} close={close}>
			{directory ? (
				<TagChoices
					directory={directory}
					selected={selected}
					mixed={mixed}
					onDirectory={setDirectory}
					toggle={(id, v) => setChanges(c => ({ ...c, [id]: v }))}
				/>
			) : (
				!error && <p>Loading tags…</p>
			)}
			{error && (
				<p role="alert" className="mt-2 text-sm">
					{error}
				</p>
			)}
			<button className={tagControl + " mt-4"} disabled={!directory || saving} onClick={() => void save()}>
				Apply tags
			</button>
		</LibraryDialog>
	);
}
