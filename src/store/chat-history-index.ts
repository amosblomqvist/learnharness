import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Tokenizer, TokenType } from "@streamparser/json";
import { CURRENT_CHAT_VERSION, type ChatRecord } from "../core/contracts/chat.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const FORMAT = 1;
const CHUNK_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const OPENING_FIELDS = new Set(["id", "title", "kind", "version"]);
const indexFile = (file: string) => `${file}.history.idx`;

interface HistoryIndex {
	format: number;
	revision: string;
	offsets: number[];
	fields: Record<string, unknown>;
}

function revisionOf({ dev, ino, size, mtimeNs, ctimeNs }: fs.BigIntStats): string {
	return [dev, ino, size, mtimeNs, ctimeNs].join(":");
}

/** The library handles UTF-8, escapes and tokens split across reads. We
 * retain only top-level opening metadata and boundaries in messages[]. */
async function locate(source: FileHandle) {
	const tokenizer = new Tokenizer({ stringBufferSize: CHUNK_BYTES });
	const fields: HistoryIndex["fields"] = {};
	let offsets: number[] | undefined;
	let inMessages = false;
	let depth = 0;
	let key: string | undefined;
	let expectValue = false;

	tokenizer.onToken = ({ token, value, offset }) => {
		if (depth === 1) {
			if (expectValue) {
				expectValue = false;
				if (key === "messages") {
					if (token !== TokenType.LEFT_BRACKET) throw new Error("Invalid message array");
					offsets = [];
					inMessages = true;
				} else if (key !== undefined && OPENING_FIELDS.has(key)) fields[key] = value;
			} else if (token === TokenType.COLON) expectValue = true;
			else if (token === TokenType.STRING) key = value as string;
		}
		if (inMessages && depth === 2) {
			if (token === TokenType.LEFT_BRACE) offsets!.push(offset);
			else if (token === TokenType.RIGHT_BRACKET) {
				offsets!.push(offset);
				inMessages = false;
			} else if (token !== TokenType.COMMA) throw new Error("Invalid native message");
		}
		if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) depth++;
		if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth--;
	};
	for await (const chunk of source.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) tokenizer.write(chunk);
	tokenizer.end();
	if (depth !== 0 || !offsets?.length) throw new Error("Invalid chat history index source");
	return { offsets, fields };
}

async function buildIndex(file: string): Promise<void> {
	try {
		const source = await fs.promises.open(file, "r");
		try {
			const revision = revisionOf(await source.stat({ bigint: true }));
			const layout = await locate(source);
			const text = JSON.stringify({ format: FORMAT, revision, ...layout } satisfies HistoryIndex);
			if (Buffer.byteLength(text) > MAX_INDEX_BYTES) return;
			if (revision === revisionOf(fs.statSync(file, { bigint: true }))) writeFileAtomicSync(indexFile(file), text);
		} finally { await source.close(); }
	} catch {
		// The canonical record remains available without the index.
	}
}

const pendingBuilds = new Map<string, { dirty: boolean; done: Promise<void> }>();

/** Refresh after the canonical save returns. A burst of saves shares one
 * scan, with one more pass if the file changed while it was being read. */
export function rebuildChatHistoryIndex(file: string, changed = false): Promise<void> {
	const pending = pendingBuilds.get(file);
	if (pending) {
		pending.dirty ||= changed;
		return pending.done;
	}
	const job = { dirty: false, done: Promise.resolve() };
	job.done = (async () => {
		do {
			job.dirty = false;
			await buildIndex(file);
		} while (job.dirty);
	})().finally(() => pendingBuilds.delete(file));
	pendingBuilds.set(file, job);
	return job.done;
}

function readRange(fd: number, start: number, length: number): Buffer {
	const bytes = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const size = fs.readSync(fd, bytes, filled, length - filled, start + filled);
		if (!size) throw new Error("Incomplete indexed read");
		filled += size;
	}
	return bytes;
}

function readIndex(file: string): HistoryIndex | null {
	const fd = fs.openSync(indexFile(file), "r");
	try {
		const { size } = fs.fstatSync(fd);
		if (size <= 0 || size > MAX_INDEX_BYTES) return null;
		const index = JSON.parse(readRange(fd, 0, size).toString("utf8")) as HistoryIndex;
		return index.format === FORMAT && Array.isArray(index.offsets) && index.offsets.length && index.fields ? index : null;
	} finally { fs.closeSync(fd); }
}

export interface IndexedChatHistory {
	chat: Pick<ChatRecord, "id" | "title" | "kind">;
	messages: LhMessage[];
	start: number;
	total: number;
	revision: string;
}

/** before is an exclusive native message ordinal, defaulting to the tail.
 * Only the size-limited sidecar and the requested message range are read. */
export function readChatHistoryIndex(
	file: string,
	{ limit, maxBytes, before }: { limit: number; maxBytes: number; before?: number },
): IndexedChatHistory | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(limit) || limit < 1) return null;
	try {
		const index = readIndex(file);
		if (!index) return null;
		const source = fs.openSync(file, "r");
		try {
			const info = fs.fstatSync(source, { bigint: true });
			const revision = revisionOf(info);
			if (revision !== index.revision) return null;
			const { id, title, kind, version } = index.fields;
			if (typeof id !== "string" || typeof title !== "string" || (kind !== undefined && kind !== "teach" && kind !== "practice")) return null;
			if (typeof version === "number" && version > CURRENT_CHAT_VERSION) return null;
			const { offsets } = index;
			const total = offsets.length - 1;
			const end = before ?? total;
			if (!Number.isSafeInteger(end) || end < 0 || end > total) return null;
			let start = Math.max(0, end - limit);
			const stop = offsets[end]!;
			if (!Number.isSafeInteger(stop) || stop > Number(info.size)) return null;
			while (start < end && stop - offsets[start]! > maxBytes) start++;
			const from = offsets[start]!;
			if (!Number.isSafeInteger(from) || from < 0 || from > stop || (start < end && from === stop)) return null;
			const slice = start === end ? "" : readRange(source, from, stop - from).toString("utf8").trimEnd().replace(/,$/, "");
			const messages = JSON.parse(`[${slice}]`) as LhMessage[];
			if (messages.length !== end - start || revision !== revisionOf(fs.fstatSync(source, { bigint: true }))) return null;
			return { chat: { id, title, kind }, messages, start, total, revision };
		} finally { fs.closeSync(source); }
	} catch { return null; }
}

export function deleteChatHistoryIndex(file: string): void {
	try {
		fs.unlinkSync(indexFile(file));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[store] could not remove chat history index:", error);
	}
	removeLeftoverTemps(indexFile(file));
}
