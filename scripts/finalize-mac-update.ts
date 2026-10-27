/** Local-only macOS release finalization. Never uploads or publishes anything.
 * CLI (cwd = tagged checkout):
 *   tsx scripts/finalize-mac-update.ts <arm64-dir> <x64-dir> <output-dir>
 * Each input directory must contain only its feed, DMG, ZIP and two blockmaps.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	checkVersion, expectedAssets, feedExpectations, loadRepoConfig,
	verifyConfigAssumptions, verifyUpdateFeeds,
	type ExpectedAssets, type ReleaseAsset, type ReleaseRecord,
} from "./verify-release.ts";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
	load(source: string): unknown;
	dump(value: unknown, options?: { lineWidth: number; noRefs: boolean }): string;
};
type FileEntry = { url: string; sha512: string; size: number };
type MacFeed = {
	version: string;
	files: FileEntry[];
	path: string;
	sha512: string;
	releaseDate: string | Date;
	releaseName?: string;
	releaseNotes?: string;
	minimumSystemVersion?: string;
	stagingPercentage?: number;
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function regularFile(file: string): fs.Stats {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
		throw new Error(`${file}: must be a nonempty regular file, not a symlink`);
	}
	return stat;
}

function directory(dir: string): string {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir}: must be a directory, not a symlink`);
	return fs.realpathSync(dir);
}

async function digest(file: string): Promise<string> {
	const hash = createHash("sha512");
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
	} finally {
		await handle.close();
	}
	return hash.digest("base64");
}

function release(assets: ReleaseAsset[], version: string): ReleaseRecord {
	return { id: 0, tag_name: `v${version}`, draft: true, assets };
}

/** Reject fields the current Mac updater does not need rather than forwarding
 * unvalidated download references (for example packages or a legacy sha2). */
function validateMacFields(value: unknown, label: string): asserts value is MacFeed {
	if (!record(value)) throw new Error(`${label}: not a mapping`);
	const allowed = ["version", "files", "path", "sha512", "releaseDate", "releaseName", "releaseNotes", "minimumSystemVersion", "stagingPercentage"];
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
	}
	const date = value.releaseDate;
	if (!(typeof date === "string" || date instanceof Date) || !Number.isFinite(date instanceof Date ? date.getTime() : Date.parse(date))) {
		throw new Error(`${label}: releaseDate must be a valid date`);
	}
	for (const key of ["releaseName", "releaseNotes", "minimumSystemVersion"]) {
		if (key in value && (typeof value[key] !== "string" || value[key] === "")) {
			throw new Error(`${label}: ${key} must be a nonempty string`);
		}
	}
	if ("stagingPercentage" in value && (typeof value.stagingPercentage !== "number" ||
		!Number.isFinite(value.stagingPercentage) || value.stagingPercentage < 0 || value.stagingPercentage > 100)) {
		throw new Error(`${label}: stagingPercentage must be a number from 0 to 100`);
	}
	// Core fields have already passed verifyUpdateFeeds; check optional file fields.
	if (!Array.isArray(value.files)) throw new Error(`${label}: files must be an array`);
	for (const entry of value.files) {
		if (!record(entry)) throw new Error(`${label}: file entry must be a mapping`);
		for (const key of Object.keys(entry)) {
			if (!["url", "sha512", "size"].includes(key)) throw new Error(`${label}: unsupported file field ${key}`);
		}
	}
}

