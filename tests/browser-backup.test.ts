/**
 * Phone backup / restore (mobile Phase 1): the zip codec round-trips and
 * reads zips made by other tools; restore finds the desktop data folder
 * however it was zipped, replaces the phone's data and keeps its API keys.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vfs from "../src/browser/shims/vfs.ts";
import fs from "../src/browser/shims/fs.ts";
import { crc32, readZip, writeZip } from "../src/browser/zip.ts";
import { applyRestore, exportBackup, planRestore } from "../src/browser/backup.ts";
import { addFile, listAddedFiles } from "../src/browser/files.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

test("crc32 matches the standard check value", () => {
	assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("zip round-trips text and binary, deflated and stored", async () => {
	const entries = [
		{ path: "data/chats/a.json", data: enc.encode(JSON.stringify({ messages: "x".repeat(5000) })) },
		{ path: "data/tiny.txt", data: enc.encode("hi") },
		{ path: "data/bin.png", data: new Uint8Array([0, 255, 1, 254]) },
		{ path: "data/ünïcødé.md", data: enc.encode("✓") },
	];
	const zipped = await bytesOf(await writeZip(entries));
	assert.ok(zipped.length < 5000, "the repetitive JSON was deflated");
	const back = await readZip(zipped);
	assert.deepEqual(back.map((e) => e.path), entries.map((e) => e.path));
	back.forEach((e, i) => assert.deepEqual([...e.data], [...entries[i]!.data]));
});

test("our zips open with the system unzip, and system zips open with ours", async () => {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "lh-zip-"));
	try {
		const ours = path.join(dir, "ours.zip");
		nodeFs.writeFileSync(ours, await bytesOf(await writeZip([{ path: "data/settings.json", data: enc.encode('{"version":1}') }])));
		assert.equal(execFileSync("unzip", ["-p", ours, "data/settings.json"]).toString(), '{"version":1}');

		nodeFs.mkdirSync(path.join(dir, "data", "chats"), { recursive: true });
		nodeFs.writeFileSync(path.join(dir, "data", "chats", "c1.json"), JSON.stringify({ id: "c1", body: "y".repeat(3000) }));
		execFileSync("zip", ["-qr", "theirs.zip", "data"], { cwd: dir });
		const entries = await readZip(new Uint8Array(nodeFs.readFileSync(path.join(dir, "theirs.zip"))));
		const chat = entries.find((e) => e.path === "data/chats/c1.json");
		assert.ok(chat);
		assert.equal(JSON.parse(dec.decode(chat.data)).id, "c1");
	} finally {
		nodeFs.rmSync(dir, { recursive: true, force: true });
	}
});

test("restore finds the data folder however it was zipped, skipping Finder litter", async () => {
	const file = (p: string, s: string) => ({ path: p, data: enc.encode(s) });
	for (const prefix of ["data/", "", "Backups/LearnHarness/data/"]) {
		const zip = await bytesOf(
			await writeZip([
				file(`${prefix}chats/c1.json`, "{}"),
				file(`${prefix}chats/c2.json`, "{}"),
				file(`${prefix}graph/nodes.jsonl`, ""),
				file(`${prefix}settings.json`, "{}"),
				file(`__MACOSX/${prefix}chats/._c1.json`, "junk"),
				file(`${prefix}.DS_Store`, "junk"),
			]),
		);
		const plan = await planRestore(zip);
		assert.equal(plan.sessions, 2, `prefix "${prefix}"`);
		assert.deepEqual(plan.files.map((f) => f.rel).sort(), ["chats/c1.json", "chats/c2.json", "graph/nodes.jsonl", "settings.json"]);
	}
	await assert.rejects(planRestore(await bytesOf(await writeZip([file("notes/readme.txt", "hi")]))), /doesn’t contain LearnHarness data/);
});

test("added files ride in files/; a desktop zip (no files/) leaves them alone", async () => {
	vfs.resetForTests();
	try {
		fs.mkdirSync("/lh/data/chats", { recursive: true });
		fs.writeFileSync("/lh/data/chats/c.json", "{}");
		addFile("optics notes.md", enc.encode("# Optics"));
		assert.equal(addFile("optics notes.md", enc.encode("again")), "optics notes (2).md");
		assert.deepEqual(listAddedFiles().map((f) => f.name), ["optics notes (2).md", "optics notes.md"]);

		const backup = await bytesOf((await exportBackup()).blob);
		const paths = (await readZip(backup)).map((e) => e.path).sort();
		assert.deepEqual(paths, ["data/chats/c.json", "files/optics notes (2).md", "files/optics notes.md"]);

		// Desktop zip: no files/ → added files survive the restore.
		applyRestore(await planRestore(await bytesOf(await writeZip([{ path: "data/chats/d.json", data: enc.encode("{}") }]))));
		assert.equal(listAddedFiles().length, 2);

		// Phone backup with files/ (data zipped at the root): files replaced,
		// and files/ never leaks into the data folder.
		const phone = await writeZip([
			{ path: "chats/e.json", data: enc.encode("{}") },
			{ path: "files/paper.pdf", data: new Uint8Array([37, 80, 68, 70]) },
		]);
		const plan = await planRestore(await bytesOf(phone));
		assert.deepEqual(plan.files.map((f) => f.rel), ["chats/e.json"]);
		applyRestore(plan);
		assert.deepEqual(listAddedFiles().map((f) => f.name), ["paper.pdf"]);
		assert.equal(fs.existsSync("/lh/data/files/paper.pdf"), false);
	} finally {
		vfs.resetForTests();
	}
});

test("restore replaces phone data, keeps the keys; backups never contain keys", async () => {
	vfs.resetForTests();
	try {
		fs.mkdirSync("/lh/data/chats", { recursive: true });
		fs.writeFileSync("/lh/data/auth.json", '{"ANTHROPIC_API_KEY":"sk-ant-secret"}');
		fs.writeFileSync("/lh/data/chats/phone.json", '{"id":"phone"}');
		fs.writeFileSync("/lh/data/settings.json", '{"version":1}');

		const backup = await exportBackup();
		const inBackup = (await readZip(await bytesOf(backup.blob))).map((e) => e.path).sort();
		assert.deepEqual(inBackup, ["data/chats/phone.json", "data/settings.json"]);

		const desktop = await writeZip([
			{ path: "data/chats/desk.json", data: enc.encode('{"id":"desk"}') },
			{ path: "data/graph/nodes.jsonl", data: enc.encode('{"id":"n1"}\n') },
			{ path: "data/auth.json", data: enc.encode('{"ANTHROPIC_API_KEY":"from-zip"}') },
		]);
		applyRestore(await planRestore(await bytesOf(desktop)));

		assert.equal(fs.existsSync("/lh/data/chats/phone.json"), false);
		assert.equal(fs.existsSync("/lh/data/settings.json"), false);
		assert.equal(fs.readFileSync("/lh/data/chats/desk.json", "utf-8"), '{"id":"desk"}');
		assert.equal(fs.readFileSync("/lh/data/graph/nodes.jsonl", "utf-8"), '{"id":"n1"}\n');
		assert.equal(fs.readFileSync("/lh/data/auth.json", "utf-8"), '{"ANTHROPIC_API_KEY":"sk-ant-secret"}');
	} finally {
		vfs.resetForTests();
	}
});
