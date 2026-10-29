/**
 * THE COURSE-LIBRARY SERVICE SEAM (course library wave, 2026-10-29):
 * upload → background import processing, deletion choreography, and
 * chat-attachment validation. The store (src/store/library.ts) is the
 * single writer; this module orchestrates it with the agent layer's
 * readers (pdf-ops, LibreOffice conversion, OOXML extraction).
 *
 * Import processing, per format:
 * - pdf:    probe + page count → via "pdf"
 * - image:  content sniff (the extension can lie) → via "image"
 * - docx/pptx: LibreOffice → converted.pdf when installed ("converted-pdf");
 *   otherwise, or when conversion fails, in-app extraction →
 *   extracted.json ("extracted")
 * Failures mark the file "failed" with the reason — it stays in the tree
 * so the learner sees what happened and can delete it.
 */

import * as fs from "node:fs";
import { stores } from "./stores.ts";
import { emit } from "../core/events.ts";
import type { ChatAttachmentsSnapshot, LibraryDeletionImpact, LibraryItem, LibrarySnapshot, LibrarySummaryState } from "../core/contracts.ts";
import { classifyUpload, effectiveTag, libraryAncestors, libraryPath, librarySubtree, resolveAttachmentFiles } from "../core/contracts.ts";
import { pdfPageCount } from "../agent/subagents/pdf-ops.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/index.ts";
import { extractOffice, type ExtractedDocument } from "../agent/library/office-extract.ts";
import { convertToPdf, findSoffice } from "../agent/library/libreoffice.ts";
import { birthSessionOf } from "../core/session-clusters.ts";

const library = () => stores.libraryStore;

// ─── Import processing (one at a time — conversions are CPU-heavy) ───────────

interface ProcessingGlobal {
	__lhLibraryQueue?: { tail: Promise<void>; queued: Set<string> };
}

/** globalThis-backed (the turn-liveness rationale): Next dev compiles each
 *  route as its own module entry; one queue must span them. */
function queue() {
	const g = globalThis as typeof globalThis & ProcessingGlobal;
	return (g.__lhLibraryQueue ??= { tail: Promise.resolve(), queued: new Set() });
}

/** Enqueue a file's import processing; idempotent while queued. Returns
 *  the promise that settles when THIS file is done (tests await it). */
export function processLibraryFile(id: string): Promise<void> {
	const q = queue();
	if (q.queued.has(id)) return q.tail;
	q.queued.add(id);
	q.tail = q.tail.then(async () => {
		try {
			await runProcessing(id);
		} catch (err) {
			console.error(`[library ${id}] processing crashed:`, err);
		} finally {
			q.queued.delete(id);
		}
	});
	return q.tail;
}

/** Re-enqueue files left "processing" by a restart. Cheap; the library
 *  list route calls it on every read. */
export function resumeLibraryProcessing(): void {
	for (const item of library().listItems()) {
		if (item.file?.status === "processing" && !queue().queued.has(item.id)) void processLibraryFile(item.id);
	}
}

