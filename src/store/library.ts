/**
 * LibraryStore — the fs adapter for the shared course library
 * (course library wave, owner-approved plan 2026-10-29).
 *
 * Layout under PATHS.library:
 *   index.json                       the tree (LibraryIndex, schema-stamped)
 *   files/<id>/original.<ext>        the copied-in upload
 *   files/<id>/converted.pdf         LibreOffice conversion (Office files)
 *   files/<id>/extracted.json        in-app extraction fallback (Office files)
 *   files/<id>/summary.json          the cached summary (LibrarySummary)
 *
 * Implements core/ports.ts LibraryStore; wired in src/server/stores.ts.
 * Idioms: sync fs (each read-modify-write has no awaits, so it is atomic
 * within the event loop), id-guarded paths, tab-indented JSON, and the
 * index replaced via tmp + rename so a crash never leaves a torn tree.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { LibraryDerivedName, LibraryStore } from "../core/ports.ts";
import type { LibraryFileFormat, LibraryFileMeta, LibraryIndex, LibraryItem, LibrarySummary, LibraryTag } from "../core/contracts.ts";
import { CURRENT_LIBRARY_VERSION, isInLibrarySubtree, librarySubtree, validateLibraryName } from "../core/contracts.ts";

const INDEX_FILE = () => path.join(PATHS.library, "index.json");
const FILES_DIR = () => path.join(PATHS.library, "files");

function fileDir(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid library id: ${id}`);
	return path.join(FILES_DIR(), id);
}

function newId(prefix: "fld" | "file"): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function readIndex(): LibraryIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(INDEX_FILE(), "utf-8"));
	} catch {
		return { items: [] };
	}
	// The chat store's honest refusal: a NEWER-stamped index (downgrade) is
	// never rewritten by a build that doesn't understand it.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_LIBRARY_VERSION) {
		throw new Error(`Library index stamped with schema version ${v} > ${CURRENT_LIBRARY_VERSION} — this app build is older`);
	}
	const items = (parsed as { items?: unknown }).items;
	return { items: Array.isArray(items) ? (items as LibraryItem[]) : [] };
}

function writeIndex(items: LibraryItem[]): void {
	fs.mkdirSync(PATHS.library, { recursive: true });
	const file = INDEX_FILE();
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	const body: LibraryIndex = { version: CURRENT_LIBRARY_VERSION, items };
	try {
		fs.writeFileSync(tmp, JSON.stringify(body, null, "\t"), "utf-8");
		fs.renameSync(tmp, file);
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename already consumed it */
		}
	}
}

function requireName(name: string): string {
	const verdict = validateLibraryName(name);
	if (!verdict.ok) throw new Error(verdict.error);
	return verdict.name;
}

function requireFolder(items: LibraryItem[], parentId: string | null): void {
	if (parentId === null) return;
	const parent = items.find((i) => i.id === parentId);
	if (!parent) throw new Error(`Folder not found: ${parentId}`);
	if (parent.kind !== "folder") throw new Error("Items can only live inside folders");
}

function listItems(): LibraryItem[] {
	return readIndex().items;
}

function getItem(id: string): LibraryItem | null {
	return readIndex().items.find((i) => i.id === id) ?? null;
}

function createFolder(parentId: string | null, name: string): LibraryItem {
	const { items } = readIndex();
	requireFolder(items, parentId);
	const now = new Date().toISOString();
	const folder: LibraryItem = { id: newId("fld"), parentId, kind: "folder", name: requireName(name), createdAt: now, updatedAt: now };
	writeIndex([...items, folder]);
	emit("library-changed", {});
	return folder;
}

