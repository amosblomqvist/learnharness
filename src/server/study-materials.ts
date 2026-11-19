import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { parseHTML } from "linkedom";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { isWithin, resolvePolicy } from "../agent/tools/file-access.ts";
import { fileAccessPolicy } from "./file-access.ts";
import { readBoundedJson } from "./custom-provider-body.ts";
import type { MaterialConnections, MaterialEntry, MaterialReference, MaterialSource, StudyMaterial } from "../core/study-materials.ts";

export interface MaterialConfig { obsidianRoot?: string; notionToken?: string; zoteroEnabled?: boolean }
const PAGE_LIMIT = 100;
const TEXT_LIMIT = 60_000;
const richText = (value: any): string => Array.isArray(value) ? value.map(part => part.plain_text ?? part.text?.content ?? part.equation?.expression ?? "").join("") : "";
const notionTitle = (page: any): string => richText((Object.values(page.properties ?? {}) as { type?: string; title?: unknown }[]).find(value => value.type === "title")?.title) || "Untitled page";
const uuid = (value: string) => { if (!/^[0-9a-f]{32}$/i.test(value.replaceAll("-", ""))) throw new Error("Invalid Notion page or block ID."); return value; };
const zoteroKey = (value: string) => { if (!/^[A-Z0-9]{8}$/.test(value)) throw new Error("Invalid Zotero item key."); return value; };
function plainNote(html: string): string {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	for (const element of document.querySelectorAll("script,style")) element.remove();
	return document.body.textContent ?? "";
}

/** Zotero is loopback-only: never send local library reads through an ambient
 * HTTP proxy (the desktop may enable env proxies for subscription sign-in). */
export const materialFetch: typeof fetch = async (input, options) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin !== "http://127.0.0.1:23119") return fetch(input, options);
	if (options?.method !== "GET" || !url.pathname.startsWith("/api/users/0/")) throw new Error("Unsupported Zotero read route.");
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers: { "Zotero-API-Version": "3" }, signal: options.signal ?? undefined }, incoming => {
			resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode ?? 500, headers: { "Content-Type": "application/json" } }));
		});
		request.on("error", reject);
	});
};

