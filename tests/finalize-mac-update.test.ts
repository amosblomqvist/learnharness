import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UpdateInfo, UpdateFileInfo } from "builder-util-runtime";
import { finalizeMacUpdate } from "../scripts/finalize-mac-update.ts";
import { expectedAssets, verifyMetadataFiles } from "../scripts/verify-release.ts";

const require = createRequire(import.meta.url);
// Runtime imports avoid Electron's global DOM overloads in this web/Node test
// project. Only the selection/download boundary used below is typed here.
type ResolvedFile = { url: URL; info: UpdateFileInfo };
type SelectionOptions = {
	updateInfoAndProvider: { info: UpdateInfo; provider: { resolveFiles(info: UpdateInfo): ResolvedFile[] } };
};
type UpdaterSelection = {
	logger: { info(): void; warn(): void; error(): void };
	doDownloadUpdate(options: SelectionOptions): Promise<string[]>;
	executeDownload(task: { fileExtension: string; fileInfo: ResolvedFile }): Promise<string[]>;
};
const { MacUpdater } = require("electron-updater/out/MacUpdater.js") as { MacUpdater: { prototype: UpdaterSelection } };
const { parseUpdateInfo, resolveFiles } = require("electron-updater/out/providers/Provider.js") as {
	parseUpdateInfo(source: string, channel: string, url: URL): UpdateInfo;
	resolveFiles(info: UpdateInfo, baseUrl: URL): ResolvedFile[];
};
const yaml = require("js-yaml") as { dump(value: unknown): string };
const childProcess = require("node:child_process") as typeof ChildProcess;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const version = "0.3.8";
const expected = expectedAssets(version);
type FixtureFeed = {
	version: string;
	files: Array<{ url: string; size: number; sha512: string }>;
	path: string;
	sha512: string;
	releaseDate: string;
	releaseNotes?: string;
};
type Fixture = {
	root: string;
	dirs: Record<"arm64" | "x64", string>;
	feeds: Record<"arm64" | "x64", FixtureFeed>;
	output: string;
	writeFeed(arch: "arm64" | "x64", info?: unknown): void;
	run(): Promise<string[]>;
};

function fixture(t: { after(fn: () => void): void }, fixtureVersion = version): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mac-finalizer-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const names = expectedAssets(fixtureVersion);
	const dirs = { arm64: path.join(root, "arm64"), x64: path.join(root, "x64") };
	const feeds = {} as Record<"arm64" | "x64", FixtureFeed>;
	for (const arch of ["arm64", "x64"] as const) {
		fs.mkdirSync(dirs[arch]);
		const files = [names.mac[arch].zip, names.mac[arch].dmg].map((url) => {
			const bytes = Buffer.from(`artifact fixture for ${url}\n`);
			fs.writeFileSync(path.join(dirs[arch], url), bytes);
			fs.writeFileSync(path.join(dirs[arch], `${url}.blockmap`), `blockmap fixture for ${url}\n`);
			return { url, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
		});
		feeds[arch] = {
			version: fixtureVersion, files, path: files[0]!.url, sha512: files[0]!.sha512,
			releaseDate: arch === "arm64" ? "2026-10-26T04:27:17.094Z" : "2026-10-26T05:27:17.094Z",
		};
		fs.writeFileSync(path.join(dirs[arch], names.mac.feed), yaml.dump(feeds[arch]));
	}
	const output = path.join(root, "combined");
	return {
		root, dirs, feeds, output,
		writeFeed(arch: "arm64" | "x64", info: unknown = feeds[arch]) {
			fs.writeFileSync(path.join(dirs[arch], names.mac.feed), yaml.dump(info));
		},
		run: () => finalizeMacUpdate(dirs.arm64, dirs.x64, output, fixtureVersion),
	};
}

