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

/** Format selected tutor text as a Markdown blockquote. */
export function quoteAsMarkdown(quote: string): string {
	return quote
		.trim()
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n");
}

export function appendBlockText(notes: string, block: string): string {
	return notes.trim() ? `${notes.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export interface NoteRange {
	from: number;
	to: number;
}

/** The occurrence of `highlight` whose start is nearest to `from` (ties: the earlier). */
export function locateHighlight(notes: string, highlight: string, from: number): NoteRange | null {
	if (!highlight) return null;
	let best: NoteRange | null = null;
	for (let i = notes.indexOf(highlight); i !== -1; i = notes.indexOf(highlight, i + 1)) {
		if (!best || Math.abs(i - from) < Math.abs(best.from - from)) best = { from: i, to: i + highlight.length };
	}
	return best;
}
