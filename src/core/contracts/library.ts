/**
 * Course-library contracts — the shared library of learner materials
 * (course library wave, owner-approved plan 2026-10-29).
 *
 * The library is ONE tree shared by every chat: free-form nested folders
 * holding copied-in files (PDF / DOCX / PPTX / images). Any folder or file
 * may carry an optional tag; a file without its own tag inherits the
 * nearest tagged ancestor's. Chats ATTACH items (folders or files) and only
 * attached files are ever in an agent's scope.
 *
 * Pure types + tiny pure helpers (browser-safe — the library page and the
 * Materials panel fold the same tree the server does). The single writer is
 * src/store/library.ts.
 */

// ─── Tags ─────────────────────────────────────────────────────────────────────

/** The tag vocabulary (owner, 2026-10-29). Untagged = general reference. */
export const LIBRARY_TAGS = [
	"lecture",
	"quiz",
	"practice-test",
	"answer-key",
	"homework",
	"notes",
	"syllabus",
] as const;

export type LibraryTag = (typeof LIBRARY_TAGS)[number];

export const LIBRARY_TAG_LABELS: Record<LibraryTag, string> = {
	lecture: "Lecture",
	quiz: "Quiz",
	"practice-test": "Practice Test",
	"answer-key": "Answer Key",
	homework: "Homework",
	notes: "Notes",
	syllabus: "Syllabus",
};

export function isLibraryTag(value: unknown): value is LibraryTag {
	return typeof value === "string" && (LIBRARY_TAGS as readonly string[]).includes(value);
}

// ─── Formats ──────────────────────────────────────────────────────────────────

export type LibraryFileFormat = "pdf" | "docx" | "pptx" | "image";

