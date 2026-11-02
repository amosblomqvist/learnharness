/**
 * Phone-build shims (mobile Phase 0) — the browser stand-ins for node:fs,
 * node:path, node:crypto and Buffer must behave like Node for the calls the
 * bundled server code makes, because the store adapters run unchanged on
 * top of them. Each case compares against the real Node module where one
 * exists. (The router and IndexedDB layer are exercised end to end by
 * scripts/smoke-mobile.mjs in a real browser.)
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as nodeCrypto from "node:crypto";
import * as nodePath from "node:path";

import * as vfs from "../src/browser/shims/vfs.ts";
import fs from "../src/browser/shims/fs.ts";
import * as fsp from "../src/browser/shims/fs-promises.ts";
import * as bpath from "../src/browser/shims/path.ts";
import { Buffer as BBuffer } from "../src/browser/shims/buffer.ts";
import { createHash, createHmac, randomBytes } from "../src/browser/shims/crypto.ts";

test("sha256 and hmac match node:crypto", () => {
	for (const input of ["", "abc", "x".repeat(55), "x".repeat(56), "y".repeat(1000), "ünïcødé ✓"]) {
		assert.equal(createHash("sha256").update(input).digest("hex"), nodeCrypto.createHash("sha256").update(input).digest("hex"));
		assert.equal(
			createHmac("sha256", "key").update(input).digest("base64url"),
			nodeCrypto.createHmac("sha256", "key").update(input).digest("base64url"),
		);
	}
	const long = "k".repeat(100);
	assert.equal(createHmac("sha256", long).update("m").digest("hex"), nodeCrypto.createHmac("sha256", long).update("m").digest("hex"));
	assert.match(randomBytes(6).toString("hex"), /^[0-9a-f]{12}$/);
});

test("Buffer encodings match node", () => {
	const text = "hello ✓ wörld";
	for (const enc of ["hex", "base64", "base64url", "utf8"] as const) {
		assert.equal(BBuffer.from(text).toString(enc), Buffer.from(text).toString(enc));
		assert.equal(BBuffer.from(Buffer.from(text).toString(enc), enc).toString(), text);
	}
	assert.equal(BBuffer.byteLength(text), Buffer.byteLength(text));
});

test("path matches node:path (posix) for the forms the code uses", () => {
	const cases: [keyof typeof bpath & keyof typeof nodePath.posix, string[]][] = [
		["join", ["/lh/data", "chats", "a.json"]],
		["join", ["a", "..", "b", "./c/"]],
		["dirname", ["/lh/app/config.ts"]],
		["dirname", ["/a"]],
		["basename", ["/x/y/file.md", ".md"]],
		["extname", ["/x/y/file.tar.gz"]],
		["extname", ["/x/.hidden"]],
		["relative", ["/lh/app/src", "/lh/app/src/agent/prompts/a.md"]],
		["relative", ["/a/b/c", "/a/x"]],
		["normalize", ["/a//b/../c/."]],
		["isAbsolute", ["rel/path"]],
	];
	for (const [fn, args] of cases) {
		assert.deepEqual((bpath[fn] as (...a: string[]) => unknown)(...args), (nodePath.posix[fn] as (...a: string[]) => unknown)(...args), `${fn}(${args})`);
	}
	assert.equal(bpath.resolve("/lh/data", "graph", "../chats"), "/lh/data/chats");
	assert.equal(bpath.resolve("relative"), "/lh/app/relative");
});

test("fs: files, dirs, errors and listing behave like node:fs", async () => {
	vfs.resetForTests();
	assert.throws(() => fs.writeFileSync("/d/a.json", "{}"), { code: "ENOENT" });
	fs.mkdirSync("/d/chats", { recursive: true });
	assert.equal(fs.mkdirSync("/d/chats", { recursive: true }), undefined);
	assert.throws(() => fs.mkdirSync("/d/chats"), { code: "EEXIST" });

	fs.writeFileSync("/d/chats/a.json", '{"x":1}', "utf-8");
	fs.appendFileSync("/d/log.jsonl", "1\n");
	fs.appendFileSync("/d/log.jsonl", "2\n");
	assert.equal(fs.readFileSync("/d/log.jsonl", "utf-8"), "1\n2\n");
	assert.equal(fs.readFileSync("/d/chats/a.json").toString(), '{"x":1}');
	assert.throws(() => fs.readFileSync("/d/nope.json", "utf-8"), { code: "ENOENT" });
	assert.throws(() => fs.readFileSync("/d/chats", "utf-8"), { code: "EISDIR" });

	assert.deepEqual(fs.readdirSync("/d"), ["chats", "log.jsonl"]);
	const dirents = fs.readdirSync("/d", { withFileTypes: true }) as { name: string; isDirectory(): boolean }[];
	assert.deepEqual(dirents.map((d) => [d.name, d.isDirectory()]), [["chats", true], ["log.jsonl", false]]);
	assert.equal(fs.statSync("/d/chats/a.json")?.size, 7);
	assert.equal(fs.statSync("/d/missing", { throwIfNoEntry: false }), undefined);

	fs.renameSync("/d/chats/a.json", "/d/chats/b.json");
	assert.equal(fs.existsSync("/d/chats/a.json"), false);
	assert.equal(await fsp.readFile("/d/chats/b.json", "utf-8"), '{"x":1}');
	assert.throws(() => fs.rmSync("/d"), { code: "ENOTEMPTY" });
	fs.rmSync("/d", { recursive: true, force: true });
	assert.equal(fs.existsSync("/d/chats/b.json"), false);
	fs.rmSync("/d/never", { force: true });
	assert.throws(() => fs.unlinkSync("/d/never"), { code: "ENOENT" });

	fs.mkdirSync("/bin", { recursive: true });
	fs.writeFileSync("/bin/x.png", new Uint8Array([1, 2, 3]));
	assert.deepEqual([...(fs.readFileSync("/bin/x.png") as Uint8Array)], [1, 2, 3]);
	assert.equal(fs.readFileSync("/bin/x.png", "base64"), "AQID");
});

test("vfs: every mutation reaches the persistence sink; seeds do not", () => {
	vfs.resetForTests();
	const ops: string[] = [];
	vfs.setPersistSink({ put: (p) => ops.push(`put ${p}`), remove: (p) => ops.push(`rm ${p}`) });
	try {
		vfs.seedFile("/lh/app/src/agent/system-prompt.md", "prompt");
		fs.mkdirSync("/lh/data/chats", { recursive: true });
		fs.writeFileSync("/lh/data/chats/c.json", "{}");
		fs.renameSync("/lh/data/chats/c.json", "/lh/data/chats/d.json");
		fs.unlinkSync("/lh/data/chats/d.json");
		assert.deepEqual(ops, ["put /lh/data/chats/c.json", "rm /lh/data/chats/c.json", "put /lh/data/chats/d.json", "rm /lh/data/chats/d.json"]);
		assert.equal(fs.readFileSync("/lh/app/src/agent/system-prompt.md", "utf-8"), "prompt");
	} finally {
		vfs.setPersistSink(null);
		vfs.resetForTests();
	}
});
