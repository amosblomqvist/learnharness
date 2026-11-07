"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, CircleOffIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
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
const tagColors = [
	{ name: "Red", value: "#c46d75" },
	{ name: "Orange", value: "#c58b56" },
	{ name: "Yellow", value: "#b5a45b" },
	{ name: "Green", value: "#6ca183" },
	{ name: "Blue", value: "#5b83b5" },
	{ name: "Purple", value: "#967abe" },
	{ name: "Pink", value: "#bf78a1" },
	{ name: "Gray", value: "#8d929e" },
];
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
export function FolderSelect({ state, exclude = [], value, onChange }: {
	state: SourceOrganization;
	exclude?: string[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<span className="relative block min-w-0">
			<select value={value} onChange={e => onChange(e.target.value)} className={tagInput + " h-8 appearance-none pr-9"}>
				<option value="">Top level</option>
				{state.folders
					.filter(f => !exclude.includes(f.id))
					.map(f => (
						<option key={f.id} value={f.id}>
							{folderPath(state, f.id)}
						</option>
					))}
			</select>
			<ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
		</span>
	);
}
export function TagMark({ tag }: { tag: SourceTag }) {
	return (
		<span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle">
			{tag.symbol ? (
				<span aria-hidden className="shrink-0" style={{ color: tag.color }}>
					{tag.symbol}
				</span>
			) : (
				tag.color && (
					<span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
				)
			)}
			<span className="truncate">{tag.name}</span>
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
			className="settings-dialog-pop fixed inset-0 m-auto max-h-[85dvh] w-[32rem] max-w-[calc(100vw-2rem)] overflow-auto rounded-md border border-border bg-card p-5 text-sm text-foreground shadow-xl backdrop:bg-background/80"
		>
			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 id={titleId} className="text-sm font-semibold">
					{title}
				</h2>
				<Hint label="Close" binding="escape" side="left">
					<button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={close} aria-label="Close dialog">
						<XIcon className="size-3.5" aria-hidden="true" />
					</button>
				</Hint>
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
	const colorGroup = useId();
	const validColor = color === undefined || /^#[0-9a-f]{6}$/i.test(color);
	const [error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	async function save() {
		if (!validColor) return;
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
			<label className="grid gap-1.5 text-xs text-muted-foreground">
				Tag name
				<Input autoFocus required value={name} onChange={e => setName(e.target.value)} className={tagInput + " h-8 shadow-none dark:bg-background"} />
			</label>
			<label className="grid gap-1.5 text-xs text-muted-foreground">
				Folder
				<FolderSelect state={directory.organization} value={parent} onChange={setParent} />
			</label>
			<label className="grid gap-1.5 text-xs text-muted-foreground">
				Symbol (optional)
				<Input value={symbol} onChange={e => setSymbol(e.target.value)} className={tagInput + " h-8 shadow-none dark:bg-background"} />
			</label>
			<fieldset className="min-w-0">
				<legend className="text-xs text-muted-foreground">Color</legend>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<label className="cursor-pointer">
						<input type="radio" name={colorGroup} aria-label="No color" checked={color === undefined}
							onChange={() => setColor(undefined)} className="peer sr-only" />
						<span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground peer-checked:border-foreground/70 peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
							<CircleOffIcon className="size-3.5" aria-hidden="true" />
							No color
						</span>
					</label>
					{tagColors.map(option => (
						<Hint key={option.value} label={option.name}>
							<label className="cursor-pointer">
								<input type="radio" name={colorGroup} aria-label={option.name}
									checked={color?.toLowerCase() === option.value} onChange={() => setColor(option.value)} className="peer sr-only" />
								<span aria-hidden="true" style={{ backgroundColor: option.value }}
									className="block size-8 rounded-md border border-border/60 ring-offset-2 ring-offset-card transition-shadow peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring" />
							</label>
						</Hint>
					))}
				</div>
				<label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					Custom hex
					<span className="flex items-center gap-2">
						<span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border"
							style={{ backgroundColor: validColor ? color : undefined }}>
							{!color && <CircleOffIcon className="size-3.5" />}
						</span>
						<Input value={color ?? ""} onChange={e => setColor(e.target.value.trim() || undefined)}
							placeholder="#RRGGBB" pattern="#[0-9a-fA-F]{6}" title="Use # followed by six hexadecimal digits."
							autoComplete="off" spellCheck={false} aria-invalid={!validColor}
							className="h-8 w-32 bg-background text-sm shadow-none dark:bg-background" />
					</span>
				</label>
			</fieldset>
			{error && <p role="alert">{error}</p>}
			<div className="mt-1 flex justify-end gap-2">
				<Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground" type="button" onClick={cancel}>
					Cancel
				</Button>
				<Button type="submit" variant="outline" size="sm" className="text-xs" disabled={busy || !name.trim() || !validColor}>
					Save tag
				</Button>
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