/** Accepted extensions (owner: modern formats only, 100 MB per file). */
export const LIBRARY_FORMATS: Record<string, { format: LibraryFileFormat; mime: string }> = {
	pdf: { format: "pdf", mime: "application/pdf" },
	docx: { format: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
	pptx: { format: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
	jpg: { format: "image", mime: "image/jpeg" },
	jpeg: { format: "image", mime: "image/jpeg" },
	png: { format: "image", mime: "image/png" },
	gif: { format: "image", mime: "image/gif" },
	webp: { format: "image", mime: "image/webp" },
};

export const LIBRARY_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Formats rejected with a specific message instead of a generic one. */
const REJECTED: Record<string, string> = {
	doc: "Legacy .doc files aren't supported — save it as .docx or PDF and upload that.",
	ppt: "Legacy .ppt files aren't supported — save it as .pptx or PDF and upload that.",
	heic: "HEIC photos aren't supported — export as JPG or PNG and upload that.",
	heif: "HEIF photos aren't supported — export as JPG or PNG and upload that.",
};

export function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type UploadVerdict =
	| { ok: true; ext: string; format: LibraryFileFormat; mime: string }
	| { ok: false; error: string };

/** The upload gate: extension allow-list + the per-file size cap. */
export function classifyUpload(name: string, bytes: number): UploadVerdict {
	const ext = fileExtension(name);
	const rejected = REJECTED[ext];
	if (rejected) return { ok: false, error: rejected };
	const known = LIBRARY_FORMATS[ext];
	if (!known) {
		return { ok: false, error: `Unsupported file type${ext ? ` .${ext}` : ""} — upload PDF, DOCX, PPTX, JPG, PNG, GIF, or WEBP.` };
	}
	if (bytes <= 0) return { ok: false, error: "The file is empty." };
	if (bytes > LIBRARY_MAX_FILE_BYTES) return { ok: false, error: "The file is larger than 100 MB." };
	return { ok: true, ext, ...known };
}

// ─── Records ──────────────────────────────────────────────────────────────────

/** How a file's content is read: PDFs natively, Office files via a
 *  LibreOffice-converted PDF when available, else the in-app extraction
 *  (text + embedded images); images as images. */
export type LibraryReadVia = "pdf" | "converted-pdf" | "extracted" | "image";

export interface LibraryFileMeta {
	ext: string;
	mime: string;
	format: LibraryFileFormat;
	bytes: number;
	/** Content hash — the summary cache key (a summary regenerates only
	 *  when the content changes; retagging never regenerates). */
	sha256: string;
	/** Import processing (conversion / extraction / page count). */
	status: "processing" | "ready" | "failed";
	via?: LibraryReadVia;
	/** Pages (PDF, converted PDF) or slides (extracted PPTX). */
	pages?: number;
	error?: string;
}

export interface LibraryItem {
	id: string;
	parentId: string | null;
	kind: "folder" | "file";
	name: string;
	/** The item's OWN tag (absent = inherit). */
	tag?: LibraryTag;
	createdAt: string;
	updatedAt: string;
	/** Present exactly when kind === "file". */
	file?: LibraryFileMeta;
}

/** data/library/index.json */
export interface LibraryIndex {
	version?: number;
	items: LibraryItem[];
}

export const CURRENT_LIBRARY_VERSION = 1;

/** A cached file summary (data/library/files/<id>/summary.json). */
export interface LibrarySummary {
	/** The content hash it was written for — stale when it differs. */
	sha256: string;
	text: string;
	generatedAt: string;
	/** Provider-qualified model that wrote it. */
	model: string;
}

/** The client's view of a file's summary state (chat Materials panel). */
export type LibrarySummaryState = "ready" | "pending" | "failed";

// ─── Pure tree helpers ────────────────────────────────────────────────────────

export function libraryItemById(items: readonly LibraryItem[], id: string): LibraryItem | undefined {
	return items.find((i) => i.id === id);
}

/** Folders first, then files; each group by name (case-insensitive). */
export function compareLibraryItems(a: LibraryItem, b: LibraryItem): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

export function libraryChildren(items: readonly LibraryItem[], parentId: string | null): LibraryItem[] {
	return items.filter((i) => i.parentId === parentId).sort(compareLibraryItems);
}

/** Root-first ancestor chain of an item, excluding the item itself. A
 *  dangling or cyclic parent link ends the walk (never loops). */
export function libraryAncestors(items: readonly LibraryItem[], id: string): LibraryItem[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const chain: LibraryItem[] = [];
	const seen = new Set<string>([id]);
	let parentId = byId.get(id)?.parentId ?? null;
	while (parentId !== null && !seen.has(parentId)) {
		const parent = byId.get(parentId);
		if (!parent) break;
		chain.unshift(parent);
		seen.add(parentId);
		parentId = parent.parentId;
	}
	return chain;
}

/** "Math 3339/Unit 1/Quizzes/quiz1.pdf" — the display path. */
export function libraryPath(items: readonly LibraryItem[], id: string): string {
	const item = libraryItemById(items, id);
	if (!item) return "";
	return [...libraryAncestors(items, id), item].map((i) => i.name).join("/");
}

/** The item's own tag, else the nearest tagged ancestor's. */
export function effectiveTag(items: readonly LibraryItem[], id: string): LibraryTag | undefined {
	const item = libraryItemById(items, id);
	if (!item) return undefined;
	if (item.tag) return item.tag;
	const ancestors = libraryAncestors(items, id);
	for (let i = ancestors.length - 1; i >= 0; i--) {
		if (ancestors[i]!.tag) return ancestors[i]!.tag;
	}
	return undefined;
}

/** The item and everything beneath it (pre-order, tree-sorted). */
export function librarySubtree(items: readonly LibraryItem[], id: string): LibraryItem[] {
	const root = libraryItemById(items, id);
	if (!root) return [];
	const out: LibraryItem[] = [];
	const seen = new Set<string>();
	const walk = (item: LibraryItem) => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		out.push(item);
		if (item.kind === "folder") for (const child of libraryChildren(items, item.id)) walk(child);
	};
	walk(root);
	return out;
}

/** True when `candidateId` is `ancestorId` itself or lies beneath it — the
 *  move gate (a folder can never move into its own subtree). */
export function isInLibrarySubtree(items: readonly LibraryItem[], ancestorId: string, candidateId: string): boolean {
	if (ancestorId === candidateId) return true;
	return libraryAncestors(items, candidateId).some((a) => a.id === ancestorId);
}

/** Every FILE an attachment list puts in scope: attached files plus all
 *  files beneath attached folders — deduped, in attachment order, each
 *  folder's files in tree order. Unknown ids (deleted items) drop out. */
export function resolveAttachmentFiles(items: readonly LibraryItem[], attachmentIds: readonly string[]): LibraryItem[] {
	const out: LibraryItem[] = [];
	const seen = new Set<string>();
	for (const id of attachmentIds) {
		for (const item of librarySubtree(items, id)) {
			if (item.kind !== "file" || seen.has(item.id)) continue;
			seen.add(item.id);
			out.push(item);
		}
	}
	return out;
}

/** Name gate for folders and renames: trimmed, non-empty, no path
 *  separators, bounded. Returns the cleaned name or an error. */
export function validateLibraryName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
	if (typeof name !== "string") return { ok: false, error: "Name must be a string" };
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, error: "Name can't be empty" };
	if (/[/\\]/.test(trimmed)) return { ok: false, error: "Name can't contain / or \\" };
	if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return { ok: false, error: "Name can't contain control characters" };
	if (trimmed.length > 200) return { ok: false, error: "Name is too long (200 characters max)" };
	return { ok: true, name: trimmed };
}
