import { deleteSourcesTraces, type ChatDeleteMode } from "../core/graph-deletion.ts";
import { folderIsEmpty, type SourceDirectory } from "../core/source-organization.ts";
import { folderDeletionScope, type FolderDeletionScope } from "../core/session-folders.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";
import { deleteIdleChatRecord, runningWorkBlocker, settleChatsForDeletion } from "./chats.ts";
import { graphRevision } from "./graph.ts";
import { tr } from "../core/i18n.ts";

export class SourceDeletionError extends Error {
	constructor(message: string, public status = 400, public code = "invalid_source_deletion") { super(message); }
}
export interface SourceDeletionRequest { sourceIds: string[]; folderIds: string[]; deleteSessions: boolean }
export function parseSourceDeletion(raw: unknown): SourceDeletionRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SourceDeletionError(tr("无效的来源删除请求。", "Invalid source deletion request."));
	const r = raw as Record<string, unknown>;
	const ids = (value: unknown) => {
		if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) throw new SourceDeletionError(tr("来源和文件夹 ID 必须是由非空字符串组成的数组。", "Source and folder IDs must be arrays of non-empty strings."));
		return [...new Set(value)] as string[];
	};
	if (typeof r.deleteSessions !== "boolean") throw new SourceDeletionError(tr("必须明确选择是否删除会话。", "Session deletion must be explicitly selected or declined."));
	const result = { sourceIds: ids(r.sourceIds), folderIds: ids(r.folderIds), deleteSessions: r.deleteSessions };
	if (!result.sourceIds.length && !result.folderIds.length) throw new SourceDeletionError(tr("请至少选择一个来源或文件夹。", "Select at least one source or folder."));
	return result;
}

/** A single synchronous deletion stretch, after the same global extraction
 * refusal as the old chains-view deletion. No imports or turns are cancelled.
 * Missing entries are harmless on retry after a partially completed I/O failure. */
export function deleteSources(raw: unknown): SourceDirectory & { graphRevision: number } {
	const request = parseSourceDeletion(raw);
	const directory = sourceDirectory.read(); // validate organization before any destructive write
	const targets = directory.sources.filter((s) => request.sourceIds.includes(s.id));
	if (targets.length && extractionStatuses().length) throw new SourceDeletionError(tr("正在进行提取 — 请等待活动面板中的任务完成后再试。", "An extraction is running — try again when the activity dock drains."), 409, "extraction_running");
	if (request.deleteSessions) for (const entry of targets) if (entry.kind === "chat") {
		const blocker = runningWorkBlocker(entry.id);
		if (blocker) throw new SourceDeletionError(blocker.error, blocker.status, blocker.code);
	}
	// Clear the whole selected batch in one graph rewrite. Kept chats lose
	// coverage/checkpoints too, so their unchanged messages can be re-extracted.
	deleteSourcesTraces(stores.graphStore, new Set(targets.map((s) => s.id)), "delete-nodes");
	stores.graphStore.deleteSources(new Set(targets.filter((s) => s.kind === "notes").map((s) => s.id)));
	const removed = new Set(request.sourceIds.filter((id) => !directory.sources.some((s) => s.id === id)));
	for (const entry of targets) {
		if (entry.kind === "chat" && request.deleteSessions) {
			const outcome = deleteIdleChatRecord(entry.id);
			if (!outcome.ok) throw new SourceDeletionError(outcome.error, outcome.status, outcome.code);
			removed.add(entry.id);
		} else if (entry.kind !== "chat") removed.add(entry.id);
	}
	const state = structuredClone(directory.organization);
	state.placements = Object.fromEntries(Object.entries(state.placements).filter(([id]) => !removed.has(id)));
	const remainingSources = new Set(sourceDirectory.read().sources.map((s) => s.id));
	// Bottom-up fixed point: remove selected empty descendants, then their
	// emptied ancestors. Kept conversations and unselected entries block removal.
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of request.folderIds) {
			if (state.folders.some((f) => f.id === id) && folderIsEmpty(state, id, remainingSources)) {
				state.folders = state.folders.filter((f) => f.id !== id);
				state.placements = Object.fromEntries(Object.entries(state.placements).filter(([, p]) => p.folderId !== id));
				changed = true;
			}
		}
	}
	if (JSON.stringify(state) !== JSON.stringify(directory.organization)) stores.sourceOrganizationStore.write(state);
	return { ...sourceDirectory.read(), graphRevision: graphRevision() };
}

function parseFolderDeletionScope(raw: unknown): FolderDeletionScope {
	const invalid = () => new SourceDeletionError(tr("删除文件夹时必须附带已确认的删除范围。", "A folder deletion must include the reviewed scope."), 400, "bad_folder_scope");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
	const r = raw as Record<string, unknown>;
	const ids = (value: unknown): string[] => {
		if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) throw invalid();
		return [...value].sort();
	};
	if (r.parentId !== null && (typeof r.parentId !== "string" || !r.parentId)) throw invalid();
	return { parentId: r.parentId, folderIds: ids(r.folderIds), chatIds: ids(r.chatIds), noteIds: ids(r.noteIds) };
}

