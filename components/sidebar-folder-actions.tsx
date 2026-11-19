"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { ChatListItem, ChatListResponse } from "@/src/core";

export type SidebarOrganization = NonNullable<ChatListResponse["organization"]>;
type SidebarFolder = SidebarOrganization["folders"][number];

export interface FolderTarget {
	id: string | null;
	label: string;
}

export type FolderCommand =
	| { action: "create-folder"; name: string; parentId: string | null }
	| { action: "move"; kind: "source"; id: string; parentId: string | null };

export type FolderPlan =
	| { kind: "command"; command: FolderCommand }
	| { kind: "skip" }
	| { kind: "error"; error: string };

export type FolderWriteResult = { ok: true; createdFolderId?: string } | { ok: false; error: string; ambiguous: boolean };

/** Shared with the dialogs: the pre-send planner's "target vanished" text —
 *  the wrappers reset the selection to Outside folders on exactly this. */
const FOLDER_GONE_MESSAGE = "That folder no longer exists.";
const FOLDER_WRITE_AMBIGUOUS =
	"Could not confirm the folder change. The list was refreshed; try again if it is still needed.";

const parentOf = (folderById: Map<string, SidebarFolder>, f: SidebarFolder): string | null =>
	f.parentId !== null && folderById.has(f.parentId) ? f.parentId : null;

/**
 * The move/create picker's options: "Outside folders" (id null) first,
 * then every folder labelled by its full path joined with " / " — sorted
 * by the base/numeric collator on that path, ties by id. Two folders can
 * share a full path (same names under different roots is NOT a tie — the
 * path differs; true duplicates come from identical name chains), and
 * each of those carries a ` (${id.slice(-6)})` suffix so the picker can
 * tell them apart. Sorting keys on the unsuffixed path so duplicates stay
 * adjacent and "ties by id" is the real tiebreak.
 */
export function folderTargets(organization: SidebarOrganization): FolderTarget[] {
	const folderById = new Map(organization.folders.map((f) => [f.id, f]));

	/* Full path label per folder, root first; the upward walk is
	 * cycle-safe — corrupt parent loops just stop. */
	const pathOf = new Map<string, string>();
	for (const f of organization.folders) {
		const names: string[] = [];
		const seen = new Set<string>();
		let cur: SidebarFolder | null = f;
		while (cur !== null && !seen.has(cur.id)) {
			seen.add(cur.id);
			names.unshift(cur.name);
			const p = parentOf(folderById, cur);
			cur = p === null ? null : (folderById.get(p) ?? null);
		}
		pathOf.set(f.id, names.join(" / "));
	}

	const pathCount = new Map<string, number>();
	for (const label of pathOf.values()) pathCount.set(label, (pathCount.get(label) ?? 0) + 1);

	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const folders = [...organization.folders].sort((a, b) => {
		const byLabel = collator.compare(pathOf.get(a.id) ?? "", pathOf.get(b.id) ?? "");
		return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
	});
	return [
		{ id: null, label: "Outside folders" },
		...folders.map((f) => {
			const path = pathOf.get(f.id) ?? f.name;
			return { id: f.id, label: (pathCount.get(path) ?? 0) > 1 ? `${path} (${f.id.slice(-6)})` : path };
		}),
	];
}

/**
 * Folder IDs from the root down to folderId inclusive — the chain the
 * sidebar expands after a write so the target is visible. [] for null or
 * an unknown id; a folder whose parentId names nothing reads as
 * root-level (the tree's own rule); cycle-safe.
 */
