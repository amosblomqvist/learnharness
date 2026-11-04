import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { rewriteDesktopEntry, updateAppImageShortcuts } = require("../electron/appimage-shortcuts.cjs");
const oldPath = "/apps/LearnHarness-1.2.3-x86_64.AppImage";
const newPath = "/apps/LearnHarness-1.2.4-x86_64.AppImage";
const entry = (command = oldPath) => `[Desktop Entry]\nName=LearnHarness\nExec=${command} %U\nTryExec=${oldPath}\n`;

it("changes exact direct Exec/TryExec paths, retaining arguments and every other byte", () => {
	const original = `[Desktop Entry]\r\nName=LearnHarness\r\n# ${oldPath}\r\nExec=${oldPath}\t--no-sandbox --label="two words" %U\r\nTryExec=${oldPath}\r\nIcon=${oldPath}\r\nX-AppImage-Version=1.2.3`;
	assert.equal(rewriteDesktopEntry(original, oldPath, newPath), original
		.replace(`Exec=${oldPath}\t`, `Exec=${newPath}\t`)
		.replace(`TryExec=${oldPath}\r`, `TryExec=${newPath}\r`));
});

it("handles double-quoted direct paths with spaces without interpreting the arguments", () => {
	const old = "/apps/My Images/LearnHarness-1.2.3.AppImage";
	const next = "/apps/My Images/LearnHarness-1.2.4.AppImage";
	const original = `[Desktop Entry]\nExec="${old}" --label="$HOME" %U\nTryExec=${old}\n`;
	assert.equal(rewriteDesktopEntry(original, old, next), original.replaceAll(old, next));
	assert.equal(rewriteDesktopEntry(entry(`"${oldPath}"`), oldPath, newPath), entry(`"${newPath}"`).replace(`TryExec=${oldPath}`, `TryExec=${newPath}`));
});

it("quotes a new executable path when needed, without changing the remaining command", () => {
	const next = "/apps/New Images/LearnHarness.AppImage";
	assert.equal(rewriteDesktopEntry(entry(), oldPath, next), `[Desktop Entry]\nName=LearnHarness\nExec="${next}" %U\nTryExec=${next}\n`);
});

for (const command of [
	`${oldPath}.backup`, `${oldPath}/other`, `/other${oldPath}`, `/other/image.AppImage --open ${oldPath}`,
	`env APPIMAGE=${oldPath} ${oldPath}`, `sh -c '"${oldPath}"'`, `"/wrapper" ${oldPath}`,
	`'${oldPath}'`, ` ${oldPath}`, `"${oldPath}`, `${oldPath}"suffix`, `"${oldPath}"suffix`,
	`%f ${oldPath}`, `file://${oldPath}`,
]) it(`leaves unsupported/indirect/non-exact Exec unchanged: ${command}`, () => {
	const original = `[Desktop Entry]\nExec=${command}\n`;
	assert.equal(rewriteDesktopEntry(original, oldPath, newPath), original);
});

for (const value of [undefined, null, "relative.AppImage", "/apps/escaped\\path", "/apps/$name", "/apps/`name`", "/apps/%name", "/apps/a\nb", "/apps/a\0b"]) {
	it(`rejects ambiguous/non-absolute executable paths ${JSON.stringify(value)}`, () => {
		const original = entry();
		assert.equal(rewriteDesktopEntry(original, value, newPath), original);
		assert.equal(rewriteDesktopEntry(original, oldPath, value), original);
	});
}

it("updates direct Desktop Action Execs but not unknown groups, metadata, or TryExec command forms", () => {
	const original = `Exec=${oldPath}\n[Desktop Entry]\nExec=${oldPath}\nTryExec="${oldPath}"\n[Desktop Action new-window]\nExec=${oldPath} --new-window\nTryExec=${oldPath}\n[X-Tool]\nExec=${oldPath}\n`;
	assert.equal(rewriteDesktopEntry(original, oldPath, newPath), `Exec=${oldPath}\n[Desktop Entry]\nExec=${newPath}\nTryExec="${oldPath}"\n[Desktop Action new-window]\nExec=${newPath} --new-window\nTryExec=${oldPath}\n[X-Tool]\nExec=${oldPath}\n`);
	const withArgs = `[Desktop Entry]\nTryExec=${oldPath} --extra\n`;
	assert.equal(rewriteDesktopEntry(withArgs, oldPath, newPath), withArgs);
});

