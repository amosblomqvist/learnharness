import katex from "katex";
import { readContentSpans } from "./content-reader.ts";
import { restoreMathEscapes } from "./math-delims.ts";
import { noteSectionHeading, type NoteDocument } from "./session-notes.ts";

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => entities[c]!);

/** User/model prose is text. Only the trusted, locally configured TeX renderer emits markup. */
export function noteTextHtml(text: string, strict = false): string {
	return readContentSpans(restoreMathEscapes(text))
		.map(span =>
			span.kind === "math"
				? katex.renderToString(span.body, {
						displayMode: span.display || span.open === "$$",
						throwOnError: strict,
						trust: false,
						strict: "ignore",
					})
				: escapeHtml(span.raw).replace(/\n/g, "<br>"),
		)
		.join("");
}
export function noteDocumentHtml(doc: NoteDocument): string {
	const sections = doc.sections
		.map((section, index) => {
			const blocks = section.blocks
				.map(block => {
					const label = block.kind[0]!.toUpperCase() + block.kind.slice(1);
					if (block.kind === "paragraph") return `<p>${noteTextHtml(block.text)}</p>`;
					return `<div class="note-${block.kind === "example" ? "example" : "box"}"><strong>${escapeHtml(label)}</strong><div>${noteTextHtml(block.text)}</div></div>`;
				})
				.join("");
			return `<section id="notes-${escapeHtml(section.id)}"><h2><span>${index + 1}.</span> ${noteTextHtml(noteSectionHeading(section.heading))}</h2>${blocks}</section>`;
		})
		.join("");
	return `<article class="lecture-notes"><h1>${noteTextHtml(doc.title)}</h1>${doc.overview ? `<p class="note-overview">${noteTextHtml(doc.overview)}</p>` : ""}${sections}</article>`;
}
