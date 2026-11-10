/** Defer opening setup until its owning effect and native boundary have
 * committed. Cleanup can retire a not-yet-started setup; this never retries a
 * submission whose finalization/hooks have already begun. */
export function scheduleOpeningSubmission(isCurrent: () => boolean, start: () => void): () => void {
	let live = true;
	queueMicrotask(() => { if (live && isCurrent()) start(); });
	return () => { live = false; };
}
