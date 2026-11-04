/**
 * Artifact download helpers (release polish, 2026-10-07): the tiny
 * save-a-blob seam shared by the demo + figure cards, plus the filename
 * slug. The slug is pure (test-pinned); downloadFile touches the DOM and
 * only runs on click.
 */

/** Slugify a demo title into a filename stem — lowercase, accents folded,
 *  runs of non-alphanumerics collapsed to "-", trimmed, capped at 64
 *  chars. Empty/fully-symbolic titles fall back to "demo". */
export function slugFilename(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "demo";
}

/** Save text (or bytes) as a downloaded file. The blob URL is revoked right
 *  after the click — Chromium keeps the download alive past the revoke. */
export function downloadFile(name: string, content: string | Uint8Array<ArrayBuffer>, mime: string): void {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}
