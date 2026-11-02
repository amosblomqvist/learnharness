/**
 * Crash-safe store writes (#403): src/store/atomic-write.ts. Each save must
 * leave the old bytes or the complete new bytes on the rename path. The
 * opt-in Windows in-place fallback retains the old interruption risk and
 * keeps the temp if writing fails midway. The Windows cases fake the
 * rename errors that held files raise; scripts in the verify skill hold real
 * files open.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it, type TestContext } from "node:test";
import { removeLeftoverTemps, writeFileAtomicSync } from "../src/store/atomic-write.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-atomic-write-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const onWindows = { skip: process.platform !== "win32" && "Windows rename semantics" };

function target(name: string, text?: string, folder = "case-"): string {
	const dir = fs.mkdtempSync(path.join(root, folder));
	const file = path.join(dir, name);
	if (text !== undefined) fs.writeFileSync(file, text);
	return file;
}
const temps = (file: string) => fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"));
const fail = (code: string) => Object.assign(new Error(code), { code });

function modelWindows(t: TestContext): void {
	// Only the platform gate is modeled. These are not native held-handle tests.
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
}

describe("writeFileAtomicSync", () => {
	it("replaces the file with exactly the given text and leaves no temp file", () => {
		const file = target("record.json", "old");
		writeFileAtomicSync(file, '{\n\t"é": "\u{1F600}"\n}');
		assert.equal(fs.readFileSync(file, "utf-8"), '{\n\t"é": "\u{1F600}"\n}');
		assert.deepEqual(temps(file), []);
	});

	it("creates files that did not exist", () => {
		const file = target("new.json");
		writeFileAtomicSync(file, "{}");
		assert.equal(fs.readFileSync(file, "utf-8"), "{}");
	});

	it("failed saves in folders with non-ASCII characters leave no temp file", (t) => {
		const file = target("record.json", "old", "José-日本-");
		t.mock.method(fs, "renameSync", () => { throw fail("EIO"); });
		assert.throws(() => writeFileAtomicSync(file, "new"), { code: "EIO" });
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(file), []);
	});

	it("failed renames throw their own error and keep the old file whole", (t) => {
		const file = target("record.json", "old");
		const rename = t.mock.method(fs, "renameSync", () => { throw fail("EIO"); });
		assert.throws(() => writeFileAtomicSync(file, "new"), { code: "EIO" });
		assert.equal(rename.mock.callCount(), 1, "only sharing violations are retried");
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(file), []);
	});

	it("crashes right before the rename keep the chat (the #403 repro)", () => {
		const env = { ...process.env, NODE_ENV: "test" as const, LH_DATA_DIR: fs.mkdtempSync(path.join(root, "data-")) };
		const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "tests/helpers/chat-save-crash.ts", ...args], { env, encoding: "utf8", timeout: 30000 });
		const id = run("create").stdout.trim();
		assert.equal(run("crash", id).status, 77);
		const seen = JSON.parse(run("read", id).stdout);
		assert.equal(seen.chat?.messages[0].content, "first", "the old record still reads");
		assert.deepEqual(seen.listed, [id], "the sidebar still lists it and skips the leftover");
		assert.equal(seen.files.filter((f: string) => f.includes(".tmp-")).length, 1, "the crash left its temp file");
	});

	it("modeled Windows: briefly held files are renamed once released", (t) => {
		modelWindows(t);
		const file = target("record.json", "old");
		const rename = fs.renameSync;
		let refusals = 2;
		t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
			if (refusals-- > 0) throw fail("EPERM");
			return rename(...args);
		});
		const warn = t.mock.method(console, "warn", () => {});
		writeFileAtomicSync(file, "new");
		assert.equal(fs.readFileSync(file, "utf-8"), "new");
		assert.deepEqual(temps(file), []);
		assert.equal(warn.mock.callCount(), 0, "the rename landed; no in-place fallback");
	});

	it("modeled Windows: new files whose temp is briefly held still land by rename", (t) => {
		modelWindows(t);
		const file = target("new.json");
		const rename = fs.renameSync;
		let refusals = 2;
		t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
			if (refusals-- > 0) throw fail("EPERM"); // scanners holding the fresh temp file
			return rename(...args);
		});
		const warn = t.mock.method(console, "warn", () => {});
		writeFileAtomicSync(file, "new");
		assert.equal(fs.readFileSync(file, "utf-8"), "new");
		assert.equal(warn.mock.callCount(), 0, "the rename landed; no in-place fallback");
	});

	it("modeled Windows: files held past the retry are saved in place instead of failing", (t) => {
		modelWindows(t);
		const file = target("record.json", "old");
		t.mock.method(fs, "renameSync", () => { throw fail("EPERM"); });
		const warn = t.mock.method(console, "warn", () => {});
		const started = Date.now();
		writeFileAtomicSync(file, "new", { allowInPlaceFallback: true });
		assert.ok(Date.now() - started < 1000, "the retry is short");
		assert.equal(fs.readFileSync(file, "utf-8"), "new");
		assert.deepEqual(temps(file), []);
		assert.match(String(warn.mock.calls[0]?.arguments[0]), /held open/);
	});

	it("modeled Windows: fallbacks that cannot open the file fail and keep the old file", (t) => {
		modelWindows(t);
		const file = target("record.json", "old");
		t.mock.method(fs, "renameSync", () => { throw fail("EPERM"); });
		const open = fs.openSync;
		t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
			if (args[0] === file) throw fail("EBUSY");
			return open(...args);
		});
		const warn = t.mock.method(console, "warn", () => {});
		assert.throws(() => writeFileAtomicSync(file, "new", { allowInPlaceFallback: true }), { code: "EBUSY" });
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(file), []);
		assert.equal(warn.mock.callCount(), 0, "nothing was saved");
	});

	it("modeled Windows: fallbacks that fail midway keep the complete temp file", (t) => {
		modelWindows(t);
		const file = target("record.json", "old");
		t.mock.method(fs, "renameSync", () => { throw fail("EPERM"); });
		const write = fs.writeFileSync;
		let writes = 0;
		t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
			if (++writes === 2) throw fail("ENOSPC"); // the in-place write, after the temp's
			return write(...args);
		});
		assert.throws(() => writeFileAtomicSync(file, "new", { allowInPlaceFallback: true }), { code: "ENOSPC" });
		const kept = temps(file);
		assert.equal(kept.length, 1);
		assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]!), "utf-8"), "new");
	});

	it("Windows: read-only files fail at once, like in-place writes", onWindows, () => {
		const file = target("record.json", "old");
		fs.chmodSync(file, 0o444);
		const started = Date.now();
		assert.throws(() => writeFileAtomicSync(file, "new"), { code: "EPERM" });
		assert.ok(Date.now() - started < 50, "no waiting on read-only files");
		fs.chmodSync(file, 0o666);
		assert.equal(fs.readFileSync(file, "utf-8"), "old");
		assert.deepEqual(temps(file), []);
	});

	it("folders in the way fail at once", () => {
		const file = target("record.json");
		fs.mkdirSync(file);
		const started = Date.now();
		assert.throws(() => writeFileAtomicSync(file, "new"));
		assert.ok(Date.now() - started < 50, "no waiting on folders");
		assert.deepEqual(temps(file), []);
	});

	it("rename replaces a symlink without changing its referent", (t) => {
		const real = target("real.json", "old");
		const link = path.join(path.dirname(real), "link.json");
		try {
			fs.symlinkSync(real, link);
		} catch {
			t.skip("symlinks need extra rights on this machine");
			return;
		}
		writeFileAtomicSync(link, "new", { mode: 0o600 });
		assert.ok(fs.lstatSync(link).isFile());
		assert.equal(fs.readFileSync(link, "utf-8"), "new");
		assert.equal(fs.readFileSync(real, "utf-8"), "old");
		if (process.platform !== "win32") assert.equal(fs.statSync(link).mode & 0o777, 0o600);
	});

	it("modeled Windows: a held symlink never falls back to overwriting its referent", (t) => {
		const real = target("real.json", "old");
		const link = path.join(path.dirname(real), "link.json");
		try { fs.symlinkSync(real, link); }
		catch {
			t.skip("symlinks need extra rights on this machine");
			return;
		}
		modelWindows(t);
		const rename = t.mock.method(fs, "renameSync", () => { throw fail("EACCES"); });
		const warn = t.mock.method(console, "warn", () => {});
		assert.throws(() => writeFileAtomicSync(link, "new", { allowInPlaceFallback: true }), { code: "EACCES" });
		assert.ok(rename.mock.callCount() > 1, "replacement was retried before failing");
		assert.ok(fs.lstatSync(link).isSymbolicLink(), "the unsuccessful replacement leaves the link intact");
		assert.equal(fs.readFileSync(real, "utf-8"), "old", "the referent was never truncated or written");
		assert.equal(warn.mock.callCount(), 0, "no in-place save was performed");
		assert.deepEqual(temps(link), []);
	});

	for (const code of ["EPERM", "EACCES", "EBUSY"]) {
		for (const allowInPlaceFallback of [false, true]) {
			it(`modeled Windows ${code}: in-place fallback is ${allowInPlaceFallback ? "enabled" : "disabled by default"}`, (t) => {
				modelWindows(t);
				const file = target("record.json", "old");
				const rename = t.mock.method(fs, "renameSync", () => { throw fail(code); });
				const warn = t.mock.method(console, "warn", () => {});
				if (allowInPlaceFallback) {
					writeFileAtomicSync(file, "new", { allowInPlaceFallback: true });
					assert.equal(fs.readFileSync(file, "utf-8"), "new");
					assert.equal(warn.mock.callCount(), 1);
				} else {
					assert.throws(() => writeFileAtomicSync(file, "new"), { code });
					assert.equal(fs.readFileSync(file, "utf-8"), "old");
					assert.equal(warn.mock.callCount(), 0);
				}
				assert.ok(rename.mock.callCount() > 1, "sharing violations were retried");
				assert.deepEqual(temps(file), []);
			});
		}
	}

	it("mode applies to the new file", { skip: process.platform === "win32" && "Windows has no POSIX modes" }, () => {
		const file = target("secret.json", "old");
		writeFileAtomicSync(file, "new", { mode: 0o600 });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});
});

describe("removeLeftoverTemps", () => {
	it("removes only that file's crash leftovers", () => {
		const file = target("chat_a.json", "{}");
		const dir = path.dirname(file);
		for (const name of ["chat_a.json.tmp-1", "chat_a.json.tmp-2", "chat_ab.json.tmp-3", "chat_b.json"]) fs.writeFileSync(path.join(dir, name), "x");
		removeLeftoverTemps(file);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["chat_a.json", "chat_ab.json.tmp-3", "chat_b.json"]);
	});

	it("works in folders with non-ASCII characters", () => {
		const file = target("chat_a.json", "{}", "José-日本-");
		fs.writeFileSync(`${file}.tmp-1`, "x");
		removeLeftoverTemps(file);
		assert.deepEqual(temps(file), []);
	});

	it("does nothing when the folder is gone", () => {
		removeLeftoverTemps(path.join(root, "missing", "x.json"));
	});
});
