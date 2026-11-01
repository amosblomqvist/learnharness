import { DOMParser } from "linkedom";
import { embedLearnerImage, LEARNER_IMAGE_HREF } from "../../core/learner-image-svg.ts";

/** Structural annotation protocol, not a claim to prove visibility or mark accuracy.
 * Native-only rendering avoids executing generated SVG in the browser fallback.
 */
export function annotationPlacementProblem(svg: string, width: number, height: number): string | null {
	if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return "annotation SVGs cannot declare entities or a document type";
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml") as unknown as Document;
	if (doc.documentElement?.localName !== "svg") return "expected a complete SVG document";
	const elements = Array.from(doc.querySelectorAll("*"));
	const images = elements.filter((element) => element.localName === "image");
	if (images.length !== 1) return `the SVG must place the learner's image exactly once with <image href="${LEARNER_IMAGE_HREF}" …/> (found ${images.length})`;
	const image = images[0]!;
	const hrefs = Array.from(image.attributes).filter((attr) => attr.name === "href" || attr.name === "xlink:href");
	if (hrefs.length !== 1 || hrefs[0]!.value !== LEARNER_IMAGE_HREF) return `the image must use exactly one href="${LEARNER_IMAGE_HREF}"`;
	if (embedLearnerImage(svg, { mimeType: "image/png", data: "", width, height }) === svg) return "use the literal learner-image placeholder in the image href";
	if (Number(image.getAttribute("width")) !== width || Number(image.getAttribute("height")) !== height) return `place the image at its natural ${width}×${height} pixel size`;
	for (const element of elements) {
		if (["script", "foreignobject", "style", "animate", "animatemotion", "animatetransform", "set", "discard"].includes(element.localName.toLowerCase())) return "annotation SVGs must use static SVG marks and inline styling";
		for (const attr of Array.from(element.attributes)) {
			if (/^on/i.test(attr.name)) return "annotation SVGs cannot contain event handlers";
			if (attr.name === "xml:base" || /\\|@import/i.test(attr.value)) return "annotation SVGs cannot change resource bases or use escaped resource syntax";
			if ((attr.name === "href" || attr.name === "xlink:href") && element !== image && !/^#[A-Za-z_][\w:.-]*$/.test(attr.value)) return "annotation SVGs cannot reference other files or URLs";
			if (/url\s*\(/i.test(attr.value) && !/^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)$/.test(attr.value)) return "annotation SVG resources must be local fragment references";
		}
	}
	return null;
}
