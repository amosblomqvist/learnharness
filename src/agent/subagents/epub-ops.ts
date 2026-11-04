import * as fs from "node:fs/promises";
import * as path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { DOMParser, parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * EPUB reading layer (session attachments, 2026-10-29) — the epub_* tools'
 * engine, the EPUB sibling of pdf-ops. An EPUB is a zip of XHTML chapters:
 * container.xml names the OPF package, the OPF spine gives reading order,
 * and the nav document (EPUB 3) or NCX (EPUB 2) gives chapter titles.
 *
 * Chapters are SPINE ITEMS, numbered 1..N in reading order — the unit the
 * agent reads, cites and searches by. Each is converted XHTML → Markdown
 * (linkedom + turndown, the web tool's pair) so the agent reads structure
 * (headings, lists, emphasis) instead of markup.
 *
 * Lazy by design: the zip is indexed without inflating, and only the
 * documents a call needs are inflated. Parsed books cache by path+mtime so
 * a reading session's info → read → search calls don't re-open the zip.
 */

export class EpubError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EpubError";
	}
}

export interface EpubChapterInfo {
	/** 1-based position in the spine (reading order). */
	chapter: number;
	title: string;
	words: number;
}

export interface EpubInfo {
	title: string;
	author: string;
	chapters: EpubChapterInfo[];
}

export interface EpubSearchHit {
	chapter: number;
	chapterTitle: string;
	/** Nearest heading above the hit inside the chapter, if any. */
	heading?: string;
	text: string;
}

interface SpineItem {
	/** Zip entry name. */
	entry: string;
	title: string;
}

interface Book {
	title: string;
	author: string;
	spine: SpineItem[];
	bytes: Uint8Array;
	/** Converted chapters, filled on demand. */
	markdown: Map<number, string>;
}

/** Font obfuscation (IDPF / Adobe) is not DRM — fonts aren't content. */
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style"]);

const cache = new Map<string, { mtimeMs: number; book: Book }>();
const CACHE_MAX = 8;

function inflate(bytes: Uint8Array, names: string[]): Record<string, Uint8Array> {
	const want = new Set(names);
	try {
		return unzipSync(bytes, { filter: (f) => want.has(f.name) });
	} catch {
		throw new EpubError("Not a readable EPUB (the zip archive is damaged or not a zip).");
	}
}

function entryNames(bytes: Uint8Array): string[] {
	const names: string[] = [];
	try {
		unzipSync(bytes, {
			filter: (f) => {
				names.push(f.name);
				return false;
			},
		});
	} catch {
		throw new EpubError("Not a readable EPUB (the zip archive is damaged or not a zip).");
	}
	return names;
}

function xml(text: string) {
	return new DOMParser().parseFromString(text, "text/xml");
}

/** Resolve an href relative to the document that contains it, as a zip entry name. */
function resolveHref(base: string, href: string): string {
	const clean = decodeURIComponent(href.split("#")[0]!);
	return path.posix.normalize(path.posix.join(path.posix.dirname(base), clean));
}

/** href (zip entry) → title, from the nav document or the NCX. */
function tocTitles(bytes: Uint8Array, opfPath: string, opf: ReturnType<typeof xml>): Map<string, string> {
	const titles = new Map<string, string>();
	const items = [...opf.getElementsByTagName("item")];
	const nav = items.find((i) => (i.getAttribute("properties") ?? "").split(/\s+/).includes("nav"));
	const spineToc = opf.getElementsByTagName("spine")[0]?.getAttribute("toc");
	const ncx = items.find((i) => i.getAttribute("media-type") === "application/x-dtbncx+xml" || (spineToc && i.getAttribute("id") === spineToc));
	if (nav?.getAttribute("href")) {
		const navPath = resolveHref(opfPath, nav.getAttribute("href")!);
		const navBytes = inflate(bytes, [navPath])[navPath];
		if (navBytes) {
			const { document } = parseHTML(strFromU8(navBytes));
			const tocNav = [...document.querySelectorAll("nav")].find((n) => /\btoc\b/.test(n.getAttribute("epub:type") ?? "")) ?? document.querySelector("nav");
			for (const a of tocNav?.querySelectorAll("a[href]") ?? []) {
				const target = resolveHref(navPath, a.getAttribute("href")!);
				const label = a.textContent?.trim();
				if (label && !titles.has(target)) titles.set(target, label);
			}
		}
	}
	if (titles.size === 0 && ncx?.getAttribute("href")) {
		const ncxPath = resolveHref(opfPath, ncx.getAttribute("href")!);
		const ncxBytes = inflate(bytes, [ncxPath])[ncxPath];
		if (ncxBytes) {
			const doc = xml(strFromU8(ncxBytes));
			for (const point of doc.getElementsByTagName("navPoint")) {
				const src = point.getElementsByTagName("content")[0]?.getAttribute("src");
				const label = point.getElementsByTagName("text")[0]?.textContent?.trim();
				if (src && label) {
					const target = resolveHref(ncxPath, src);
					if (!titles.has(target)) titles.set(target, label);
				}
			}
		}
	}
	return titles;
}