export function folderPath(organization: SidebarOrganization, folderId: string | null): string[] {
	if (folderId === null) return [];
	const folderById = new Map(organization.folders.map((f) => [f.id, f]));
	if (!folderById.has(folderId)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	let cur: string | null = folderId;
	while (cur !== null && !seen.has(cur)) {
		seen.add(cur);
		const f = folderById.get(cur);
		if (!f) break;
		ids.unshift(f.id);
		cur = parentOf(folderById, f);
	}
	return ids;
}

/**
 * The folder a chat currently renders in — the same rule
 * buildSidebarFolderView applies: practice chats are always at the root,
 * a placement counts only when it names an existing folder, and a missing
 * entry, folderId null or an unknown id all read as root (null).
 */
export function currentChatFolder(organization: SidebarOrganization, chat: ChatListItem): string | null {
	if ((chat.kind ?? "teach") === "practice") return null;
	if (!Object.hasOwn(organization.placements, chat.id)) return null;
	const folderId = organization.placements[chat.id]?.folderId;
	return folderId != null && organization.folders.some((f) => f.id === folderId) ? folderId : null;
}

/** Pre-send validation against the freshest snapshot (server validation
 *  stays authoritative): blank name and unknown parent are user-facing
 *  errors; a valid plan carries the trimmed name. */
export function planCreateFolder(
	organization: SidebarOrganization,
	name: string,
	parentId: string | null,
): FolderPlan {
	const trimmed = name.trim();
	if (trimmed === "") return { kind: "error", error: "Enter a folder name." };
	if (parentId !== null && !organization.folders.some((f) => f.id === parentId)) {
		return { kind: "error", error: FOLDER_GONE_MESSAGE };
	}
	return { kind: "command", command: { action: "create-folder", name: trimmed, parentId } };
}

/** Same pre-send validation for the chat move: the chat must exist in the
 *  snapshot and be a teaching chat, the target must exist, and a target
 *  equal to the current folder is a skip — no POST for a no-op. */
export function planMoveChat(
	organization: SidebarOrganization,
	chats: readonly ChatListItem[],
	chatId: string,
	parentId: string | null,
): FolderPlan {
	const chat = chats.find((c) => c.id === chatId);
	if (!chat) return { kind: "error", error: "This session no longer exists." };
	if ((chat.kind ?? "teach") === "practice") {
		return { kind: "error", error: "Practice sessions stay outside folders." };
	}
	if (parentId !== null && !organization.folders.some((f) => f.id === parentId)) {
		return { kind: "error", error: FOLDER_GONE_MESSAGE };
	}
	if (currentChatFolder(organization, chat) === parentId) return { kind: "skip" };
	return { kind: "command", command: { action: "move", kind: "source", id: chatId, parentId } };
}

/**
 * POST the command as JSON to the shared write route. 2xx → ok
 * (createdFolderId when the body carries a string one). 400 is the
 * server's definite refusal — its message verbatim, never ambiguous.
 * Any other status, a thrown fetch or an unreadable body means the write
 * MAY have landed: ambiguous, and the caller refreshes before offering a
 * retry (no automatic retries anywhere).
 */
export async function postFolderCommand(
	command: FolderCommand,
	fetchImpl: typeof fetch = fetch,
): Promise<FolderWriteResult> {
	let res: Response;
	try {
		res = await fetchImpl("/api/graph/sources", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(command),
		});
	} catch {
		return { ok: false, ambiguous: true, error: FOLDER_WRITE_AMBIGUOUS };
	}
	if (res.ok) {
		try {
			const body = (await res.json()) as { createdFolderId?: unknown } | null;
			const createdFolderId = typeof body?.createdFolderId === "string" ? body.createdFolderId : undefined;
			return createdFolderId === undefined ? { ok: true } : { ok: true, createdFolderId };
		} catch {
			return { ok: false, ambiguous: true, error: FOLDER_WRITE_AMBIGUOUS };
		}
	}
	if (res.status === 400) {
		try {
			const body = (await res.json()) as { error?: unknown } | null;
			const message = typeof body?.error === "string" ? body.error : undefined;
			return { ok: false, error: message ?? "The folder change was rejected.", ambiguous: false };
		} catch {
			return { ok: false, error: "The folder change was rejected.", ambiguous: false };
		}
	}
	return { ok: false, ambiguous: true, error: FOLDER_WRITE_AMBIGUOUS };
}

/**
 * One sidebar write at a time: a write arriving while another is in
 * flight resolves the "still saving" refusal WITHOUT posting; every
 * posted command is followed by afterWrite — success or failure — before
 * write() resolves, so the sidebar's invalidate/refresh always runs.
 */
