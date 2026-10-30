import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { zipSync, unzipSync } from "fflate";
import { downloadExport, previewExport } from "../src/store/lesson-export.ts";
import { readImportPackage, previewImport, installImport, recoverTransfers, importPause, importVersions, importVersion } from "../src/store/lesson-import.ts";
import { graphSnapshot } from "../src/core/graph.ts";
const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-")); roots.push(root); return root; };
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const record = (id = "chat_import", text = "Authored offline example") => ({ version: 1, id, title: "Synthetic import", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", opaque: { preserve: "Ω" }, messages: [{ id: "u", role: "user", content: text, timestamp: 1 }] });
const node = (id: string, chatId: string) => ({ id, name: id, statement: "Synthetic proposition", aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [{ chatId, messageId: "u" }], opaque: { preserve: true } });
function write(root: string, file: string, data: string | Uint8Array) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), data); }
function archive(records = [record()], nodes = records.map(c => node(`n_${c.id}`, c.id)), chains: object[] = []) {
	const root = temp();
	for (const c of records) write(root, `chats/${c.id}.json`, JSON.stringify(c, null, "\t") + "\n");
	write(root, "graph/nodes.jsonl", nodes.map(n => JSON.stringify(n)).join("\n") + (nodes.length ? "\n" : ""));
	write(root, "graph/chains.jsonl", chains.map(c => JSON.stringify(c)).join("\n") + (chains.length ? "\n" : ""));
	write(root, "graph/format.json", '{"version":1,"opaque":"preserve"}\n');
	const ids = records.map(c => c.id), p = previewExport(root, ids);
	return { root, bytes: downloadExport(root, ids, "zip", { revision: p.revision, files: [], allowIncomplete: true }).bytes };
}
function install(root: string, bytes: Uint8Array, choices = {}, afterWrite?: (index: number) => void) {
	return installImport(root, bytes, { revision: previewImport(root, bytes).revision, choices, acknowledged: true }, afterWrite);
}
function files(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	function walk(folder: string) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		const file = path.join(folder, entry.name); if (entry.isDirectory()) walk(file); else out[path.relative(root, file)] = hash(fs.readFileSync(file));
	} }
	walk(root); return out;
}
function repack(bytes: Uint8Array, edit: (members: Record<string, Uint8Array>) => void) {
	const members = unzipSync(bytes); edit(members);
	const manifest = JSON.parse(Buffer.from(members["manifest.json"]!).toString());
	manifest.files = Object.entries(members).filter(([p]) => p !== "manifest.json").map(([p, raw]) => ({ path: p, bytes: raw.length, sha256: hash(raw) }));
	members["manifest.json"] = Buffer.from(JSON.stringify(manifest)); return zipSync(members);
}

