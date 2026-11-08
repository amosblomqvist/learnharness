export const NOTES_MIN_WIDTH = 256;
export const NOTES_MAX_WIDTH = 640;
export const NOTES_DEFAULT_WIDTH = 352;
/** Window width (px) below which the panel auto-folds. */
export const NOTES_AUTOFOLD_BELOW = 1184;
export const NOTES_WIDTH_KEY = "lh-notes-width";

export function clampNotesWidth(px: number): number {
	if (!Number.isFinite(px)) return NOTES_DEFAULT_WIDTH;
	return Math.min(NOTES_MAX_WIDTH, Math.max(NOTES_MIN_WIDTH, Math.round(px)));
}
