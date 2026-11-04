import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ParsedDocument } from "./document-parser.ts";

function chatDocDir(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.documents, chatId);
}

function manifestPath(chatId: string): string {
	return path.join(chatDocDir(chatId), "manifest.json");
}

function rawDir(chatId: string): string {
	return path.join(chatDocDir(chatId), "raw");
}

/** Read manifest of documents for a chat session */
export async function getDocuments(chatId: string): Promise<ParsedDocument[]> {
	try {
		const raw = await fs.readFile(manifestPath(chatId), "utf-8");
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

/** Save a parsed document and its raw buffer */
export async function saveDocument(
	chatId: string,
	doc: ParsedDocument,
	rawBuffer?: Buffer,
): Promise<void> {
	const dir = chatDocDir(chatId);
	const raw = rawDir(chatId);
	await fs.mkdir(raw, { recursive: true });

	if (rawBuffer) {
		const filePath = path.join(raw, `${doc.id}_${doc.fileName}`);
		await fs.writeFile(filePath, rawBuffer);
	}

	const existing = await getDocuments(chatId);
	const filtered = existing.filter((d) => d.id !== doc.id && d.fileName !== doc.fileName);
	filtered.push(doc);

	await fs.writeFile(manifestPath(chatId), JSON.stringify(filtered, null, "\t"), "utf-8");
}

/** Delete a document from a chat session */
export async function deleteDocument(chatId: string, docId: string): Promise<void> {
	const existing = await getDocuments(chatId);
	const target = existing.find((d) => d.id === docId);
	if (!target) return;

	const filtered = existing.filter((d) => d.id !== docId);
	await fs.writeFile(manifestPath(chatId), JSON.stringify(filtered, null, "\t"), "utf-8");

	try {
		const filePath = path.join(rawDir(chatId), `${target.id}_${target.fileName}`);
		await fs.unlink(filePath);
	} catch {
		// Ignore if raw file is missing
	}
}