/** Fixed remote origins, read operations only. HTTP search POST is not a Notion mutation. */
export class StudyMaterials {
	private lastNotionRequest = 0;
	constructor(readonly config: MaterialConfig, private readonly fetchLike: typeof fetch = materialFetch) {}
	status(): MaterialConnections { return { obsidianRoot: this.config.obsidianRoot ?? "", notionConfigured: !!this.config.notionToken, zoteroEnabled: this.config.zoteroEnabled === true }; }
	private async json(source: "notion" | "zotero", route: string, body?: object): Promise<any> {
		if (source === "notion" && !this.config.notionToken) throw new Error("Connect a Notion integration with read access first.");
		if (source === "zotero" && !this.config.zoteroEnabled) throw new Error("Enable the Zotero connection first.");
		if (source === "notion") { const delay = Math.max(0, this.lastNotionRequest + 350 - Date.now()); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); this.lastNotionRequest = Date.now(); }
		const response = await this.fetchLike(`${source === "notion" ? "https://api.notion.com/v1/" : "http://127.0.0.1:23119/api/users/0/"}${route}`, {
			method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
			headers: source === "notion" ? { Authorization: `Bearer ${this.config.notionToken}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" } : { "Zotero-API-Version": "3" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) throw new Error(`${source === "notion" ? "Notion" : "Zotero"} returned ${response.status}. ${source === "zotero" && response.status === 403 ? "Allow local API access in Zotero Settings → Advanced." : "Check the connection and access to this material."}`);
		return readBoundedJson(response, 4_000_000);
	}
	private root(): string {
		if (!this.config.obsidianRoot) throw new Error("Choose your Obsidian vault folder in Connections.");
		return resolveSourcePath(this.config.obsidianRoot, resolvePolicy(fileAccessPolicy()));
	}
	private notePath(id: string): string {
		const root = this.root();
		if (id.includes("\0") || path.isAbsolute(id)) throw new Error("Invalid vault-relative path.");
		const target = resolveSourcePath(path.resolve(root, id || "."), resolvePolicy(fileAccessPolicy()));
		if (!isWithin(target, root)) throw new Error("This material is outside the configured vault.");
		return target;
	}
	async list(source: MaterialSource, folder = "", query = "", cursor = ""): Promise<{ entries: MaterialEntry[]; nextCursor?: string }> {
		if (query.length > 300 || folder.length > 2000 || cursor.length > 16000) throw new Error("Search input is too long.");
		if (source === "obsidian") {
			const dir = this.notePath(folder);
			const files = await fs.readdir(dir, { withFileTypes: true });
			if (files.length > 5000) throw new Error("This folder is too large. Choose a smaller source folder.");
			const entries: MaterialEntry[] = [];
			for (const item of files.sort((a, b) => a.name.localeCompare(b.name))) {
				if (item.name.startsWith(".") || item.isSymbolicLink() || (!item.isDirectory() && !item.name.toLowerCase().endsWith(".md")) || !item.name.toLowerCase().includes(query.toLowerCase())) continue;
				const id = path.join(folder, item.name);
				try { this.notePath(id); } catch { continue; }
				entries.push({ source, id, title: item.name, kind: item.isDirectory() ? "folder" : "document", description: item.isDirectory() ? "Folder" : "Markdown note" });
			}
			const offset = /^\d+$/.test(cursor) ? Number(cursor) : 0;
			return { entries: entries.slice(offset, offset + PAGE_LIMIT), ...(offset + PAGE_LIMIT < entries.length ? { nextCursor: String(offset + PAGE_LIMIT) } : {}) };
		}
		if (source === "notion") {
			const result = await this.json(source, "search", { query, filter: { property: "object", value: "page" }, page_size: PAGE_LIMIT, ...(cursor ? { start_cursor: cursor } : {}) });
			return { entries: result.results.map((page: any) => ({ source, id: page.id, title: notionTitle(page), kind: "document", description: "Notion page" })), ...(result.has_more ? { nextCursor: result.next_cursor } : {}) };
		}
		const offset = /^\d+$/.test(cursor) ? Number(cursor) : 0;
		const result = await this.json(source, `${folder ? `items/${zoteroKey(folder)}/children` : "items/top"}?format=json&limit=${PAGE_LIMIT}&start=${offset}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
		if (!Array.isArray(result)) throw new Error("Zotero returned an unexpected item list.");
		return { entries: result.map((item: any) => ({ source, id: item.key, title: item.data.title || (item.data.itemType === "note" ? plainNote(item.data.note ?? "").slice(0, 100) : item.key), kind: ["note", "attachment"].includes(item.data.itemType) ? "document" : "folder", description: item.data.itemType })), ...(result.length === PAGE_LIMIT ? { nextCursor: String(offset + PAGE_LIMIT) } : {}) };
	}
	async read(reference: MaterialReference): Promise<StudyMaterial> {
		const { source, id } = reference;
		let title: string, origin: string, text: string;
		const notices: string[] = [];
		if (source === "obsidian") {
			const file = this.notePath(id);
			if (path.extname(file).toLowerCase() !== ".md" || !(await fs.stat(file)).isFile()) throw new Error("Select a Markdown note, not a folder.");
			const handle = await fs.open(file, "r");
			try {
				if ((await handle.stat()).size > 240_000) throw new Error("This note is too large for one selection. Choose a smaller note.");
				text = await handle.readFile("utf8");
			} finally { await handle.close(); }
			title = path.basename(file); origin = file;
			if (/!\[|!\[\[/.test(text)) notices.push("Markdown text only. Embedded images, PDFs and linked notes are not included.");
		} else if (source === "notion") {
			const page = await this.json(source, `pages/${uuid(id)}`);
			title = notionTitle(page); origin = page.url;
			const lines: string[] = [], seen = new Set<string>(); let blocks = 0, characters = 0;
			const deadline = Date.now() + 45_000;
			const visit = async (blockId: string, depth: number): Promise<void> => {
				if (depth > 12 || seen.has(blockId)) throw new Error("This Notion page is too deeply nested or cyclic.");
				seen.add(blockId); let cursor = "";
				const cursors = new Set<string>();
				do {
					if (Date.now() > deadline) throw new Error("This Notion page took too long to read. Choose a smaller page.");
					const page = await this.json(source, `blocks/${uuid(blockId)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
					for (const block of page.results) {
						if (++blocks > 600) throw new Error("This Notion page is too large. Choose a smaller page.");
						const value = block[block.type] ?? {};
						const content = richText(value.rich_text) || (block.type === "equation" ? value.expression : "") || (block.type === "table_row" ? (value.cells ?? []).map(richText).join(" | ") : "");
						if (content) { characters += content.length; if (characters > TEXT_LIMIT) throw new Error("This Notion page exceeds 60,000 characters. Choose a smaller page."); lines.push(content); }
						if (["image", "pdf", "file", "video", "audio", "embed", "child_database", "child_page"].includes(block.type)) notices.push(`Not included in extracted text: ${block.type}.`);
						if (block.has_children) await visit(block.id, depth + 1);
					}
					cursor = page.has_more ? page.next_cursor : "";
					if (cursor && cursors.has(cursor)) throw new Error("Notion repeated a pagination cursor.");
					cursors.add(cursor);
				} while (cursor);
			};
			await visit(id, 0); text = lines.join("\n\n");
		} else {
			const item = await this.json(source, `items/${zoteroKey(id)}?format=json`);
			title = item.data.title || "Zotero note"; origin = `zotero://select/library/items/${id}`;
			if (item.data.itemType === "note") text = plainNote(item.data.note ?? "");
			else if (item.data.itemType === "attachment") {
				const fulltext = await this.json(source, `items/${zoteroKey(id)}/fulltext`);
				text = typeof fulltext.content === "string" ? fulltext.content : "";
				if (!text.trim()) throw new Error("No indexed attachment text. Index the PDF in Zotero, or select a note. Metadata alone will not be used as the paper.");
			} else throw new Error("Open the reference and select a note or indexed PDF attachment.");
		}
		if (!text.trim()) throw new Error("No readable text was found in this material.");
		if (text.length > TEXT_LIMIT) throw new Error("This material exceeds 60,000 characters. Choose a smaller note or page.");
		return { source, id, title, origin, text, notices: [...new Set(notices)] };
	}
}