function requireFolderDeletionScope(directory: SourceDirectory, folderId: string, expected: FolderDeletionScope) {
	const actual = folderDeletionScope(directory, folderId);
	if (!actual) throw new SourceDeletionError(tr("此文件夹已不存在。", "This folder no longer exists."), 404, "not_found");
	const equalIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
	if (actual.parentId !== expected.parentId || !equalIds(actual.folderIds, expected.folderIds)
		|| !equalIds(actual.chatIds, expected.chatIds) || !equalIds(actual.noteIds, expected.noteIds)) {
		throw new SourceDeletionError(tr("文件夹已更改，未删除任何内容。请重新打开“删除”以查看其当前内容。", "The folder changed. Nothing was deleted. Open Delete again to review its current contents."), 409, "folder_scope_changed");
	}
	return actual;
}

function blockedIn(title: string | null, code: string, error: string): SourceDeletionError {
	const name = tr(`“${title ?? "未命名会话"}”`, `“${title ?? "Untitled"}”`);
	const message = code === "turn_in_flight" ? tr(`${name}中有回合正在运行 — 请在其结束后再试`, `A turn is running in ${name} — try again when it finishes`)
		: code === "jobs_running" ? tr(`${name}中仍有后台任务在运行 — 请在其结束后再试`, `Background jobs are still running in ${name} — try again when they finish`)
		: code === "extraction_winding_down" ? tr(`${name}的提取仍在收尾 — 请稍后再试`, `The extraction of ${name} is still winding down — try again in a moment`)
		: error;
	return new SourceDeletionError(message, code === "extraction_winding_down" ? 503 : 409, code);
}

/**
 * The sidebar's folder Delete (owner, 2026-11-18): the folder, every
 * subfolder, and every session inside (practice included) go; imported
 * notes and other non-session placements inside move out to the deleted
 * folder's parent (top level for a top-level folder), keeping their graph
 * contribution. `mode` is the session dialog's choice, applied to every
 * session: preserve-graph keeps their graph contributions, delete-nodes
 * removes their traces. The single-session choreography, batched: gates
 * (409, nothing touched) → the sessions' extraction runs cancelled and
 * awaited (503 on timeout) → one synchronous block (one ledger rewrite,
 * the session records, then the organization). Chains' source deletion is
 * unchanged.
 */
export async function deleteFolderWithSessions(folderId: string, mode: ChatDeleteMode, rawScope: unknown): Promise<SourceDirectory & { graphRevision: number; deletedChatIds: string[] }> {
	if (mode !== "preserve-graph" && mode !== "delete-nodes") throw new SourceDeletionError(tr('mode 必须是 "preserve-graph" 或 "delete-nodes"', 'mode must be "preserve-graph" or "delete-nodes"'), 400, "bad_mode");
	const expected = parseFolderDeletionScope(rawScope);
	const initial = sourceDirectory.read();
	const before = requireFolderDeletionScope(initial, folderId, expected);
	const settled = await settleChatsForDeletion(before.chatIds);
	if (settled) {
		const title = initial.sources.find((c) => c.id === settled.chatId)?.label ?? null;
		throw blockedIn(title, settled.failure.code, settled.failure.error);
	}

	// THE SYNC BLOCK — no awaits below. Re-read: the folder's contents may
	// have changed during the wind-down; every target is checked before any
	// write, so a refusal still touches nothing.
	const directory = sourceDirectory.read();
	const targets = requireFolderDeletionScope(directory, folderId, expected);
	const running = new Set(extractionStatuses().map((run) => run.chatId));
	const labels = new Map(directory.sources.map((source) => [source.id, source.label]));
	for (const id of targets.chatIds) {
		const title = labels.get(id) ?? null;
		const blocker = runningWorkBlocker(id);
		if (blocker) throw blockedIn(title, blocker.code, blocker.error);
		if (running.has(id)) throw blockedIn(title, "extraction_winding_down", "");
	}
	const chatIds = new Set(targets.chatIds);
	deleteSourcesTraces(stores.graphStore, chatIds, mode);
	for (const id of chatIds) {
		const outcome = deleteIdleChatRecord(id);
		if (!outcome.ok) throw new SourceDeletionError(outcome.error, outcome.status, outcome.code);
	}
	const state = structuredClone(directory.organization);
	const folderIds = new Set(targets.folderIds);
	const parentId = targets.parentId;
	state.folders = state.folders.filter((f) => !folderIds.has(f.id));
	state.placements = Object.fromEntries(Object.entries(state.placements).flatMap(([id, placement]) => {
		if (chatIds.has(id)) return [];
		if (placement.folderId !== null && folderIds.has(placement.folderId)) return [[id, { ...placement, folderId: parentId }]];
		return [[id, placement]];
	}));
	stores.sourceOrganizationStore.write(state);
	return { ...sourceDirectory.read(), graphRevision: graphRevision(), deletedChatIds: [...chatIds] };
}
