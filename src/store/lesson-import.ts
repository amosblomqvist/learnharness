import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { selectExportGraph } from "../core/export-graph.ts";
import type { ChatRecord, ChatSettings, ImportPreview, ImportChoices } from "../core/contracts/chat.ts";
import { EXPORT_LIMIT, parseTransferJson as json, readTransferMember as read } from "./lesson-export.ts";

const hash = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const state = "lesson-transfers";
const decode = (raw: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(raw);
const lines = (raw: string) => raw.split("\n").filter(s => s.trim());
const joined = (rows: string[]) => rows.length ? rows.join("\n") + "\n" : "";
function appendAssertions(before: string, incoming: string): string {
	const seen = new Set(lines(before));
	const extra = lines(incoming).filter(line => { if (seen.has(line)) return false; seen.add(line); return true; });
	return extra.length ? before + (before && !before.endsWith("\n") ? "\n" : "") + joined(extra) : before;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
	return JSON.stringify(value);
}
function chat(raw: Buffer, id: string): ChatRecord {
	const v = object(json(raw));
	if (v.id !== id || (v.version !== undefined && v.version !== 1) || typeof v.title !== "string" || v.title.length > 2000 ||
		typeof v.createdAt !== "string" || typeof v.updatedAt !== "string" || !Array.isArray(v.messages) || v.messages.length > 10_000 ||
		(v.kind !== undefined && v.kind !== "teach" && v.kind !== "practice")) throw new Error("Unsupported native lesson");
	const mids = new Set<string>();
	for (const m of v.messages) {
		const msg = object(m);
		if (typeof msg.id !== "string" || !msg.id || msg.id.length > 512 || mids.has(msg.id) ||
			!["user", "assistant", "toolResult", "custom"].includes(msg.role as string)) throw new Error("Invalid native message");
		if (msg.role === "assistant" && !Array.isArray(msg.content)) throw new Error("Invalid assistant content");
		if (msg.role === "user" && typeof msg.content !== "string" && !Array.isArray(msg.content)) throw new Error("Invalid learner content");
		mids.add(msg.id);
	}
	return v as unknown as ChatRecord;
}
/** No extraction to archive-provided paths. Inspect the directory first, then inflate in
 * small chunks with independent actual-output caps (never trust ZIP size metadata). */
export function readImportPackage(bytes: Uint8Array) {
	if (!bytes.length || bytes.length > EXPORT_LIMIT) throw new Error("Import size limit");
	if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		if (bytes.length > 16_000_000) throw new Error("Lesson size limit");
		const raw = Buffer.from(bytes), id = object(json(raw)).id;
		if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Invalid lesson identity");
		const record = chat(raw, id);
		return { sha: hash(bytes), chats: [{ raw, record }], nodes: "", chains: "", format: undefined,
			graph: selectExportGraph(new Map([[id, new Set(record.messages.map(m => m.id))]]), "", "") };
	}
	if (bytes.length < 22) throw new Error("Invalid ZIP");
	const inventory = new Map<string, number>(); let declared = 0;
	const allowed = /^(?:manifest\.json|chats\/[A-Za-z0-9_-]{1,200}\.json|graph\/(?:nodes\.jsonl|chains\.jsonl|format\.json))$/;
	unzipSync(bytes, { filter(file) {
		if (!allowed.test(file.name) || inventory.has(file.name) || inventory.size >= 104 || ![0, 8].includes(file.compression) ||
			file.originalSize > (file.name === "manifest.json" ? 524_288 : 16_000_000) || (declared += file.originalSize) > EXPORT_LIMIT)
			throw new Error("Unsafe, duplicate, oversized or unsupported ZIP member");
		inventory.set(file.name, file.originalSize); return false;
	} });
	const members = new Map<string, Buffer>(), seen = new Set<string>(); let total = 0;
	const unzip = new Unzip(file => {
		if (!inventory.has(file.name) || seen.has(file.name)) throw new Error("ZIP directory mismatch");
		seen.add(file.name);
		let length = 0; const chunks: Uint8Array[] = [];
		file.ondata = (error, data, final) => {
			if (error) throw error;
			length += data.length; total += data.length;
			if (length > inventory.get(file.name)! || total > EXPORT_LIMIT) throw new Error("ZIP output limit");
			chunks.push(data);
			if (final) {
				if (length !== inventory.get(file.name)) throw new Error("ZIP length mismatch");
				members.set(file.name, Buffer.concat(chunks));
			}
		};
		file.start();
	});
	unzip.register(UnzipInflate);
	for (let start = 0; start < bytes.length; start += 1024) unzip.push(bytes.subarray(start, start + 1024), start + 1024 >= bytes.length);
	if (members.size !== inventory.size || !members.has("manifest.json")) throw new Error("Incomplete ZIP");
	const manifest = object(json(members.get("manifest.json")!));
	if (manifest.format !== "learnharness-transfer" || manifest.version !== 1 || manifest.nativeChatVersion !== 1 || manifest.nativeGraphVersion !== 1 ||
		!Array.isArray(manifest.chats) || !manifest.chats.length || manifest.chats.length > 100 || new Set(manifest.chats).size !== manifest.chats.length ||
		manifest.chats.some(id => typeof id !== "string" || !idPattern.test(id)) || !Array.isArray(manifest.files) || manifest.files.length !== members.size - 1 ||
		(manifest.attachments !== undefined && (!Array.isArray(manifest.attachments) || manifest.attachments.length))) throw new Error("Unsupported transfer manifest");
	const checked = new Set<string>();
	for (const entry of manifest.files) {
		const f = object(entry), raw = members.get(f.path as string);
		if (typeof f.path !== "string" || f.path === "manifest.json" || checked.has(f.path) || !raw || f.bytes !== raw.length || f.sha256 !== hash(raw)) throw new Error("Inventory mismatch");
		checked.add(f.path);
	}
	const chats = (manifest.chats as string[]).map(id => {
		const raw = members.get(`chats/${id}.json`); if (!raw) throw new Error("Missing lesson");
		return { raw, record: chat(raw, id) };
	});
	if ([...members.keys()].filter(p => p.startsWith("chats/")).length !== chats.length) throw new Error("Unselected lesson");
	const nodes = members.get("graph/nodes.jsonl"), chains = members.get("graph/chains.jsonl"), format = members.get("graph/format.json");
	if (!nodes || !chains) throw new Error("Missing native graph");
	if (format && object(json(format)).version !== 1) throw new Error("Unsupported graph format");
	for (const raw of [nodes, chains]) for (const line of lines(decode(raw))) json(Buffer.from(line));
	const graph = selectExportGraph(new Map(chats.map(c => [c.record.id, new Set(c.record.messages.map(m => m.id))])), decode(nodes), decode(chains));
	if (graph.nodes !== joined(lines(decode(nodes))) || graph.chains !== joined(lines(decode(chains)))) throw new Error("Unselected graph assertions");
	return { sha: hash(bytes), chats, nodes: decode(nodes), chains: decode(chains), format, graph };
}

