"use client";
import { useEffect, useRef, useState } from "react";
import type { AuthKeyStatus } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { ProviderMenuList } from "./model-menu";

/** One pi-ai provider with plain API-key auth (the Platform seam —
 *  derived from pi-ai's own env-key table; no drift possible). */
export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
}

/** The minimal status line, e.g. "…ab12 · 64 chars" (" · env" marks an
 *  environment-owned value — the row itself is read-only then). Pure. */
export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}

/** One table row: label left, tiny docs link + status right. Writable
 *  rows click-unfold an editor beneath (owner interaction); env-owned
 *  rows are dimmed and read-only (a paste box there would mislead). */
export function KeyTableRow({
	label,
	docsUrl,
	status,
	expanded,
	onToggle,
	onSave,
	onDelete,
	onCancel,
	testid,
}: {
	label: string;
	/** The "Get a key ↗" target — curated keys carry one. */
	docsUrl?: string;
	status: AuthKeyStatus;
	expanded: boolean;
	onToggle: () => void;
	onSave: (value: string) => Promise<string | null>;
	onDelete?: () => Promise<void>;
	/** Folds the editor (owner, fix wave: the way OUT of a paste prompt
	 *  must be visible — Cancel beside Save/Delete, not only Esc). */
	onCancel: () => void;
	testid: string;
}) {
	const envOwned = status.source === "env";
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save() {
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		const err = await onSave(value);
		if (err) setError(err);
		else setValue("");
		setBusy(false);
	}

	// INLINE editing (owner, fix wave: "type the keys in line — more
	// table-like"): the expanded row becomes the editor itself — label
	// left, the paste field filling the middle, Save | Cancel (| Delete)
	// right — instead of a second line beneath the row.
	if (expanded && !envOwned) {
		return (
			<div data-testid={testid}>
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`${testid}-editor`}>
					<span className="shrink-0 font-ui text-xs text-foreground">{label}</span>
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
						}}
						placeholder="Paste key…"
						aria-label={`${label} key`}
						data-testid={`${testid}-input`}
						disabled={busy}
						autoFocus
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
					/>
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !value.trim()}
						data-testid={`${testid}-save`}
						className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						data-testid={`${testid}-cancel`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Cancel
					</button>
					{status.present && status.source === "file" && onDelete && (
						<button
							type="button"
							onClick={() => void onDelete()}
							disabled={busy}
							data-testid={`${testid}-delete`}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Delete
						</button>
					)}
				</div>
				{error && (
					<p role="alert" data-testid={`${testid}-error`} className="px-1 text-xs text-red-500">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div data-testid={testid} className={envOwned ? "opacity-40" : undefined}>
			<button
				type="button"
				aria-expanded={expanded}
				data-testid={`${testid}-row`}
				onClick={() => !envOwned && onToggle()}
				className={`flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left ${
					envOwned ? "cursor-default" : "cursor-pointer transition-colors hover:bg-accent/50"
				}`}
			>
				<span className="font-ui text-xs text-foreground">{label}</span>
				<span className="flex items-center gap-2">
					{docsUrl && (
						<a
							href={docsUrl}
							target="_blank"
							rel="noreferrer"
							onClick={(e) => e.stopPropagation()}
							className="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
						>
							key ↗
						</a>
					)}
					<span data-testid={`${testid}-status`} className="font-mono text-[11px] text-muted-foreground">
						{keyStatusLine(status)}
					</span>
				</span>
			</button>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="pl-6 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}

/** The Add-provider control — the table's last row, the app's shared
 *  dropdown look (portaled menu, the search + arrow-walk machine). */
export function AddProviderRow({
	addable,
	onPick,
	testid = "add-provider",
	disabled = false,
}: {
	addable: ProviderKeyInfo[];
	onPick: (p: ProviderKeyInfo) => void;
	testid?: string;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);
	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) setOpen(false);
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

	return (
		<div ref={anchorRef} className="relative">
			<button
				type="button"
				aria-expanded={open}
				data-testid={testid}
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
			>
				<span>+ Add a provider</span>
				{addable.length > 0 && <span className="font-mono text-[11px]">{addable.length}</span>}
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid={`${testid}-menu`}
					preferredSide="down"
					menuClass="flex w-72 flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
				>
					{/* Close on pick (owner, fix wave): a chosen provider ends
					    the dropdown — the paste row is the next step. */}
					<ProviderMenuList
						providers={addable}
						onPick={(p) => {
							setOpen(false);
							onPick(p);
						}}
					/>
				</MenuShell>
			)}
		</div>
	);
}
