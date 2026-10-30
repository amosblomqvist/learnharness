import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { selectExportGraph } from "../core/export-graph.ts";
import type { ChatRecord, ExportMode, ExportPreview, ExportSource } from "../core/contracts/chat.ts";

export const EXPORT_LIMIT = 32 * 1024 * 1024;
const MEMBER_LIMIT = 16_000_000;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => Buffer.from(text, "utf8");

export function readTransferMember(file: string, optional = false, limit = MEMBER_LIMIT): Buffer {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const before = fs.fstatSync(fd);
			if (!before.isFile() || before.size > limit) throw new Error("Export member limit");
			// A bounded descriptor read, not readFileSync on a path that may grow after stat.
			const buffer = Buffer.alloc(before.size + 1);
			let count = 0, n: number;
			while (count < buffer.length && (n = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += n;
			const after = fs.fstatSync(fd);
			if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
				throw new Error("File changed during export; preview again");
			return buffer.subarray(0, count);
		} finally { fs.closeSync(fd); }
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
		throw error;
	}
}
export function parseTransferJson(bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	let depth = 0, containers = 0, quoted = false, escaped = false;
	for (const char of text) {
		if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
		else if (char === '"') quoted = true;
		else if (char === "{" || char === "[") { if (++depth > 64 || ++containers > 100_000) throw new Error("Export JSON structure limit"); }
		else if (char === "}" || char === "]") depth--;
	}
	return JSON.parse(text);
}
const read = readTransferMember, json = parseTransferJson;
function records(root: string, ids: string[]) {
	if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length ||
		ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new Error("Select 1–100 distinct lessons");
	let total = 0;
	return ids.map(id => {
		const raw = read(path.join(root, "chats", `${id}.json`));
		if ((total += raw.length) > EXPORT_LIMIT - 524_288) throw new Error("Export selection limit");
		const record = json(raw) as ChatRecord;
		if (!record || record.id !== id || (record.version !== undefined && record.version !== 1) ||
			!Array.isArray(record.messages) || record.messages.length > 10_000 || typeof record.title !== "string") throw new Error("Unsupported native lesson");
		const mids = record.messages.map(m => m?.id);
		if (mids.some(mid => typeof mid !== "string" || !mid || mid.length > 512) || new Set(mids).size !== mids.length)
			throw new Error("Invalid native message identities");
		return { record, raw };
	});
}
function candidate(root: string, file: string): ExportSource {
	const result: ExportSource = { path: file, name: path.basename(file), bytes: 0, modified: 0, status: "blocked" };
	// Model-authored paths are not permission. Only reviewed document/image sources, never
	// directories, symlinks, device streams, the app's library, settings or credential stores.
	const protectedPath = /(^|[\\/])(?:\.[^\\/]+|auth|credentials?|settings|tokens?|secrets?)(?:[.\\/]|$)/i;
	if (!path.isAbsolute(file) || file.length > 4096 || !/\.(pdf|png|jpe?g|webp|gif|txt|md)$/i.test(file) || protectedPath.test(file)) return result;
	try {
		const stat = fs.lstatSync(file), actual = fs.realpathSync(file), library = fs.realpathSync(root);
		const relative = path.relative(library, actual);
		const inLibrary = relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
		const authPath = path.resolve(process.env.LH_AUTH_FILE ?? path.join(root, "auth.json"));
		const authTarget = fs.existsSync(authPath) ? fs.realpathSync(authPath) : authPath;
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MEMBER_LIMIT || protectedPath.test(actual) || inLibrary ||
			path.relative(actual, authTarget) === "") return result;
		return { ...result, bytes: stat.size, modified: stat.mtimeMs, status: "available" };
	} catch { return { ...result, status: "missing" }; }
}
function snapshot(root: string, ids: string[]) {
	const chats = records(root, ids);
	const nodes = read(path.join(root, "graph/nodes.jsonl"), true), chains = read(path.join(root, "graph/chains.jsonl"), true);
	const format = read(path.join(root, "graph/format.json"), true);
	if (format.length && (json(format) as { version?: unknown })?.version !== 1) throw new Error("Unsupported native graph version");
	const decode = (raw: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(raw);
	// Bound all opaque JSON before the native assertion selector parses it.
	for (const raw of [nodes, chains]) for (const line of decode(raw).split("\n")) if (line.trim()) json(encode(line));
	const graph = selectExportGraph(new Map(chats.map(c => [c.record.id, new Set(c.record.messages.map(m => m.id))])), decode(nodes), decode(chains));
	const paths = new Set<string>(), issues = new Set<string>();
	const known = new Set(["ask_user_question", "quiz", "probe", "probe_done", "recall", "explain", "plan_init", "send_to_user", "problem", "conclude", "read", "pdf", "research", "demo", "visual", "find", "list_sessions", "list_propositions"]);
	for (const { record } of chats) {
		const delivered = new Set(record.messages.flatMap(m => m.role === "custom" && m.customType === "subagent-steer" ? [(m.details as { toolCallId?: unknown } | undefined)?.toolCallId] : []));
		for (const m of record.messages) {
			if (m.role === "assistant" && Array.isArray(m.content)) for (const block of m.content) if (block.type === "toolCall") {
				if (!known.has(block.name)) issues.add(`Unsupported dependency schema: ${block.name}`);
				if (block.name === "read" || block.name === "pdf") {
					const p = (block.arguments as { path?: unknown })?.path;
					if (typeof p === "string") paths.add(p); else issues.add("Source reference without a path");
				}
				if (["research", "demo", "visual", "pdf"].includes(block.name) && !delivered.has(block.id)) issues.add("Specialist job state is not transferred");
			}
			if (m.role === "custom" && m.customType === "subagent-steer") {
				const result = (m.details as { result?: { path?: unknown } } | undefined)?.result;
				if (typeof result?.path === "string") paths.add(result.path);
			}
		}
	}
	const sourceBytes = read(path.join(root, "graph/sources.json"), true);
	const sources = sourceBytes.length ? json(sourceBytes) as Record<string, { filePath?: unknown }> : {};
	if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("Invalid graph source registry");
	const selectedSources: Record<string, unknown> = {};
	for (const p of graph.external) {
		const source = sources[p.chatId];
		if (p.chatId.startsWith("src_") && source) {
			selectedSources[p.chatId] = source;
			if (typeof source.filePath === "string") paths.add(source.filePath);
		} else issues.add(`External provenance not included: ${p.chatId}`);
	}
	if (paths.size > 100) throw new Error("Too many source files");
	const files = [...paths].map(p => candidate(root, p));
	// Partial by design: unknown opaque extensions, source dependencies of active artifacts,
	// resumable jobs and extraction coverage have not been audited for portability.
	const revision = hash(JSON.stringify([chats.map(c => [c.record.id, hash(c.raw)]), hash(nodes), hash(chains), hash(format), selectedSources, files]));
	return { chats, graph, format, sources: selectedSources, files, revision, issues: [...issues] };
}
export function previewExport(root: string, ids: string[]): ExportPreview {
	const s = snapshot(root, ids);
	return { revision: s.revision, chats: s.chats.map(c => ({ id: c.record.id, title: c.record.title })), files: s.files, issues: s.issues, complete: false };
}
export function downloadExport(root: string, ids: string[], mode: ExportMode, approval?: { revision: string; files: number[]; allowIncomplete: boolean }) {
	if (!["md", "txt", "json", "zip"].includes(mode)) throw new Error("Unknown export format");
	if (mode !== "zip") {
		const chats = records(root, ids);
		if (mode === "json") {
			if (chats.length !== 1) throw new Error("Select one lesson for native JSON");
			const chat = chats[0]!;
			return { bytes: chat.raw, name: `${chat.record.id}.json`, type: "application/json" };
		}
		const text = chats.map(c => sessionMarkdown(c.record.messages, { title: c.record.title, anchors: false, pendingQuestion: true, toolNotes: false })).join("\n\n---\n\n");
		const bytes = encode(mode === "txt" ? text.replace(/^#{1,3} /gm, "") : text);
		if (bytes.length > EXPORT_LIMIT) throw new Error("Export text limit");
		return { bytes, name: `lessons.${mode}`, type: mode === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8" };
	}
	const s = snapshot(root, ids);
	if (!approval || approval.revision !== s.revision) throw new Error("Selection changed; preview again");
	if (!approval.allowIncomplete) throw new Error("Acknowledge the partial dependency audit before exporting");
	if (!Array.isArray(approval.files) || new Set(approval.files).size !== approval.files.length || approval.files.some(i => !Number.isInteger(i) || s.files[i]?.status !== "available"))
		throw new Error("Invalid source-file selection");
	const files: Record<string, Uint8Array> = {};
	let total = 0;
	const add = (name: string, raw: Uint8Array) => {
		if (raw.length > MEMBER_LIMIT || (total += raw.length) > EXPORT_LIMIT - 524_288) throw new Error("Export payload limit");
		files[name] = raw;
	};
	for (const c of s.chats) add(`chats/${c.record.id}.json`, c.raw);
	add("graph/nodes.jsonl", encode(s.graph.nodes)); add("graph/chains.jsonl", encode(s.graph.chains));
	if (s.format.length) add("graph/format.json", s.format);
	if (Object.keys(s.sources).length) add("graph/sources.json", encode(JSON.stringify(s.sources)));
	const attachments = approval.files.map(i => {
		const source = s.files[i]!;
		if (JSON.stringify(candidate(root, source.path)) !== JSON.stringify(source)) throw new Error("Source changed; preview again");
		const raw = read(source.path);
		if (JSON.stringify(candidate(root, source.path)) !== JSON.stringify(source)) throw new Error("Source changed during export");
		const name = `files/${String(i).padStart(3, "0")}${path.extname(source.path).toLowerCase()}`;
		add(name, raw); return { path: name, sourcePath: source.path };
	});
	const manifest = encode(JSON.stringify({ format: "learnharness-transfer", version: 1, nativeChatVersion: 1, nativeGraphVersion: 1,
		chats: ids, files: Object.entries(files).map(([p, b]) => ({ path: p, bytes: b.length, sha256: hash(b) })), attachments,
		report: { complete: false, dependencyAudit: "partial", coverage: "not-included", jobs: "not-included", pendingInput: "not-included", continuationAuthorized: false,
			issues: s.issues, sources: s.files.map((f, i) => ({ ...f, included: approval.files.includes(i) })) } }));
	if (manifest.length > 524_288) throw new Error("Export manifest limit");
	files["manifest.json"] = manifest;
	const bytes = zipSync(files, { level: 6 });
	if (bytes.length > EXPORT_LIMIT) throw new Error("Export ZIP limit");
	return { bytes, name: "learnharness-lessons.zip", type: "application/zip" };
}
