/**
 * SCHEMA STAMPS (schema-versioning wave, owner 2026-10-10): LAZY v1 for
 * chats (record.version, stamped at the write choke point) and the graph
 * family (data/graph/format.json sidecar — ledgers, sources,
 * render-settings; positions deliberately unversioned, rebuildable).
 * Honest refusal: records stamped NEWER than this build are refused on
 * read (the downgrade scenario) — never misparsed, never rewritten.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stamps-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { readRenderSettings, writeRenderSettings } = await import("../src/store/render-settings.ts");
const { GRAPH_FORMAT_FILE } = await import("../config.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── chats: lazy stamp at the write choke point ──────────────────────────────

test("chats: createChat stamps version 1 on disk", () => {
	const r = chatStore.createChat("stamp test");
	assert.equal(r.version, 1, "the in-memory twin is stamped");
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${r.id}.json`), "utf8"));
	assert.equal(onDisk.version, 1, "the record carries the stamp");
});

test("chats: an UNSTAMPED legacy record reads fine (absence = v1) and is stamped by its next write", () => {
	const id = "chat_legacy000_stamp0";
	fs.mkdirSync(path.join(TMP_DATA, "chats"), { recursive: true });
	fs.writeFileSync(
		path.join(TMP_DATA, "chats", `${id}.json`),
		JSON.stringify({ id, title: "legacy", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }),
		"utf-8",
	);
	const r = chatStore.getChat(id);
	assert.ok(r, "unstamped record reads (lazy v1)");
	chatStore.saveMessages(id, []);
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${id}.json`), "utf8"));
	assert.equal(onDisk.version, 1, "the write choke point stamped it");
});

test("chats: a NEWER-stamped record is refused honestly (the downgrade scenario)", () => {
	const id = "chat_future000_stamp0";
	fs.writeFileSync(
		path.join(TMP_DATA, "chats", `${id}.json`),
		JSON.stringify({ id, title: "from the future", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], version: 99 }),
		"utf-8",
	);
	assert.equal(chatStore.getChat(id), null, "getChat refuses: reads as absent, never misparsed");
	assert.ok(!chatStore.listChats().some((s) => s.id === id), "listChats skips it too");
	// and the refused record is NOT rewritten or downgraded by the visit:
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${id}.json`), "utf8"));
	assert.equal(onDisk.version, 99, "the future record survives untouched");
});

// ── the graph family: the lazy format.json sidecar ──────────────────────────

test("graph: reads never write — no sidecar appears from reading alone", () => {
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE), "no sidecar before any write");
	assert.deepEqual(graphStore.readNodes(), [], "ledger reads fine without a sidecar");
	assert.equal(readRenderSettings(), null, "render-settings reads fine without a sidecar");
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE), "reads did NOT create the sidecar (lazy = write-side only)");
});

test("graph: the first ledger append creates the sidecar at version 1", () => {
	graphStore.appendNode({
		id: "n_stamp0",
		name: "Stamps",
		statement: "The graph family carries one format sidecar.",
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: [],
	});
	assert.ok(fs.existsSync(GRAPH_FORMAT_FILE), "the first write stamped the family");
	assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 1);
	assert.equal(graphStore.readNodes().length, 1, "the ledger reads back with the sidecar present");
});

test("graph: a NEWER-stamped sidecar is refused honestly", () => {
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }), "utf-8");
	assert.throws(() => graphStore.readNodes(), /older than its data|format version 99/);
	assert.throws(() => graphStore.readSources(), /older than its data|format version 99/);
	assert.throws(() => readRenderSettings(), /older than its data|format version 99/);
});

test("render-settings: its write stamps the family sidecar too", () => {
	fs.rmSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true, force: true });
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE));
	const written = writeRenderSettings({ sizeUnits: "world", nodeSize: 3 });
	assert.equal(written.nodeSize, 3);
	assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 1, "the render-settings write stamped the family");
});

// ── the fixtures stay the legacy pin: golden data reads unstamped ───────────

test("golden fixtures are deliberately the unstamped legacy shape (lazy v1 = current-valid)", () => {
	const here = import.meta.dirname;
	const teach = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "golden-data", "chats", "chat_mv27rrra_feff23b6.json"), "utf8"));
	assert.equal(teach.version, undefined, "fixture records pin the unstamped read path");
	assert.ok(!fs.existsSync(path.join(here, "fixtures", "golden-data", "graph", "format.json")), "no sidecar in the fixture graph dir");
});
