/**
 * Annotating a figure on a page of the learner's PDF — deterministic, zero network:
 *
 *   1. crop rendering (real pdfjs + Skia): only the crop is rasterized, sized
 *      by fitLongSide, and bad crops are refused
 *   2. pixel boxes → page fractions (clamping, the minimum size)
 *   3. visual with pdf: the dispatch-time gate and the raw input on the job
 *   4. the maker in PDF mode (fake model + fake source): sees the page, crops,
 *      annotates the crop; re-crops discard the SVG; whole page; not found
 *   5. the job runner end to end on a real PDF: only the final crop is stored
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import * as photon from "@silvia-odwyer/photon-node";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type ImageContent,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import { learnerImageFromBytes } from "../src/agent/tools/learner-image.ts";
import { checkPdfPage, cropFraction, loadPdfFigureSource, type PdfFigureImage, type PdfFigureSource } from "../src/agent/tools/pdf-figure.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createVisualTools, LEARNER_IMAGE_HREF, runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { headlessOverride, realHeadless, type HeadlessApi, type PdfCrop } from "../src/agent/subagents/headless.ts";
import { createJobRunner, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { isSubagentFailure, type JobRecord, type SteerMessage, type VisualResult } from "../src/core/contracts.ts";
import type { JobStore } from "../src/core/ports.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

// The key-presence gate (see demos.test.tsx): the runner's model checks
// read env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-figures-"));
const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
	for (const id of createdChats) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
	for (const id of createdJobs) fs.rmSync(path.join(JOBS_DIR, `${id}.json`), { force: true });
	headlessOverride.current = undefined;
	visualModelOverride.current = undefined;
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const RED: [number, number, number] = [1, 0, 0];
/** A US-letter page (612×792 pt) whose bottom-right quarter is a red block. */
const QUARTER_PAGE = { rects: [{ x: 306, y: 0, width: 306, height: 396, rgb: RED }] };

function file(name: string, bytes: Uint8Array | string): string {
	const p = path.join(scratch, name);
	fs.writeFileSync(p, bytes);
	return p;
}

/** A two-page deck: page 1 blank, page 2 with the red quarter. */
function deck(name: string): string {
	return file(name, tinyPdf([{}, QUARTER_PAGE]));
}

function decode(png: Buffer | string): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
	const image = photon.PhotonImage.new_from_byteslice(typeof png === "string" ? Buffer.from(png, "base64") : png);
	try {
		const width = image.get_width();
		const height = image.get_height();
		const raw = image.get_raw_pixels();
		return {
			width,
			height,
			at: (x, y) => {
				const i = (y * width + x) * 4;
				return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
			},
		};
	} finally {
		image.free();
	}
}

const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 60 && b < 60;
const isWhite = ([r, g, b]: [number, number, number]) => r > 230 && g > 230 && b > 230;

/** A solid raster (a different color gives a different snapshot). */
function raster(width: number, height: number, color = "#1144cc"): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = color;
	context.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

/** A faux engine that snapshots every provider-facing context. */
function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const base = faux.getModel();
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: { ...base, input: ["text", "image"] },
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

function images(context: TranscriptContext): ImageContent[] {
	return context.messages.flatMap((message) =>
		Array.isArray(message.content) ? message.content.filter((part): part is ImageContent => part.type === "image") : [],
	);
}

function text(context: TranscriptContext): string {
	return context.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => (part as { text: string }).text)
						.join("\n"),
		)
		.join("\n");
}

function fakeHeadless(renderPdfPages: HeadlessApi["renderPdfPages"] = async () => { throw new Error("unexpected pdf render"); }): HeadlessApi & { svgCalls: string[] } {
	const svgCalls: string[] = [];
	return {
		svgCalls,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unexpected demo run");
		},
		renderSvg: async (svg) => {
			svgCalls.push(svg);
			return raster(4, 3);
		},
		renderPdfPages,
	};
}

const marked = (width: number, height: number) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${LEARNER_IMAGE_HREF}" x="0" y="0" width="${width}" height="${height}"/><circle cx="10" cy="10" r="6" fill="none" stroke="red" stroke-width="2"/></svg>`;

