import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeImage } from "../image-media.ts";
import { getHeadless } from "../subagents/headless.ts";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/**
 * pdf_view: look at ONE page (or a crop of it) of a local PDF as an image.
 * Local render only (pdfjs + Skia in this process): no browser, no network,
 * no extra model call. The normalized PNG goes back as a native image part
 * (the same ImageFileResult path as read); details carry only the source,
 * page and crop, never a copy of the pixels.
 */

const cropSchema = Type.Object({
	x: Type.Number({ minimum: 0, maximum: 1, description: "Left edge, 0..1 of page width" }),
	y: Type.Number({ minimum: 0, maximum: 1, description: "Top edge, 0..1 of page height" }),
	width: Type.Number({ exclusiveMinimum: 0, maximum: 1, description: "Width, 0..1 of page width" }),
	height: Type.Number({ exclusiveMinimum: 0, maximum: 1, description: "Height, 0..1 of page height" }),
});

const pdfViewInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the PDF (relative paths resolve against the home directory)" }),
	page: Type.Integer({ minimum: 1, description: "Page number, 1-based" }),
	crop: Type.Optional(cropSchema),
	dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300, description: "Render resolution, 72 to 300 (default 150)" })),
});

export interface PdfViewDetails {
	text: string;
	source: string;
	page: number;
	crop?: { x: number; y: number; width: number; height: number };
}

export const pdfViewTool: AgentTool<typeof pdfViewInput> = {
	name: "pdf_view",
	label: "pdf_view",
	description:
		"Render one page of a local PDF (or a rectangular crop of it) as an image you can look at, for equations, figures, tables and layout that text extraction loses. " +
		"page is 1-based and must exist. crop is optional: x, y, width, height are fractions 0..1 of the page as displayed (after rotation), measured from the top-left corner; " +
		"width and height must be greater than 0 and x+width and y+height must not exceed 1. Use a crop to zoom into a small region. " +
		"dpi is 72 to 300 (default 150); output is capped at 2048px on the longest side and 5MiB. PDFs up to 100MiB and 5000 pages. " +
		"Rendering is local and does not call a model; one page or crop per call. If your model cannot see images, the image is omitted.",
	parameters: pdfViewInput,
	execute: serverExecute("pdf_view", pdfViewInput, async ({ path: rawPath, page, crop, dpi }, { signal }): Promise<ImageFileResult> => {
		const absolute = resolveSourcePath(rawPath);
		const [rendered] = await getHeadless().renderPdfPages(absolute, [page], { dpi: dpi ?? 150, crop, strict: true, signal });
		if (!rendered) throw new Error(`page ${page} could not be rendered`);
		const image = await normalizeImage(rendered.png, signal);
		const text = `Rendered page ${page} of ${absolute}${crop ? ` (crop x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height})` : ""}, attached as an image.`;
		const details: PdfViewDetails = { text, source: absolute, page, ...(crop ? { crop } : {}) };
		return { text, images: [{ data: image.data, mimeType: image.mimeType }], details };
	}),
};
