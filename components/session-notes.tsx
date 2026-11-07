"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, DownloadIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
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
export function useSessionNotes(chatId: string) {
	const [view, setView] = useState<NotesView>(emptyNotesView);
	const [error, setError] = useState(""),
		[sending, setSending] = useState(false);
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
	async function action(input: { action: "generate" | "retry-pdf" } | { action: "set-live"; enabled: boolean }) {
		setSending(true);
		setError("");
		try {
			const r = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!r.ok) throw new Error((await r.json()).error);
			await refresh();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSending(false);
		}
	}
	return { view, error, sending, action };
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
				<label className="ml-auto flex items-center gap-1.5 text-xs">
					<input
						type="checkbox"
						checked={view.liveEnabled}
						disabled={notes.sending}
						onChange={e => {
							void notes.action({ action: "set-live", enabled: e.target.checked });
							if (e.target.checked) navigate({ mode: "live" });
						}}
					/>
					Live updates
				</label>
			</div>
			<div className="flex flex-wrap items-center gap-2 px-3 pt-3">
				<button
					className={control}
					disabled={notes.sending || view.running.includes("final") || !view.eligible}
					onClick={() => {
						navigate({ mode: "final" });
						void notes.action({ action: "generate" });
					}}
				>
					{view.final ? "Regenerate notes" : "Generate notes"}
				</button>
				{view.final && (
					<a className={control} href={`/api/chats/${encodeURIComponent(chatId)}/notes/pdf`} download>
						<DownloadIcon size={13} />
						Download PDF
					</a>
				)}
				{view.pdfPending && !view.running.includes("final") && (
					<button className={control} onClick={() => void notes.action({ action: "retry-pdf" })}>
						Retry PDF
					</button>
				)}
			</div>
			{view.running.length > 0 && (
				<p role="status" className="px-3 pt-2 text-xs text-muted-foreground">
					{view.running.includes("final") ? "Composing handout…" : "Updating live notes…"}
				</p>
			)}
			{view.outdated && location.mode === "final" && (
				<p className="px-3 pt-2 text-xs text-muted-foreground">
					The session has new material. Regenerate to include it.
				</p>
			)}
			{(notes.error || view.error[location.mode]) && (
				<p role="alert" className="px-3 pt-2 text-sm text-destructive">
					{notes.error || view.error[location.mode]}
				</p>
			)}
			<div className="min-h-0 flex-1 overflow-auto" ref={article}>
				{edition ? (
					<div dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<p className="p-5 text-sm text-muted-foreground">
						{location.mode === "final"
							? view.eligible
								? "Generate a handout from the material covered so far."
								: "Notes become available after teaching or a completed practice problem."
							: view.liveEnabled
								? "The first summary appears when the lesson changes topic or a practice problem finishes."
								: "Turn on live updates to collect topic summaries as you study."}
					</p>
				)}
			</div>
			{view.usage.length > 0 && (
				<details className="border-t px-3 py-2 text-xs text-muted-foreground">
					<summary className="cursor-pointer">Notes generation usage</summary>
					{view.usage.map(u => (
						<p key={u.mode} className="mt-1">
							{u.mode === "final" ? "Handouts" : "Live updates"} · {u.calls} model {u.calls === 1 ? "call" : "calls"}
							{u.tokens !== undefined && ` · ${u.tokens.toLocaleString()} tokens`}
						</p>
					))}
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
