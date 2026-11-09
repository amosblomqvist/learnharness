import katex from "katex";
import { readContentSpans, type ContentSpan } from "./content-reader.ts";
import { restoreMathEscapes } from "./math-delims.ts";
import { noteSectionHeading, type NoteDocument, type NoteQuickReference } from "./session-notes.ts";

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
function quickReferenceHtml(reference: NoteQuickReference): string {
	const decisions = reference.decisions.length
		? `<table><thead><tr><th scope="col">When you need to…</th><th scope="col">Use this approach</th></tr></thead><tbody>${reference.decisions.map(row => `<tr><td>${noteBodyHtml(row.situation)}</td><td>${noteBodyHtml(row.approach)}</td></tr>`).join("")}</tbody></table>`
		: "";
	const essentials = reference.essentials.map(item => `<div class="note-reference-item"><strong>${noteTextHtml(item.title)}</strong>${noteBodyHtml(item.text)}</div>`).join("");
	return `<div class="note-quick-reference"><h2>Quick reference</h2>${decisions}<div class="note-reference-results">${essentials}</div></div>`;
}
export function noteDocumentHtml(doc: NoteDocument): string {
	const sections = doc.sections
		.map((section, index) => {
			let example = 0;
			const blocks = section.blocks
				.map(block => {
					const label = block.kind[0]!.toUpperCase() + block.kind.slice(1);
					const steps = block.steps?.length ? `<ol class="note-steps">${block.steps.map(step => `<li>${noteBodyHtml(step)}</li>`).join("")}</ol>` : "";
					const body = noteBodyHtml(block.text);
					const content = `${steps}${body}`;
					if (block.kind === "paragraph") return content;
					const numbered = block.kind === "example" ? `${label} ${index + 1}.${++example}` : label;
					const title = block.title?.trim() ? `<span class="note-block-title">${noteTextHtml(block.title)}</span>` : "";
					// Keep the actionable procedure boxed; its rationale reads as prose immediately below.
					const explanation = block.kind === "method" && steps ? `<div class="note-explanation">${body}</div>` : "";
					return `<div class="note-${block.kind === "example" ? "example" : "box"}${block.kind === "method" ? " note-method" : ""}"><p class="note-label"><strong>${escapeHtml(numbered)}</strong>${title}</p><div class="note-content">${explanation ? steps : content}</div></div>${explanation}`;
				})
				.join("");
			return `<section id="notes-${escapeHtml(section.id)}"><h2><span>${index + 1}.</span> ${noteTextHtml(noteSectionHeading(section.heading))}</h2>${blocks}</section>`;
		})
		.join("");
	const frontmatter = `<h1>${noteTextHtml(doc.title)}</h1>${doc.overview ? `<div class="note-overview">${noteBodyHtml(doc.overview)}</div>` : ""}${doc.quickReference ? quickReferenceHtml(doc.quickReference) : ""}`;
	return `<article class="lecture-notes"><header${doc.quickReference ? ' class="note-reference-page"' : ""}>${frontmatter}</header>${sections}</article>`;
}
