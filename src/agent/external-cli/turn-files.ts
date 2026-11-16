import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A temp working directory and a private directory holding the named files. */
export type TurnDirs<Name extends string> = { cwd: string; privateDir: string; files: Record<Name, string> };

/**
 * Creates `<prefix>-cwd-*` and `<prefix>-private-*` and writes each file (name to content) into the private one.
 * `cwdFiles` (relative path to content) are written into the cwd, for files the CLI looks up from its working directory.
 */
export async function createTurnDirs<Name extends string>(prefix: string, files: Record<Name, string>, mode: number, cwdFiles: Record<string, string> = {}): Promise<TurnDirs<Name>> {
	const cwd = await mkdtemp(join(tmpdir(), `${prefix}-cwd-`));
	let privateDir: string | undefined;
	try {
		for (const [relativePath, content] of Object.entries(cwdFiles)) {
			const target = join(cwd, relativePath);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, { mode });
		}
		privateDir = await mkdtemp(join(tmpdir(), `${prefix}-private-`));
		const paths = {} as Record<Name, string>;
		for (const name of Object.keys(files) as Name[]) {
			paths[name] = join(privateDir, name);
			await writeFile(paths[name], files[name], { mode });
		}
		return { cwd, privateDir, files: paths };
	} catch (error) {
		await Promise.all([rm(cwd, { recursive: true, force: true }), ...(privateDir ? [rm(privateDir, { recursive: true, force: true })] : [])]);
		throw error;
	}
}

export async function removeTurnDirs(dirs: TurnDirs<string>): Promise<void> {
	await Promise.all([
		rm(dirs.cwd, { recursive: true, force: true }),
		rm(dirs.privateDir, { recursive: true, force: true }),
	]);
}
