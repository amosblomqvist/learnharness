import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { unzipSync } from "fflate";
import { downloadExport, previewExport } from "../src/store/lesson-export.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-transfer-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
function library() {
	const root = fs.mkdtempSync(path.join(scratch, "library-"));
	fs.mkdirSync(path.join(root, "chats")); fs.mkdirSync(path.join(root, "graph"));
	return root;
}
const user = { id: "u", role: "user", content: "Teach me $x^2$", timestamp: 1 };
const question = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "q", name: "quiz", arguments: { question: "What is x?", options: [{ label: "Alpha", value: "UNREVEALED" }, { label: "Beta", value: "second" }], correctAnswer: "UNREVEALED", explanation: "SECRET_EXPLANATION" } }], stopReason: "toolUse", timestamp: 2 };
function chat(root: string, id = "chat_one", messages: unknown[] = [user, question]) {
	const raw = Buffer.from(JSON.stringify({ version: 1, id, title: "Synthetic lesson", createdAt: "2026-10-30", updatedAt: "2026-10-30", messages, opaque: { future: "preserve" }, turns: [{ opaque: "usage" }] }, null, "\t") + "\n");
	fs.writeFileSync(path.join(root, "chats", id + ".json"), raw); return raw;
}
function graph(root: string) {
	const n = (id: string, chatId: string) => ({ id, name: id, statement: id, aliases: [], createdAt: "2026-10-30", provenance: [{ chatId, messageId: "u" }], opaque: "keep" });
	const ns = [n("n1", "chat_one"), n("n2", "chat_other"), n("n3", "chat_other")];
	const cs = [{ id: "c1", premises: ["n2"], conclusion: "n1", createdAt: "2026-10-30", provenance: [{ chatId: "chat_one", messageId: "u" }] }, { id: "c2", premises: ["n1"], conclusion: "n3", createdAt: "2026-10-30", provenance: [{ chatId: "chat_other", messageId: "u" }] }];
	fs.writeFileSync(path.join(root, "graph/nodes.jsonl"), ns.map(n => JSON.stringify(n)).join("\n") + "\n");
	fs.writeFileSync(path.join(root, "graph/chains.jsonl"), cs.map(c => JSON.stringify(c)).join("\n") + "\n");
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function archive(root: string, files: number[] = []) {
	const preview = previewExport(root, ["chat_one"]);
	return unzipSync(downloadExport(root, ["chat_one"], "zip", { revision: preview.revision, files }).bytes);
}

test("readable text excludes hidden commitments, JSON preserves exact bytes, neither depends on graph compatibility", () => {
	const root = library(), raw = chat(root, "chat_one", [user,
		{ id: "service-call", role: "assistant", content: [{ type: "toolCall", id: "list", name: "list_sessions", arguments: {} }] },
		{ id: "service-result", role: "toolResult", toolCallId: "list", toolName: "list_sessions", content: [{ type: "text", text: "SERVICE_SENTINEL" }] }, question]);
	fs.writeFileSync(path.join(root, "graph/nodes.jsonl"), "not json");
	for (const mode of ["md", "txt"] as const) {
		const out = text(downloadExport(root, ["chat_one"], mode).bytes);
		assert.match(out, /Teach me \$x\^2\$/); assert.match(out, /What is x\?/); assert.match(out, /Alpha/);
		assert.doesNotMatch(out, /UNREVEALED|SECRET_EXPLANATION|SERVICE_SENTINEL|result delivered|### Tool|opaque|usage/);
	}
	assert.deepEqual(downloadExport(root, ["chat_one"], "json").bytes, raw);
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_one.json")), raw);
	assert.throws(() => downloadExport(root, ["chat_one", "chat_one"], "md"));
	assert.throws(() => downloadExport(root, ["../escape"], "md"));
	assert.throws(() => downloadExport(root, ["chat_one"], "html" as never));
});

test("current structured learner answers export as labels with thinking, not object dumps", () => {
	const root = library();
	chat(root, "chat_one", [user, question, { id: "r", role: "toolResult", toolCallId: "q", toolName: "quiz", content: [], details: {
		questionText: "What is x?", answers: [{ label: "Alpha", value: "UNREVEALED", index: 1 }], correct: true, thinking: "Authored learner thought", readingThinking: "Reading note"
	} }]);
	const out = text(downloadExport(root, ["chat_one"], "md").bytes);
	assert.match(out, /learner chose: Alpha/); assert.match(out, /Authored learner thought/); assert.match(out, /Reading note/);
	assert.doesNotMatch(out, /object Object|UNREVEALED|SECRET_EXPLANATION|Pending question/);
});

test("ZIP preserves native bytes, selects graph by provenance and inventories every inert member", () => {
	const root = library(), raw = chat(root); chat(root, "chat_other"); graph(root);
	const zip = archive(root), manifest = JSON.parse(text(zip["manifest.json"]!));
	assert.equal(manifest.format, "learnharness-transfer"); assert.equal(manifest.report.complete, false);
	assert.equal(manifest.report.continuationAuthorized, false); assert.equal(manifest.report.dependencyAudit, "partial");
	assert.deepEqual(Buffer.from(zip["chats/chat_one.json"]!), raw); assert.equal(zip["chats/chat_other.json"], undefined);
	assert.match(text(zip["graph/nodes.jsonl"]!), /n2/); assert.doesNotMatch(text(zip["graph/nodes.jsonl"]!), /n3/);
	assert.match(text(zip["graph/chains.jsonl"]!), /c1/); assert.doesNotMatch(text(zip["graph/chains.jsonl"]!), /c2/);
	for (const item of manifest.files) {
		assert.equal(item.bytes, zip[item.path]!.length);
		assert.equal(item.sha256, createHash("sha256").update(zip[item.path]!).digest("hex"));
	}
	assert.equal(manifest.files.length, Object.keys(zip).length - 1);
	assert.ok(manifest.report.issues.some((i: string) => i.includes("chat_other")));
	assert.deepEqual(fs.readFileSync(path.join(root, "chats/chat_one.json")), raw);
});

test("sources are opt-in, missing and credential-like paths are reported, and changed previews refuse", () => {
	const root = library(), source = path.join(scratch, "source.pdf"), secret = path.join(scratch, "credentials.txt");
	fs.writeFileSync(source, "%PDF synthetic"); fs.writeFileSync(secret, "do not export");
	const missing = path.join(scratch, "missing.pdf");
	chat(root, "chat_one", [user, { id: "read", role: "assistant", content: [source, secret, missing].map((p, i) => ({ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: p } })) }]);
	const auth = process.env.LH_AUTH_FILE;
	try {
		process.env.LH_AUTH_FILE = source; // Auth locations are blocked regardless of their extension.
		assert.equal(previewExport(root, ["chat_one"]).files[0]!.status, "blocked");
	} finally { if (auth === undefined) delete process.env.LH_AUTH_FILE; else process.env.LH_AUTH_FILE = auth; }
	const preview = previewExport(root, ["chat_one"]);
	assert.deepEqual(preview.files.map(f => f.status), ["available", "blocked", "missing"]);
	const without = archive(root); assert.equal(without["files/000.pdf"], undefined);
	const withSource = archive(root, [0]); assert.equal(text(withSource["files/000.pdf"]!), "%PDF synthetic");
	assert.equal(JSON.parse(text(withSource["manifest.json"]!)).attachments[0].sourcePath, source);
	assert.throws(() => archive(root, [1])); assert.throws(() => archive(root, [-1]));
	assert.throws(() => downloadExport(root, ["chat_one"], "zip"));
	fs.appendFileSync(source, " changed");
	assert.throws(() => downloadExport(root, ["chat_one"], "zip", { revision: preview.revision, files: [0] }), /changed/);
	assert.equal(fs.readFileSync(secret, "utf8"), "do not export");
});

test("missing definitions, newer graph formats, malformed UTF-8 and oversized/deep JSON refuse without changing the library", () => {
	const root = library(); chat(root); graph(root);
	fs.writeFileSync(path.join(root, "graph/nodes.jsonl"), "");
	assert.throws(() => previewExport(root, ["chat_one"]), /dangling/);
	fs.writeFileSync(path.join(root, "graph/format.json"), '{"version":2}');
	assert.throws(() => previewExport(root, ["chat_one"]), /version/);
	fs.writeFileSync(path.join(root, "chats/chat_one.json"), Buffer.from([0xff]));
	assert.throws(() => downloadExport(root, ["chat_one"], "json"));
	const deep = '{"extra":' + "[".repeat(65) + "0" + "]".repeat(65) + "}";
	fs.writeFileSync(path.join(root, "chats/chat_one.json"), deep);
	assert.throws(() => downloadExport(root, ["chat_one"], "json"), /structure/);
	const file = path.join(root, "chats/chat_one.json");
	fs.writeFileSync(file, Buffer.alloc(16_000_001, 0x20));
	assert.throws(() => downloadExport(root, ["chat_one"], "json"), /limit/);
	assert.equal(fs.statSync(file).size, 16_000_001);
});
