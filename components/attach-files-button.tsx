"use client";

import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PaperclipIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";
import { InteractionLayerOwner, useInteractionLayer, useInteractionLayers, useOptionalInteractionLayers } from "./interaction-layers";
import { INTERACTION_LAYER_Z_BASE } from "./host-dialog";
import { isInteractionScopeEligible } from "./plugin-input-focus";

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

/** Center over the paperclip, but clear the whole visible composer, not just
 * its bottom-aligned button. Clamp horizontally and scroll above the dock. */
export function attachmentPopupPlacement(button: { left: number; right: number }, composer: { top: number }, popupWidth: number, viewport: { width: number; height: number }) {
	const edge = 8;
	const gap = 4;
	const maxWidth = Math.max(0, viewport.width - edge * 2);
	const width = Math.min(popupWidth, maxWidth);
	return {
		left: Math.max(edge, Math.min((button.left + button.right - width) / 2, viewport.width - edge - width)),
		bottom: viewport.height - composer.top + gap,
		maxWidth,
		maxHeight: Math.max(0, Math.min(viewport.height * 0.6, composer.top - gap - edge)),
	};
}

const noSubscribe = () => () => {};
/** The bridge is fixed for the window's life; the server render is always
 *  the browser case, so hydration never mismatches. */
function useDesktopPaths(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

/** The choice menu owns Escape with the same layer law as MenuShell, while
 * retaining its paperclip/composer-specific geometry. Mount separately so a
 * closed button remains safe in standalone/static renders. Notices are passive. */
function AttachmentPopup({ anchorRef, rootRef, open, close, children }: {
	anchorRef: RefObject<HTMLButtonElement | null>; rootRef: RefObject<HTMLDivElement | null>;
	open: boolean; close(): void; children: ReactElement<{ style?: CSSProperties }>;
}) {
	const controller = useInteractionLayers();
	const owner = controller.ownerOf(anchorRef.current);
	const layer = useInteractionLayer({ kind: "popup", enabled: open, rootRef, anchorRef, ownerId: owner?.id,
		onClose: reason => {
			close();
			if (reason === "escape" && controller.isPopupOrigin(anchorRef.current)) anchorRef.current?.focus();
			return "closed";
		},
	});
	const portal = controller.getPortalContainer(anchorRef.current, owner?.id);
	if (!portal) return null;
	return createPortal(<InteractionLayerOwner.Provider value={open ? layer.id : owner?.id ?? null}>
		{cloneElement(children, { style: { ...children.props.style, zIndex: INTERACTION_LAYER_Z_BASE + (open ? layer.order : owner?.order ?? 0) } })}
	</InteractionLayerOwner.Provider>, portal);
}

/**
 * The attach button (issue #285): files become quoted path chips at the caret
 * of `editorRef` (a PathInput root). Two sources, one chip shape:
 *  - desktop: the files stay where they are; the bridge resolves their paths.
 *  - browser (web build, 2026-11-11): a File has no path, so the bytes are
 *    POSTed to /api/attachments, stored in the app data dir, and the returned
 *    server paths are chipped. Folder uploads keep their relative path.
 * Any file type; the agent reads what it can. aria-disabled, not disabled, so
 * the tooltip still shows while an upload is in flight.
 */
export function AttachFilesButton({ editorRef }: { editorRef: React.RefObject<HTMLDivElement | null> }) {
	const controller = useOptionalInteractionLayers();
	const pickerRef = useRef<HTMLInputElement>(null);
	const desktop = useDesktopPaths();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const choosingFolder = useRef(false);
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState("");
	const [uploading, setUploading] = useState(false);
	const folderRef = useRef<HTMLInputElement>(null);
	const [placement, setPlacement] = useState<ReturnType<typeof attachmentPopupPlacement> | null>(null);
	const positioned = placement !== null;
	// Like MenuShell, portal to body with viewport-capped, reanchored placement.
	// The production chat/new-session docks deliberately clip their children.
	// Keep notice focus passive; only the choice menu takes keyboard focus.
	useLayoutEffect(() => {
		if (!open && !notice) { setPlacement(null); return; }
		const button = buttonRef.current;
		const popup = popupRef.current;
		if (!button || !popup) return;
		const composer = button.closest<HTMLElement>("[data-attachment-composer]") ?? button;
		const place = () => {
			setPlacement(attachmentPopupPlacement(button.getBoundingClientRect(), composer.getBoundingClientRect(),
				popup.getBoundingClientRect().width, { width: window.innerWidth, height: window.innerHeight }));
		};
		place();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
		observer?.observe(composer);
		observer?.observe(popup);
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => { observer?.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
	}, [open, notice]);
	useEffect(() => { if (open && positioned && isInteractionScopeEligible(popupRef.current, controller)) popupRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open, positioned, controller]);
	useEffect(() => {
		if (!open && !notice) return;
		const dismissOutside = (event: PointerEvent) => {
			if (isInteractionScopeEligible(popupRef.current, controller) && event.target instanceof Node && !popupRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) {
				setOpen(false); setNotice("");
			}
		};
		document.addEventListener("pointerdown", dismissOutside);
		return () => document.removeEventListener("pointerdown", dismissOutside);
	}, [open, notice, controller]);
	const handlePicked = async (files: FileList | null) => {
		const list = Array.from(files ?? []);
		if (list.length === 0) return;
		if (desktop) {
			const resolve = window.lh?.getPathForFile;
			const { paths } = resolve ? pathsForFiles(list, resolve) : { paths: [] };
			if (paths.length > 0) editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			return;
		}
		// Web build: no local path exists, so copy the bytes to the server and
		// chip the paths it answers with (folder uploads keep their relative path).
		setOpen(false);
		setNotice("");
		setUploading(true);
		try {
			const form = new FormData();
			for (const file of list) form.append("files", file, file.name);
			form.append("paths", JSON.stringify(list.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)));
			const response = await fetch("/api/attachments", { method: "POST", body: form });
			const payload = (await response.json().catch(() => null)) as { paths?: string[]; error?: string; skipped?: number } | null;
			const paths = payload?.paths ?? [];
			if (!response.ok || paths.length === 0) {
				setNotice(payload?.error ?? "Upload failed. Try again.");
				return;
			}
			editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			if (payload?.skipped) setNotice(`${payload.skipped} file${payload.skipped === 1 ? "" : "s"} skipped.`);
		} catch {
			setNotice("Upload failed. Try again.");
		} finally {
			setUploading(false);
		}
	};
	const chooseFolder = async () => {
		if (choosingFolder.current) return;
		const editor = editorRef.current;
		const choose = window.lh?.chooseAttachmentFolder;
		setOpen(false);
		setNotice("");
		if (!choose) { setNotice(BROWSER_NOTICE); return; }
		choosingFolder.current = true;
		try {
			const chosen = await choose();
			if (chosen === null) return; // Native cancellation leaves the draft intact.
			const path = directoryReferencePath(chosen);
			if (editor?.isConnected && editor === editorRef.current) editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: [path] }));
		} catch { setNotice("Could not choose a folder. Try again."); }
		finally { choosingFolder.current = false; }
	};
	return (
		<div className="relative shrink-0"
			onBlur={(event) => { if (isInteractionScopeEligible(popupRef.current ?? buttonRef.current, controller) && !event.currentTarget.contains(event.relatedTarget) && !popupRef.current?.contains(event.relatedTarget)) setOpen(false); }}>
			<input
				ref={pickerRef}
				type="file"
				multiple
				hidden
				data-testid="attach-files-input"
				onChange={(e) => { void handlePicked(e.currentTarget.files); }}
			/>
			<input
				ref={folderRef}
				type="file"
				multiple
				hidden
				data-testid="attach-folder-input"
				{...{ webkitdirectory: "" }}
				onChange={(e) => { void handlePicked(e.currentTarget.files); }}
			/>
			<Hint label={uploading ? "Uploading…" : desktop ? "Attach files or a folder" : "Upload files or a folder"}>
				<button
					ref={buttonRef}
					type="button"
					aria-label="Attach files"
					aria-disabled={uploading}
					aria-haspopup="menu"
					aria-expanded={open}
					data-testid="attach-files"
					onClick={() => { if (!uploading) { setNotice(""); setOpen(!open); } }}
					className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
				>
					<PaperclipIcon className="size-4" />
				</button>
			</Hint>
			{(open || notice) && <AttachmentPopup anchorRef={buttonRef} rootRef={popupRef} open={open} close={() => setOpen(false)}><div ref={popupRef} role={open ? "menu" : "status"}
				aria-label={open ? "Attach files or a folder" : undefined}
				data-testid="attachment-popup"
				style={{ position: "fixed", zIndex: 60, ...(placement ?? { left: 0, top: 0, visibility: "hidden" }), overflowY: "auto" }}
				className={open ? "w-max rounded-lg border bg-card p-1 shadow-lg" : "w-64 rounded-lg border bg-card p-2 text-xs text-muted-foreground shadow-lg"}
				onKeyDown={(event) => {
					const buttons = Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
					if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
				}}>
				{open ? <>
					<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); pickerRef.current?.click(); }}>Files</button>
					<button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => { setOpen(false); if (desktop) void chooseFolder(); else folderRef.current?.click(); }}>Folder</button>
					{!desktop && <div className="px-2 pb-1 pt-1 text-[10px] leading-snug text-muted-foreground">Uploads a copy to the server; the agent reads it from there.</div>}
				</> : notice}
			</div></AttachmentPopup>}
		</div>
	);
}
