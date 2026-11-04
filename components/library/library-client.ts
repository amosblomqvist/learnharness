"use client";

import { useCallback, useEffect, useState } from "react";
import { useServerEvent } from "@/components/server-events";
import type { ChatAttachmentsSnapshot, LibraryDeletionImpact, LibraryItem, LibrarySnapshot, LibraryTag } from "@/src/core";

/**
 * The course library's client seam (course library wave, 2026-10-29): the
 * library page, the attach picker, and the Materials panel all read the
 * same snapshot and write through these helpers. Truth refreshes on the
 * events channel (library-changed) — notify, then fetch.
 */

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
	return body;
}

export function useLibrary(): { snapshot: LibrarySnapshot | null; error: string | null; refresh: () => void } {
	const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(() => {
		fetch("/api/library", { cache: "no-store" })
			.then((r) => json<LibrarySnapshot>(r))
			.then((s) => {
				setSnapshot(s);
				setError(null);
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("library-changed", refresh);
	return { snapshot, error, refresh };
}

export function createFolder(parentId: string | null, name: string): Promise<{ item: LibraryItem }> {
	return fetch("/api/library/folders", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ parentId, name }),
	}).then((r) => json(r));
}

export function updateItem(id: string, patch: { name?: string; parentId?: string | null; tag?: LibraryTag | null }): Promise<{ item: LibraryItem }> {
	return fetch(`/api/library/items/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	}).then((r) => json(r));
}

export function deletionImpact(id: string): Promise<{ impact: LibraryDeletionImpact }> {
	return fetch(`/api/library/items/${id}?dryRun=1`, { method: "DELETE" }).then((r) => json(r));
}

export function deleteItem(id: string): Promise<{ impact: LibraryDeletionImpact }> {
	return fetch(`/api/library/items/${id}`, { method: "DELETE" }).then((r) => json(r));
}

export type UploadOutcome = { name: string; ok: true } | { name: string; ok: false; error: string };

/** One request per file — the proxy's body buffer is sized for one 100MB
 *  upload (next.config.ts proxyClientMaxBodySize). */
export async function uploadFiles(parentId: string | null, files: readonly File[], onProgress?: (done: number) => void): Promise<UploadOutcome[]> {
	const out: UploadOutcome[] = [];
	for (const file of files) {
		const form = new FormData();
		form.set("parentId", parentId ?? "");
		form.append("files", file, file.name);
		try {
			const res = await fetch("/api/library/upload", { method: "POST", body: form });
			const body = (await res.json().catch(() => ({}))) as { results?: { ok: boolean; error?: string }[]; error?: string };
			const result = body.results?.[0];
			out.push(result?.ok ? { name: file.name, ok: true } : { name: file.name, ok: false, error: result?.error ?? body.error ?? `Upload failed (${res.status})` });
		} catch {
			out.push({ name: file.name, ok: false, error: "Upload failed — network error" });
		}
		onProgress?.(out.length);
	}
	return out;
}

export function useChatAttachments(chatId: string): {
	snapshot: ChatAttachmentsSnapshot | null;
	setAttachments: (ids: string[]) => Promise<void>;
	error: string | null;
} {
	const [snapshot, setSnapshot] = useState<ChatAttachmentsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(() => {
		fetch(`/api/chats/${chatId}/attachments`, { cache: "no-store" })
			.then((r) => json<ChatAttachmentsSnapshot>(r))
			.then(setSnapshot)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [chatId]);
	useEffect(refresh, [refresh]);
	useServerEvent("library-changed", refresh);
	useServerEvent("record-changed", (p) => {
		if (p.chatId === chatId) refresh();
	});
	const setAttachments = useCallback(
		async (ids: string[]) => {
			try {
				const next = await fetch(`/api/chats/${chatId}/attachments`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ attachments: ids }),
				}).then((r) => json<ChatAttachmentsSnapshot>(r));
				setSnapshot(next);
				setError(null);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[chatId],
	);
	return { snapshot, setAttachments, error };
}
