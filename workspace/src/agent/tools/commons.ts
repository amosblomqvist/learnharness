import { safeFetch } from "./safe-fetch.ts";

/**
 * Wikimedia Commons client for find_image / show_image({ commons }). It
 * needs no key, and every file on Commons carries a free license. Only text
 * metadata ever reaches the model: search returns candidates as text, and a
 * shown picture goes straight into the session record.
 *
 * Requests go only to commons.wikimedia.org (the API) and
 * upload.wikimedia.org (thumbnails), through safeFetch. The User-Agent
 * names the app and its public project page, never the learner.
 */

const API = "https://commons.wikimedia.org/w/api.php";
const THUMB_HOST = "upload.wikimedia.org";
const USER_AGENT = "LearnHarness/0.7 (https://github.com/amosblomqvist/learnharness)";
const TIMEOUT_MS = 15_000;
/** Commons renders thumbnails at this width (SVG and TIFF become PNG/JPEG). */
export const COMMONS_THUMB_WIDTH = 1024;
const MAX_THUMB_BYTES = 10 * 1024 * 1024;
export const COMMONS_MAX_RESULTS = 5;
const DESCRIPTION_CHARS = 120;

export interface CommonsCandidate {
	/** "File:…", the value show_image's `commons` input takes. */
	title: string;
	description?: string;
	width: number;
	height: number;
	license?: string;
	author?: string;
}

export interface CommonsImageMeta {
	title: string;
	/** The file's description page on Commons (attribution link). */
	pageUrl: string;
	author?: string;
	license?: string;
	licenseUrl?: string;
}

interface ApiImageInfo {
	thumburl?: string;
	width?: number;
	height?: number;
	descriptionurl?: string;
	extmetadata?: Record<string, { value?: unknown } | undefined>;
}
interface ApiPage {
	title?: string;
	index?: number;
	missing?: boolean;
	imageinfo?: ApiImageInfo[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

/** Commons metadata is HTML; keep plain, single-line text. Pure. */
export function plainText(html: unknown): string | undefined {
	if (typeof html !== "string") return undefined;
	const text = html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
			if (name[0] === "#") {
				const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
			}
			return ENTITIES[name.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
	if (!text) return undefined;
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** "Foo.jpg" or "file:Foo.jpg" → "File:Foo.jpg". Pure. */
export function normalizeCommonsTitle(raw: string): string {
	const trimmed = raw.trim().replace(/^file:/i, "").trim();
	return `File:${trimmed}`;
}

function meta(info: ApiImageInfo, key: string): string | undefined {
	return plainText(info.extmetadata?.[key]?.value);
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function api(params: Record<string, string>, signal?: AbortSignal): Promise<ApiPage[]> {
	const url = new URL(API);
	const query = {
		action: "query",
		format: "json",
		formatversion: "2",
		prop: "imageinfo",
		iiprop: "url|size|mime|extmetadata",
		iiextmetadatafilter: "ImageDescription|Artist|LicenseShortName|LicenseUrl",
		iiextmetadatalanguage: "en",
		iiurlwidth: String(COMMONS_THUMB_WIDTH),
		...params,
	};
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const res = await safeFetch(url.toString(), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: withTimeout(signal) });
	if (!res.ok) throw new Error(`Wikimedia Commons answered HTTP ${res.status}`);
	const body = (await res.json()) as { query?: { pages?: ApiPage[] }; error?: { info?: string } };
	if (body.error) throw new Error(`Wikimedia Commons refused the request: ${body.error.info ?? "unknown error"}`);
	return body.query?.pages ?? [];
}

/** Up to five free-licensed bitmap or drawing files for a query, best first. */
export async function searchCommons(query: string, signal?: AbortSignal): Promise<CommonsCandidate[]> {
	const pages = await api({
		generator: "search",
		gsrsearch: `${query} filetype:bitmap|drawing`,
		gsrnamespace: "6",
		gsrlimit: String(COMMONS_MAX_RESULTS),
	}, signal);
	return pages
		.filter((page) => page.title && page.imageinfo?.[0]?.thumburl)
		.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
		.slice(0, COMMONS_MAX_RESULTS)
		.map((page) => {
			const info = page.imageinfo![0]!;
			const description = clip(meta(info, "ImageDescription"), DESCRIPTION_CHARS);
			const license = meta(info, "LicenseShortName");
			const author = clip(meta(info, "Artist"), 60);
			return {
				title: page.title!,
				...(description ? { description } : {}),
				width: info.width ?? 0,
				height: info.height ?? 0,
				...(license ? { license } : {}),
				...(author ? { author } : {}),
			};
		});
}

/** Fetch one file's thumbnail bytes plus its attribution. */
export async function fetchCommonsImage(rawTitle: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; meta: CommonsImageMeta }> {
	const title = normalizeCommonsTitle(rawTitle);
	const [page] = await api({ titles: title }, signal);
	const info = page?.imageinfo?.[0];
	if (!page || page.missing || !info?.thumburl) throw new Error(`No Wikimedia Commons file named "${title}". Use a title exactly as find_image listed it.`);
	const thumb = new URL(info.thumburl);
	if (thumb.protocol !== "https:" || thumb.hostname !== THUMB_HOST) throw new Error(`Refusing a Commons thumbnail outside ${THUMB_HOST}`);
	const res = await safeFetch(thumb.toString(), { headers: { "User-Agent": USER_AGENT }, signal: withTimeout(signal) });
	if (!res.ok) throw new Error(`Could not download the Commons image (HTTP ${res.status})`);
	const declared = Number(res.headers.get("content-length") ?? "0");
	if (declared > MAX_THUMB_BYTES) throw new Error("The Commons image is too large to show");
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.byteLength > MAX_THUMB_BYTES) throw new Error("The Commons image is too large to show");
	const author = meta(info, "Artist");
	const license = meta(info, "LicenseShortName");
	const licenseUrl = plainText(info.extmetadata?.LicenseUrl?.value);
	return {
		bytes,
		meta: {
			title: page.title ?? title,
			pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
			...(author ? { author: clip(author, 120)! } : {}),
			...(license ? { license } : {}),
			...(licenseUrl && /^https?:\/\//.test(licenseUrl) ? { licenseUrl } : {}),
		},
	};
}

/** The model-facing candidate list: text only, about 300 tokens. Pure. */
export function formatCandidates(query: string, candidates: CommonsCandidate[]): string {
	if (candidates.length === 0) {
		return `No Wikimedia Commons images matched "${query}". Try a shorter or English query, or draw it instead (a pixel or mermaid block). Nothing was shown.`;
	}
	const lines = candidates.map((c, i) => {
		const facts = [`${c.width}×${c.height}`, c.license, c.author].filter(Boolean).join(", ");
		return `${i + 1}. ${c.title}${c.description ? ` — ${c.description}` : ""} (${facts})`;
	});
	return [
		`Wikimedia Commons results for "${query}". Nothing has been shown yet. To show one, call show_image with commons set to its exact title; if none fits, search again or draw it.`,
		...lines,
	].join("\n");
}
