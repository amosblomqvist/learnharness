/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;

/** The one list of file types "Extract files" takes, by file-name extension
 * (case-insensitive). The client check, the server check and the Files
 * picker's `accept` all derive from it. */
const IMPORT_EXTENSION_NAMES = ["txt", "md", "markdown", "rst", "org", "adoc", "tex", "pdf"] as const;
export const IMPORT_EXTENSIONS = new RegExp(`\\.(?:${IMPORT_EXTENSION_NAMES.join("|")})$`, "i");
export const IMPORT_ACCEPT = IMPORT_EXTENSION_NAMES.map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, or PDF.";
export const NOT_PLAIN_TEXT_MESSAGE = "This file isn't plain text.";

/** A zero byte in the first 8 KiB means the file is not plain text (the same
 * rule as the agent's grep binary skip, `isBinaryFile` in fs-shared.ts). */
export const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8192).includes(0);

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
