"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { HostDialog } from "@/components/host-dialog";
import { SOURCE_DRAG_TYPE } from "@/components/source-folder-tree";
import type { ChatListItem, ChatListResponse } from "@/src/core";

export type SidebarOrganization = NonNullable<ChatListResponse["organization"]>;
export type SidebarFolder = SidebarOrganization["folders"][number];

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

export type FolderWriteResult = { ok: true } | { ok: false; error: string };

/** Shared with the dialogs: the pre-send planner's "target vanished" text —
 *  the wrappers reset the selection to Outside folders on exactly this. */
const FOLDER_GONE_MESSAGE = "That folder no longer exists.";
const FOLDER_WRITE_AMBIGUOUS =
	"Could not confirm the folder change. The list was refreshed; try again if it is still needed.";

const folderIndex = (organization: SidebarOrganization): Map<string, SidebarFolder> =>
	new Map(organization.folders.map((f) => [f.id, f]));

/** A folder's parent id, or null when it sits at the root — a parentId
 *  naming no folder reads as root (the store rejects cycles and dangling
 *  parents on read, so the client never sees either). */
export const folderParentId = (folderById: Map<string, SidebarFolder>, f: SidebarFolder): string | null =>
	f.parentId !== null && folderById.has(f.parentId) ? f.parentId : null;

/** The folder's ancestor chain root → leaf ([] for an unknown id). */
export function folderChain(folderById: Map<string, SidebarFolder>, id: string): SidebarFolder[] {
	const chain: SidebarFolder[] = [];
	for (let cur = folderById.get(id); cur !== undefined;) {
		chain.unshift(cur);
		const p = folderParentId(folderById, cur);
		cur = p === null ? undefined : folderById.get(p);
	}
	return chain;
}

/**
 * The move/create picker's options: "Outside folders" (id null) first,
 * then every folder labelled by its full path, sorted by the
 * base/numeric collator on that path, ties by id. Folders sharing one
 * full path each get a ` (${id.slice(-6)})` suffix so the picker can
 * tell them apart; sorting keys on the unsuffixed path so duplicates
 * stay adjacent.
 */