function addFile(
	parentId: string | null,
	name: string,
	bytes: Uint8Array,
	kind: { ext: string; mime: string; format: LibraryFileFormat },
): LibraryItem {
	const { items } = readIndex();
	requireFolder(items, parentId);
	const cleanName = requireName(name);
	const id = newId("file");
	const dir = fileDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `original.${kind.ext}`), bytes);
	const now = new Date().toISOString();
	const item: LibraryItem = {
		id,
		parentId,
		kind: "file",
		name: cleanName,
		createdAt: now,
		updatedAt: now,
		file: {
			ext: kind.ext,
			mime: kind.mime,
			format: kind.format,
			bytes: bytes.byteLength,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
			status: "processing",
		},
	};
	writeIndex([...items, item]);
	emit("library-changed", {});
	return item;
}

function updateItem(id: string, patch: { name?: string; parentId?: string | null; tag?: LibraryTag | null }): LibraryItem {
	const { items } = readIndex();
	const index = items.findIndex((i) => i.id === id);
	if (index < 0) throw new Error(`Library item not found: ${id}`);
	const next: LibraryItem = { ...items[index]! };
	if (patch.name !== undefined) next.name = requireName(patch.name);
	if (patch.parentId !== undefined) {
		requireFolder(items, patch.parentId);
		if (patch.parentId !== null && isInLibrarySubtree(items, id, patch.parentId)) {
			throw new Error("A folder can't move into itself or one of its subfolders");
		}
		next.parentId = patch.parentId;
	}
	if (patch.tag !== undefined) {
		if (patch.tag === null) delete next.tag;
		else next.tag = patch.tag;
	}
	next.updatedAt = new Date().toISOString();
	const updated = [...items];
	updated[index] = next;
	writeIndex(updated);
	emit("library-changed", {});
	return next;
}

function setFileMeta(id: string, patch: Partial<Pick<LibraryFileMeta, "status" | "via" | "pages" | "error">>): LibraryItem {
	const { items } = readIndex();
	const index = items.findIndex((i) => i.id === id);
	const current = items[index];
	if (!current?.file) throw new Error(`Library file not found: ${id}`);
	const file = { ...current.file, ...patch };
	for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
		if (patch[key] === undefined) delete file[key];
	}
	const next: LibraryItem = { ...current, file };
	const updated = [...items];
	updated[index] = next;
	writeIndex(updated);
	emit("library-changed", {});
	return next;
}

function deleteItem(id: string): string[] {
	const { items } = readIndex();
	const doomed = librarySubtree(items, id);
	if (doomed.length === 0) return [];
	const ids = new Set(doomed.map((i) => i.id));
	writeIndex(items.filter((i) => !ids.has(i.id)));
	// Records first, bytes second: a crash between leaves orphan
	// directories (harmless), never index entries pointing at nothing.
	for (const item of doomed) {
		if (item.kind === "file") fs.rmSync(fileDir(item.id), { recursive: true, force: true });
	}
	emit("library-changed", {});
	return [...ids];
}

function originalPath(id: string): string {
	const item = getItem(id);
	if (!item?.file) throw new Error(`Library file not found: ${id}`);
	return path.join(fileDir(id), `original.${item.file.ext}`);
}

function derivedPath(id: string, name: LibraryDerivedName): string {
	return path.join(fileDir(id), name);
}

function writeDerived(id: string, name: LibraryDerivedName, data: Uint8Array | string): void {
	const dir = fileDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), data);
}

function readSummary(id: string): LibrarySummary | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(fileDir(id), "summary.json"), "utf-8")) as LibrarySummary;
		return typeof parsed.text === "string" && typeof parsed.sha256 === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** Summary writes announce: open Materials panels flip pending → ready. */
function writeSummary(id: string, summary: LibrarySummary): void {
	const dir = fileDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, "\t"), "utf-8");
	emit("library-changed", {});
}

export const libraryStore: LibraryStore = {
	listItems,
	getItem,
	createFolder,
	addFile,
	updateItem,
	setFileMeta,
	deleteItem,
	originalPath,
	derivedPath,
	writeDerived,
	readSummary,
	writeSummary,
};
