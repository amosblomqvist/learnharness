import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { comparePluginVersions, parsePluginCatalog } from "../src/core/plugin-catalog.ts";
import { extractCatalogZip, replacePluginDist } from "../src/server/plugin-catalog-install.ts";
import { readPluginConversation } from "../src/server/plugin-catalog.ts";
import currentCatalog from "../plugin-catalog/catalog.json";

const entry = {
	id: "tablet-tools", name: "Tablet Tools", summary: "Stylus controls for drawing.", features: ["Drawing", "Tablet"],
	version: "1.0.0", minAppVersion: "0.6.0", sourceUrl: "https://github.com/example/tablet-tools",
	releaseUrl: "https://github.com/example/tablet-tools/releases/download/v1.0.0/tablet-tools.zip",
	sha256: "a".repeat(64), issueNumber: 123,
};

test("catalog validates reviewed identity, URLs and version ordering", () => {
	assert.deepEqual(parsePluginCatalog(currentCatalog), currentCatalog);
	assert.equal(parsePluginCatalog({ schemaVersion: 1, plugins: [entry] }).plugins[0]?.id, "tablet-tools");
	assert.equal(comparePluginVersions("100000000000000000.0.0", "2.0.0"), 1);
	assert.throws(() => parsePluginCatalog({ schemaVersion: 1, plugins: [entry, entry] }), /duplicate/);
	assert.throws(() => parsePluginCatalog({ schemaVersion: 1, plugins: [{ ...entry, id: "drawing-pad" }] }), /reserved/);
	assert.throws(() => parsePluginCatalog({ schemaVersion: 1, plugins: [{ ...entry, releaseUrl: "https://github.com/other/repo/releases/download/v1/file.zip" }] }), /source repository/);
	assert.throws(() => parsePluginCatalog({ schemaVersion: 1, plugins: [{ ...entry, releaseUrl: "http://localhost/file.zip" }] }), /GitHub URLs/);
});

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
	return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: { name: string; data: string; mode?: number }[]): Buffer {
	const local: Buffer[] = [], central: Buffer[] = [];
	let offset = 0;
	for (const { name, data, mode = 0o100644 } of entries) {
		const filename = Buffer.from(name), bytes = Buffer.from(data), checksum = crc32(bytes);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
		head.writeUInt32LE(checksum, 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(filename.length, 26);
		local.push(head, filename, bytes);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
		record.writeUInt32LE(checksum, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28);
		record.writeUInt32LE(mode * 65536, 38); record.writeUInt32LE(offset, 42);
		central.push(record, filename);
		offset += head.length + filename.length + bytes.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

test("ZIP extraction admits built files and rejects traversal, data and links", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-test-"));
	try {
		await extractCatalogZip(zip([{ name: "dist/manifest.json", data: "{}" }, { name: "dist/assets/icon.svg", data: "<svg/>" }]), root);
		assert.equal(fs.readFileSync(path.join(root, "assets", "icon.svg"), "utf8"), "<svg/>");
		await assert.rejects(extractCatalogZip(zip([{ name: "dist/../outside", data: "bad" }]), root), /Unsafe/);
		await assert.rejects(extractCatalogZip(zip([{ name: "dist/data/private.json", data: "bad" }]), root), /Non-distributable/);
		await assert.rejects(extractCatalogZip(zip([{ name: "dist/link", data: "target", mode: 0o120777 }]), root), /Unsupported/);
		await assert.rejects(extractCatalogZip(zip([{ name: "dist/CON.txt", data: "bad" }]), root), /filename/);
		assert.equal(fs.existsSync(path.join(root, "outside")), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed package refresh restores old code and preserves data", async () => {
	const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-replace-"));
	try {
		const dist = path.join(plugin, "dist"), data = path.join(plugin, "data"), stage = path.join(plugin, "stage"), next = path.join(stage, "dist");
		fs.mkdirSync(dist); fs.mkdirSync(data); fs.mkdirSync(next, { recursive: true });
		fs.writeFileSync(path.join(dist, "main.js"), "old"); fs.writeFileSync(path.join(data, "settings.json"), "kept"); fs.writeFileSync(path.join(next, "main.js"), "new");
		await assert.rejects(replacePluginDist(plugin, next, async () => { throw Error("refresh failed"); }), /refresh failed/);
		assert.equal(fs.readFileSync(path.join(dist, "main.js"), "utf8"), "old");
		assert.equal(fs.readFileSync(path.join(data, "settings.json"), "utf8"), "kept");
	} finally { fs.rmSync(plugin, { recursive: true, force: true }); }
});

test("GitHub issue response supplies public comments and thumbs-up count", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = async (url) => Response.json(String(url).includes("/comments?")
		? [{ user: { login: "author" }, body: "Works well", created_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/amosblomqvist/learnharness/issues/98765#issuecomment-1" }]
		: { comments: 1, reactions: { "+1": 7 } });
	try {
		const result = await readPluginConversation(98765);
		assert.equal(result.thumbsUp, 7);
		assert.equal(result.comments[0]?.body, "Works well");
		assert.equal(result.issueUrl, "https://github.com/amosblomqvist/learnharness/issues/98765");
	} finally { globalThis.fetch = previous; }
});