export function folderTargets(organization: SidebarOrganization): FolderTarget[] {
	const folderById = folderIndex(organization);
	const pathOf = new Map<string, string>();
	for (const f of organization.folders) {
		pathOf.set(f.id, folderChain(folderById, f.id).map((x) => x.name).join(" / "));
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
 * an unknown id.
 */
export function folderPath(organization: SidebarOrganization, folderId: string | null): string[] {
	if (folderId === null) return [];
	return folderChain(folderIndex(organization), folderId).map((f) => f.id);
}

/** The folder a chat currently renders in: practice chats are always at
 *  the root, a placement counts only when it names an existing folder,
 *  and a missing entry, folderId null or an unknown id all read as root. */
export function currentChatFolder(organization: SidebarOrganization, chat: ChatListItem): string | null {
	if ((chat.kind ?? "teach") === "practice") return null;
	if (!Object.hasOwn(organization.placements, chat.id)) return null;
	const folderId = organization.placements[chat.id]?.folderId;
	return folderId != null && organization.folders.some((f) => f.id === folderId) ? folderId : null;
}

/** Parse the SourceDragRow payload; anything but { kind: "source" | "folder", id: non-empty string } → null. */
export function readDragPayload(raw: string): { kind: "source" | "folder"; id: string } | null {
	let item: unknown;
	try {
		item = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!item || typeof item !== "object") return null;
	const { kind, id } = item as { kind?: unknown; id?: unknown };
	if ((kind !== "source" && kind !== "folder") || typeof id !== "string" || id === "") return null;
	return { kind, id };
}

/** Whether the sidebar may drop the chat on target (folder id or null =
 *  Outside folders): exactly when the pre-send planner below would emit
 *  a command — a real change to an existing, legal target. */
function canDropChat(
	organization: SidebarOrganization,
	chats: readonly ChatListItem[],
	chatId: string,
	target: string | null,
): boolean {
	return planMoveChat(organization, chats, chatId, target).kind === "command";
}

/**
 * Sidebar chat drag state. dragChatId arms only on a dragstart bubbled
 * from this list's own SourceDragRow payload (a teaching chat in chats);
 * drops are accepted only when the drop payload's kind and id equal
 * dragChatId's — foreign drags never become a move.
 */
export function useSidebarDrag(deps: {
	organization: SidebarOrganization | null;
	chats: readonly ChatListItem[];
	moveChat: (chatId: string, parentId: string | null) => Promise<string | null>;
}): {
	dragChatId: string | null;
	/** undefined = no highlighted target; null = Outside folders; string = folder id. */
	dropTarget: string | null | undefined;
	error: string | null;
	containerProps: { onDragStart(e: DragEvent): void; onDragEnd(e: DragEvent): void };
	targetProps(target: string | null): { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void };
} {
	const [dragChatId, setDragChatId] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(armTimer.current), []);

	/* Arming waits for the next task: React would otherwise re-render
	   inside dragstart, and the Outside folders zone (or a cleared error)
	   shifts the row under the pointer — Chrome then cancels the native
	   drag with an immediate dragend. dragover/drop arrive much later. */
	const containerProps = {
		onDragStart(e: DragEvent) {
			clearTimeout(armTimer.current);
			const organization = deps.organization;
			const payload = readDragPayload(e.dataTransfer.getData(SOURCE_DRAG_TYPE));
			let armed: string | null = null;
			if (organization !== null && payload !== null && payload.kind === "source") {
				const chat = deps.chats.find((c) => c.id === payload.id);
				if (chat !== undefined && (chat.kind ?? "teach") !== "practice") {
					armed = chat.id;
				}
			}
			armTimer.current = setTimeout(() => {
				setError(null);
				if (armed !== null) setDragChatId(armed);
			}, 0);
		},
		onDragEnd() {
			clearTimeout(armTimer.current);
			setDragChatId(null);
			setDropTarget(undefined);
		},
	};

	const targetProps = (target: string | null) => ({
		onDragOver(e: DragEvent) {
			if (!Array.from(e.dataTransfer.types).includes(SOURCE_DRAG_TYPE)) return;
			const organization = deps.organization;
			if (dragChatId === null || organization === null || !canDropChat(organization, deps.chats, dragChatId, target)) {
				e.dataTransfer.dropEffect = "none";
				setDropTarget((previous) => (previous === target ? undefined : previous));
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			setDropTarget(target);
		},
		onDragLeave(e: DragEvent) {
			if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
			setDropTarget((previous) => (previous === target ? undefined : previous));
		},
		onDrop(e: DragEvent) {
			const raw = e.dataTransfer.getData(SOURCE_DRAG_TYPE);
			if (raw === "") return;
			e.preventDefault();
			e.stopPropagation();
			const chatId = dragChatId;
			setDragChatId(null);
			setDropTarget(undefined);
			const payload = readDragPayload(raw);
			const organization = deps.organization;
			if (payload === null || payload.kind !== "source" || chatId === null || payload.id !== chatId) return;
			if (organization === null || !canDropChat(organization, deps.chats, chatId, target)) return;
			void deps.moveChat(chatId, target).then((failure) => {
				if (failure !== null) setError(failure);
			});
		},
	});

	return { dragChatId, dropTarget, error, containerProps, targetProps };
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
 * POST the command as JSON to the shared write route. A readable 2xx body
 * → ok; an unreadable one means the write MAY have landed — the
 * confirm-failure text, not success. 400 is the server's definite
 * refusal — its message verbatim, never ambiguous. Any other status or a
 * thrown fetch is the same confirm-failure (no automatic retries).
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
		return { ok: false, error: FOLDER_WRITE_AMBIGUOUS };
	}
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	if (res.ok) return body === null ? { ok: false, error: FOLDER_WRITE_AMBIGUOUS } : { ok: true };
	if (res.status === 400) {
		const message = typeof body?.error === "string" ? body.error : undefined;
		return { ok: false, error: message ?? "The folder change was rejected." };
	}
	return { ok: false, error: FOLDER_WRITE_AMBIGUOUS };
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
				return { ok: false, error: "Another folder change is still saving." };
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

/** The folder picker's <select>: "Outside folders" (value "") plus one
 *  option per target, labelled by full path — shared by the create and
 *  move dialogs, which differ only in id/label. */
function FolderSelect({
	id,
	label,
	targets,
	value,
	onChange,
	selectRef,
}: {
	id: string;
	label: string;
	targets: readonly FolderTarget[];
	value: string | null;
	onChange: (id: string | null) => void;
	selectRef?: Ref<HTMLSelectElement>;
}): ReactNode {
	return (
		<div className="mt-3">
			<label htmlFor={id} className="block text-xs text-muted-foreground">
				{label}
			</label>
			<select
				id={id}
				ref={selectRef}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				data-testid={id}
				className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
			>
				{targets.map((t) => (
					<option key={t.id ?? "outside"} value={t.id ?? ""}>
						{t.label}
					</option>
				))}
			</select>
		</div>
	);
}

function DialogError({ testId, error }: { testId: string; error: string | null }): ReactNode {
	if (error === null) return null;
	return (
		<div role="alert" data-testid={testId} className="mt-3 text-xs text-error">
			{error}
		</div>
	);
}

/** Cancel/Confirm row shared by the folder dialogs. */
function DialogActions({
	cancelTestId,
	confirmTestId,
	busy,
	confirmDisabled,
	confirmIdle,
	confirmBusy,
	onCancel,
	onConfirm,
}: {
	cancelTestId: string;
	confirmTestId: string;
	busy: boolean;
	confirmDisabled: boolean;
	confirmIdle: string;
	confirmBusy: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactNode {
	return (
		<div className="mt-4 flex justify-end gap-2">
			<button
				type="button"
				data-testid={cancelTestId}
				onClick={onCancel}
				disabled={busy}
				className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
			>
				Cancel
			</button>
			<button
				type="button"
				data-testid={confirmTestId}
				onClick={onConfirm}
				disabled={busy || confirmDisabled}
				className="rounded-sm border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{busy ? confirmBusy : confirmIdle}
			</button>
		</div>
	);
}

/** The folder dialogs' shared HostDialog frame (the delete-source-dialog
 *  renderFrame pattern): one backdrop, busy blocks closing, each dialog
 *  passes its own initial-focus ref. */
function FolderDialogFrame({
	frame,
	busy,
	onClose,
	initialFocusRef,
}: {
	frame: ReactElement<{ children: ReactNode }>;
	busy: boolean;
	onClose: () => void;
	initialFocusRef?: RefObject<HTMLElement | null>;
}): ReactNode {
	return (
		<HostDialog
			open
			frame={frame}
			initialFocusRef={initialFocusRef}
			onClose={() => {
				if (busy) return "blocked";
				onClose();
				return "closed";
			}}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
		>
			{frame.props.children}
		</HostDialog>
	);
}

/** Shared submit state for the folder dialogs: busy + error around one
 *  in-flight submit; a FOLDER_GONE failure resets the target selection to
 *  Outside folders (onFolderGone), anything else just shows the error. */
function useFolderSubmit({
	onSubmit,
	onClose,
	onFolderGone,
}: {
	onSubmit: () => Promise<string | null>;
	onClose: () => void;
	onFolderGone?: () => void;
}): { busy: boolean; error: string | null; submit: () => void } {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit();
		if (failure === null) {
			onClose();
			return;
		}
		setError(failure);
		if (failure === FOLDER_GONE_MESSAGE) onFolderGone?.();
		setBusy(false);
	};
	return { busy, error, submit: () => void submit() };
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
			<FolderSelect id="new-folder-parent" label="Parent folder" targets={targets} value={parentId} onChange={onParent} />
			<DialogError testId="new-folder-error" error={error} />
			<DialogActions
				cancelTestId="new-folder-cancel"
				confirmTestId="new-folder-create"
				busy={busy}
				confirmDisabled={name.trim() === ""}
				confirmIdle="Create"
				confirmBusy="Creating…"
				onCancel={onCancel}
				onConfirm={onCreate}
			/>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/**
 * The move-to-folder form's pure body — same SSR-pin pattern as
 * NewFolderBody (the testids stay move-chat-*). Move stays disabled
 * while the target equals the current folder: the planner would skip
 * the write anyway.
 */
export function MoveTargetBody({
	title,
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
	title: string;
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
				<code className="font-mono text-sm text-foreground">{title}</code>
			</div>
			<p data-testid="move-chat-current" className="mt-2 text-xs text-muted-foreground">
				Currently in: {currentLabel}
			</p>
			<FolderSelect id="move-chat-target" label="Folder" targets={targets} value={targetId} onChange={onTarget} selectRef={selectRef} />
			<DialogError testId="move-chat-error" error={error} />
			<DialogActions
				cancelTestId="move-chat-cancel"
				confirmTestId="move-chat-confirm"
				busy={busy}
				confirmDisabled={targetId === currentId}
				confirmIdle="Move"
				confirmBusy="Moving…"
				onCancel={onCancel}
				onConfirm={onMove}
			/>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/**
 * The new-folder dialog — mount it only while open (`{open && …}`), so
 * every opening is a fresh form with no reset effect. Targets recompute
 * from the live organization prop every render: a folder deleted
 * elsewhere drops out of the picker after the sidebar refreshes. Initial
 * focus lands in the name input.
 */
export function NewFolderDialog({
	organization,
	onClose,
	onSubmit,
}: {
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (name: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const [name, setName] = useState("");
	const [parentId, setParentId] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement | null>(null);
	const { busy, error, submit } = useFolderSubmit({
		onSubmit: () => onSubmit(name, parentId),
		onClose,
		onFolderGone: () => setParentId(null),
	});

	return (
		<NewFolderBody
			name={name}
			parentId={parentId}
			targets={folderTargets(organization)}
			busy={busy}
			error={error}
			onName={setName}
			onParent={setParentId}
			onCancel={onClose}
			onCreate={submit}
			nameRef={nameRef}
			renderFrame={(frame) => <FolderDialogFrame frame={frame} busy={busy} onClose={onClose} initialFocusRef={nameRef} />}
		/>
	);
}

/**
 * The move-chat dialog: mount it only while a chat is picked, keyed by
 * chat id, so every opening is a fresh form whose target starts at the
 * chat's current folder — a snapshot refresh can't reset the user's
 * choice. Initial focus lands in the target select.
 */
export function MoveTargetDialog({
	chat,
	organization,
	onClose,
	onSubmit,
}: {
	chat: ChatListItem;
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (chatId: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const currentId = currentChatFolder(organization, chat);
	const [targetId, setTargetId] = useState<string | null>(currentId);
	const selectRef = useRef<HTMLSelectElement | null>(null);
	const { busy, error, submit } = useFolderSubmit({
		onSubmit: () => onSubmit(chat.id, targetId),
		onClose,
		onFolderGone: () => setTargetId(null),
	});

	return (
		<MoveTargetBody
			title={chat.title}
			currentId={currentId}
			targetId={targetId}
			targets={folderTargets(organization)}
			busy={busy}
			error={error}
			onTarget={setTargetId}
			onCancel={onClose}
			onMove={submit}
			selectRef={selectRef}
			renderFrame={(frame) => <FolderDialogFrame frame={frame} busy={busy} onClose={onClose} initialFocusRef={selectRef} />}
		/>
	);
}
