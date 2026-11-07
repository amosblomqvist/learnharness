"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, DownloadIcon, Maximize2Icon, Minimize2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import {
	emptyNotesView,
	noteDocumentHtml,
	noteHref,
	type NoteIndexEntry,
	type NoteMode,
	type NotesView,
} from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";

const control =
	"inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-45";
const actionRow = "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs";
const textControl =
	"inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm py-1 text-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:no-underline";
const secondaryControl = textControl + " ml-auto text-muted-foreground hover:text-foreground";
export function useSessionNotes(chatId: string) {
	const [view, setView] = useState<NotesView>(emptyNotesView);
	const [error, setError] = useState(""),
		[sending, setSending] = useState(false);
	const [actionErrors, setActionErrors] = useState<Partial<Record<NoteMode, string>>>({});
	const sequence = useRef(0);
	const url = `/api/chats/${encodeURIComponent(chatId)}/notes`;
	const refresh = useCallback(async () => {
		const version = ++sequence.current;
		try {
			const r = await fetch(url, { cache: "no-store" });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			if (version === sequence.current) {
				setView(data);
				setError("");
			}
		} catch (e) {
			if (version === sequence.current) setError((e as Error).message);
		}
	}, [url]);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	useServerResync(refresh);
	useServerEvent("chats-changed", refresh);
	useServerEvent("notes-changed", e => {
		if (e.chatId === chatId) void refresh();
	});
	useServerEvent("turn-settled", e => {
		if (e.chatId === chatId) void refresh();
	});
	async function action(input: { action: "generate" | "retry-pdf" | "update-live" } | { action: "set-live"; enabled: boolean }) {
		const mode = input.action === "set-live" || input.action === "update-live" ? "live" : "final";
		setSending(true);
		setError("");
		setActionErrors(previous => ({ ...previous, [mode]: undefined }));
		try {
			const r = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!r.ok) throw new Error((await r.json()).error);
			await refresh();
		} catch (e) {
			setActionErrors(previous => ({ ...previous, [mode]: (e as Error).message }));
		} finally {
			setSending(false);
		}
	}
	return { view, error, actionErrors, sending, action };
}
export interface NoteLocation {
	mode: NoteMode;
	sectionId?: string;
}
export function NotesPanel({
	chatId,
	notes,
	location,
	navigate,
	close,
}: {
	chatId: string;
	notes: ReturnType<typeof useSessionNotes>;
	location: NoteLocation;
	navigate: (next: NoteLocation) => void;
	close: () => void;
}) {
	const { view } = notes;
	const [expanded, setExpanded] = useState(false);
	const article = useRef<HTMLDivElement>(null);
	const edition = view[location.mode];
	const running = view.running.includes(location.mode);
	const error = notes.error || notes.actionErrors[location.mode] || (!running && view.error[location.mode]);
	const usage = view.usage.find(u => u.mode === location.mode);
	const html = useMemo(() => (edition ? noteDocumentHtml(edition.document) : ""), [edition]);
	useEffect(() => {
		const target = location.sectionId && article.current?.ownerDocument.getElementById("notes-" + location.sectionId);
		if (target && article.current?.contains(target)) target.scrollIntoView({ block: "start" });
	}, [location.sectionId, html]);
	return (
		<aside
			aria-label="Session notes"
			className={`notes-panel ${expanded ? "notes-expanded" : ""} flex min-h-0 flex-col border-l bg-background`}
		>
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<BookOpenIcon className="size-4" />
				<h2 className="mr-auto text-sm font-semibold">Notes</h2>
				<button
					className={control + " notes-expand-control"}
					aria-label={expanded ? "Return to side panel" : "Expand notes"}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? <Minimize2Icon size={15} /> : <Maximize2Icon size={15} />}
				</button>
				<button className={control} aria-label="Close notes" onClick={close}>
					<XIcon size={15} />
				</button>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-b p-3">
				<button
					className={control}
					aria-pressed={location.mode === "final"}
					onClick={() => navigate({ mode: "final" })}
				>
					Handout
				</button>
				<button
					className={control}
					aria-pressed={location.mode === "live"}
					onClick={() => navigate({ mode: "live" })}
				>
					Live notes
				</button>
			</div>
			{location.mode === "final" ? (
				<div className="space-y-2 px-3 pt-3">
					<div className={actionRow}>
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
							<button
								type="button"
								className={textControl + " text-foreground"}
								disabled={notes.sending || running || !view.eligible}
								onClick={() => void notes.action({ action: "generate" })}
							>
								{view.final ? "Regenerate handout" : "Generate handout"}
							</button>
							{view.pdfPending && !running && (
								<button type="button" className={textControl + " text-foreground"} disabled={notes.sending} onClick={() => void notes.action({ action: "retry-pdf" })}>
									Retry handout PDF
								</button>
							)}
						</div>
						{view.final && (
							<a className={secondaryControl} href={`/api/chats/${encodeURIComponent(chatId)}/notes/pdf`} download>
								<DownloadIcon size={13} aria-hidden="true" />
								Download handout PDF
							</a>
						)}
					</div>
					<p className="text-xs text-muted-foreground">A printable snapshot of the session.</p>
				</div>
			) : (
				<div className="space-y-2 px-3 pt-3">
					<div className={actionRow}>
						<div className="flex items-center gap-2">
							<span className="text-muted-foreground">{view.liveEnabled ? "Active" : "Paused"}</span>
							<span aria-hidden="true" className="text-muted-foreground">·</span>
							<button
								type="button"
								className={textControl + " text-foreground"}
								disabled={notes.sending}
								onClick={() => void notes.action({ action: "set-live", enabled: !view.liveEnabled })}
							>
								{view.liveEnabled ? "Pause live notes" : "Resume live notes"}
							</button>
						</div>
						<button
							type="button"
							className={secondaryControl}
							disabled={notes.sending || running || !view.eligible}
							onClick={() => void notes.action({ action: "update-live" })}
						>
							<RefreshCwIcon size={13} aria-hidden="true" />
							Update now
						</button>
					</div>
					<p className="text-xs text-muted-foreground">Update now includes everything taught so far, even while paused.</p>
				</div>
			)}
			{running && (
				<p role="status" className="px-3 pt-2 text-xs text-muted-foreground">
					{location.mode === "final" ? "Composing handout…" : "Updating live notes…"}
				</p>
			)}
			{view.outdated && location.mode === "final" && (
				<p className="px-3 pt-2 text-xs text-muted-foreground">
					The session has new material. Regenerate to include it.
				</p>
			)}
			{error && (
				<p role="alert" className="px-3 pt-2 text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="min-h-0 flex-1 overflow-auto" ref={article}>
				{edition ? (
					<div dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<p className="p-5 text-sm text-muted-foreground">
						{!view.eligible
							? "Notes become available after teaching or a completed practice problem."
							: location.mode === "final"
								? "Generate a handout from the material covered so far."
								: "No live notes yet."}
					</p>
				)}
			</div>
			{usage && (
				<details className="border-t px-3 py-2 text-xs text-muted-foreground">
					<summary className="cursor-pointer">{location.mode === "final" ? "Handout generation usage" : "Live notes usage"}</summary>
					<p className="mt-1">
						{usage.calls} model {usage.calls === 1 ? "call" : "calls"}
						{usage.tokens !== undefined && ` · ${usage.tokens.toLocaleString()} tokens`}
					</p>
				</details>
			)}
		</aside>
	);
}
export function GraphNotesLinks({ nodeId }: { nodeId: string }) {
	const [links, setLinks] = useState<NoteIndexEntry[]>([]);
	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			const r = await fetch(`/api/graph/nodes/${encodeURIComponent(nodeId)}/notes`, { signal, cache: "no-store" });
			if (r.ok) {
				const data = await r.json();
				if (!signal?.aborted) setLinks(data);
			}
		},
		[nodeId],
	);
	useEffect(() => {
		const c = new AbortController();
		setLinks([]);
		void refresh(c.signal).catch(() => {});
		return () => c.abort();
	}, [refresh]);
	useServerEvent("notes-changed", () => {
		void refresh().catch(() => {});
	});
	return links.length ? (
		<div className="mt-3 border-t pt-2">
			<div className="text-xs text-muted-foreground">Notes</div>
			{links.map(l => (
				<Link
					key={l.chatId + l.sectionId}
					href={noteHref(l.chatId, l.mode, l.sectionId)}
					className="block rounded px-2 py-1.5 text-sm hover:bg-accent"
				>
					{l.heading}
					<small className="block text-muted-foreground">{l.sessionTitle}</small>
				</Link>
			))}
		</div>
	) : null;
}