async function runProcessing(id: string): Promise<void> {
	const item = library().getItem(id);
	if (!item?.file) return; // deleted while queued
	const original = library().originalPath(id);
	try {
		switch (item.file.format) {
			case "pdf": {
				const pages = await pdfPageCount(original);
				library().setFileMeta(id, { status: "ready", via: "pdf", pages, error: undefined });
				return;
			}
			case "image": {
				const head = fs.readFileSync(original).subarray(0, 64);
				if (!detectSupportedImageMimeType(head)) throw new Error("The file isn't a readable JPG, PNG, GIF, or WEBP image");
				library().setFileMeta(id, { status: "ready", via: "image", error: undefined });
				return;
			}
			case "docx":
			case "pptx":
				await processOffice(id, item.file.format, original);
				return;
		}
	} catch (err) {
		if (!library().getItem(id)) return;
		library().setFileMeta(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
	}
}

async function processOffice(id: string, format: "docx" | "pptx", original: string): Promise<void> {
	const soffice = findSoffice();
	if (soffice) {
		try {
			const pdf = await convertToPdf(soffice, original);
			if (!library().getItem(id)) return;
			library().writeDerived(id, "converted.pdf", pdf);
			const pages = await pdfPageCount(library().derivedPath(id, "converted.pdf"));
			library().setFileMeta(id, { status: "ready", via: "converted-pdf", pages, error: undefined });
			return;
		} catch (err) {
			// The hybrid's fallback: a failed conversion still gets read.
			console.error(`[library ${id}] LibreOffice conversion failed, using in-app extraction:`, err);
		}
	}
	const extracted = extractOffice(new Uint8Array(fs.readFileSync(original)), format);
	if (!library().getItem(id)) return;
	library().writeDerived(id, "extracted.json", JSON.stringify(extracted, null, "\t"));
	library().setFileMeta(id, { status: "ready", via: "extracted", pages: extracted.units.length, error: undefined });
}

/** The extracted-document record for a file read "extracted"; null when
 *  absent or corrupt. */
export function readExtracted(id: string): ExtractedDocument | null {
	try {
		return JSON.parse(fs.readFileSync(library().derivedPath(id, "extracted.json"), "utf-8")) as ExtractedDocument;
	} catch {
		return null;
	}
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export type UploadResult = { ok: true; item: LibraryItem } | { ok: false; name: string; error: string };

/** Validate + copy one uploaded file into a folder, then enqueue its
 *  import processing. Never throws for learner-correctable problems. */
export function uploadLibraryFile(parentId: string | null, name: string, bytes: Uint8Array): UploadResult {
	const verdict = classifyUpload(name, bytes.byteLength);
	if (!verdict.ok) return { ok: false, name, error: verdict.error };
	try {
		const item = library().addFile(parentId, name, bytes, verdict);
		void processLibraryFile(item.id);
		return { ok: true, item };
	} catch (err) {
		return { ok: false, name, error: err instanceof Error ? err.message : String(err) };
	}
}

// ─── Deletion choreography ────────────────────────────────────────────────────

function attachingChats(ids: ReadonlySet<string>): { id: string; title: string; attachments: string[] }[] {
	const out: { id: string; title: string; attachments: string[] }[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		const attachments = record?.attachments ?? [];
		if (attachments.some((a) => ids.has(a))) out.push({ id: summary.id, title: summary.title, attachments });
	}
	return out;
}

/** What deleting an item would take with it — the confirm dialog's list.
 *  A chat counts as using the item when it attached the item or anything
 *  beneath it (those references get detached) OR attached an ancestor
 *  folder (nothing to detach — the files just leave that folder's scope). */
export function libraryDeletionImpact(id: string): LibraryDeletionImpact | null {
	const items = library().listItems();
	if (!items.some((i) => i.id === id)) return null;
	const itemIds = librarySubtree(items, id).map((i) => i.id);
	const touched = new Set([...itemIds, ...libraryAncestors(items, id).map((i) => i.id)]);
	return { itemIds, chats: attachingChats(touched).map(({ id: chatId, title }) => ({ id: chatId, title })) };
}

/** Delete an item (and subtree) and detach it from every chat that
 *  attached any removed id. Past messages are untouched. */
export function deleteLibraryItem(id: string): LibraryDeletionImpact | null {
	const impact = libraryDeletionImpact(id);
	if (!impact) return null;
	const doomed = new Set(impact.itemIds);
	for (const chat of attachingChats(doomed)) {
		stores.chatStore.saveAttachments(chat.id, chat.attachments.filter((a) => !doomed.has(a)));
		emit("record-changed", { chatId: chat.id });
	}
	library().deleteItem(id);
	return impact;
}

// ─── Chat attachments ─────────────────────────────────────────────────────────

/** Validate + persist a chat's attachment list (replace-whole). Unknown
 *  ids are a 400 at the route; duplicates collapse, order kept. */
export function setChatAttachments(chatId: string, ids: string[]): { ok: true; attachments: string[] } | { ok: false; error: string } {
	const items = library().listItems();
	const known = new Set(items.map((i) => i.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length > 0) return { ok: false, error: `Unknown library item(s): ${unknown.join(", ")}` };
	const attachments = [...new Set(ids)];
	stores.chatStore.saveAttachments(chatId, attachments);
	emit("record-changed", { chatId });
	return { ok: true, attachments };
}

/** The files a chat's attachments put in scope (live library view). */
export function chatAttachmentFiles(chatId: string): LibraryItem[] {
	const attachments = stores.chatStore.getChat(chatId)?.attachments ?? [];
	return attachments.length ? resolveAttachmentFiles(library().listItems(), attachments) : [];
}

// ─── Snapshots (the routes' read payloads) ────────────────────────────────────

/** A file's summary state for the UI: ready when a summary for the CURRENT
 *  content exists; otherwise whatever the summary service reports (pending
 *  while generating, failed after an error); absent = never requested. */
export function summaryStateOf(item: LibraryItem): LibrarySummaryState | undefined {
	if (!item.file) return undefined;
	if (library().readSummary(item.id)?.sha256 === item.file.sha256) return "ready";
	return summaryStatusOverride.current?.(item.id);
}

/** Late-bound hook the summary service registers (it lives in its own
 *  module and imports this one — the hook keeps the import one-way). */
export const summaryStatusOverride: { current?: (fileId: string) => LibrarySummaryState | undefined } = {};

export function librarySnapshot(): LibrarySnapshot {
	resumeLibraryProcessing();
	const items = library().listItems();
	const summaries: Record<string, LibrarySummaryState> = {};
	for (const item of items) {
		const state = summaryStateOf(item);
		if (state) summaries[item.id] = state;
	}
	return { items, summaries, libreOffice: findSoffice() !== null };
}

export function chatAttachmentsSnapshot(chatId: string): ChatAttachmentsSnapshot {
	const attachments = stores.chatStore.getChat(chatId)?.attachments ?? [];
	const items = library().listItems();
	return {
		attachments,
		items: attachments.flatMap((id) => {
			const item = items.find((i) => i.id === id);
			if (!item) return [];
			const tag = effectiveTag(items, id);
			return [{
				id,
				kind: item.kind,
				name: item.name,
				path: libraryPath(items, id),
				...(tag ? { tag } : {}),
				fileCount: resolveAttachmentFiles(items, [id]).length,
			}];
		}),
		files: resolveAttachmentFiles(items, attachments).map((f) => {
			const tag = effectiveTag(items, f.id);
			const summary = summaryStateOf(f);
			return {
				id: f.id,
				name: f.name,
				path: libraryPath(items, f.id),
				...(tag ? { tag } : {}),
				format: f.file!.format,
				status: f.file!.status,
				...(f.file!.pages !== undefined ? { pages: f.file!.pages } : {}),
				...(summary ? { summary } : {}),
			};
		}),
	};
}

/** PRACTICE INHERITANCE (owner rulings 2026-10-29): a practice session
 *  started from picked propositions attaches whatever each proposition's
 *  BIRTH chat attached — deduped, in pick order, items still in the
 *  library only. Notes-import births (src_…) carry no attachments. */
export function inheritedAttachments(nodeIds: readonly string[]): string[] {
	const nodes = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	const known = new Set(library().listItems().map((i) => i.id));
	const out: string[] = [];
	const seenChats = new Set<string>();
	for (const id of nodeIds) {
		const node = nodes.get(id);
		const birth = node ? birthSessionOf(node) : null;
		if (!birth || seenChats.has(birth)) continue;
		seenChats.add(birth);
		for (const a of stores.chatStore.getChat(birth)?.attachments ?? []) {
			if (known.has(a) && !out.includes(a)) out.push(a);
		}
	}
	return out;
}
