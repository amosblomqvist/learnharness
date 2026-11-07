"use client";

import { useEffect, useState } from "react";
import { placementOf, type TagChanges, type SourceDirectory } from "@/src/core";
import { directoryRequest, LibraryDialog, TagChoices, TagMark, tagControl } from "./tag-picker";
import { notesPath } from "./notes-import-queue";

export function ImportTagDialog({
	files,
	submit,
	close,
}: {
	files: File[];
	submit: (tags: ReadonlyMap<File, TagChanges>) => void;
	close: () => void;
}) {
	const [dir, setDir] = useState<SourceDirectory>(),
		[failure, setFailure] = useState("");
	const [changes, setChanges] = useState<Map<File, Record<string, boolean>>>(new Map());
	const [editing, setEditing] = useState<File | null>(null);
	useEffect(() => {
		let mounted = true;
		void directoryRequest()
			.then(d => {
				if (mounted) setDir(d);
			})
			.catch(e => {
				if (mounted) setFailure(e.message);
			});
		return () => {
			mounted = false;
		};
	}, []);
	const targets = editing ? [editing] : files;
	const tags = dir?.organization.tags ?? [];
	const existing = new Map(
		dir?.sources
			.filter(s => s.kind === "notes" && s.filePath)
			.map(s => [s.filePath!, placementOf(dir.organization, s.id)?.tagIds ?? []]),
	);
	const checkedFor = (file: File, id: string) =>
		changes.get(file)?.[id] ?? existing.get(notesPath(file))?.includes(id) ?? false;
	const count = (id: string) => targets.filter(file => checkedFor(file, id)).length;
	function submitChanges() {
		const pending = new Map<File, TagChanges>();
		for (const [file, edits] of changes) {
			const ids = Object.keys(edits);
			pending.set(file, { add: ids.filter(id => edits[id]), remove: ids.filter(id => !edits[id]) });
		}
		submit(pending);
	}
	function toggle(id: string, checked: boolean) {
		setChanges(current => {
			const next = new Map(current);
			for (const file of targets) {
				next.set(file, { ...next.get(file), [id]: checked });
			}
			return next;
		});
	}
	return (
		<LibraryDialog title="Tag imported files" close={close}>
			<div className="mb-2 flex items-center justify-between gap-2">
				<strong className="break-all text-sm">{editing ? notesPath(editing) : "Tags for all files"}</strong>
				{editing && (
					<button className={tagControl} onClick={() => setEditing(null)}>
						Back to all files
					</button>
				)}
			</div>
			{dir && (
				<TagChoices
					directory={dir}
					onDirectory={setDir}
					selected={tags.filter(t => count(t.id) === targets.length).map(t => t.id)}
					mixed={tags.filter(t => count(t.id) > 0 && count(t.id) < targets.length).map(t => t.id)}
					toggle={toggle}
				/>
			)}
			{failure && <p role="alert">{failure}</p>}
			{!editing && (
				<ul className="my-3 max-h-52 divide-y overflow-auto border-y">
					{files.map((file, i) => (
						<li key={i}>
							<button
								className="flex w-full items-center gap-2 px-1 py-2 text-left text-sm hover:bg-accent"
								onClick={() => setEditing(file)}
							>
								<span className="mr-auto break-all">{notesPath(file)}</span>
								<span className="flex flex-wrap gap-1 text-xs">
									{tags
										.filter(t => checkedFor(file, t.id))
										.map(t => (
											<TagMark key={t.id} tag={t} />
										))}
								</span>
								<span className="text-xs text-muted-foreground">Edit</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<button type="button" className={tagControl + " mt-3"} onClick={submitChanges}>
				Import {files.length === 1 ? "file" : `${files.length} files`}
			</button>
		</LibraryDialog>
	);
}
