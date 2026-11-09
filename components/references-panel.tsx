"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookMarkedIcon, FileTextIcon, GlobeIcon, PlusIcon, XIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { pathsForFiles } from "@/components/attach-files-button";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { filePathLabel, type SessionReference } from "@/src/core";

/**
 * THE SESSION REFERENCE SHELF (issue #63): a small header chip + panel —
 * the Plan chip's interaction language (a top-bar chip opening a popup),
 * the attach button's file-picking language (paths stay in place, nothing
 * uploads). References ground ALL of the session's agents (the per-turn
 * prompt segment); they are mutable during the session's life and take
 * effect on the next turn, like a model change.
 *
 * Distinct by design from the composer's per-message paperclip (a path
 * quoted into ONE message) and from graph notes-import (bulk extraction
 * into the knowledge graph) — see docs/getting-started.md. This panel is
 * grounding only: no upload, no graph import, no curriculum definition.
 */

/** One entry's display label: the optional name, else the file's short
 *  label / the raw URL (title carries the full value either way). */
export function referenceLabel(reference: SessionReference): string {
	if (reference.name) return reference.name;
	return reference.kind === "file" ? filePathLabel(reference.value) : reference.value;
}

async function putReferences(chatId: string, references: SessionReference[]): Promise<SessionReference[]> {
	const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/references`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ references }),
	});
	const body = (await res.json().catch(() => null)) as { references?: SessionReference[]; error?: string } | null;
	if (!res.ok || !body?.references) throw new Error(body?.error ?? `Could not save references (${res.status})`);
	return body.references;
}

export function ReferencesChip({ chatId, initialReferences }: { chatId: string; initialReferences?: SessionReference[] }) {
	const [references, setReferences] = useState<SessionReference[]>(initialReferences ?? []);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const [urlDraft, setUrlDraft] = useState("");
	const buttonRef = useRef<HTMLButtonElement>(null);
	const pickerRef = useRef<HTMLInputElement>(null);

	/** Replace-whole save (the settings-PUT convention); the response's
	 *  sanitized list is the new local truth, a failure keeps the old list
	 *  and shows the server's wording (e.g. a protected file path). */
	const save = useCallback(
		async (next: SessionReference[]) => {
			try {
				setReferences(await putReferences(chatId, next));
				setError("");
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not save references");
			}
		},
		[chatId],
	);

	// The menu contract (the sidebar context menu's): pointerdown outside
	// the chip or the portaled menu closes it; Esc is CLAIMED so it never
	// also aborts a turn. The panel only mounts client-side, so the
	// window reads below never run during SSR.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (buttonRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	/** Add picked files — the attach button's twin: paths resolve through
	 *  the desktop bridge, stay in place, and skip duplicates. */
	const addPicked = (files: File[]) => {
		const resolve = window.lh?.getPathForFile;
		if (!resolve) {
			setError(BROWSER_NOTICE);
			return;
		}
		const now = new Date().toISOString();
		const fresh = pathsForFiles(files, resolve).paths
			.filter((value) => !references.some((r) => r.kind === "file" && r.value === value))
			.map((value) => ({ id: crypto.randomUUID(), kind: "file" as const, value, addedAt: now }));
		if (fresh.length === 0) {
			setError("That file is already on the shelf.");
			return;
		}
		void save([...references, ...fresh]);
	};

	const addUrl = () => {
		const value = urlDraft.trim();
		if (!value) return;
		if (references.some((r) => r.kind === "url" && r.value === value)) {
			setError("That URL is already on the shelf.");
			return;
		}
		setUrlDraft("");
		void save([...references, { id: crypto.randomUUID(), kind: "url", value, addedAt: new Date().toISOString() }]);
	};

	const remove = (id: string) => {
		void save(references.filter((r) => r.id !== id));
	};

	return (
		<div className="shrink-0">
			<input
				ref={pickerRef}
				type="file"
				multiple
				hidden
				data-testid="references-file-input"
				onChange={(e) => {
					addPicked(Array.from(e.currentTarget.files ?? []));
					e.currentTarget.value = ""; // allow re-picking the same file
				}}
			/>
			<Hint label="Reference materials grounding this session" side="bottom">
				<button
					type="button"
					data-testid="references-chip"
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={(e) => {
						blurAfterPointerClick(e);
						setError("");
						setOpen(!open);
					}}
					className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				>
					<BookMarkedIcon className="size-3.5 text-primary" aria-hidden />
					References{references.length > 0 ? ` · ${references.length}` : ""}
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={buttonRef}
					testid="references-panel"
					preferredSide="down"
					menuClass="flex w-80 flex-col gap-2 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<div className="font-medium text-foreground">Session references</div>
					<p className="text-muted-foreground">
						Added here, the agents consult these while teaching — the next reply uses a change.
					</p>
					{references.length === 0 ? (
						<p data-testid="references-empty" className="rounded-lg border border-dashed border-border/70 p-2 text-muted-foreground">
							No references yet. To ground a single message instead, attach a file path with the
							composer&apos;s paperclip.
						</p>
					) : (
						<ul className="flex flex-col gap-1" data-testid="references-list">
							{references.map((reference) => (
								<li key={reference.id} className="flex items-center gap-1.5 rounded-lg px-1 py-1 hover:bg-accent/50">
									{reference.kind === "file" ? (
										<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
									) : (
										<GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
									)}
									<span className="min-w-0 flex-1 truncate text-foreground" title={reference.value}>
										{referenceLabel(reference)}
									</span>
									<button
										type="button"
										data-testid={`references-remove-${reference.id}`}
										aria-label={`Remove ${referenceLabel(reference)}`}
										onClick={() => remove(reference.id)}
										className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
									>
										<XIcon className="size-3" aria-hidden />
									</button>
								</li>
							))}
						</ul>
					)}
					<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							data-testid="references-add-file"
							onClick={() => pickerRef.current?.click()}
							className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<PlusIcon className="size-3" aria-hidden />
							Add file…
						</button>
					</div>
					<div className="flex items-center gap-1.5">
						<input
							data-testid="references-url-input"
							value={urlDraft}
							onChange={(e) => setUrlDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addUrl();
								}
							}}
							placeholder="https://… (article, docs, paper)"
							spellCheck={false}
							className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1 outline-none focus:border-border"
						/>
						<button
							type="button"
							data-testid="references-add-url"
							disabled={urlDraft.trim() === ""}
							onClick={addUrl}
							className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
						>
							<PlusIcon className="size-3" aria-hidden />
							Add URL
						</button>
					</div>
					{error && (
						<p data-testid="references-error" role="alert" className="text-destructive">
							{error}
						</p>
					)}
				</MenuShell>
			)}
		</div>
	);
}
