"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PaperclipIcon } from "lucide-react";
import { quoteFilePath } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";

/** Picked files → the rooted paths an editor chips (issue #285), via the
 *  desktop bridge. Same validity rule as drops: a file without a usable
 *  path is skipped, never guessed. */
export function pathsForFiles(files: Iterable<File>, resolve: (file: File) => string): { paths: string[]; skipped: number } {
	const paths: string[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const path = resolve(file);
			quoteFilePath(path);
			paths.push(path);
		} catch { skipped++; }
	}
	return { paths, skipped };
}

const noSubscribe = () => () => {};
/** The bridge is fixed for the window's life; the server render is always
 *  the browser case, so hydration never mismatches. */
function useDesktopPaths(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

/**
 * The attach button (issue #285): the picker's twin of a file drop — files
 * stay where they are and only their quoted paths enter the draft, at the
 * caret of `editorRef` (a PathInput root). Any file type; the agent reads
 * what it can. Desktop only: a browser File has no local path, so there the
 * button explains instead (the drop zone's notice). The separate native
 * folder choice returns the directory itself, including an empty directory.
 * aria-disabled, not disabled, so the tooltip still shows.
 */
export function AttachFilesButton({ editorRef }: { editorRef: React.RefObject<HTMLDivElement | null> }) {
	const pickerRef = useRef<HTMLInputElement>(null);
	const desktop = useDesktopPaths();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const choosingFolder = useRef(false);
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState("");
	useEffect(() => { if (open) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open]);
	const chooseFolder = async () => {
		if (choosingFolder.current) return;
		const editor = editorRef.current;
		const choose = window.lh?.chooseAttachmentFolder;
		setOpen(false);
		setNotice("");
		if (!choose) { setNotice(BROWSER_NOTICE); return; }
		choosingFolder.current = true;
		try {
			const path = await choose();
			if (path === null) return; // Native cancellation leaves the draft intact.
			quoteFilePath(path);
			if (editor?.isConnected && editor === editorRef.current) editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: [path] }));
		} catch { setNotice("Could not choose a folder. Try again."); }
		finally { choosingFolder.current = false; }
	};
	return (
		<div className="relative shrink-0"
			onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
			onKeyDown={(event) => {
				if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); }
			}}>
			<input
				ref={pickerRef}
				type="file"
				multiple
				hidden
				data-testid="attach-files-input"
				onChange={(e) => {
					const resolve = window.lh?.getPathForFile;
					const { paths } = resolve ? pathsForFiles(Array.from(e.currentTarget.files ?? []), resolve) : { paths: [] };
					if (paths.length > 0) editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
					e.currentTarget.value = ""; // allow re-picking the same file
				}}
			/>
			<Hint label={desktop ? "Attach files or a folder" : BROWSER_NOTICE}>
				<button
					ref={buttonRef}
					type="button"
					aria-label="Attach files"
					aria-disabled={!desktop}
					aria-haspopup="menu"
					aria-expanded={open}
					data-testid="attach-files"
					onClick={() => { if (desktop) { setNotice(""); setOpen(!open); } }}
					className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
				>
					<PaperclipIcon className="size-4" />
				</button>
			</Hint>
			{open && <div ref={menuRef} role="menu" aria-label="Attach files or a folder"
				className="absolute bottom-full right-0 z-50 mb-1 min-w-32 rounded-lg border bg-card p-1 shadow-lg"
				onKeyDown={(event) => {
					const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
					if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
				}}>
				<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
					onClick={() => { setOpen(false); pickerRef.current?.click(); }}>Files</button>
				<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
					onClick={() => { void chooseFolder(); }}>Folder</button>
			</div>}
			{notice && <div role="status" className="absolute bottom-full right-0 z-50 mb-1 w-64 rounded-lg border bg-card p-2 text-xs text-muted-foreground shadow-lg">{notice}</div>}
		</div>
	);
}