test("preview is read-only; install preserves native bytes, graph and opaque metadata; reimport is idempotent and real readers fold it", async () => {
	const source = archive(), root = temp(), before = files(root);
	const p = previewImport(root, source.bytes);
	assert.deepEqual(files(root), before); assert.equal(p.chats[0]!.kind, "new"); assert.equal(p.nodes, 1); assert.equal(p.blockers.length, 0);
	assert.deepEqual(install(root, source.bytes).installed, ["chat_import"]);
	for (const file of ["chats/chat_import.json", "graph/nodes.jsonl", "graph/chains.jsonl", "graph/format.json"])
		assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.join(source.root, file)));
	assert.ok(importPause(root, "chat_import"));
	const after = files(root); assert.deepEqual(install(root, source.bytes).installed, []); assert.deepEqual(files(root), after);
	assert.deepEqual(importVersions(root).map(v => importVersion(root, v.id, v.sha).toString()), [fs.readFileSync(path.join(source.root, "chats/chat_import.json"), "utf8")]);
	// Compose the actual desktop adapters in this isolated library, never installed data.
	process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "unused-auth.json");
	const { chatStore } = await import("../src/store/chats.ts");
	const { graphStore } = await import("../src/store/graph.ts");
	assert.equal(chatStore.getChat("chat_import")!.messages[0]!.id, "u");
	assert.equal(graphSnapshot({ chatStore, graphStore }).nodes.length, 1);
	assert.deepEqual(chatStore.getChat("chat_import")!.settings, {});
	const local = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } };
	chatStore.saveSettings("chat_import", local);
	assert.deepEqual(chatStore.getChat("chat_import")!.settings, local);
	assert.ok(chatStore.pendingImport?.("chat_import"));
	chatStore.saveMessages("chat_import", chatStore.getChat("chat_import")!.messages);
	chatStore.acceptInput?.("chat_import");
	assert.equal(chatStore.pendingImport?.("chat_import"), undefined);
	assert.deepEqual(chatStore.getChat("chat_import")!.settings, local);
});
test("standalone JSON preserves bytes, uses the same conflicts and bounds, and adds no graph assertions", () => {
	const root = temp(), raw = Buffer.from(" \n" + JSON.stringify(record(), null, "\t") + "\n");
	const p = previewImport(root, raw);
	assert.equal(p.chats[0]!.kind, "new"); assert.equal(p.nodes, 0); assert.equal(p.chains, 0);
	install(root, raw); assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_import.json")), raw);
	assert.ok(importPause(root, "chat_import"));
	assert.deepEqual(fs.readdirSync(path.join(root, "lesson-transfers/packages")), [`${hash(raw)}.json`]);
	const before = files(root); install(root, raw); assert.deepEqual(files(root), before);
	const changed = Buffer.from(JSON.stringify(record("chat_import", "Changed JSON")));
	assert.equal(previewImport(root, changed).chats[0]!.kind, "conflict");
	assert.throws(() => install(root, changed)); install(root, changed, { chat_import: "incoming" });
	assert.equal(importVersions(root).length, 2);
	assert.equal(fs.readFileSync(path.join(root, "graph/nodes.jsonl"), "utf8"), "");
	for (const bad of [Buffer.from('{"id":"../unsafe","messages":[]}'), Buffer.from(JSON.stringify({ ...record(), version: 2 })),
		Buffer.from([0xc3, 0x28]), Buffer.from("[".repeat(65) + "0" + "]".repeat(65)), Buffer.alloc(16_000_001, 32)])
		assert.throws(() => readImportPackage(bad));
});
test("conflicts require every explicit decision, retain both originals and never rename identities", () => {
	const a = archive([record()], [], []), b = archive([record("chat_import", "Changed incoming")], [], []), root = temp();
	install(root, a.bytes); const before = files(root), p = previewImport(root, b.bytes);
	assert.equal(p.chats[0]!.kind, "conflict");
	assert.throws(() => installImport(root, b.bytes, { revision: p.revision, choices: {}, acknowledged: true })); assert.deepEqual(files(root), before);
	install(root, b.bytes, { chat_import: "local" });
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_import.json")), fs.readFileSync(path.join(a.root, "chats/chat_import.json")));
	assert.equal(importVersions(root).length, 2);
	install(root, b.bytes, { chat_import: "incoming" });
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_import.json")), fs.readFileSync(path.join(b.root, "chats/chat_import.json")));
	assert.equal(importVersions(root).length, 2); assert.deepEqual(fs.readdirSync(path.join(root, "chats")), ["chat_import.json"]);
});
test("stale preview, absent acknowledgement and extra conflict keys fail before mutation", () => {
	const source = archive(), root = temp(), p = previewImport(root, source.bytes);
	assert.throws(() => installImport(root, source.bytes, { revision: p.revision, choices: {}, acknowledged: false }));
	assert.throws(() => installImport(root, source.bytes, { revision: p.revision, choices: { wrong: "local" }, acknowledged: true }));
	write(root, "chats/chat_import.json", JSON.stringify(record("chat_import", "Local changed")));
	const before = files(root);
	assert.throws(() => installImport(root, source.bytes, { revision: p.revision, choices: { chat_import: "incoming" }, acknowledged: true })); assert.deepEqual(files(root), before);
});
test("shared definitions, graph format differences, skipped conflicting provenance and replacement of graph evidence are blocked", () => {
	const first = archive(), root = temp(); install(root, first.bytes);
	const changed = archive([record()], [{ ...node("n_chat_import", "chat_import"), statement: "Different definition" }]);
	assert.match(previewImport(root, changed.bytes).blockers.join(), /node conflict/); assert.throws(() => install(root, changed.bytes));
	const format = repack(first.bytes, members => { members["graph/format.json"] = Buffer.from('{"version":1,"different":true}'); });
	assert.match(previewImport(root, format).blockers.join(), /metadata differs/);
	const second = archive([record("chat_import", "Changed"), record("chat_other")], [node("n_shared", "chat_import"), { ...node("n_other", "chat_other"), provenance: [{ chatId: "chat_other", messageId: "u" }, { chatId: "chat_import", messageId: "u" }] }]);
	assert.throws(() => install(root, second.bytes, { chat_import: "local" }), /skipped conflicting history/);
	assert.throws(() => install(root, second.bytes, { chat_import: "incoming" }), /Existing graph depends/);
});
test("existing unrelated graph bytes are retained, assertions deduplicate, and identical local lessons do not gain an import pause", () => {
	const source = archive(), root = temp(), existing = JSON.stringify(node("n_other", "chat_unrelated")) + "\n\n";
	write(root, "graph/nodes.jsonl", existing);
	write(root, "chats/chat_import.json", fs.readFileSync(path.join(source.root, "chats/chat_import.json")));
	install(root, source.bytes); assert.equal(importPause(root, "chat_import"), undefined);
	assert.equal(importPause(root, "chat_" + "x".repeat(200)), undefined);
	assert.ok(fs.readFileSync(path.join(root, "graph/nodes.jsonl"), "utf8").startsWith(existing));
	const before = files(root); install(root, source.bytes); assert.deepEqual(files(root), before);
});
test("combined graph assertion limits block installation before mutation without counting identical reimports twice", () => {
	const source = archive([record()], Array.from({ length: 5001 }, (_, i) => node(`n_incoming_${i}`, "chat_import"))), root = temp();
	install(root, source.bytes); assert.equal(previewImport(root, source.bytes).blockers.length, 0);
	const other = temp(); write(other, "graph/nodes.jsonl", Array.from({ length: 5000 }, (_, i) => JSON.stringify(node(`n_local_${i}`, "chat_local"))).join("\n") + "\n");
	const before = files(other);
	assert.match(previewImport(other, source.bytes).blockers.join(), /assertion limits/);
	assert.throws(() => install(other, source.bytes)); assert.deepEqual(files(other), before);
});
test("every injected write failure rolls back active records, graph, flags and archived versions", () => {
	const source = archive();
	for (let fail = 0; fail < 7; fail++) {
		const root = temp(), before = files(root);
		assert.throws(() => install(root, source.bytes, {}, index => { if (index === fail) throw new Error("Injected write failure"); }), /Injected/);
		assert.deepEqual(files(root), before); assert.equal(fs.existsSync(path.join(root, "lesson-transfers/pending")), false);
	}
});
test("a process-death journal is rolled back on adapter startup before serving chats", () => {
	const source = archive(), root = temp(); write(root, "input.zip", source.bytes); const before = files(root);
	const cwd = process.cwd();
	const script = `import fs from 'node:fs'; import {previewImport,installImport} from './src/store/lesson-import.ts'; const b=fs.readFileSync(process.env.LH_DATA_DIR+'/input.zip'); installImport(process.env.LH_DATA_DIR,b,{revision:previewImport(process.env.LH_DATA_DIR,b).revision,choices:{},acknowledged:true},i=>{if(i===3)process.exit(23)});`;
	assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd, timeout: 20_000, env: { ...process.env, LH_DATA_DIR: root, LH_AUTH_FILE: path.join(root, "unused-auth.json") }, stdio: "pipe" }), (e: unknown) => (e as { status: number }).status === 23);
	assert.equal(fs.existsSync(path.join(root, "lesson-transfers/pending/journal.json")), true);
	execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import {chatStore} from './src/store/chats.ts'; if(chatStore.getChat('chat_import')!==null)process.exit(24);"], { cwd, timeout: 20_000, env: { ...process.env, LH_DATA_DIR: root, LH_AUTH_FILE: path.join(root, "unused-auth.json") }, stdio: "pipe" });
	assert.deepEqual(files(root), before); install(root, source.bytes);
});
test("unsafe members, file/source dependencies, bad hashes, newer versions and malformed UTF-8/JSON are refused", () => {
	const source = archive();
	for (const name of ["../escape", "files/000.pdf", "graph/sources.json", "chats/unselected.json"]) assert.throws(() => readImportPackage(repack(source.bytes, m => { m[name] = Buffer.from("{}"); })));
	assert.throws(() => readImportPackage(repack(source.bytes, m => { m["chats/chat_import.json"] = Buffer.from([0xff]); })));
	assert.throws(() => readImportPackage(repack(source.bytes, m => { m["chats/chat_import.json"] = Buffer.from("[".repeat(65) + "0" + "]".repeat(65)); })));
	assert.throws(() => readImportPackage(repack(source.bytes, m => { const r = record(); r.version = 2; m["chats/chat_import.json"] = Buffer.from(JSON.stringify(r)); })));
	const damaged = unzipSync(source.bytes); damaged["chats/chat_import.json"] = Buffer.from("{}"); assert.throws(() => readImportPackage(zipSync(damaged)));
	assert.throws(() => readImportPackage(new Uint8Array(32 * 1024 * 1024 + 1)));
	const forged = Buffer.from(source.bytes);
	for (let i = 0; i + 46 < forged.length; i++) if (forged.readUInt32LE(i) === 0x02014b50 && forged.subarray(i + 46, i + 46 + forged.readUInt16LE(i + 28)).toString().startsWith("chats/")) { forged.writeUInt32LE(1, i + 24); break; }
	assert.throws(() => readImportPackage(forged), /output limit|length mismatch/);
});
test("recovery refuses unsafe journal destinations without modifying files outside the library", () => {
	const root = temp(), victim = temp(); write(victim, "untouched", "preserve");
	write(root, "lesson-transfers/pending/journal.json", JSON.stringify([{ path: `../${path.basename(victim)}/untouched`, before: null }]));
	assert.throws(() => recoverTransfers(root)); assert.equal(fs.readFileSync(path.join(victim, "untouched"), "utf8"), "preserve");
});
