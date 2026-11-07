"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, TagsIcon } from "lucide-react";
import {
	canMoveFolder,
	libraryRows,
	matchingPassage,
	noteHref,
	noteTextHtml,
	placementOf,
	type LibraryScope,
	type NoteIndexEntry,
	type OrganizationAction,
	type SourceDirectory,
	type SourceFolder,
	type SourceTag,
} from "@/src/core";
import {
	directoryRequest,
	FolderOptions,
	LibraryDialog,
	SourceTagDialog,
	TagEditor,
	TagMark,
	tagControl,
	tagInput,
} from "./tag-picker";
import { TopBar } from "./top-bar";
import { useServerEvent, useServerResync } from "./server-events";
import { NotesImportControl, NotesImportErrors, NotesImportNotices, useNotesImport } from "./notes-import";

type Library = SourceDirectory & { notes: NoteIndexEntry[] };
type Editor =
	| { kind: "tag"; tag?: SourceTag }
	| { kind: "folder"; folder?: SourceFolder }
	| { kind: "move" | "rename"; id: string }
	| { kind: "delete"; item: SourceTag | SourceFolder; type: "tag" | "folder" };
export function TagsLibrary() {
	const [library, setLibrary] = useState<Library>(),
		[failure, setFailure] = useState("");
	const [scope, setScope] = useState<LibraryScope>({ kind: "all" }),
		[query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string[]>([]),
		[tagging, setTagging] = useState(false);
	const [editor, setEditor] = useState<Editor>(),
		[name, setName] = useState(""),
		[parent, setParent] = useState("");
	const [busy, setBusy] = useState(false),
		[editError, setEditError] = useState("");
	const version = useRef(0);
	const refresh = useCallback(async () => {
		const token = ++version.current;
		try {
			const r = await fetch("/api/notes/library", { cache: "no-store" });
			if (!r.ok) throw new Error("Could not load the library.");
			const data: Library = await r.json();
			if (token !== version.current) return;
			setLibrary(data);
			setFailure("");
			setSelected(ids => ids.filter(id => data.sources.some(s => s.id === id && s.kind !== "missing")));
		} catch (e) {
			if (token === version.current) setFailure((e as Error).message);
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			version.current++;
		};
	}, [refresh]);
	useServerResync(refresh);
	useServerEvent("sources-changed", refresh);
	useServerEvent("notes-changed", refresh);
	useServerEvent("chats-changed", refresh);
	const imports = useNotesImport({ onFinish: refresh });
	const rows = useMemo(() => (library ? libraryRows(library, scope, query) : []), [library, scope, query]);
	const org = library?.organization;
	const folder = scope.kind === "folder" ? org?.folders.find(f => f.id === scope.id) : undefined;
	const tag = scope.kind === "tag" ? org?.tags?.find(t => t.id === scope.id) : undefined;
	const defaultParent = folder?.id ?? tag?.parentId ?? null;
	function select(next: LibraryScope) {
		setScope(next);
		setSelected([]);
	}
	function begin(next: Editor, label = "", parentId: string | null = defaultParent) {
		setEditor(next);
		setEditError("");
		setName(label);
		setParent(parentId ?? "");
	}
	async function submit() {
		if (!editor || editor.kind === "tag" || !library) return;
		setBusy(true);
		setEditError("");
		try {
			let action: OrganizationAction;
			if (editor.kind === "folder" && editor.folder) {
				await directoryRequest({ action: "edit-folder", id: editor.folder.id, name, parentId: parent || null });
			} else {
				if (editor.kind === "folder") action = { action: "create-folder", name, parentId: parent || null };
				else if (editor.kind === "rename") action = { action: "rename-source", id: editor.id, name };
				else if (editor.kind === "move")
					action = { action: "move", kind: "source", id: editor.id, parentId: parent || null };
				else if (editor.kind === "delete")
					action = { action: editor.type === "tag" ? "delete-tag" : "delete-folder", id: editor.item.id };
				else return;
				const next = await directoryRequest(action);
				if (next.createdFolderId) select({ kind: "folder", id: next.createdFolderId });
				if (editor.kind === "delete") select({ kind: "all" });
			}
			setEditor(undefined);
			await refresh();
		} catch (e) {
			setEditError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}
	const navClass = (active: boolean) =>
		"flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent " +
		(active ? "bg-accent font-semibold" : "");
	function branch(parentId: string | null) {
		return (
			<ul className={parentId ? "ml-3 border-l pl-2" : ""}>
				{org?.folders
					.filter(f => f.parentId === parentId)
					.map(f => (
						<li key={f.id}>
							<div className="flex items-center">
								<button
									className="p-1"
									aria-expanded={!collapsed.has(f.id)}
									aria-label={`Toggle ${f.name}`}
									onClick={() =>
										setCollapsed(old => {
											const next = new Set(old);
											if (next.has(f.id)) next.delete(f.id);
											else next.add(f.id);
											return next;
										})
									}
								>
									{collapsed.has(f.id) ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
								</button>
								<button
									className={navClass(folder?.id === f.id)}
									onClick={() => select({ kind: "folder", id: f.id })}
								>
									<FolderIcon size={15} />
									{f.name}
								</button>
							</div>
							{!collapsed.has(f.id) && branch(f.id)}
						</li>
					))}
				{org?.tags
					?.filter(t => t.parentId === parentId)
					.map(t => (
						<li key={t.id}>
							<button
								className={navClass(tag?.id === t.id) + " w-full"}
								onClick={() => select({ kind: "tag", id: t.id })}
							>
								<TagMark tag={t} />
							</button>
						</li>
					))}
			</ul>
		);
	}
	const single = selected.length === 1 ? library?.sources.find(s => s.id === selected[0]) : undefined;
	return (
		<div className="flex h-dvh flex-col bg-background">
			<TopBar>
				<TagsIcon size={17} />
				<span className="font-medium">Tags</span>
				<div className="ml-auto">
					<NotesImportControl importing={imports.importing} onImportFiles={imports.onImportFiles} />
				</div>
			</TopBar>
			<NotesImportErrors errors={imports.errors} />
			<NotesImportNotices notices={imports.notices} />
			{failure && (
				<p role="alert" className="p-3">
					{failure} <button onClick={() => void refresh()}>Retry</button>
				</p>
			)}
			<div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] md:grid-cols-[minmax(13rem,18rem)_1fr] md:grid-rows-1">
				<nav
					aria-label="Tag folders"
					className="max-h-[32vh] overflow-auto border-b p-4 md:max-h-none md:border-r md:border-b-0"
				>
					<button className={navClass(scope.kind === "all") + " w-full"} onClick={() => select({ kind: "all" })}>
						All material
					</button>
					{branch(null)}
					<div className="mt-5 flex flex-wrap gap-2">
						<button disabled={!library} className={tagControl} onClick={() => begin({ kind: "tag" })}>
							New tag
						</button>
						<button disabled={!library} className={tagControl} onClick={() => begin({ kind: "folder" })}>
							New folder
						</button>
					</div>
				</nav>
				<main className="min-w-0 overflow-auto p-4 md:p-7">
					<div className="mx-auto max-w-5xl">
						<div className="mb-4 flex flex-wrap items-center gap-2">
							<h1 className="mr-auto text-xl font-semibold">
								{tag ? <TagMark tag={tag} /> : (folder?.name ?? "All material")}
							</h1>
							{(tag || folder) && (
								<>
									<button
										className={tagControl}
										onClick={() =>
											tag
												? begin({ kind: "tag", tag })
												: begin({ kind: "folder", folder }, folder!.name, folder!.parentId)
										}
									>
										Edit {tag ? "tag" : "folder"}
									</button>
									<button
										className={tagControl}
										onClick={() => begin({ kind: "delete", item: (tag ?? folder)!, type: tag ? "tag" : "folder" })}
									>
										Remove
									</button>
								</>
							)}
						</div>
						<input
							className={tagInput}
							aria-label="Search sessions and notes"
							value={query}
							onChange={e => {
								setQuery(e.target.value);
								setSelected([]);
							}}
							placeholder="Search sessions, files, and notes…"
						/>
						{rows.length > 0 && (
							<div className="my-3 flex flex-wrap items-center gap-3 text-sm">
								<label className="flex items-center gap-2">
									<input
										type="checkbox"
										aria-label="Select all visible items"
										checked={rows.every(r => selected.includes(r.source.id))}
										onChange={e => setSelected(e.target.checked ? rows.map(r => r.source.id) : [])}
									/>
									{selected.length ? `${selected.length} selected` : "Select all"}
								</label>
								{selected.length > 0 && (
									<button className={tagControl} onClick={() => setTagging(true)}>
										Edit tags
									</button>
								)}
								{single && (
									<>
										<button
											className={tagControl}
											onClick={() =>
												begin({ kind: "move", id: single.id }, "", placementOf(org!, single.id)?.folderId)
											}
										>
											Move
										</button>
										<button
											className={tagControl}
											onClick={() => begin({ kind: "rename", id: single.id }, single.label ?? "")}
										>
											Rename
										</button>
									</>
								)}
							</div>
						)}
						{!library ? (
							<p className="mt-6 text-sm">Loading library…</p>
						) : (
							rows.length === 0 && (
								<p className="mt-6 text-sm text-muted-foreground">
									{query ? "No matching sessions, files, or notes." : "No material here yet."}
								</p>
							)
						)}
						<ul className="divide-y border-t">
							{rows.map(({ source, labels, notes, matches }) => (
								<li key={source.id} className="py-3">
									<div className="flex items-start gap-3">
										<input
											className="mt-1.5"
											type="checkbox"
											aria-label={`Select ${source.label}`}
											checked={selected.includes(source.id)}
											onChange={e =>
												setSelected(ids =>
													e.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id),
												)
											}
										/>
										<div className="min-w-0 flex-1">
											{source.kind === "chat" ? (
												<Link className="font-medium hover:underline" href={`/chat/${encodeURIComponent(source.id)}`}>
													{source.label}
												</Link>
											) : (
												<span className="font-medium">{source.label}</span>
											)}
											<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
												<span>
													{source.kind === "notes"
														? "Imported file"
														: source.chatKind === "practice"
															? "Practice"
															: "Teaching"}
												</span>
												{labels.map(t => (
													<button
														key={t.id}
														className="rounded border px-1.5 py-0.5"
														onClick={() => select({ kind: "tag", id: t.id })}
													>
														<TagMark tag={t} />
													</button>
												))}
											</div>
										</div>
										{notes[0] && (
											<Link className={tagControl} href={noteHref(source.id, notes[0].mode)}>
												{notes[0].mode === "final" ? "Open handout" : "Live notes"}
											</Link>
										)}
									</div>
									{matches.map(n => (
										<Link
											key={n.mode + n.sectionId}
											className="ml-7 mt-2 block rounded px-2 py-1 text-sm hover:bg-accent"
											href={noteHref(source.id, n.mode, n.sectionId)}
										>
											<strong dangerouslySetInnerHTML={{ __html: noteTextHtml(n.heading) }} />
											<span
												className="block overflow-hidden text-muted-foreground"
												dangerouslySetInnerHTML={{ __html: noteTextHtml(matchingPassage(n.text, query)) }}
											/>
										</Link>
									))}
								</li>
							))}
						</ul>
					</div>
				</main>
			</div>
			{tagging && <SourceTagDialog ids={selected} close={() => setTagging(false)} onSaved={() => void refresh()} />}
			{editor && library && (
				<LibraryDialog
					title={
						editor.kind === "tag"
							? editor.tag
								? "Edit tag"
								: "Create tag"
							: editor.kind === "folder"
								? editor.folder
									? "Edit folder"
									: "Create folder"
								: editor.kind === "delete"
									? `Remove ${editor.item.name}?`
									: editor.kind === "rename"
										? "Rename item"
										: "Move item"
					}
					close={() => setEditor(undefined)}
				>
					{editor.kind === "tag" ? (
						<TagEditor
							tag={editor.tag}
							directory={library}
							parentId={defaultParent}
							cancel={() => setEditor(undefined)}
							saved={(_, id) => {
								setEditor(undefined);
								select({ kind: "tag", id });
								void refresh();
							}}
						/>
					) : (
						<form
							className="grid gap-3"
							onSubmit={e => {
								e.preventDefault();
								void submit();
							}}
						>
							{(editor.kind === "rename" || editor.kind === "folder") && (
								<label>
									Name
									<input
										required
										autoFocus
										className={tagInput}
										value={name}
										onChange={e => setName(e.target.value)}
									/>
								</label>
							)}
							{(editor.kind === "move" || editor.kind === "folder") && (
								<label>
									Parent folder
									<select className={tagInput} value={parent} onChange={e => setParent(e.target.value)}>
										<FolderOptions
											state={library.organization}
											exclude={
												editor.kind === "folder" && editor.folder
													? library.organization.folders
															.filter(f => !canMoveFolder(library.organization, editor.folder!.id, f.id))
															.map(f => f.id)
													: []
											}
										/>
									</select>
								</label>
							)}
							{editor.kind === "delete" && (
								<p className="text-sm">
									{editor.type === "tag"
										? "Remove this label from all tagged items."
										: "Only empty folders can be removed."}
								</p>
							)}
							{editError && <p role="alert">{editError}</p>}
							<button className={tagControl} disabled={busy}>
								{editor.kind === "delete" ? "Remove" : "Save"}
							</button>
						</form>
					)}
				</LibraryDialog>
			)}
		</div>
	);
}