it("is idempotent and does nothing for a stable filename", () => {
	assert.equal(rewriteDesktopEntry(entry(), oldPath, oldPath), entry());
	const rewritten = rewriteDesktopEntry(entry(), oldPath, newPath);
	assert.equal(rewriteDesktopEntry(rewritten, oldPath, newPath), rewritten);
});

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-appimage-shortcuts-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const dataHome = path.join(root, "xdg-data");
	const directory = path.join(dataHome, "applications");
	fs.mkdirSync(directory, { recursive: true });
	fs.mkdirSync(home);
	const messages: string[] = [];
	const options = { oldPath, newPath, home, dataHome, log: (line: string) => messages.push(line) };
	const write = (name: string, text = entry()) => {
		const file = path.join(directory, name);
		fs.writeFileSync(file, text);
		return file;
	};
	return { root, home, dataHome, directory, messages, options, write };
}

it("updates multiple ordinary user entries, preserving permissions and leaving non-desktop files alone", (t) => {
	const f = fixture(t);
	const first = f.write("learnharness.desktop");
	const second = f.write("custom-name.desktop");
	const unrelated = f.write("notes.txt");
	fs.chmodSync(first, 0o755);
	updateAppImageShortcuts(f.options);
	assert.equal(fs.readFileSync(first, "utf8"), entry(newPath).replace(`TryExec=${oldPath}`, `TryExec=${newPath}`));
	assert.equal(fs.readFileSync(second, "utf8"), fs.readFileSync(first, "utf8"));
	assert.equal(fs.readFileSync(unrelated, "utf8"), entry());
	if (process.platform !== "win32") assert.equal(fs.statSync(first).mode & 0o777, 0o755);
	assert.deepEqual(fs.readdirSync(f.directory).sort(), ["custom-name.desktop", "learnharness.desktop", "notes.txt"]);
	assert.equal(f.messages.length, 2);
});

it("does not inspect the Desktop, other data homes or system directories", (t) => {
	const f = fixture(t);
	const user = f.write("learnharness.desktop");
	const outside = path.join(f.home, "Desktop");
	fs.mkdirSync(outside);
	const desktop = path.join(outside, "learnharness.desktop");
	fs.writeFileSync(desktop, entry());
	const seen: string[] = [];
	updateAppImageShortcuts({ ...f.options, io: { ...fs, readdirSync: (dir: string) => { seen.push(dir); return fs.readdirSync(dir); } } });
	assert.deepEqual(seen, [f.directory]);
	assert.match(fs.readFileSync(user, "utf8"), /1\.2\.4/);
	assert.equal(fs.readFileSync(desktop, "utf8"), entry());
});

it("falls back to the home data directory for absent/relative XDG_DATA_HOME", (t) => {
	const f = fixture(t);
	const fallback = path.join(f.home, ".local", "share", "applications");
	fs.mkdirSync(fallback, { recursive: true });
	for (const dataHome of [undefined, "relative-data", ""]) {
		const file = path.join(fallback, "learnharness.desktop");
		fs.writeFileSync(file, entry());
		updateAppImageShortcuts({ ...f.options, dataHome });
		assert.match(fs.readFileSync(file, "utf8"), /1\.2\.4/);
	}
});

it("does no I/O without valid different AppImage paths or an absolute data root", () => {
	const io = new Proxy({}, { get() { assert.fail("unexpected I/O"); } });
	for (const [old, next] of [[undefined, newPath], [oldPath, undefined], [oldPath, oldPath], ["relative", newPath]]) {
		updateAppImageShortcuts({ oldPath: old, newPath: next, home: "/home/test", io });
	}
	updateAppImageShortcuts({ oldPath, newPath, home: "relative", dataHome: "relative", io });
});

it("a missing applications directory is a harmless no-op", (t) => {
	const f = fixture(t);
	fs.rmdirSync(f.directory);
	assert.doesNotThrow(() => updateAppImageShortcuts(f.options));
	assert.deepEqual(f.messages, []);
});

