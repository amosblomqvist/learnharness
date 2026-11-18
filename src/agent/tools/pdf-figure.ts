import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { renderOpenPdfPage, type PdfCrop } from "../subagents/headless.ts";
import { openPdfBytes } from "../subagents/pdf-ops.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { learnerImageFromBytes, type LearnerImage } from "./learner-image.ts";

/** Pages and crops render at about this long side; storage caps at 1600 too. */
const FIGURE_LONG_SIDE = 1600;
/** A small crop stops gaining detail here instead of upscaling further. */
const MAX_FIGURE_DPI = 300;
export const MIN_CROP_SIDE = 16;
const MAX_PDF_FIGURE_BYTES = 64 * 1024 * 1024;
const PDF_FIGURE_SIZE_ERROR = "PDF exceeds 64 MiB; provide a smaller PDF";

/** A page or crop of the learner's PDF, stored like any learner image. */
export interface PdfFigureImage extends LearnerImage {
	page: number;
	/** Absent for the whole page. */
	crop?: PdfCrop;
}

/** A box in the pixels of the page image the maker was shown. */
export interface CropBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One page of the learner's PDF, ready for the visual maker to crop. */
export interface PdfFigureSource {
	path: string;
	page: number;
	pageImage: PdfFigureImage;
	crop(box: CropBox, signal?: AbortSignal): Promise<PdfFigureImage>;
	/** Any page or crop image this source produced, by snapshot id. */
	imageFor(snapshotId: string): PdfFigureImage | undefined;
	/** Release the opened PDF, including its source bytes. */
	close(): Promise<void>;
}

function checkPdfFile(stat: Stats): void {
	if (!stat.isFile()) throw new Error("it is not a regular file");
	if (stat.size === 0) throw new Error("the file is empty");
	if (stat.size > MAX_PDF_FIGURE_BYTES) throw new Error(PDF_FIGURE_SIZE_ERROR);
}

/** Read at most the checked size plus one byte, including if the file grows
 * during the read. Owned storage can be handed directly to pdfjs. */
async function readPdfFigureFile(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
	checkPdfFile(await fs.stat(absolute));
	signal?.throwIfAborted();
	const handle = await fs.open(absolute, "r");
	try {
		const before = await handle.stat();
		checkPdfFile(before);
		signal?.throwIfAborted();
		const bytes = new Uint8Array(before.size);
		for (let offset = 0; offset < bytes.length;) {
			const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), null);
			signal?.throwIfAborted();
			if (!bytesRead) throw new Error("the file changed while being read; try again");
			offset += bytesRead;
		}
		const { bytesRead: extra } = await handle.read(new Uint8Array(1), 0, 1, null);
		signal?.throwIfAborted();
		const after = await handle.stat();
		signal?.throwIfAborted();
		if (after.size > MAX_PDF_FIGURE_BYTES || (extra && bytes.length === MAX_PDF_FIGURE_BYTES)) {
			throw new Error(PDF_FIGURE_SIZE_ERROR);
		}
		if (extra || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
			throw new Error("the file changed while being read; try again");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function openFigurePdf(rawPath: string, page: number, signal?: AbortSignal) {
	signal?.throwIfAborted();
	// Reuse the shared file-access policy, including canonical/symlink checks.
	const path = resolveSourcePath(rawPath);
	let opened: Awaited<ReturnType<typeof openPdfBytes>>;
	try {
		opened = await openPdfBytes(await readPdfFigureFile(path, signal), signal);
	} catch (error) {
		signal?.throwIfAborted();
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot open PDF ${path}: ${reason}`);
	}
	const { doc, task } = opened;
	if (!Number.isInteger(page) || page < 1 || page > doc.numPages) {
		const pages = doc.numPages;
		await task.destroy();
		signal?.throwIfAborted();
		throw new Error(`PDF ${path} has ${pages} page${pages === 1 ? "" : "s"}; page ${page} does not exist`);
	}
	return { path, doc, close: task.destroy };
}

/** Dispatch-time gate: an unusable PDF or page fails the visual call. */
export async function checkPdfPage(rawPath: string, page: number, signal?: AbortSignal): Promise<string> {
	const { path, close } = await openFigurePdf(rawPath, page, signal);
	await close();
	signal?.throwIfAborted();
	return path;
}

/** Job-time recheck: open one authorized byte snapshot. The preview and
 * every crop use that same page, never re-open the path. */
export async function loadPdfFigureSource(rawPath: string, page: number, signal?: AbortSignal): Promise<PdfFigureSource> {
	const { path, doc, close } = await openFigurePdf(rawPath, page, signal);
	try {
		signal?.throwIfAborted();
		const sourcePage = await doc.getPage(page);
		const made = new Map<string, PdfFigureImage>();

		const render = async (crop: PdfCrop | undefined, abort = signal): Promise<PdfFigureImage> => {
			const png = await renderOpenPdfPage(sourcePage, { dpi: MAX_FIGURE_DPI, fitLongSide: FIGURE_LONG_SIDE, crop }, abort);
			abort?.throwIfAborted();
			const image: PdfFigureImage = { ...(await learnerImageFromBytes(png, path, abort)), page, ...(crop ? { crop } : {}) };
			made.set(image.snapshotId, image);
			return image;
		};

		const pageImage = await render(undefined);
		return {
			path,
			page,
			pageImage,
			crop: (box, abort) => render(cropFraction(box, pageImage.width, pageImage.height), abort),
			imageFor: (snapshotId) => made.get(snapshotId),
			close,
		};
	} catch (error) {
		await close().catch(() => {});
		signal?.throwIfAborted();
		throw error;
	}
}

/** Clamp a pixel box to the page and turn it into page fractions. */
export function cropFraction(box: CropBox, pageWidth: number, pageHeight: number): PdfCrop {
	if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error("x, y, width and height must be numbers");
	const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
	const left = clamp(box.x, pageWidth);
	const top = clamp(box.y, pageHeight);
	const right = clamp(box.x + box.width, pageWidth);
	const bottom = clamp(box.y + box.height, pageHeight);
	if (right - left < MIN_CROP_SIDE || bottom - top < MIN_CROP_SIDE) {
		throw new Error(`the crop must cover at least ${MIN_CROP_SIDE}×${MIN_CROP_SIDE} px of the ${pageWidth}×${pageHeight} page`);
	}
	const round = (v: number) => Math.round(v * 10_000) / 10_000;
	const x = round(left / pageWidth);
	const y = round(top / pageHeight);
	return { x, y, width: Math.min(round(right / pageWidth), 1) - x, height: Math.min(round(bottom / pageHeight), 1) - y };
}
