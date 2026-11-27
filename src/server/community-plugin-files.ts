import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const COMMUNITY_STAGE_PREFIX = ".catalog-stage-";

/** Use the entire installed dist tree, not only the host's executable snapshot.
 * A locally edited file or an added directory makes an update ineligible. */
export function catalogTreeDigest(root: string): string | undefined {
	const hash = createHash("sha256");
	let count = 0, bytes = 0;
	function visit(relative: string, depth: number) {
		const filename = path.join(root, relative);
		const stat = fs.lstatSync(filename);
		if (++count > 1550 || depth > 16 || stat.isSymbolicLink()) throw new Error("Different folder layout");
		hash.update(`${relative.length}:${relative}:`);
		if (stat.isDirectory()) {
			hash.update("d:");
			for (const name of fs.readdirSync(filename).sort()) visit(relative ? `${relative}/${name}` : name, depth + 1);
		} else if (stat.isFile()) {
			if ((bytes += stat.size) > 48 * 1024 * 1024) throw new Error("Different folder layout");
			const contents = fs.readFileSync(filename);
			hash.update(`f:${contents.length}:`).update(contents);
		} else throw new Error("Different folder layout");
	}
	try { visit("", 0); return hash.digest("hex"); } catch { return undefined; }
}

/** Staged publication is synchronous under the host's lifecycle queue. Only
 * dist is replaced. If rollback itself fails, keep the old build for recovery. */
export function publishCatalogFiles(directory: string, id: string, files: ReadonlyMap<string, Buffer>, update: boolean, save: (digest: string) => void) {
	const root = path.join(directory, id), dist = path.join(root, "dist");
	const stage = fs.mkdtempSync(path.join(directory, COMMUNITY_STAGE_PREFIX));
	const incoming = path.join(stage, id), built = path.join(incoming, "dist"), backup = path.join(stage, "old-dist");
	let backedUp = false, published = false;
	try {
		fs.mkdirSync(built, { recursive: true });
		for (const [relative, contents] of files) {
			const filename = path.join(built, relative);
			if (!filename.startsWith(built + path.sep)) throw new Error("Unsafe package file");
			fs.mkdirSync(path.dirname(filename), { recursive: true });
			fs.writeFileSync(filename, contents, { flag: "wx", mode: 0o600 });
		}
		const digest = catalogTreeDigest(built);
		if (!digest) throw new Error("Could not verify staged build");
		if (update) {
			fs.renameSync(dist, backup); backedUp = true;
			fs.renameSync(built, dist);
		} else fs.renameSync(incoming, root);
		published = true;
		save(digest);
	} catch (error) {
		try {
			if (published) fs.renameSync(update ? dist : root, path.join(stage, "uncommitted"));
			if (backedUp) fs.renameSync(backup, dist);
		} catch { throw new Error(`Rollback failed. The previous build, if any, was retained in ${stage}.`); }
		try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* Staging is not discoverable as a plugin. */ }
		throw error;
	}
	try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* Committed. Recover/remove leftover staging manually. */ }
}
