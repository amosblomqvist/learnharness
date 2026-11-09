/**
 * Document-sourced sessions (issue #175): stage the source documents a
 * teaching session is created FROM. The creation route converts each
 * attached file with the SAME local rule the notes import uses
 * (readNotesFile: PDF → Markdown via pdf-markdown, no OCR; MD/TXT as
 * text), then writes the converted text under data/graph/materials/
 * <sourceId>.md — a stable, agent-readable path the session's prompt
 * segment points the read tool at.
 *
 * The graph accumulates the document through the ORDINARY notes-import
 * pipeline: same source identity ("src_" + path/name hash — extraction.ts
 * importNotes), same source record, same extractor → auditor → merger
 * run. That run is model work and can take minutes, so creation starts it
 * in the background (startDocumentExtraction) instead of holding the
 * HTTP response; the session itself never waits on it — the agent reads
 * the staged material directly.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { validNotesPath } from "../../lib/notes-import-limits.ts";
import type { SourceDocumentRef } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { readNotesFile } from "./notes-file.ts";
import { sourceDirectory } from "./source-organization.ts";
import { extraction } from "./chat-handler.ts";

/** The existing source-identity rule (extraction.ts importNotes,
 *  source-organization.ts registerImport): "src_" + the file path/name
 *  hash — same-named files are the same source, by design. */
export function sourceIdForFile(filePath: string): string {
	return `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

/** The converted material's stable home: data/graph/materials/<id>.md. */
export function materialPathFor(sourceId: string): string {
	return path.join(PATHS.materials, `${sourceId}.md`);
}

/** A staged document: the record's reference plus the converted text (the
 *  in-memory handoff to the background extraction; only the SourceDocumentRef
 *  fields persist on the chat record). */
export interface StagedDocument extends SourceDocumentRef {
	text: string;
	/** The PDF-conversion caveat, when the source was a scanned PDF. */
	notice?: string;
}

/** Convert and stage the creation request's files. SYNCHRONOUS with the
 *  creation request by design: conversion is local CPU work bounded by
 *  the import caps (25 MiB per request, 1,000 PDF pages), so a big PDF
 *  makes creation slower but never needs a job registry. A file that
 *  cannot be converted (image-only PDF, unreadable) refuses the WHOLE
 *  creation — the route must not mint a session missing its curriculum. */
export async function stageSessionDocuments(files: readonly File[]): Promise<{ ok: true; documents: StagedDocument[] } | { ok: false; error: string }> {
	const staged: StagedDocument[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		// Same name rule as the notes import (lib/notes-import-limits): a
		// browser basename, no empty/control-character tricks.
		if (!validNotesPath(file.name, file.name)) return { ok: false, error: `"${file.name}" is not a usable file name.` };
		// Same-name files share a source identity; the first wins.
		if (seen.has(file.name)) continue;
		const notes = await readNotesFile(file);
		if (notes.kind === "refused") return { ok: false, error: `${file.name}: ${notes.error}` };
		seen.add(file.name);
		staged.push({ sourceId: sourceIdForFile(file.name), name: file.name, path: materialPathFor(sourceIdForFile(file.name)), text: notes.text });
	}
	fs.mkdirSync(PATHS.materials, { recursive: true });
	for (const doc of staged) fs.writeFileSync(doc.path, doc.text, "utf-8");
	return { ok: true, documents: staged };
}

/** Feed the staged documents into the ordinary notes-import pipeline —
 * registered in the source organization, then one background importNotes
 * run per file (NOT awaited: extractor + auditor are model calls). A
 * refusal (e.g. models not configured yet, or the same source already
 * importing) is logged and swallowed: the graph simply accumulates the
 * document later, on the next explicit import of the same name — the
 * session's own teaching never depends on this run. */
export function startDocumentExtraction(documents: readonly StagedDocument[]): void {
	for (const doc of documents) {
		try {
			sourceDirectory.registerImport(doc.name);
			void extraction.importNotes({ filePath: doc.name, text: doc.text }).catch((err: unknown) => {
				console.error(`[session-documents ${doc.sourceId}] background import failed:`, err instanceof Error ? err.message : err);
			});
		} catch (err) {
			console.error(`[session-documents ${doc.sourceId}] registration failed:`, err instanceof Error ? err.message : err);
		}
	}
	if (documents.length > 0) emit("sources-changed", {});
}
