/** Per-session lesson notes: Markdown with $…$ / $$…$$ LaTeX, stored on the chat record. */

export const NOTES_MAX_CHARS = 100_000;

export class NotesInputError extends Error {}

/** Validate the save body `{ text }`; the text is returned untrimmed. */
export function parseNotesInput(raw: unknown): string {
	if (typeof raw !== "object" || raw === null) throw new NotesInputError("Body must be an object");
	const text = (raw as { text?: unknown }).text;
	if (typeof text !== "string") throw new NotesInputError("text must be a string");
	if (text.length > NOTES_MAX_CHARS) throw new NotesInputError(`Notes exceed ${NOTES_MAX_CHARS} characters`);
	return text;
}
