import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import packageJson from "../../package.json";
import fallbackCatalog from "../../plugin-catalog/catalog.json";
import { parsePluginCatalog, type PluginCatalog } from "../core/plugin-catalog.ts";

const CATALOG_URL = "https://raw.githubusercontent.com/amosblomqvist/learnharness/main/plugin-catalog/catalog.json";
const cacheFile = path.join(PATHS.data, "plugin-catalog-cache.json");
const maxCatalogBytes = 1024 * 1024;
const headers = { Accept: "application/vnd.github+json", "User-Agent": `LearnHarness/${packageJson.version}` };
let recent: { catalog: PluginCatalog; at: number; stale: boolean } | undefined;
const commentsCache = new Map<number, { at: number; result: IssueConversation }>();

async function limitedBytes(response: Response, limit: number): Promise<Uint8Array> {
	if (!response.body) throw Error("Empty response body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw Error("GitHub response exceeds size limit");
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

function cachedCatalog(): PluginCatalog {
	try { return parsePluginCatalog(JSON.parse(fs.readFileSync(cacheFile, "utf8"))); }
	catch { return parsePluginCatalog(fallbackCatalog); }
}

export async function readPluginCatalog(force = false): Promise<{ catalog: PluginCatalog; stale: boolean }> {
	if (!force && recent && Date.now() - recent.at < 15 * 60_000) return recent;
	try {
		const response = await fetch(CATALOG_URL, { headers, signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error" });
		if (!response.ok) throw Error(`Catalog HTTP ${response.status}`);
		const catalog = parsePluginCatalog(JSON.parse(new TextDecoder().decode(await limitedBytes(response, maxCatalogBytes))));
		fs.mkdirSync(PATHS.data, { recursive: true });
		const temporary = `${cacheFile}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(catalog));
		fs.renameSync(temporary, cacheFile);
		recent = { catalog, stale: false, at: Date.now() };
	} catch {
		recent = { catalog: cachedCatalog(), stale: true, at: Date.now() };
	}
	return recent;
}

export interface IssueConversation {
	issueUrl: string;
	thumbsUp: number;
	commentCount: number;
	comments: { author: string; body: string; createdAt: string; url: string }[];
}

export async function readPluginConversation(issueNumber: number): Promise<IssueConversation> {
	if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw Error("Invalid issue number");
	const cached = commentsCache.get(issueNumber);
	if (cached && Date.now() - cached.at < 5 * 60_000) return cached.result;
	const base = `https://api.github.com/repos/amosblomqvist/learnharness/issues/${issueNumber}`;
	const [issue, comments] = await Promise.all([
		fetch(base, { headers, signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error" }),
		fetch(`${base}/comments?per_page=30`, { headers, signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error" }),
	]);
	if (!issue.ok || !comments.ok) throw Error(`GitHub comments unavailable (${issue.status}/${comments.status})`);
	const info = JSON.parse(new TextDecoder().decode(await limitedBytes(issue, 128 * 1024)));
	const entries = JSON.parse(new TextDecoder().decode(await limitedBytes(comments, 512 * 1024)));
	if (!Array.isArray(entries) || !Number.isSafeInteger(info.comments) || !Number.isSafeInteger(info.reactions?.["+1"]) || info.pull_request) throw Error("Invalid GitHub issue response");
	const result: IssueConversation = {
		issueUrl: `https://github.com/amosblomqvist/learnharness/issues/${issueNumber}`,
		thumbsUp: info.reactions["+1"], commentCount: info.comments,
		comments: entries.map((entry: Record<string, unknown>) => ({
			author: typeof (entry.user as { login?: unknown } | undefined)?.login === "string" ? (entry.user as { login: string }).login : "GitHub user",
			body: typeof entry.body === "string" ? entry.body : "",
			createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
			url: typeof entry.html_url === "string" ? entry.html_url : `https://github.com/amosblomqvist/learnharness/issues/${issueNumber}`,
		})),
	};
	commentsCache.set(issueNumber, { at: Date.now(), result });
	return result;
}