async function nativeFeed(dir: string, arch: "arm64" | "x64", expected: ExpectedAssets) {
	const artifacts = [expected.mac[arch].zip, expected.mac[arch].dmg];
	const names = [...artifacts, ...artifacts.map((name) => `${name}.blockmap`), expected.mac.feed];
	const actual = fs.readdirSync(dir).sort();
	if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) {
		throw new Error(`${arch}: staged assets must be exactly ${names.join(", ")}; found ${actual.join(", ")}`);
	}
	const assets = names.map((name, id) => ({ id, name, size: regularFile(path.join(dir, name)).size, state: "uploaded" }));
	const feedPath = path.join(dir, expected.mac.feed);
	const fd = fs.openSync(feedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	let source: string;
	try {
		source = fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
	const verdict = verifyUpdateFeeds({ [expected.mac.feed]: source }, release(assets, expected.version), expected.version,
		[{ file: expected.mac.feed, urls: artifacts, first: expected.mac[arch].zip }]);
	if (!verdict.ok) throw new Error(`${arch}: ${verdict.errors.join("\n")}`);
	const info = yaml.load(source);
	validateMacFields(info, arch);
	for (const entry of info.files) {
		if (await digest(path.join(dir, entry.url)) !== entry.sha512) throw new Error(`${arch}: ${entry.url}: SHA512 does not match actual artifact`);
	}
	return { dir, names: names.filter((name) => name !== expected.mac.feed), assets, info };
}

/** Validates both immutable native stages before creating any output. The output
 * must be absent or empty; stale artifacts are never silently overwritten. */
export async function finalizeMacUpdate(arm64Dir: string, x64Dir: string, outputDir: string, version: string): Promise<string[]> {
	const versioned = checkVersion(version);
	if (!versioned.ok) throw new Error(versioned.errors.join("\n"));
	const expected = expectedAssets(version);
	const arm64Path = directory(arm64Dir);
	const x64Path = directory(x64Dir);
	if (arm64Path === x64Path) throw new Error("architecture stages must be distinct directories");
	const outputPath = path.resolve(outputDir);
	// Resolve the existing parent as well, so an alias cannot hide an input/output overlap.
	const canonicalOutput = fs.existsSync(outputPath) ? directory(outputPath) : path.join(fs.realpathSync(path.dirname(outputPath)), path.basename(outputPath));
	for (const input of [arm64Path, x64Path]) {
		if (canonicalOutput === input || canonicalOutput.startsWith(`${input}${path.sep}`) || input.startsWith(`${canonicalOutput}${path.sep}`)) {
			throw new Error("output directory must be separate from both input stages");
		}
	}
	if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length !== 0) throw new Error("output directory must be empty");
	const arm64 = await nativeFeed(arm64Path, "arm64", expected);
	const x64 = await nativeFeed(x64Path, "x64", expected);
	for (const key of ["releaseName", "releaseNotes", "minimumSystemVersion", "stagingPercentage"] as const) {
		if (arm64.info[key] !== x64.info[key]) throw new Error(`conflicting ${key} between architecture feeds`);
	}
	// Native jobs have different timestamps. Keep the complete legacy arm64 fields,
	// including its releaseDate; only files[] is extended with the Intel entries.
	const combined: MacFeed = { ...arm64.info, files: [...arm64.info.files, ...x64.info.files] };
	const source = yaml.dump(combined, { lineWidth: -1, noRefs: true });
	const verdict = verifyUpdateFeeds({ [expected.mac.feed]: source }, release([...arm64.assets, ...x64.assets], version), version,
		[feedExpectations(expected)[0]!]);
	if (!verdict.ok) throw new Error(verdict.errors.join("\n"));
	fs.mkdirSync(outputPath, { recursive: true });
	for (const stage of [arm64, x64]) {
		for (const name of stage.names) {
			fs.copyFileSync(path.join(stage.dir, name), path.join(outputPath, name), fs.constants.COPYFILE_EXCL);
		}
	}
	// The feed is written last: failed staging can never leave a publishable feed.
	fs.writeFileSync(path.join(outputPath, expected.mac.feed), source, { flag: "wx" });
	return [...arm64.names, ...x64.names, expected.mac.feed];
}

async function main(args: string[]): Promise<void> {
	if (args.length !== 3) throw new Error("usage: finalize-mac-update.ts <arm64-dir> <x64-dir> <output-dir>");
	const repo = loadRepoConfig();
	if (!repo.ok) throw new Error(repo.errors.join("\n"));
	const config = verifyConfigAssumptions(repo.config, repo.pkg, repo.x64Config);
	if (!config.ok) throw new Error(config.errors.join("\n"));
	const version = checkVersion(record(repo.pkg) ? repo.pkg.version : undefined);
	if (!version.ok) throw new Error(version.errors.join("\n"));
	const names = await finalizeMacUpdate(args[0]!, args[1]!, args[2]!, version.version);
	console.log(`Finalized ${names.length} macOS release assets for ${version.version} in ${path.resolve(args[2]!)}`);
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