/** A hand-made source: an 80×60 "page" whose crops are solid rasters of the crop's size. */
async function fakeSource(page = 3) {
	const sourcePath = "/learner/Courses/lec5.pdf";
	const pageImage: PdfFigureImage = { ...(await learnerImageFromBytes(raster(80, 60, "#ffffff"), sourcePath)), page };
	const made = new Map<string, PdfFigureImage>([[pageImage.snapshotId, pageImage]]);
	const crops: PdfCrop[] = [];
	const source: PdfFigureSource = {
		path: sourcePath,
		page,
		pageImage,
		crop: async (box) => {
			const crop = cropFraction(box, pageImage.width, pageImage.height);
			crops.push(crop);
			const color = crops.length === 1 ? "#cc0000" : "#00aa00";
			const image: PdfFigureImage = {
				...(await learnerImageFromBytes(raster(Math.round(crop.width * 80), Math.round(crop.height * 60), color), sourcePath)),
				page,
				crop,
			};
			made.set(image.snapshotId, image);
			return image;
		},
		imageFor: (id) => made.get(id),
	};
	return { source, crops, made };
}

// ─── 1. crop rendering ───────────────────────────────────────────────────────

describe("PDF crop rendering (real pdfjs + Skia)", () => {
	const pdf = file("quarter.pdf", tinyPdf([QUARTER_PAGE]));

	it("without a crop renders the whole page as before", async () => {
		const [page] = await realHeadless.renderPdfPages(pdf, [1], { dpi: 72 });
		const png = decode(page!.png);
		assert.equal(png.width, 612);
		assert.equal(png.height, 792);
		assert.ok(isRed(png.at(459, 594)), "bottom-right is red");
		assert.ok(isWhite(png.at(153, 198)), "top-left is white");
	});

	it("rasterizes only the crop, at the crop's own size", async () => {
		const [page] = await realHeadless.renderPdfPages(pdf, [1], { dpi: 72, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } });
		const png = decode(page!.png);
		assert.equal(png.width, 306);
		assert.equal(png.height, 396);
		assert.ok(isRed(png.at(5, 5)) && isRed(png.at(300, 390)), "the crop is all red quarter");
	});

	it("places the crop's top-left at the requested point", async () => {
		const [page] = await realHeadless.renderPdfPages(pdf, [1], { dpi: 72, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
		const png = decode(page!.png);
		assert.ok(isWhite(png.at(50, 50)), "top-left of the crop is page white");
		assert.ok(isRed(png.at(250, 350)), "bottom-right of the crop is the red quarter");
	});

	it("fitLongSide sizes the region's longer side, capped by dpi", async () => {
		const quarter = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
		const [fit] = await realHeadless.renderPdfPages(pdf, [1], { dpi: 300, fitLongSide: 800, crop: quarter });
		const fitted = decode(fit!.png);
		assert.equal(fitted.height, 800, "396pt tall → 800px");
		assert.equal(fitted.width, Math.ceil(306 * (800 / 396)));
		const [capped] = await realHeadless.renderPdfPages(pdf, [1], { dpi: 72, fitLongSide: 800, crop: quarter });
		assert.equal(decode(capped!.png).height, 396, "dpi stays the ceiling");
	});

	it("refuses crops outside the page, empty crops, and non-numbers", async () => {
		await assert.rejects(realHeadless.renderPdfPages(pdf, [1], { crop: { x: 0.6, y: 0, width: 0.5, height: 1 } }), /inside the page/);
		await assert.rejects(realHeadless.renderPdfPages(pdf, [1], { crop: { x: 0, y: 0, width: 0, height: 1 } }), /greater than 0/);
		await assert.rejects(realHeadless.renderPdfPages(pdf, [1], { crop: { x: Number.NaN, y: 0, width: 1, height: 1 } }), /finite/);
		await assert.rejects(realHeadless.renderPdfPages(pdf, [1], { fitLongSide: -1 }), /fitLongSide/);
	});
});

// ─── 2. pixel box → page fractions ──────────────────────────────────────────

describe("cropFraction", () => {
	it("turns a pixel box into page fractions", () => {
		assert.deepEqual(cropFraction({ x: 200, y: 150, width: 400, height: 300 }, 800, 600), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
	});

	it("clamps a box that spills past the page", () => {
		const crop = cropFraction({ x: -40, y: 500, width: 200, height: 400 }, 800, 600);
		assert.deepEqual(crop, { x: 0, y: 0.8333, width: 0.2, height: 1 - 0.8333 });
		assert.ok(crop.y + crop.height <= 1);
	});

	it("refuses a box under 16 px or with non-numbers", () => {
		assert.throws(() => cropFraction({ x: 10, y: 10, width: 10, height: 100 }, 800, 600), /at least 16×16 px of the 800×600 page/);
		assert.throws(() => cropFraction({ x: 790, y: 0, width: 100, height: 100 }, 800, 600), /at least 16×16 px/);
		assert.throws(() => cropFraction({ x: Number.NaN, y: 0, width: 100, height: 100 }, 800, 600), /must be numbers/);
	});
});

// ─── 3. visual with pdf: dispatch ────────────────────────────────────────────

describe("visual with a PDF page: dispatch", () => {
	function fakeJobs() {
		const created: unknown[] = [];
		const spawned: unknown[] = [];
		const store = {
			findJobByToolCallId: () => undefined,
			createJob: (record: Pick<JobRecord, "kind" | "chatId" | "toolCallId" | "input">) => {
				const job = { ...record, id: `job_${created.length + 1}`, status: "running", activity: "", createdAt: "", updatedAt: "" };
				created.push(job);
				return job;
			},
		} as unknown as JobStore;
		const tools = jobTools({ chatId: "chat_x", jobStore: store, spawn: (_job, input) => spawned.push(input) });
		return { tools, created, spawned };
	}

	it("unusable PDFs and pages fail the call and create no job", async () => {
		const { tools, created, spawned } = fakeJobs();
		const good = deck("dispatch.pdf");
		const notPdf = file("notes.txt", "plain text, not a PDF");
		await assert.rejects(tools.visual!.execute("c1", { brief: "b", pdf: { path: path.join(scratch, "gone.pdf"), page: 1 } }), /Cannot open PDF .*gone\.pdf: no such file/);
		await assert.rejects(tools.visual!.execute("c2", { brief: "b", pdf: { path: notPdf, page: 1 } }), /Cannot open PDF .*notes\.txt: /);
		await assert.rejects(tools.visual!.execute("c3", { brief: "b", pdf: { path: good, page: 3 } }), /has 2 pages; page 3 does not exist/);
		await assert.rejects(tools.visual!.execute("c4", { brief: "b", pdf: { path: scratch, page: 1 } }), /not a regular file/);
		const image = file("photo.png", raster(8, 8));
		await assert.rejects(tools.visual!.execute("c5", { brief: "b", image, pdf: { path: good, page: 1 } }), /either image or pdf, not both/);
		assert.equal(created.length, 0);
		assert.equal(spawned.length, 0);
	});

	it("a usable page dispatches the job with the raw input", async () => {
		const { tools, created, spawned } = fakeJobs();
		const p = deck("dispatch-ok.pdf");
		const result = await tools.visual!.execute("c6", { brief: "Circle the red block.", pdf: { path: p, page: 2 } });
		assert.match((result.content[0] as { text: string }).text, /^Dispatched \(job job_1\)/);
		assert.equal(created.length, 1);
		assert.deepEqual(spawned, [{ brief: "Circle the red block.", pdf: { path: p, page: 2 } }]);
	});

	it("resolves relative paths against the learner's home, like read", async () => {
		await assert.rejects(checkPdfPage("lh-no-such-deck.pdf", 1), (err: Error) => err.message.includes(path.join(os.homedir(), "lh-no-such-deck.pdf")));
	});
});

// ─── 4. the maker in PDF mode ────────────────────────────────────────────────

describe("visual maker with a PDF page (fake model + fake source)", () => {
	it("shows the page, crops the figure, and annotates the crop", async () => {
		const { source, crops } = await fakeSource();
		const headless = fakeHeadless();
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("crop_page", { x: 40, y: 30, width: 40, height: 30 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: marked(40, 30) }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Circled the red block.")]),
		]);
		const result = await runVisualMaker({ brief: "The red block. Circle it.", pdf: source }, { engine, headless });

		assert.match(text(requests[0]!), /FINDING THE FIGURE ON A PDF PAGE/, "the PDF doctrine joins the system prompt");
		assert.match(text(requests[0]!), /ANNOTATING THE LEARNER'S IMAGE/);
		assert.match(text(requests[0]!), /Page 3 of the learner's PDF follows: 80×60 px/);
		assert.ok(JSON.stringify(requests[0]).includes('"crop_page"'), "crop_page is declared");
		assert.equal(images(requests[0]!).length, 1, "the maker sees the page up front");

		assert.deepEqual(crops, [{ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }]);
		assert.match(text(requests[1]!), /Cropped: 40×30 px/);
		assert.match(text(requests[1]!), /Here is your crop \(40×30 px\)/);
		assert.equal(images(requests[1]!).length, 2, "page, then the crop");

		const cropImage = source.imageFor(result.image!.snapshotId)!;
		assert.equal(cropImage.width, 40);
		assert.ok(headless.svgCalls[0]!.includes(`href="data:${cropImage.mimeType};base64,${cropImage.data}"`), "renders embed the crop");
		assert.equal(result.svg, marked(40, 30));
		assert.deepEqual(result.image, { path: source.path, snapshotId: cropImage.snapshotId, page: 3, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } });
		for (const request of requests) {
			assert.ok(!text(request).includes(source.pageImage.data) && !text(request).includes(cropImage.data), "base64 never enters the model's text");
		}
	});

	it("re-cropping discards the SVG and switches the placement size", async () => {
		const { source, crops } = await fakeSource();
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("crop_page", { x: 40, y: 30, width: 40, height: 30 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: marked(40, 30) }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("crop_page", { x: 20, y: 15, width: 60, height: 45 }, { id: "c2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write_svg", { svg: marked(40, 30) }, { id: "w2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: marked(60, 45) }, { id: "w3" }), fauxToolCall("render_svg", {}, { id: "r3" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Re-cropped to include the legend.")]),
		]);
		const result = await runVisualMaker({ brief: "b", pdf: source }, { engine, headless: fakeHeadless() });
		assert.equal(crops.length, 2);
		assert.match(text(requests[3]!), /Cropped: 60×45 px .*Your earlier SVG was discarded; write_svg again\./);
		assert.match(text(requests[4]!), /place the image at its natural 60×45 pixel size/, "the old size is refused");
		assert.equal(result.svg, marked(60, 45));
		assert.deepEqual(result.image?.crop, { x: 0.25, y: 0.25, width: 0.75, height: 0.75 });
		assert.equal(source.imageFor(result.image!.snapshotId)?.width, 60);
	});

	it("annotates the whole page when the maker never crops", async () => {
		const { source } = await fakeSource(1);
		const { engine } = scripted([
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: marked(80, 60) }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("The figure fills the slide.")]),
		]);
		const result = await runVisualMaker({ brief: "b", pdf: source }, { engine, headless: fakeHeadless() });
		assert.deepEqual(result.image, { path: source.path, snapshotId: source.pageImage.snapshotId, page: 1 });
	});

	it("reports bad boxes to the model and keeps going", async () => {
		const { source, crops } = await fakeSource();
		const { engine, requests } = scripted([
			fauxAssistantMessage(
				[fauxToolCall("crop_page", { x: 0, y: 0, width: 5, height: 5 }, { id: "c1" }), fauxToolCall("crop_page", { x: "left" }, { id: "c2" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: marked(80, 60) }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Whole page.")]),
		]);
		const result = await runVisualMaker({ brief: "b", pdf: source }, { engine, headless: fakeHeadless() });
		assert.match(text(requests[1]!), /ERROR: crop failed — the crop must cover at least 16×16 px of the 80×60 page/);
		assert.match(text(requests[1]!), /ERROR: expected numbers x, y, width and height/);
		assert.equal(crops.length, 0);
		assert.equal(result.image?.snapshotId, source.pageImage.snapshotId);
	});

	it("a figure that is not on the page fails with the maker's notes", async () => {
		const { source } = await fakeSource();
		const { engine } = scripted([fauxAssistantMessage([fauxText("The page shows only a title slide; no circuit diagram is on it.")])]);
		const result = await runVisualMaker({ brief: "The circuit diagram.", pdf: source }, { engine, headless: fakeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: the maker never wrote an SVG\. \(The page shows only a title slide/);
	});

	it("crop_page exists only in PDF mode", () => {
		assert.ok(!("crop_page" in createVisualTools()));
		assert.ok("crop_page" in createVisualTools({ pdf: true }));
	});
});

// ─── 5. the job runner on a real PDF ─────────────────────────────────────────

describe("visual job runner with a PDF page", () => {
	function testRunner() {
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				steers.push(steer);
				const jobId = (steer.details as { jobId: string }).jobId;
				const job = jobStore.getJob(jobId);
				if (job && job.status === "running") {
					const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
					jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
				}
			},
		});
		return { steers, runner };
	}

	function visualChat(title: string, input: { brief: string; pdf: { path: string; page: number } }) {
		const chat = chatStore.createChat(title);
		createdChats.push(chat.id);
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-vp", input });
		createdJobs.push(job.id);
		return job;
	}

	const realPdfHeadless = () => fakeHeadless((pdfPath, pages, opts) => realHeadless.renderPdfPages(pdfPath, pages, opts));

	it("renders the page, stores only the final crop, and steers an annotated image", async () => {
		const p = deck("runner.pdf");
		// The same deterministic renders the job will make, to script the model.
		const preview = await loadPdfFigureSource(p, 2);
		const { width: W, height: H } = preview.pageImage;
		const box = { x: W / 2, y: H / 2, width: W / 2, height: H / 2 };
		const expectedCrop = await preview.crop(box);

		const job = visualChat("Test: annotate a PDF figure", { brief: "The red block. Outline it.", pdf: { path: p, page: 2 } });
		headlessOverride.current = realPdfHeadless();
		visualModelOverride.current = scripted([
			fauxAssistantMessage([fauxToolCall("crop_page", box, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("write_svg", { svg: marked(expectedCrop.width, expectedCrop.height) }, { id: "w1" }),
					fauxToolCall("render_svg", {}, { id: "r1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Outlined the red block.")]),
		]).engine;
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			visualModelOverride.current = undefined;
		}

		const result = jobStore.getJob(job.id)!.result as VisualResult;
		assert.deepEqual(result.image, { path: fs.realpathSync.native(p), snapshotId: expectedCrop.snapshotId, page: 2, crop: expectedCrop.crop });
		assert.ok(Math.abs(expectedCrop.crop!.x - 0.5) < 0.001 && Math.abs(expectedCrop.crop!.width - 0.5) < 0.001);
		const stored = chatStore.getChat(job.chatId)?.imageSnapshots ?? {};
		assert.deepEqual(Object.keys(stored), [expectedCrop.snapshotId], "only the crop is stored, never the page");
		const crop = decode(stored[expectedCrop.snapshotId]!.data);
		assert.ok(isRed(crop.at(10, 10)) && isRed(crop.at(crop.width - 10, crop.height - 10)), "the stored crop is the red quarter");
		assert.ok(Math.max(crop.width, crop.height) <= 1600);
		assert.equal(steers.length, 1);
		assert.match(steers[0]!.content as string, /^The annotated image is drawn, verified by inspection/);
	});

	it("a PDF gone by run time delivers a FAILED steer", async () => {
		const p = deck("vanishing.pdf");
		const job = visualChat("Test: annotate a PDF figure, vanished", { brief: "b", pdf: { path: p, page: 2 } });
		fs.rmSync(p);
		headlessOverride.current = realPdfHeadless();
		visualModelOverride.current = scripted([]).engine;
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			visualModelOverride.current = undefined;
		}
		const result = (steers[0]!.details as { result: VisualResult }).result;
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: Cannot open PDF .*vanishing\.pdf: no such file/);
		assert.equal(jobStore.getJob(job.id)!.status, "error");
	});
});
