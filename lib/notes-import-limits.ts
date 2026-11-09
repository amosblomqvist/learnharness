/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;

/** The file types "Extract files" takes; the client check, server check and picker `accept` all derive from this list. */
const IMPORT_EXTENSION_NAMES = ["txt", "md", "markdown", "rst", "org", "adoc", "tex", "pdf"];
export const IMPORT_EXTENSIONS = new RegExp(`\\.(?:${IMPORT_EXTENSION_NAMES.join("|")})$`, "i");
export const IMPORT_ACCEPT = IMPORT_EXTENSION_NAMES.map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, or PDF.";

/** Chat attachments take the Extract files types plus these common images; same single-list pattern. */
const ATTACH_IMAGE_EXTENSION_NAMES = ["jpg", "jpeg", "png", "gif", "webp"];
const ATTACH_EXTENSION_NAMES = [...IMPORT_EXTENSION_NAMES, ...ATTACH_IMAGE_EXTENSION_NAMES];
export const ATTACH_EXTENSIONS = new RegExp(`\\.(?:${ATTACH_EXTENSION_NAMES.join("|")})$`, "i");
export const ATTACH_ACCEPT = ATTACH_EXTENSION_NAMES.map((name) => `.${name}`).join(",");

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