async function selectedZip(info: UpdateInfo, arch: "x64" | "arm64", rosetta = false) {
	const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
	const originalExec = childProcess.execFileSync;
	Object.defineProperty(process, "arch", { ...originalArch, value: arch });
	// Deterministic architecture probes on every test host, including Linux CI.
	childProcess.execFileSync = ((file: string) => {
		if (file === "sysctl") return `sysctl.proc_translated: ${rosetta ? 1 : 0}`;
		if (file === "uname") return arch === "arm64" ? "Darwin ARM64" : "Darwin x86_64";
		throw new Error(`unexpected subprocess ${file}`);
	}) as typeof childProcess.execFileSync;
	try {
		// Run the installed updater's selection path without its Electron constructor,
		// stopping before any network request, cache write, or Squirrel launch.
		const updater = Object.create(MacUpdater.prototype) as UpdaterSelection;
		updater.logger = { info() {}, warn() {}, error() {} };
		updater.executeDownload = async (task) => {
			assert.equal(task.fileExtension, "zip");
			return [path.posix.basename(task.fileInfo.url.pathname)];
		};
		return await updater.doDownloadUpdate({
			updateInfoAndProvider: { info, provider: { resolveFiles: value => resolveFiles(value, new URL("https://updates.invalid/")) } },
		});
	} finally {
		childProcess.execFileSync = originalExec;
		Object.defineProperty(process, "arch", originalArch);
	}
}

