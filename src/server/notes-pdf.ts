import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { noteDocumentHtml } from "../core/note-render.ts";
import type { NoteDocument } from "../core/session-notes.ts";
import { printNotesPage } from "../agent/subagents/headless.ts";

let printStyles: string | undefined;
function styles() {
	if (printStyles) return printStyles;
	const file = path.join(PATHS.root, "node_modules", "katex", "dist", "katex.min.css");
	// Use bundled fonts even when the helper has no network or application origin.
	const math = fs.readFileSync(file, "utf8").replace(/src:url\((fonts\/[\w-]+\.woff2)\)[^}]+/g, (_, font: string) => {
		const bytes = fs.readFileSync(path.join(path.dirname(file), font));
		return `src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")`;
	});
	printStyles = math + fs.readFileSync(path.join(PATHS.root, "app", "session-notes.css"), "utf8");
	return printStyles;
}
export function renderNotesPdf(document: NoteDocument): Promise<Uint8Array> {
	const title = document.title.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
	return printNotesPage(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><style>${styles()}</style></head><body>${noteDocumentHtml(document)}</body></html>`,
	);
}
