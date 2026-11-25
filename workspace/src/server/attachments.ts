import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { attachmentFilename, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES } from "../../lib/attachment-limits.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { resolvePolicy, type FileAccessPolicy } from "../agent/tools/file-access.ts";
import { fileAccessPolicy } from "./file-access.ts";

/** All files are validated before writing. A failed batch leaves no partial references.
 * Explicit uploads do not override the learner's configured source restrictions. */
export async function saveAttachments(files: File[], options: { dataDirectory?: string; policy?: FileAccessPolicy } = {}): Promise<string[]> {
	if (!files.length || files.length > MAX_ATTACHMENT_FILES) throw new Error(`Choose between 1 and ${MAX_ATTACHMENT_FILES} files.`);
	if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error("Choose files totaling 25 MiB or less.");
	const policy = resolvePolicy(options.policy ?? fileAccessPolicy());
	const root = path.join(/* turbopackIgnore: true */ options.dataDirectory ?? PATHS.threadData, "attachments");
	const directory = path.join(/* turbopackIgnore: true */ root, randomUUID());
	const paths = files.map((file, index) => path.join(/* turbopackIgnore: true */ directory, String(index + 1), attachmentFilename(file.name)));
	// Apply the same canonical and mandatory credential-path checks as agent reads.
	for (const filename of paths) resolveSourcePath(filename, policy);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		for (let index = 0; index < files.length; index++) {
			const filename = resolveSourcePath(paths[index]!, policy);
			await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
			await writeFile(filename, new Uint8Array(await files[index]!.arrayBuffer()), { flag: "wx", mode: 0o600 });
		}
		return paths;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
