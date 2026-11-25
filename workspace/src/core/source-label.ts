/** Display only: the original path remains the source's identity/provenance.
 * Keep spelling and punctuation exactly; remove only the final extension. */
export function sourceFileLabel(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() || filePath;
	return base.replace(/\.[^.]+$/, "") || base;
}
