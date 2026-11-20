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

type Snapshot = Map<string, string>;
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
		const hash = createHash("sha256");
		const fd = await disk.open(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stream = fd.createReadStream();
		if (to) {
			stream.on("data", (chunk) => { hash.update(chunk); });
			await pipeline(stream, fs.createWriteStream(to, { flags: "wx", mode: stat.mode & 0o777 }));
			await sync(to, false);
		} else {
			for await (const chunk of stream) hash.update(chunk);
		}
		manifest.set(relative, `${stat.size}:${hash.digest("hex")}`);
	}
	for (const name of MANAGED_ITEMS) {
		const stat = await statIfPresent(path.join(root, name));
		if (stat) await visit(name, stat);
	}
	return manifest;
}

function matches(a: Snapshot, b: Snapshot): boolean {
	return a.size === b.size && [...a].every(([file, digest]) => b.get(file) === digest);
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
		if (!matches(expected, await snapshot(stage)) || !matches(expected, await snapshot(source))) {
			throw new Error("Data copy verification failed. The folder has not been switched.");
		}
		checkSource();
		const storeId = identity ? ensureStoreId(stage) : null;
		await sync(stage);
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
		const publishedRoot = await disk.lstat(target);
		const rollback = async () => {
			const current = await disk.lstat(target);
			if (storeId) verifyStore(target, storeId);
			const extraEntries = (await disk.readdir(target)).some(name => name !== STORE_MARKER && !expected.has(name));
			if (!current.isDirectory() || current.dev !== publishedRoot.dev || current.ino !== publishedRoot.ino ||
				extraEntries || !matches(expected, await snapshot(target))) {
				throw new Error("The copied folder changed after publishing. Its data was kept.");
			}
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
		return { expected, storeId, rollback };
	} finally {
		if (!published) await disk.rm(stage, { recursive: true, force: true });
	}
}

export async function cleanOldData(source: string, target: string, expected: Snapshot, checkSource: () => void): Promise<string[]> {
	const failures: string[] = [];
	try {
		checkSource();
		if (!matches(expected, await snapshot(target))) throw new Error("The destination changed after copying.");
		if (!matches(expected, await snapshot(source))) throw new Error("The source changed after copying.");
	} catch (error) {
		return [`No old data was removed: ${(error as Error).message}`];
	}
	// The verified manifest contains only managed paths. Remove children first;
	// rmdir leaves newly added files alone and reports the affected directory.
	for (const [relative, kind] of [...expected].reverse()) {
		const file = path.join(source, relative);
		try {
			checkSource();
			let parent = path.dirname(file);
			while (parent !== source) {
				assertOrdinary(await disk.lstat(parent), parent);
				parent = path.dirname(parent);
			}
			const stat = await disk.lstat(file);
			assertOrdinary(stat, file);
			if (kind === "dir" && stat.isDirectory()) await disk.rmdir(file);
			else if (kind !== "dir" && stat.isFile()) await disk.unlink(file);
			else throw new Error("The entry changed after copying.");
		} catch (error) {
			failures.push(`${file}: ${(error as Error).message}`);
		}
	}
	return failures;
}
