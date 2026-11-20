import fs from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { assertOrdinary, ensureStoreId, MANAGED_ITEMS, STORE_MARKER, verifyStore } from "../../electron/data-location.cjs";

const disk = fs.promises;

async function statIfPresent(file: string): Promise<fs.Stats | undefined> {
	try { return await disk.lstat(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** One mkdir per missing level. Recursive mkdir can retry forever under /proc. */
export async function createTargetDirectory(directory: string): Promise<void> {
	const stat = await statIfPresent(directory);
	if (stat) {
		assertOrdinary(stat, directory);
		if (!stat.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
		await disk.access(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
		return;
	}
	const parent = path.dirname(directory);
	await createTargetDirectory(parent);
	await disk.mkdir(directory);
	await sync(parent);
}

async function sync(file: string, directory = true): Promise<void> {
	if (directory && process.platform === "win32") return;
	const fd = await disk.open(file, "r");
	try { await fd.sync(); } finally { await fd.close(); }
}

async function assertEmpty(target: string): Promise<void> {
	const stat = await statIfPresent(target);
	if (!stat) return;
	assertOrdinary(stat, target);
	if (!stat.isDirectory() || (await disk.readdir(target)).length) {
		throw new Error("Copy requires an empty folder. Select an empty folder or explicitly choose to use the data already there.");
	}
}

type FileSnapshot = { size: number; mtimeMs: number; hash: string };
type Snapshot = Map<string, FileSnapshot | "dir">;

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
	return b.isFile() && a.dev === b.dev && a.ino === b.ino &&
		a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function readFileSnapshot(from: string, stat: fs.Stats, to?: string): Promise<FileSnapshot> {
	const hash = createHash("sha256");
	const fd = await disk.open(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		if (!sameFile(stat, await fd.stat())) throw new Error(`The file changed while reading: ${from}`);
		const stream = fd.createReadStream({ autoClose: false });
		if (to) {
			stream.on("data", (chunk) => { hash.update(chunk); });
			await pipeline(stream, fs.createWriteStream(to, { flags: "wx", mode: stat.mode & 0o777 }));
			await sync(to, false);
		} else {
			for await (const chunk of stream) hash.update(chunk);
		}
		if (!sameFile(stat, await fd.stat())) throw new Error(`The file changed while reading: ${from}`);
		return { size: stat.size, mtimeMs: stat.mtimeMs, hash: hash.digest("hex") };
	} finally {
		await fd.close();
	}
}

async function snapshot(root: string, destination?: string): Promise<Snapshot> {
	const manifest: Snapshot = new Map();
	async function visit(relative: string, stat: fs.Stats): Promise<void> {
		const from = path.join(root, relative);
		const to = destination && path.join(destination, relative);
		assertOrdinary(stat, from);
		if (stat.isDirectory()) {
			manifest.set(relative, "dir");
			if (to) await disk.mkdir(to, { mode: 0o700 });
			for (const name of await disk.readdir(from)) {
				const child = path.join(relative, name);
				await visit(child, await disk.lstat(path.join(root, child)));
			}
			if (to) await sync(to);
			return;
		}
		manifest.set(relative, await readFileSnapshot(from, stat, to));
	}
	for (const name of MANAGED_ITEMS) {
		const stat = await statIfPresent(path.join(root, name));
		if (stat) await visit(name, stat);
	}
	return manifest;
}

function matches(a: Snapshot, b: Snapshot, compareTimes = false): boolean {
	return a.size === b.size && [...a].every(([file, entry]) => {
		const other = b.get(file);
		if (entry === "dir" || other === "dir" || other === undefined) return entry === other;
		return entry.size === other.size && entry.hash === other.hash &&
			(!compareTimes || entry.mtimeMs === other.mtimeMs);
	});
}

export async function stageDataCopy(
	source: string, target: string, checkSource: () => void, identity: boolean, prepareSource: () => Promise<void>,
) {
	await assertEmpty(target);
	const parent = path.dirname(target);
	await createTargetDirectory(parent);
	const existingTarget = await statIfPresent(target);
	if (existingTarget && existingTarget.dev !== (await disk.stat(parent)).dev) {
		throw new Error("Choose a subfolder on the destination volume so the copy can be staged beside it.");
	}
	const stage = await disk.mkdtemp(path.join(parent, ".learnharness-copy-"));
	let published = false;
	try {
		await prepareSource();
		checkSource();
		const expected = await snapshot(source, stage);
		if (!matches(expected, await snapshot(stage)) || !matches(expected, await snapshot(source), true)) {
			throw new Error("Data copy verification failed. The folder has not been switched.");
		}
		checkSource();
		const storeId = identity ? ensureStoreId(stage) : null;
		await sync(stage);
		const stagedRoot = await disk.lstat(stage);
		await assertEmpty(target);
		// Rename can replace an empty directory on POSIX. Windows needs its name
		// freed first; rmdir refuses concurrently added contents.
		const emptyWindowsTarget = process.platform === "win32" && Boolean(await statIfPresent(target));
		if (emptyWindowsTarget) await disk.rmdir(target);
		try {
			await disk.rename(stage, target);
			published = true;
		} catch (error) {
			if (emptyWindowsTarget && !(await statIfPresent(target))) await disk.mkdir(target);
			throw error;
		}
		const checkTarget = () => {
			const current = fs.lstatSync(target);
			if (!current.isDirectory() || current.dev !== stagedRoot.dev || current.ino !== stagedRoot.ino) {
				throw new Error("The destination folder changed after copying.");
			}
			if (storeId) verifyStore(target, storeId);
		};
		const rollback = async () => {
			checkTarget();
			const extraEntries = (await disk.readdir(target)).some(name => name !== STORE_MARKER && !expected.has(name));
			if (extraEntries || !matches(expected, await snapshot(target))) {
				throw new Error("The copied folder changed after publishing. Its data was kept.");
			}
			checkTarget();
			await disk.rename(target, stage);
			try {
				if (existingTarget) {
					await disk.mkdir(target, { mode: existingTarget.mode & 0o777 });
					await disk.chmod(target, existingTarget.mode & 0o777);
				}
				await sync(parent);
			} finally {
				await disk.rm(stage, { recursive: true, force: true });
			}
		};
		try { await sync(parent); }
		catch (error) {
			await rollback();
			throw error;
		}
		return { expected, storeId, checkTarget, rollback };
	} finally {
		if (!published) await disk.rm(stage, { recursive: true, force: true });
	}
}

export async function cleanOldData(source: string, target: string, expected: Snapshot, checkSource: () => void): Promise<string[]> {
	const failures: string[] = [];
	try {
		checkSource();
		if (!matches(expected, await snapshot(target))) throw new Error("The destination changed after copying.");
	} catch (error) {
		return [`No old data was removed: ${(error as Error).message}`];
	}
	// The verified manifest contains only managed paths. Remove children first;
	// rmdir leaves newly added files alone and reports the affected directory.
	for (const [relative, kind] of [...expected].reverse()) {
		const file = path.join(source, relative);
		try {
			checkSource();
			const checkParents = () => {
				for (let parent = path.dirname(file); parent !== source; parent = path.dirname(parent)) {
					const stat = fs.lstatSync(parent);
					assertOrdinary(stat, parent);
					if (!stat.isDirectory()) throw new Error("The parent folder changed after copying.");
				}
			};
			checkParents();
			const stat = fs.lstatSync(file);
			assertOrdinary(stat, file);
			if (kind === "dir" && stat.isDirectory()) {
				fs.rmdirSync(file);
				continue;
			}
			if (kind === "dir" || !stat.isFile() || stat.size !== kind.size || stat.mtimeMs !== kind.mtimeMs ||
				(await readFileSnapshot(file, stat)).hash !== kind.hash) {
				throw new Error("The entry changed after copying.");
			}
			checkSource();
			checkParents();
			if (!sameFile(stat, fs.lstatSync(file))) throw new Error("The entry changed after copying.");
			fs.unlinkSync(file);
		} catch (error) {
			failures.push(`${file}: ${(error as Error).message}`);
		}
	}
	return failures;
}
