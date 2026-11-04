/**
 * Minimal OOXML builders for the course-library extraction tests: just
 * enough parts (and relationships) for a valid-shaped DOCX / PPTX, zipped
 * in memory with fflate — no binary fixtures to keep in sync.
 */

import { strToU8, zipSync } from "fflate";

const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_NOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

/** A 1x1 PNG. */
export const TINY_PNG = Uint8Array.from(
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);

function rels(entries: { id: string; type: string; target: string }[]): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
		.map((e) => `<Relationship Id="${e.id}" Type="${e.type}" Target="${e.target}"/>`)
		.join("")}</Relationships>`;
}

export interface FixtureSlide {
	title: string;
	body: string[];
	notes?: string;
	image?: boolean;
}

export function buildPptx(slides: FixtureSlide[]): Uint8Array {
	const files: Record<string, Uint8Array> = {};
	files["ppt/presentation.xml"] = strToU8(
		`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slides
			.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
			.join("")}</p:sldIdLst></p:presentation>`,
	);
	files["ppt/_rels/presentation.xml.rels"] = strToU8(
		rels(slides.map((_, i) => ({ id: `rId${i + 1}`, type: REL_SLIDE, target: `slides/slide${i + 1}.xml` }))),
	);
	slides.forEach((slide, i) => {
		const n = i + 1;
		const shape = (type: string, paras: string[]) =>
			`<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody>${paras
				.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
				.join("")}</p:txBody></p:sp>`;
		const pic = slide.image ? `<p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic>` : "";
		files[`ppt/slides/slide${n}.xml`] = strToU8(
			`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>${shape("title", [slide.title])}${shape("body", slide.body)}${pic}</p:spTree></p:cSld></p:sld>`,
		);
		const slideRels: { id: string; type: string; target: string }[] = [];
		if (slide.image) {
			slideRels.push({ id: "rIdImg", type: REL_IMAGE, target: `../media/image${n}.png` });
			files[`ppt/media/image${n}.png`] = TINY_PNG;
		}
		if (slide.notes) {
			slideRels.push({ id: "rIdNotes", type: REL_NOTES, target: `../notesSlides/notesSlide${n}.xml` });
			files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
				`<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${shape("sldImg", [])}${shape("body", [slide.notes])}${shape("sldNum", ["7"])}</p:spTree></p:cSld></p:notes>`,
			);
		}
		files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(rels(slideRels));
	});
	return zipSync(files);
}

export type FixtureBlock =
	| { heading: string }
	| { para: string }
	| { table: string[][] }
	| { image: true }
	| { math: string }
	/** Raw OMML inside <m:oMath> (delimiter/structure tests). */
	| { omml: string };

export function buildDocx(blocks: FixtureBlock[]): Uint8Array {
	const files: Record<string, Uint8Array> = {};
	let images = 0;
	const docRels: { id: string; type: string; target: string }[] = [];
	const body = blocks
		.map((b) => {
			if ("heading" in b) return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${b.heading}</w:t></w:r></w:p>`;
			if ("para" in b) return `<w:p><w:r><w:t xml:space="preserve">${b.para}</w:t></w:r></w:p>`;
			if ("math" in b) return `<w:p><m:oMath><m:r><m:t>${b.math}</m:t></m:r></m:oMath></w:p>`;
			if ("omml" in b) return `<w:p><m:oMath>${b.omml}</m:oMath></w:p>`;
			if ("table" in b)
				return `<w:tbl>${b.table
					.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
					.join("")}</w:tbl>`;
			images++;
			docRels.push({ id: `rIdImg${images}`, type: REL_IMAGE, target: `media/image${images}.png` });
			files[`word/media/image${images}.png`] = TINY_PNG;
			return `<w:p><w:r><w:drawing><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg${images}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></w:drawing></w:r></w:p>`;
		})
		.join("");
	files["word/document.xml"] = strToU8(
		`<?xml version="1.0"?><w:document xmlns:w="w" xmlns:m="m" xmlns:a="a" xmlns:r="r" xmlns:pic="pic"><w:body>${body}</w:body></w:document>`,
	);
	files["word/_rels/document.xml.rels"] = strToU8(rels(docRels));
	return zipSync(files);
}
