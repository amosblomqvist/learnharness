"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { CloseOutcome } from "@/components/interaction-layers";
import { Button } from "@/components/ui/button";
import { PromptText } from "./prompt-text";

export type PromptSaveOutcome = "saved" | "save-failed" | "activation-failed";

export function PromptSegmentDialog({ path, source, override, mode, onSave, onDelete, onClose }: {
	path: string;
	source: string;
	override: string | null;
	mode: "view" | "edit";
	onSave: (text: string, writeText: boolean) => Promise<PromptSaveOutcome>;
	onDelete: () => Promise<boolean>;
	onClose: () => void;
}) {
	const editing = mode === "edit";
	const [savedText, setSavedText] = useState(override);
	const [text, setText] = useState(editing ? override ?? source : source);
	const [preview, setPreview] = useState(!editing);
	const [busy, setBusy] = useState<"save" | "delete" | null>(null);
	const pending = useRef(false);
	const [activationFailed, setActivationFailed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const keepEditing = useRef<HTMLButtonElement>(null);
	const returningToDraft = useRef(false);
	const closeButton = useRef<HTMLButtonElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const titleId = useId(), pathId = useId();
	const dirty = editing && text !== (savedText ?? source);
	const title = !editing ? "View default" : savedText === null ? "Add override" : "Edit override";

	useLayoutEffect(() => {
		if (confirmDiscard) keepEditing.current?.focus();
		else if (returningToDraft.current) {
			returningToDraft.current = false;
			(preview ? closeButton.current : field.current)?.focus();
		}
	}, [confirmDiscard, preview]);

	function resumeEditing() {
		returningToDraft.current = true;
		setConfirmDiscard(false);
	}

	function requestClose(): CloseOutcome {
		if (pending.current) return "blocked";
		if (confirmDiscard) {
			resumeEditing();
			return "handled-without-close";
		}
		if (dirty) {
			setConfirmDiscard(true);
			return "handled-without-close";
		}
		onClose();
		return "closed";
	}

	async function save() {
		if (pending.current || (!dirty && !activationFailed)) return;
		pending.current = true;
		setBusy("save");
		setError(null);
		try {
			const result = await onSave(text, dirty);
			if (result === "saved") onClose();
			else if (result === "activation-failed") {
				setSavedText(text);
				setActivationFailed(true);
				setError("Override saved, but it couldn't be put in use. Retry activation below.");
			} else setError("Couldn't save the override. Your edits are still here.");
		} finally {
			pending.current = false;
			setBusy(null);
		}
	}

	async function remove() {
		if (pending.current || savedText === null || dirty) return;
		pending.current = true;
		setBusy("delete");
		setError(null);
		try {
			if (await onDelete()) onClose();
			else setError("Couldn't delete the override.");
		} finally {
			pending.current = false;
			setBusy(null);
		}
	}

	return <HostDialog open onClose={requestClose} aria-labelledby={titleId} aria-describedby={pathId}
		backdropProps={{ className: "fixed inset-0 flex items-center justify-center bg-background/80" }}
		frame={<div aria-busy={busy !== null} data-testid="prompt-segment-dialog" className="settings-dialog-pop mx-4 flex h-[720px] max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-border bg-card font-ui shadow-xl" />}>
		<header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
			<div className="min-w-0">
				<h2 id={titleId} className="text-sm font-semibold">{title}</h2>
				<p id={pathId} className="mt-0.5 break-all text-xs text-muted-foreground">{path}</p>
			</div>
			<div className="flex items-center gap-1" role="group" aria-label="Prompt display">
				<Button type="button" size="xs" variant="outline" className="aria-pressed:underline underline-offset-4" aria-pressed={!preview} disabled={confirmDiscard} onClick={() => setPreview(false)}>Markdown</Button>
				<Button type="button" size="xs" variant="outline" className="aria-pressed:underline underline-offset-4" aria-pressed={preview} disabled={confirmDiscard} onClick={() => setPreview(true)}>Preview</Button>
			</div>
		</header>
		<div className="flex min-h-0 flex-1 flex-col px-4 pt-4" inert={confirmDiscard}>
			<PromptText text={text} preview={preview} fieldRef={field} onChange={editing ? setText : undefined} busy={busy !== null} />
		</div>
		<footer className="flex shrink-0 flex-col gap-2 px-4 py-3">
			{error && <p role="alert" className="text-xs text-error">{error}</p>}
			{confirmDiscard ? <div className="flex flex-wrap items-center justify-between gap-2">
				<p role="status" className="text-xs">Discard unsaved changes?</p>
				<div className="ml-auto flex gap-2">
					<Button ref={keepEditing} type="button" variant="outline" size="sm" onClick={resumeEditing}>Keep editing</Button>
					<Button type="button" variant="destructive" size="sm" onClick={onClose}>Discard changes</Button>
				</div>
			</div> : <div className="flex flex-wrap items-center justify-between gap-2">
				{editing && savedText !== null && <Button type="button" variant="ghost" size="sm" className="text-error hover:text-error" disabled={busy !== null || dirty} onClick={() => void remove()}>{busy === "delete" ? "Deleting…" : "Delete override"}</Button>}
				<div className="ml-auto flex gap-2">
					<Button ref={closeButton} type="button" variant="outline" size="sm" disabled={busy !== null} onClick={requestClose}>Close</Button>
					{editing && <Button type="button" size="sm" disabled={busy !== null || (!dirty && !activationFailed)} onClick={() => void save()}>
						{busy === "save" ? "Saving…" : activationFailed && !dirty ? "Retry activation" : "Save and activate"}
					</Button>}
				</div>
			</div>}
		</footer>
	</HostDialog>;
}
