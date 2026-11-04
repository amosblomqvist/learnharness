/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;
export const IMPORT_EXTENSIONS = /\.(?:md|markdown|txt|pdf)$/i;
/** Images the vision pass reads (issue #285) — imported only when picked
 * one by one: a folder's attachments would each cost a vision call. The
 * server still sniffs content, never trusting the name. */
export const IMAGE_IMPORT_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
export const IMPORT_ACCEPT = ".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp";

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
