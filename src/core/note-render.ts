import katex from "katex";
import { readContentSpans, type ContentSpan } from "./content-reader.ts";
import { restoreMathEscapes } from "./math-delims.ts";
import { noteSectionHeading, type NoteDocument } from "./session-notes.ts";

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => entities[c]!);
function mathHtml(span: Extract<ContentSpan, { kind: "math" }>, strict = false) {
	return katex.renderToString(span.body, {
		displayMode: span.display || span.open === "$$",
		throwOnError: strict,
		trust: false,
		strict: "ignore",
	});
}

/** User/model prose is text. Only the trusted, locally configured TeX renderer emits markup. */
export function noteTextHtml(text: string, strict = false): string {
	return readContentSpans(restoreMathEscapes(text))
		.map(span =>
			span.kind === "math"
				? mathHtml(span, strict)
				: escapeHtml(span.raw).replace(/\n/g, "<br>"),
		)
		.join("");
}

/** Real paragraphs and separate equation blocks give the print engine safe break points. */
function noteBodyHtml(text: string): string {
	const parts: string[] = [];
	let paragraph = "";
	const flush = () => {
		const content = paragraph.trim().replace(/(?:<br>)+$/g, "");
		if (content) parts.push(`<p>${content}</p>`);
		paragraph = "";
	};
	for (const span of readContentSpans(restoreMathEscapes(text))) {
		if (span.kind === "math") {
			if (span.display || span.open === "$$") {
				flush();
				parts.push(`<div class="note-equation">${mathHtml(span)}</div>`);
			} else paragraph += mathHtml(span);
		} else {
			const paragraphs = span.raw.split(/\r?\n[ \t]*\r?\n/);
			paragraphs.forEach((part, index) => {
				if (index) flush();
				paragraph += escapeHtml(paragraph ? part : part.trimStart()).replace(/\r?\n/g, "<br>");
			});
		}
	}
	flush();
	return parts.join("");
}
export function noteDocumentHtml(doc: NoteDocument): string {
	const sections = doc.sections
		.map((section, index) => {
			let example = 0;
			const blocks = section.blocks
				.map(block => {
					const label = block.kind[0]!.toUpperCase() + block.kind.slice(1);
					if (block.kind === "paragraph") return noteBodyHtml(block.text);
					const numbered = block.kind === "example" ? `${label} ${index + 1}.${++example}` : label;
					const title = block.title?.trim() ? `<span class="note-block-title">${noteTextHtml(block.title)}</span>` : "";
					return `<div class="note-${block.kind === "example" ? "example" : "box"}"><p class="note-label"><strong>${escapeHtml(numbered)}</strong>${title}</p><div class="note-content">${noteBodyHtml(block.text)}</div></div>`;
				})
				.join("");
			return `<section id="notes-${escapeHtml(section.id)}"><h2><span>${index + 1}.</span> ${noteTextHtml(noteSectionHeading(section.heading))}</h2>${blocks}</section>`;
		})
		.join("");
	return `<article class="lecture-notes"><h1>${noteTextHtml(doc.title)}</h1>${doc.overview ? `<div class="note-overview">${noteBodyHtml(doc.overview)}</div>` : ""}${sections}</article>`;
}