function assertNotEncrypted(bytes: Uint8Array, names: string[], spine: SpineItem[]) {
	if (!names.includes("META-INF/encryption.xml")) return;
	const doc = xml(strFromU8(inflate(bytes, ["META-INF/encryption.xml"])["META-INF/encryption.xml"]!));
	const content = new Set(spine.map((s) => s.entry));
	for (const data of doc.getElementsByTagName("enc:EncryptedData")) {
		const algorithm = data.getElementsByTagName("enc:EncryptionMethod")[0]?.getAttribute("Algorithm") ?? "";
		const uri = data.getElementsByTagName("enc:CipherReference")[0]?.getAttribute("URI") ?? "";
		if (!FONT_OBFUSCATION.has(algorithm) && content.has(path.posix.normalize(decodeURIComponent(uri)))) {
			throw new EpubError("This EPUB is DRM-protected (its chapters are encrypted), so it can't be read. Use a DRM-free copy.");
		}
	}
}

function parseBook(bytes: Uint8Array): Book {
	const names = entryNames(bytes);
	if (!names.includes("META-INF/container.xml")) throw new EpubError("Not an EPUB (META-INF/container.xml is missing).");
	const container = xml(strFromU8(inflate(bytes, ["META-INF/container.xml"])["META-INF/container.xml"]!));
	const opfPath = container.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
	const opfBytes = opfPath ? inflate(bytes, [opfPath])[opfPath] : undefined;
	if (!opfPath || !opfBytes) throw new EpubError("Not a readable EPUB (the package document is missing).");
	const opf = xml(strFromU8(opfBytes));
	const manifest = new Map<string, string>();
	for (const item of opf.getElementsByTagName("item")) {
		const id = item.getAttribute("id");
		const href = item.getAttribute("href");
		if (id && href) manifest.set(id, resolveHref(opfPath, href));
	}
	const titles = tocTitles(bytes, opfPath, opf);
	const spine: SpineItem[] = [];
	for (const ref of opf.getElementsByTagName("itemref")) {
		const entry = manifest.get(ref.getAttribute("idref") ?? "");
		if (!entry || ref.getAttribute("linear") === "no") continue;
		spine.push({ entry, title: titles.get(entry) ?? path.posix.basename(entry).replace(/\.x?html?$/i, "") });
	}
	if (spine.length === 0) throw new EpubError("Not a readable EPUB (the reading order is empty).");
	assertNotEncrypted(bytes, names, spine);
	const meta = (tag: string) => opf.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
	return { title: meta("dc:title") || "Untitled", author: meta("dc:creator"), spine, bytes, markdown: new Map() };
}

async function openBook(filePath: string): Promise<Book> {
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch {
		throw new EpubError(`File not found: ${filePath}`);
	}
	const hit = cache.get(filePath);
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.book;
	const book = parseBook(new Uint8Array(await fs.readFile(filePath)));
	cache.delete(filePath);
	cache.set(filePath, { mtimeMs: stat.mtimeMs, book });
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
	return book;
}

function chapterOf(book: Book, chapter: number): string {
	const item = book.spine[chapter - 1];
	if (!Number.isInteger(chapter) || !item) {
		throw new EpubError(`Chapter ${chapter} doesn't exist — this book has chapters 1-${book.spine.length}.`);
	}
	const cached = book.markdown.get(chapter);
	if (cached !== undefined) return cached;
	const raw = inflate(book.bytes, [item.entry])[item.entry];
	if (!raw) throw new EpubError(`Chapter ${chapter} is listed but missing from the archive.`);
	const { document } = parseHTML(strFromU8(raw));
	const markdown = turndown.turndown(document.body ?? document.documentElement).trim();
	book.markdown.set(chapter, markdown);
	return markdown;
}

function countWords(markdown: string): number {
	return markdown.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export async function epubInfo(filePath: string): Promise<EpubInfo> {
	const book = await openBook(filePath);
	return {
		title: book.title,
		author: book.author,
		chapters: book.spine.map((s, i) => ({ chapter: i + 1, title: s.title, words: countWords(chapterOf(book, i + 1)) })),
	};
}

export async function epubChapterMarkdown(filePath: string, chapter: number): Promise<string> {
	return chapterOf(await openBook(filePath), chapter);
}

export async function epubSearch(
	filePath: string,
	query: string,
	opts: { maxHits?: number } = {},
): Promise<EpubSearchHit[]> {
	const book = await openBook(filePath);
	const maxHits = opts.maxHits ?? 50;
	const needle = query.toLowerCase();
	const hits: EpubSearchHit[] = [];
	for (let n = 1; n <= book.spine.length && hits.length < maxHits; n++) {
		let heading: string | undefined;
		for (const line of chapterOf(book, n).split("\n")) {
			const h = /^#{1,6}\s+(.*)$/.exec(line);
			if (h) heading = h[1]!.trim();
			if (line.toLowerCase().includes(needle)) {
				hits.push({ chapter: n, chapterTitle: book.spine[n - 1]!.title, heading, text: line.trim() });
				if (hits.length >= maxHits) break;
			}
		}
	}
	return hits;
}
