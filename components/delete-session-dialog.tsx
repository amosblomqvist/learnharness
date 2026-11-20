"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";
import type { ChatRecordView } from "@/components/session-kind-catalog";

/** The graph-traces checkbox copy (owner, 2026-09-24 flow rework — was
 *  the purge option's body in the two-button design): the
 *  graph-touching consequence says so, shared-topic survival included.
 *  Exported pure for render pins: the copy is design, not implementation. */
export const TRACES_COPY = {
	testid: "delete-traces",
	checkbox: "delete-traces-checkbox",
	title: "Also remove its graph traces",
	body: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
};

/** What the dialog offers for a session's record (stage C, owner C4/q52):
 *  the graph keeps its exact copy; a plugin record that declares purge gets
 *  the same checkbox in its own words; an unavailable record shows it
 *  disabled with the reason; a record without purge (or no record —
 *  practice) offers nothing. Pure, for render pins. */
export interface DeletionChoice {
	intro: string;
	traces: { title: string; body: string; disabled: boolean } | null;
}
export function deletionChoice(record: ChatRecordView): DeletionChoice {
	const removes = "This permanently removes the session — its messages, background jobs, and extraction records.";
	switch (record.status) {
		case "graph":
			return { intro: `${removes} Everything it added to the graph stays unless you check below. This cannot be undone.`, traces: { title: TRACES_COPY.title, body: TRACES_COPY.body, disabled: false } };
		case "none":
			return { intro: "This permanently removes the session — its messages and background jobs. This cannot be undone.", traces: null };
		case "plugin":
			return record.record.purge
				? { intro: `${removes} Everything it added to ${record.record.label} stays unless you check below. This cannot be undone.`,
					traces: { title: `Also remove its ${record.record.label} traces`, body: `${record.record.pluginName} removes what this session added to ${record.record.label}.`, disabled: false } }
				: { intro: `${removes} Everything it added to ${record.record.label} stays. This cannot be undone.`, traces: null };
		case "unavailable":
			return { intro: `${removes} Its record stays as it is. This cannot be undone.`,
				traces: { title: "Also remove its traces", body: "Unavailable while the plugin that owns this session's record is disabled or not installed.", disabled: true } };
	}
}

/**
 * Session deletion (wave 6 chunk A; owner flow rework 2026-09-24) — THE
 * destructive-confirmation surface, portaled z-50 like the setup dialog,
 * now in the node dialog's shape (the two must read as one design):
 *
 *   - red title "Delete session?" in the abort-turn look (owner, 2026-10-13
 *     polish: text-sm font-semibold JetBrains Mono via the UI default —
 *     the serif display title is gone), the session name below it in
 *     JetBrains Mono at normal text-sm size (was sized-up text-lg), no
 *     code-block chrome;
 *   - ONE unchecked-by-default checkbox "Also remove its graph traces"
 *     (unchecked = preserve: the session record, its jobs, and its
 *     extraction bookkeeping die; the graph keeps every contribution.
 *     checked = purge: the session's ledger traces go too);
 *   - a bottom row Cancel + destructive-red Delete, exactly the node
 *     dialog's pair.
 *
 * Retryable failures render honestly with a Try-again: 409 turn_in_flight /
 * jobs_running ("wait for running work") and 503 extraction_winding_down
 * ("in a moment") both clear on their own — the server's error line is
 * already written for the user; we show it verbatim. Try-again is just
 * Delete pressed again — the mode re-derives from the checkbox.
 */
export function DeleteSessionDialog({
	chat,
	record = { status: "graph" },
	onClose,
	onDeleted,
}: {
	/** The session up for deletion; null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	/** What the session extracts into, from the client kind catalog. */
	record?: ChatRecordView;
	onClose: () => void;
	/** Success path — the sidebar owns navigation + list patching. */
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	// Retry IS pressing Delete again: the mode always derives from the
	// checkbox's current state (a toggle between failure and retry is a
	// change of intent, honored as such — the checkbox is disabled while
	// busy, so no mid-flight switches).
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);

	// Fresh state per session: closing resets, opening a new chat starts clean.
	useEffect(() => {
		if (!chat) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [chat]);

	const choice = deletionChoice(record);
	const run = async () => {
		if (!chat || busy) return;
		const mode: ChatDeleteMode = traces && choice.traces && !choice.traces.disabled ? "purge" : "preserve";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				graphRevision?: number;
			};
			if (!res.ok) {
				// 409 (turn/jobs running) and 503 (extraction winding down) are
				// both retryable — keep the dialog open, show the server's line.
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted(chat.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!chat) return null;

	return <DeleteSessionBody
				chat={chat}
				choice={choice}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={(next) => setTraces(next)}
				onClose={onClose}
				onRun={() => void run()}
				renderFrame={(frame) => <HostDialog open frame={frame} onClose={() => {
					if (busy) return "blocked";
					onClose(); return "closed";
				}} backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>{frame.props.children}</HostDialog>}
			/>;
}

/** The dialog's pure body — exported for SSR pins (the settings-dialog /
 *  node-dialog body pattern). The wrapper owns state + effects + portal. */
export function DeleteSessionBody({
	chat,
	choice = deletionChoice({ status: "graph" }),
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
	renderFrame,
}: {
	chat: Pick<ChatListItem, "id" | "title">;
	choice?: DeletionChoice;
	/** The traces checkbox — unchecked by default (preserve). */
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete session"
			data-testid="delete-session-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete session?</h2>
			{/* The session name below the title in JetBrains Mono (owner,
			    2026-09-24): no code-block chrome — the font already says
			    code. Owner, 2026-10-13 polish: normal text-sm size (was
			    sized-up text-lg), still white. Same shape as the node
			    dialog. */}
			<div className="mt-1.5">
				<code data-testid="session-name-code" className="font-mono text-sm text-foreground">
					{chat.title}
				</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{choice.intro}</p>
			{choice.traces && (
				<label
					data-testid={TRACES_COPY.testid}
					className={"mt-4 flex items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3 " + (choice.traces.disabled ? "opacity-60" : "cursor-pointer")}
				>
					<input
						type="checkbox"
						data-testid={TRACES_COPY.checkbox}
						checked={traces && !choice.traces.disabled}
						onChange={(e) => onTraces(e.target.checked)}
						disabled={busy || choice.traces.disabled}
						className="mt-0.5 size-4 shrink-0 accent-primary"
					/>
					<span className="min-w-0">
						<span className="block text-sm text-foreground">{choice.traces.title}</span>
						<span className="mt-1 block text-xs text-muted-foreground">{choice.traces.body}</span>
					</span>
				</label>
			)}
			{failure && (
				<div
					role="alert"
					data-testid="delete-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="text-foreground">{failure.error}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onClick={onRun}
						disabled={busy}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			{/* The node dialog's exact bottom row: quiet Cancel, destructive
			    red Delete (border + text, fill on hover — the app's
			    established destructive pair). */}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}