it("skips file symlinks (including dangling links) and directories without reading their targets", (t) => {
	const f = fixture(t);
	const outside = path.join(f.root, "outside.desktop");
	fs.writeFileSync(outside, entry());
	try {
		fs.symlinkSync(outside, path.join(f.directory, "linked.desktop"), "file");
		fs.symlinkSync(path.join(f.root, "missing"), path.join(f.directory, "dangling.desktop"), "file");
	} catch (err) {
		if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows symlink permission unavailable"); return; }
		throw err;
	}
	fs.mkdirSync(path.join(f.directory, "folder.desktop"));
	const regular = f.write("regular.desktop");
	updateAppImageShortcuts(f.options);
	assert.equal(fs.readFileSync(outside, "utf8"), entry());
	assert.equal(fs.lstatSync(path.join(f.directory, "linked.desktop")).isSymbolicLink(), true);
	assert.equal(fs.lstatSync(path.join(f.directory, "dangling.desktop")).isSymbolicLink(), true);
	assert.match(fs.readFileSync(regular, "utf8"), /1\.2\.4/);
});

it("one unreadable entry does not stop subsequent entries", (t) => {
	const f = fixture(t);
	const bad = f.write("bad.desktop");
	const good = f.write("good.desktop");
	updateAppImageShortcuts({ ...f.options, io: { ...fs,
		readdirSync: () => ["bad.desktop", "good.desktop"],
		readFileSync: (file: string, ...args: unknown[]) => {
			if (file === bad) throw new Error("synthetic read denied");
			return (fs.readFileSync as Function)(file, ...args);
		},
	} });
	assert.equal(fs.readFileSync(bad, "utf8"), entry());
	assert.match(fs.readFileSync(good, "utf8"), /1\.2\.4/);
	assert.ok(f.messages.some(line => line.includes("bad.desktop skipped")));
});

for (const operation of ["accessSync", "openSync", "writeFileSync", "fchmodSync", "closeSync", "renameSync"] as const) {
	it(`preserves original bytes on ${operation} failure, cleans owned temps, and continues scanning`, (t) => {
		const f = fixture(t);
		const bad = f.write("bad.desktop", entry() + "Comment=é\n");
		const good = f.write("good.desktop");
		const original = fs.readFileSync(bad);
		let failed = false;
		const io = { ...fs, readdirSync: () => ["bad.desktop", "good.desktop"], [operation]: (...args: unknown[]) => {
			if (!failed) {
				failed = true;
				if (operation === "writeFileSync") fs.writeSync(args[0] as number, "partial replacement");
				if (operation === "closeSync") fs.closeSync(args[0] as number);
				throw new Error(`synthetic ${operation} failure`);
			}
			return (fs[operation] as Function)(...args);
		} };
		updateAppImageShortcuts({ ...f.options, io });
		assert.equal(failed, true);
		assert.deepEqual(fs.readFileSync(bad), original);
		assert.match(fs.readFileSync(good, "utf8"), /1\.2\.4/);
		assert.deepEqual(fs.readdirSync(f.directory).sort(), ["bad.desktop", "good.desktop"]);
	});
}

it("never deletes a temporary it failed to create exclusively", (t) => {
	const f = fixture(t);
	const original = f.write("learnharness.desktop");
	let collision = "";
	updateAppImageShortcuts({ ...f.options, io: { ...fs, openSync: (file: string) => {
		collision = file;
		fs.writeFileSync(file, "foreign temporary");
		throw Object.assign(new Error("collision"), { code: "EEXIST" });
	} } });
	assert.equal(fs.readFileSync(original, "utf8"), entry());
	assert.equal(fs.readFileSync(collision, "utf8"), "foreign temporary");
});

it("does not overwrite a concurrently edited entry", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	updateAppImageShortcuts({ ...f.options, io: { ...fs, writeFileSync: (...args: unknown[]) => {
		const result = (fs.writeFileSync as Function)(...args);
		fs.writeFileSync(file, "concurrent edit");
		return result;
	} } });
	assert.equal(fs.readFileSync(file, "utf8"), "concurrent edit");
	assert.deepEqual(fs.readdirSync(f.directory), ["learnharness.desktop"]);
});

it("leaves malformed UTF-8 entries byte-identical", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	const original = Buffer.concat([Buffer.from(entry() + "Comment="), Buffer.from([0xff, 0xfe])]);
	fs.writeFileSync(file, original);
	updateAppImageShortcuts(f.options);
	assert.deepEqual(fs.readFileSync(file), original);
	assert.deepEqual(fs.readdirSync(f.directory), ["learnharness.desktop"]);
});

