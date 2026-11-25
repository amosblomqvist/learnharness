export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 32;

/** A display filename, never a path, drive, stream, or Windows device name. */
export function attachmentFilename(name: string): string {
	const safe = name.normalize("NFC").replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
	if (!safe || safe === "." || safe === ".." || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)) {
		throw new Error("This filename is not supported. Rename the file and try again.");
	}
	return safe;
}