export function createFolderWriter(deps: {
	post: (command: FolderCommand) => Promise<FolderWriteResult>;
	afterWrite: (command: FolderCommand, result: FolderWriteResult) => void | Promise<void>;
}): { write(command: FolderCommand): Promise<FolderWriteResult> } {
	let inFlight = false;
	return {
		async write(command) {
			if (inFlight) {
				return { ok: false, ambiguous: false, error: "Another folder change is still saving." };
			}
			inFlight = true;
			try {
				const result = await deps.post(command);
				await deps.afterWrite(command, result);
				return result;
			} finally {
				inFlight = false;
			}
		},
	};
}

/**
 * The new-folder form's pure body — exported for SSR pins (the
 * delete-session-dialog body pattern). The wrapper owns state + portal.
 */
export function NewFolderBody({
	name,
	parentId,
	targets,
	busy,
	error,
	onName,
	onParent,
	onCancel,
	onCreate,
	nameRef,
	renderFrame,
}: {
	name: string;
	parentId: string | null;
	targets: FolderTarget[];
	busy: boolean;
	error: string | null;
	onName: (name: string) => void;
	onParent: (id: string | null) => void;
	onCancel: () => void;
	onCreate: () => void;
	nameRef?: Ref<HTMLInputElement>;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}): ReactNode {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="New folder"
			data-testid="new-folder-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">New folder</h2>
			<div className="mt-3">
				<label htmlFor="new-folder-name" className="block text-xs text-muted-foreground">
					Name
				</label>
				<input
					id="new-folder-name"
					ref={nameRef}
					type="text"
					value={name}
					onChange={(e) => onName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !busy && name.trim() !== "") onCreate();
					}}
					data-testid="new-folder-name"
					className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
				/>
			</div>
			<div className="mt-3">
				<label htmlFor="new-folder-parent" className="block text-xs text-muted-foreground">
					Parent folder
				</label>
				<select
					id="new-folder-parent"
					value={parentId ?? ""}
					onChange={(e) => onParent(e.target.value === "" ? null : e.target.value)}
					data-testid="new-folder-parent"
					className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
				>
					{targets.map((t) => (
						<option key={t.id ?? "outside"} value={t.id ?? ""}>
							{t.label}
						</option>
					))}
				</select>
			</div>
			{error !== null && (
				<div role="alert" data-testid="new-folder-error" className="mt-3 text-xs text-error">
					{error}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="new-folder-cancel"
					onClick={onCancel}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="new-folder-create"
					onClick={onCreate}
					disabled={busy || name.trim() === ""}
					className="rounded-sm border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy ? "Creating…" : "Create"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/**
 * The move-to-folder form's pure body — same SSR-pin pattern as
 * NewFolderBody. Move stays disabled while the target equals the current
 * folder: the planner would skip the write anyway.
 */
export function MoveChatBody({
	chatTitle,
	currentId,
	targetId,
	targets,
	busy,
	error,
	onTarget,
	onCancel,
	onMove,
	selectRef,
	renderFrame,
}: {
	chatTitle: string;
	currentId: string | null;
	targetId: string | null;
	targets: FolderTarget[];
	busy: boolean;
	error: string | null;
	onTarget: (id: string | null) => void;
	onCancel: () => void;
	onMove: () => void;
	selectRef?: Ref<HTMLSelectElement>;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}): ReactNode {
	const currentLabel = targets.find((t) => t.id === currentId)?.label ?? "Outside folders";
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Move to folder"
			data-testid="move-chat-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Move to folder</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{chatTitle}</code>
			</div>
			<p data-testid="move-chat-current" className="mt-2 text-xs text-muted-foreground">
				Currently in: {currentLabel}
			</p>
			<div className="mt-3">
				<label htmlFor="move-chat-target" className="block text-xs text-muted-foreground">
					Folder
				</label>
				<select
					id="move-chat-target"
					ref={selectRef}
					value={targetId ?? ""}
					onChange={(e) => onTarget(e.target.value === "" ? null : e.target.value)}
					data-testid="move-chat-target"
					className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
				>
					{targets.map((t) => (
						<option key={t.id ?? "outside"} value={t.id ?? ""}>
							{t.label}
						</option>
					))}
				</select>
			</div>
			{error !== null && (
				<div role="alert" data-testid="move-chat-error" className="mt-3 text-xs text-error">
					{error}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="move-chat-cancel"
					onClick={onCancel}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="move-chat-confirm"
					onClick={onMove}
					disabled={busy || targetId === currentId}
					className="rounded-sm border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy ? "Moving…" : "Move"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/**
 * The new-folder dialog: state for name/parent/busy/error, reset whenever
 * it closes. Targets recompute from the live organization prop every
 * render, so a folder deleted elsewhere drops out of the picker after the
 * sidebar refreshes; the initial focus lands in the name input.
 */
export function NewFolderDialog({
	open,
	organization,
	onClose,
	onSubmit,
}: {
	open: boolean;
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (name: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const [name, setName] = useState("");
	const [parentId, setParentId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement | null>(null);

	/* Fresh state per opening: closing resets the whole form (the
	 *  delete-session-dialog rule). */
	useEffect(() => {
		if (!open) {
			setName("");
			setParentId(null);
			setBusy(false);
			setError(null);
		}
	}, [open]);

	if (!open) return null;
	const targets = folderTargets(organization);

	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit(name, parentId);
		if (failure === null) {
			onClose();
			return;
		}
		setError(failure);
		if (failure === FOLDER_GONE_MESSAGE) setParentId(null);
		setBusy(false);
	};

	return (
		<NewFolderBody
			name={name}
			parentId={parentId}
			targets={targets}
			busy={busy}
			error={error}
			onName={setName}
			onParent={setParentId}
			onCancel={onClose}
			onCreate={() => void submit()}
			nameRef={nameRef}
			renderFrame={(frame) => (
				<HostDialog
					open
					frame={frame}
					initialFocusRef={nameRef}
					onClose={() => {
						if (busy) return "blocked";
						onClose();
						return "closed";
					}}
					backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				>
					{frame.props.children}
				</HostDialog>
			)}
		/>
	);
}

/**
 * The move-chat dialog: chat === null is "closed". The stateful form is
 * keyed by chat id, so every opening starts fresh with the target at the
 * chat's current folder; initial focus lands in the target select.
 */
export function MoveChatDialog({
	chat,
	organization,
	onClose,
	onSubmit,
}: {
	chat: ChatListItem | null;
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (chatId: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	/* chat === null is "closed". Keying the stateful form by chat id gives
	 *  every opening a fresh form whose target starts at the current
	 *  folder — a snapshot refresh can't reset the user's choice. */
	if (chat === null) return null;
	return <MoveChatForm key={chat.id} chat={chat} organization={organization} onClose={onClose} onSubmit={onSubmit} />;
}

function MoveChatForm({
	chat,
	organization,
	onClose,
	onSubmit,
}: {
	chat: ChatListItem;
	organization: SidebarOrganization;
	onClose: () => void;
	onSubmit: (chatId: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const [targetId, setTargetId] = useState<string | null>(() => currentChatFolder(organization, chat));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectRef = useRef<HTMLSelectElement | null>(null);
	const targets = folderTargets(organization);
	const currentId = currentChatFolder(organization, chat);

	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit(chat.id, targetId);
		if (failure === null) {
			onClose();
			return;
		}
		setError(failure);
		if (failure === FOLDER_GONE_MESSAGE) setTargetId(null);
		setBusy(false);
	};

	return (
		<MoveChatBody
			chatTitle={chat.title}
			currentId={currentId}
			targetId={targetId}
			targets={targets}
			busy={busy}
			error={error}
			onTarget={setTargetId}
			onCancel={onClose}
			onMove={() => void submit()}
			selectRef={selectRef}
			renderFrame={(frame) => (
				<HostDialog
					open
					frame={frame}
					initialFocusRef={selectRef}
					onClose={() => {
						if (busy) return "blocked";
						onClose();
						return "closed";
					}}
					backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				>
					{frame.props.children}
				</HostDialog>
			)}
		/>
	);
}