it("leaves a symlink introduced during preparation in place and does not change its target", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	const target = path.join(f.root, "outside.desktop");
	fs.writeFileSync(target, entry());
	// Verify permission before injecting the replacement on Windows.
	const probe = path.join(f.root, "probe");
	try { fs.symlinkSync(target, probe, "file"); } catch (err) {
		if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows symlink permission unavailable"); return; }
		throw err;
	}
	fs.unlinkSync(probe);
	updateAppImageShortcuts({ ...f.options, io: { ...fs, writeFileSync: (...args: unknown[]) => {
		const result = (fs.writeFileSync as Function)(...args);
		fs.unlinkSync(file);
		fs.symlinkSync(target, file, "file");
		return result;
	} } });
	assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
	assert.equal(fs.readFileSync(target, "utf8"), entry());
	assert.deepEqual(fs.readdirSync(f.directory), ["learnharness.desktop"]);
});

it("never creates replacement files for an unrelated or already-updated entry", (t) => {
	const f = fixture(t);
	const original = `[Desktop Entry]\nExec=/other/application ${oldPath}\n`;
	const unrelated = f.write("unrelated.desktop", original);
	const updated = f.write("current.desktop", rewriteDesktopEntry(entry(), oldPath, newPath));
	const io = { ...fs, openSync: () => assert.fail("unchanged entry must not be written") };
	updateAppImageShortcuts({ ...f.options, io });
	assert.equal(fs.readFileSync(unrelated, "utf8"), original);
	assert.equal(fs.readFileSync(updated, "utf8"), rewriteDesktopEntry(entry(), oldPath, newPath));
});

it("a logging failure cannot interrupt the update", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	assert.doesNotThrow(() => updateAppImageShortcuts({ ...f.options, log: () => { throw new Error("logger unavailable"); } }));
	assert.match(fs.readFileSync(file, "utf8"), /1\.2\.4/);
});

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = fs.readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);
function setupUpdater(platform: string, env: Record<string, string>, home: string, packaged = true) {
	const updater = new EventEmitter();
	const electron = {
		app: { isPackaged: packaged, setName() {}, getPath: () => home, setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: { getAllWindows: () => [] },
	};
	const context = { require: (id: string) => id === "electron" ? electron : id === "electron-updater" ? { autoUpdater: updater } : mainRequire(id),
		process: { platform, argv: [], env, on() {} }, __dirname: path.dirname(mainFile), console: { log() {} },
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	runInNewContext("setupAutoUpdater()", context);
	return updater;
}

it("production Linux registration repairs only on the filename event, with no startup migration", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	const updater = setupUpdater("linux", { APPIMAGE: oldPath, XDG_DATA_HOME: f.dataHome }, f.home);
	assert.equal(fs.readFileSync(file, "utf8"), entry(), "no startup repair");
	assert.equal(updater.listenerCount("appimage-filename-updated"), 1);
	updater.emit("appimage-filename-updated", newPath);
	assert.match(fs.readFileSync(file, "utf8"), /1\.2\.4/);
	updater.emit("appimage-filename-updated", undefined);
	assert.match(fs.readFileSync(file, "utf8"), /1\.2\.4/);
});

for (const platform of ["darwin", "win32"]) it(`${platform} never installs the AppImage shortcut handler`, (t) => {
	const f = fixture(t);
	const updater = setupUpdater(platform, { APPIMAGE: oldPath, XDG_DATA_HOME: f.dataHome }, f.home);
	assert.equal(updater.listenerCount("appimage-filename-updated"), 0);
});

it("development builds and non-AppImage Linux events cannot modify shortcuts", (t) => {
	const f = fixture(t);
	const file = f.write("learnharness.desktop");
	const dev = setupUpdater("linux", { APPIMAGE: oldPath, XDG_DATA_HOME: f.dataHome }, f.home, false);
	assert.equal(dev.listenerCount("appimage-filename-updated"), 0);
	const deb = setupUpdater("linux", { XDG_DATA_HOME: f.dataHome }, f.home);
	assert.doesNotThrow(() => deb.emit("appimage-filename-updated", newPath));
	assert.equal(fs.readFileSync(file, "utf8"), entry());
});