describe("macOS metadata finalization", () => {
	it("copies nine outputs, preserves arm64 legacy fields and selects the correct ZIP with the installed updater", async (t) => {
		const f = fixture(t);
		const names = await f.run();
		const wanted = [expected.mac.arm64.zip, expected.mac.arm64.dmg, expected.mac.x64.zip, expected.mac.x64.dmg];
		assert.deepEqual(names.toSorted(), [...wanted, ...wanted.map((name) => `${name}.blockmap`), expected.mac.feed].sort());
		assert.deepEqual(fs.readdirSync(f.output).sort(), names.toSorted());
		for (const arch of ["arm64", "x64"] as const) {
			for (const name of [expected.mac[arch].zip, expected.mac[arch].dmg]) {
				for (const file of [name, `${name}.blockmap`]) {
					assert.deepEqual(fs.readFileSync(path.join(f.output, file)), fs.readFileSync(path.join(f.dirs[arch], file)));
				}
			}
		}
		const source = fs.readFileSync(path.join(f.output, expected.mac.feed), "utf8");
		const info = parseUpdateInfo(source, expected.mac.feed, new URL("https://updates.invalid/latest-mac.yml"));
		assert.deepEqual(info.files.map((entry) => entry.url), wanted);
		assert.equal(info.path, f.feeds.arm64.path);
		assert.equal(info.sha512, f.feeds.arm64.sha512);
		assert.equal(info.releaseDate, f.feeds.arm64.releaseDate);
		assert.deepEqual(await selectedZip(info, "x64"), [expected.mac.x64.zip]);
		assert.deepEqual(await selectedZip(info, "arm64"), [expected.mac.arm64.zip]);
		assert.deepEqual(await selectedZip(info, "x64", true), [expected.mac.arm64.zip]);
	});

	const mutations: Array<[string, (f: Fixture) => void, RegExp]> = [
		["missing architecture ZIP", (f) => fs.unlinkSync(path.join(f.dirs.x64, expected.mac.x64.zip)), /staged assets must be exactly/],
		["missing sidecar", (f) => fs.unlinkSync(path.join(f.dirs.arm64, `${expected.mac.arm64.zip}.blockmap`)), /staged assets must be exactly/],
		["empty sidecar", (f) => fs.writeFileSync(path.join(f.dirs.x64, `${expected.mac.x64.dmg}.blockmap`), ""), /nonempty regular file/],
		["stale artifact", (f) => fs.writeFileSync(path.join(f.dirs.x64, "LearnHarness-0.1.0-x64.dmg"), "stale"), /staged assets must be exactly/],
		["unexpected directory", (f) => fs.mkdirSync(path.join(f.dirs.arm64, "extra")), /staged assets must be exactly/],
		["conflicting version", (f) => { f.feeds.x64.version = "0.1.0"; f.writeFeed("x64"); }, /version is/],
		["missing Intel feed entry", (f) => { f.feeds.x64.files.pop(); f.writeFeed("x64"); }, /must reference exactly/],
		["duplicate entry", (f) => { f.feeds.arm64.files.push(f.feeds.arm64.files[0]!); f.writeFeed("arm64"); }, /must reference exactly/],
		["conflicting duplicate", (f) => { f.feeds.x64.files.push({ ...f.feeds.x64.files[0]!, size: 1 }); f.writeFeed("x64"); }, /must reference exactly/],
		["wrong architecture", (f) => { f.feeds.x64.files[1]!.url = expected.mac.arm64.dmg; f.writeFeed("x64"); }, /must reference exactly/],
		["incorrect size", (f) => { f.feeds.x64.files[0]!.size++; f.writeFeed("x64"); }, /release asset size/],
		["incorrect digest", (f) => { const entry = f.feeds.x64.files[1]!; entry.sha512 = createHash("sha512").update("wrong").digest("base64"); f.writeFeed("x64"); }, /SHA512 does not match/],
		["artifact changed after metadata generation", (f) => fs.appendFileSync(path.join(f.dirs.arm64, expected.mac.arm64.dmg), "changed"), /release asset size/],
		["malformed digest", (f) => { f.feeds.arm64.files[1]!.sha512 = "A".repeat(100); f.writeFeed("arm64"); }, /not a base64 digest/],
		["wrong legacy path", (f) => { f.feeds.arm64.path = expected.mac.arm64.dmg; f.writeFeed("arm64"); }, /top-level path/],
		["wrong legacy digest", (f) => { f.feeds.arm64.sha512 = f.feeds.arm64.files[1]!.sha512; f.writeFeed("arm64"); }, /top-level sha512/],
		["ZIP not first", (f) => { f.feeds.x64.files.reverse(); f.writeFeed("x64"); }, /files\[0\] must be/],
		["non-mapping document", (f) => f.writeFeed("arm64", ["bad"]), /top level is not a mapping/],
		["malformed file entry", (f) => f.writeFeed("x64", { ...f.feeds.x64, files: [null] }), /not a mapping/],
		["string size", (f) => f.writeFeed("x64", { ...f.feeds.x64, files: [{ ...f.feeds.x64.files[0], size: "123" }, f.feeds.x64.files[1]] }), /positive integer/],
		["invalid date", (f) => { f.feeds.x64.releaseDate = "not-a-date"; f.writeFeed("x64"); }, /releaseDate/],
		["unknown download field", (f) => f.writeFeed("x64", { ...f.feeds.x64, packages: { x64: { path: "https://evil.invalid/pkg" } } }), /unsupported field packages/],
		["unknown file field", (f) => f.writeFeed("x64", { ...f.feeds.x64, files: [{ ...f.feeds.x64.files[0], sha2: "bad" }, f.feeds.x64.files[1]] }), /unsupported file field/],
		["embedded blockmap metadata on a sidecar build", (f) => f.writeFeed("x64", { ...f.feeds.x64, files: [{ ...f.feeds.x64.files[0], blockMapSize: 1 }, f.feeds.x64.files[1]] }), /unsupported file field blockMapSize/],
		["conflicting release notes", (f) => { f.feeds.x64.releaseNotes = "different"; f.writeFeed("x64"); }, /conflicting releaseNotes/],
		["duplicate YAML key", (f) => fs.appendFileSync(path.join(f.dirs.x64, expected.mac.feed), "version: 0.1.0\n"), /does not parse as YAML/],
	];
	for (const unsafe of ["../app.zip", "https://evil.invalid/app.zip", "/tmp/app.zip", "file:///tmp/app.zip", "dist\\app.zip", "%2e%2e%2fapp.zip", "app.zip?x=1", "app.zip#x"]) {
		mutations.push([`unsafe reference ${unsafe}`, (f) => { f.feeds.x64.files[1]!.url = unsafe; f.writeFeed("x64"); }, /not a bare asset name/]);
	}
	for (const name of [expected.mac.x64.zip, `${expected.mac.x64.dmg}.blockmap`, expected.mac.feed]) {
		mutations.push([`symlink ${name}`, (f) => {
			const file = path.join(f.dirs.x64, name);
			const target = path.join(f.root, `target-${name}`);
			fs.renameSync(file, target);
			fs.symlinkSync(target, file);
		}, /nonempty regular file/]);
	}
	for (const [label, mutate, pattern] of mutations) {
		it(`rejects ${label} before writing output`, async (t) => {
			const f = fixture(t);
			mutate(f);
			await assert.rejects(f.run(), pattern);
			assert.equal(fs.existsSync(f.output), false);
		});
	}

	it("rejects aliased stages, symlink directories, overlapping and nonempty outputs", async (t) => {
		const f = fixture(t);
		await assert.rejects(finalizeMacUpdate(f.dirs.arm64, f.dirs.arm64, f.output, version), /distinct directories/);
		const alias = path.join(f.root, "alias");
		fs.symlinkSync(f.dirs.x64, alias, "dir");
		await assert.rejects(finalizeMacUpdate(f.dirs.arm64, alias, f.output, version), /not a symlink/);
		await assert.rejects(finalizeMacUpdate(f.dirs.arm64, f.dirs.x64, f.dirs.x64, version), /separate/);
		await assert.rejects(finalizeMacUpdate(f.dirs.arm64, f.dirs.x64, path.join(f.dirs.x64, "out"), version), /separate/);
		fs.mkdirSync(f.output);
		fs.writeFileSync(path.join(f.output, "stale"), "do not overwrite");
		await assert.rejects(f.run(), /must be empty/);
		assert.equal(fs.readFileSync(path.join(f.output, "stale"), "utf8"), "do not overwrite");
	});

	it("the complete read-only release gate rejects a partial or duplicated combined feed", async (t) => {
		const f = fixture(t);
		await f.run();
		const macSource = fs.readFileSync(path.join(f.output, expected.mac.feed), "utf8");
		const release = { id: 1, tag_name: `v${version}`, draft: true, assets: expected.files.map((name, id) => ({
			id, name, state: "uploaded", size: fs.existsSync(path.join(f.output, name)) ? fs.statSync(path.join(f.output, name)).size : 100,
		})) };
		const otherFeed = (urls: string[]) => yaml.dump({ version, files: urls.map((url) => ({ url, size: 100, sha512: f.feeds.x64.sha512 })), path: urls[0], sha512: f.feeds.x64.sha512 });
		const feeds = { [expected.mac.feed]: macSource, [expected.win.feed]: otherFeed([expected.win.exe]), [expected.linux.feed]: otherFeed([expected.linux.appImage, expected.linux.deb]) };
		assert.equal(verifyMetadataFiles(feeds, release, expected).ok, true);
		const info = parseUpdateInfo(macSource, expected.mac.feed, new URL("https://updates.invalid/latest-mac.yml"));
		const complete = info.files;
		for (const files of [complete.filter((entry) => !entry.url.includes("x64")), [...complete, complete[0]!]]) {
			const verdict = verifyMetadataFiles({ ...feeds, [expected.mac.feed]: yaml.dump({ ...info, files }) }, release, expected);
			assert.equal(verdict.ok, false);
		}
	});

	it("CLI reads the cwd package version and both configs, staging only local outputs", (t) => {
		const futureVersion = "12.3.4";
		const f = fixture(t, futureVersion);
		const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
		fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ ...pkg, version: futureVersion }));
		for (const name of ["electron-builder.yml", "electron-builder.mac-x64.yml"]) fs.copyFileSync(path.join(repoRoot, name), path.join(f.root, name));
		const result = spawnSync(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), path.join(repoRoot, "scripts/finalize-mac-update.ts"), f.dirs.arm64, f.dirs.x64, f.output], {
			cwd: f.root, encoding: "utf8", timeout: 60_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Finalized 9 macOS release assets for 12\.3\.4/);
		assert.equal(fs.readdirSync(f.output).length, 9);
	});
});