// All local destinations are generated here, never taken from manifest source paths.
function local(root: string, relative: string): string {
	if (!/^(?:chats\/[A-Za-z0-9_-]{1,200}\.json|graph\/(?:nodes\.jsonl|chains\.jsonl|format\.json)|lesson-transfers\/(?:readonly\/[A-Za-z0-9_-]{1,200}\.json|versions\/[A-Za-z0-9_-]{1,200}\/[a-f0-9]{64}\.json|packages\/[a-f0-9]{64}\.(?:zip|json)))$/.test(relative)) throw new Error("Invalid local destination");
	const parts = relative.split("/"); let file = path.resolve(root);
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Symlink library unsupported");
	for (const part of parts) {
		file = path.join(file, part);
		try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Symlink destination unsupported"); }
		catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	}
	return file;
}
function atomic(file: string, bytes: Uint8Array) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", 0o600);
		try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(tmp, file);
	} finally { fs.rmSync(tmp, { force: true }); }
}
function pendingPath(root: string) {
	// State directories must not redirect journal writes outside the selected library.
	for (const rel of [state, `${state}/pending`]) {
		const p = path.join(root, rel);
		if (fs.existsSync(p) && (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) throw new Error("Invalid transfer journal directory");
	}
	return path.join(root, state, "pending");
}
/** Boot-time rollback BEFORE the stores serve requests. A corrupt journal fails closed. */
export function recoverTransfers(root: string): void {
	const pending = pendingPath(root);
	if (!fs.existsSync(pending)) return;
	const marker = path.join(pending, "journal.json");
	if (!fs.existsSync(marker)) { fs.rmSync(pending, { recursive: true }); return; } // staging never reached the write phase
	const journal = json(read(marker));
	if (!Array.isArray(journal) || journal.length > 405) throw new Error("Invalid transfer recovery journal");
	const entries = journal.map((entry, index) => {
		const row = object(entry);
		if (typeof row.path !== "string" || (row.before !== null && (typeof row.before !== "string" || !shaPattern.test(row.before)))) throw new Error("Invalid recovery entry");
		const file = local(root, row.path), backup = path.join(pending, `${index}.before`);
		const bytes = row.before === null ? null : read(backup, false, EXPORT_LIMIT);
		if (bytes && hash(bytes) !== row.before) throw new Error("Corrupt recovery backup");
		return { file, bytes };
	});
	for (const { file, bytes } of entries.reverse()) {
		if (bytes) atomic(file, bytes); else fs.rmSync(file, { force: true });
	}
	// Rename is the rollback completion marker; interrupted cleanup must never replay an old journal.
	const finished = `${pending}.done-${randomUUID()}`;
	fs.renameSync(pending, finished); fs.rmSync(finished, { recursive: true, force: true });
}
// Keep the former readonly marker path so existing imports gain the same explicit-input pause.
export function importPause(root: string, id: string): { packageSha: string; settings?: ChatSettings } | undefined {
	if (!idPattern.test(id)) return;
	const file = local(root, `${state}/readonly/${id}.json`);
	if (!fs.existsSync(file)) return;
	return json(read(file)) as { packageSha: string; settings?: ChatSettings };
}
export function saveImportPause(root: string, id: string, pause: ReturnType<typeof importPause>): void {
	const file = local(root, `${state}/readonly/${id}.json`);
	if (pause) atomic(file, Buffer.from(JSON.stringify(pause)));
	else fs.rmSync(file, { force: true });
}
function graphConflicts(oldNodes: string, oldChains: string, nodes: string, chains: string): string[] {
	const definitions = new Map<string, string>(), ids = new Map<string, string>(), argumentsByKey = new Map<string, string>(), blockers = new Set<string>();
	for (const raw of [oldNodes, nodes]) {
		const first = new Set<string>();
		for (const line of lines(raw)) {
			const n = JSON.parse(line); if (first.has(n.id)) continue; first.add(n.id);
			const { provenance: _provenance, ...definition } = n;
			const key = canonical(definition), before = definitions.get(n.id);
			if (before !== undefined && before !== key) blockers.add(`Shared node conflict: ${n.id}`);
			definitions.set(n.id, key);
		}
	}
	for (const raw of [oldChains, chains]) for (const line of lines(raw)) {
		const c = JSON.parse(line), key = canonical([[...new Set(c.premises)].sort(), c.conclusion]);
		if (definitions.has(c.id) || (ids.has(c.id) && ids.get(c.id) !== key) || (argumentsByKey.has(key) && argumentsByKey.get(key) !== c.id)) blockers.add(`Shared chain conflict: ${c.id}`);
		ids.set(c.id, key); argumentsByKey.set(key, c.id);
	}
	return [...blockers];
}
function snapshot(root: string, bytes: Uint8Array) {
	if (fs.existsSync(pendingPath(root))) throw new Error("Transfer recovery required; restart LearnHarness");
	const pack = readImportPackage(bytes), blockers: string[] = [];
	let localBytes = 0;
	const chats = pack.chats.map(c => {
		const file = local(root, `chats/${c.record.id}.json`), current = read(file, true);
		if (fs.existsSync(file) && !current.length) throw new Error("Corrupt local lesson");
		if ((localBytes += current.length) > EXPORT_LIMIT) throw new Error("Local selection size limit");
		if (current.length) chat(current, c.record.id);
		return { ...c, current, kind: !current.length ? "new" as const : current.equals(c.raw) ? "same" as const : "conflict" as const };
	});
	const nodes = read(local(root, "graph/nodes.jsonl"), true), chains = read(local(root, "graph/chains.jsonl"), true), format = read(local(root, "graph/format.json"), true);
	if ((fs.existsSync(local(root, "graph/format.json")) && !format.length) || (format.length && object(json(format)).version !== 1)) throw new Error("Unsupported local graph format");
	if (format.length && pack.format && !format.equals(pack.format)) blockers.push("Graph format metadata differs; import into a separate library.");
	const oldNodes = decode(nodes), oldChains = decode(chains);
	for (const raw of [oldNodes, oldChains]) for (const line of lines(raw)) json(Buffer.from(line));
	selectExportGraph(new Map(), oldNodes, oldChains); // validates without guessing at corrupt local lines
	blockers.push(...graphConflicts(oldNodes, oldChains, pack.nodes, pack.chains));
	const mergedNodes = appendAssertions(oldNodes, pack.nodes), mergedChains = appendAssertions(oldChains, pack.chains);
	if ([mergedNodes, mergedChains].some(raw => Buffer.byteLength(raw) > 16_000_000)) blockers.push("Combined graph member size limit");
	try { selectExportGraph(new Map(), mergedNodes, mergedChains); }
	catch { blockers.push("Combined native graph is invalid or exceeds assertion limits"); }
	const revision = hash(JSON.stringify([pack.sha, chats.map(c => [c.record.id, hash(c.current), importPause(root, c.record.id)]), hash(nodes), hash(chains), hash(format)]));
	return { pack, chats, oldNodes, oldChains, format, blockers, revision };
}
export function previewImport(root: string, bytes: Uint8Array): ImportPreview {
	const s = snapshot(root, bytes);
	return { revision: s.revision, packageSha: s.pack.sha, chats: s.chats.map(c => ({ id: c.record.id, title: c.record.title, kind: c.kind })),
		nodes: new Set(lines(s.pack.nodes).map(l => JSON.parse(l).id)).size, chains: new Set(lines(s.pack.chains).map(l => JSON.parse(l).id)).size,
		blockers: s.blockers, warnings: ["Import starts no model requests. Continue with your local model settings. External files are not installed; some dependencies may be missing.", ...s.pack.graph.external.map(p => `External provenance: ${p.chatId}`)] };
}
/** One synchronous installation block: no in-process writer can interleave. Durable originals
 * precede every active replacement; an interrupted transaction rolls back on the next boot. */
export function installImport(root: string, bytes: Uint8Array, approval: { revision: string; choices: ImportChoices; acknowledged: boolean },
	// Bounded fault injection for offline rollback/restart tests only; never exposed by transport.
	afterWrite?: (index: number) => void) {
	const s = snapshot(root, bytes);
	if (s.revision !== approval.revision || s.blockers.length || !approval.acknowledged) throw new Error("Preview changed or installation blocked");
	const conflicts = s.chats.filter(c => c.kind === "conflict");
	if (Object.keys(approval.choices).length !== conflicts.length || conflicts.some(c => !["local", "incoming"].includes(approval.choices[c.record.id]!))) throw new Error("Choose every conflict explicitly");
	const selected = s.chats.filter(c => c.kind !== "conflict" || approval.choices[c.record.id] === "incoming");
	const retained = new Set(conflicts.filter(c => approval.choices[c.record.id] === "local").map(c => c.record.id));
	const graph = selectExportGraph(new Map(selected.map(c => [c.record.id, new Set(c.record.messages.map(m => m.id))])), s.pack.nodes, s.pack.chains);
	if ([...lines(graph.nodes), ...lines(graph.chains)].some(l => JSON.parse(l).provenance.some((p: { chatId: string }) => retained.has(p.chatId)))) throw new Error("Incoming graph depends on skipped conflicting history");
	// Never relabel old learner evidence as evidence from a changed message with the same id.
	for (const c of conflicts.filter(c => approval.choices[c.record.id] === "incoming")) {
		const before = new Map(chat(c.current, c.record.id).messages.map(m => [m.id, canonical(m)]));
		const after = new Map(c.record.messages.map(m => [m.id, canonical(m)]));
		for (const line of [...lines(s.oldNodes), ...lines(s.oldChains)]) for (const p of JSON.parse(line).provenance)
			if (p.chatId === c.record.id && (!p.messageId || before.get(p.messageId) !== after.get(p.messageId))) throw new Error("Existing graph depends on replaced history");
	}
	const changes = new Map<string, Buffer>();
	const put = (rel: string, raw: Uint8Array) => {
		const file = local(root, rel);
		if (!fs.existsSync(file) || !read(file, false, EXPORT_LIMIT).equals(Buffer.from(raw))) changes.set(rel, Buffer.from(raw));
	};
	for (const c of s.chats) {
		if (c.current.length) put(`${state}/versions/${c.record.id}/${hash(c.current)}.json`, c.current);
		put(`${state}/versions/${c.record.id}/${hash(c.raw)}.json`, c.raw);
		if (selected.includes(c) && c.kind !== "same") {
			put(`chats/${c.record.id}.json`, c.raw);
			put(`${state}/readonly/${c.record.id}.json`, Buffer.from(JSON.stringify({ packageSha: s.pack.sha })));
		}
	}
	put("graph/nodes.jsonl", Buffer.from(appendAssertions(s.oldNodes, graph.nodes)));
	put("graph/chains.jsonl", Buffer.from(appendAssertions(s.oldChains, graph.chains)));
	if (!s.format.length && s.pack.format) put("graph/format.json", s.pack.format);
	// The full inert archive preserves skipped incoming graph/history for later inspection.
	put(`${state}/packages/${s.pack.sha}.${bytes[0] === 0x50 && bytes[1] === 0x4b ? "zip" : "json"}`, bytes);
	if (!changes.size) return { installed: [] as string[], unchanged: s.chats.length };
	const pending = pendingPath(root); fs.mkdirSync(pending, { recursive: true });
	try {
		const journal: { path: string; before: string | null }[] = [];
		let index = 0;
		for (const rel of changes.keys()) {
			const file = local(root, rel), exists = fs.existsSync(file), before = exists ? read(file, false, EXPORT_LIMIT) : null;
			if (before) atomic(path.join(pending, `${index}.before`), before);
			journal.push({ path: rel, before: before ? hash(before) : null }); index++;
		}
		atomic(path.join(pending, "journal.json"), Buffer.from(JSON.stringify(journal)));
		index = 0;
		for (const [rel, raw] of changes) { atomic(local(root, rel), raw); afterWrite?.(index++); }
		// Commit point. Cleanup failures cannot turn a committed install into a claimed rollback.
		const committed = `${pending}.done-${randomUUID()}`;
		fs.renameSync(pending, committed);
		try { fs.rmSync(committed, { recursive: true, force: true }); } catch { /* inert cleanup only */ }
	} catch (error) { recoverTransfers(root); throw error; }
	return { installed: selected.filter(c => c.kind !== "same").map(c => c.record.id), unchanged: s.chats.length - selected.filter(c => c.kind !== "same").length };
}
export function importVersions(root: string): { id: string; sha: string }[] {
	const folder = path.join(root, state, "versions");
	if (!fs.existsSync(folder)) return [];
	const out: { id: string; sha: string }[] = [];
	for (const id of fs.readdirSync(folder)) if (idPattern.test(id)) for (const name of fs.readdirSync(path.dirname(local(root, `${state}/versions/${id}/${"0".repeat(64)}.json`))))
		if (/^[a-f0-9]{64}\.json$/.test(name)) out.push({ id, sha: name.slice(0, -5) });
	return out;
}
export function importVersion(root: string, id: string, sha: string): Buffer {
	if (!idPattern.test(id) || !shaPattern.test(sha)) throw new Error("Invalid version identity");
	const raw = read(local(root, `${state}/versions/${id}/${sha}.json`));
	if (hash(raw) !== sha) throw new Error("Corrupt saved version");
	chat(raw, id); return raw;
}
