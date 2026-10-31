/**
 * Learner images in the lesson (issue #363) — deterministic, zero network:
 *
 *   1. the shared loader (learner-image.ts): byte-for-byte keep, the storage
 *      bound, EXIF baked upright, format conversion, readable failures
 *   2. show_image: one text line to the teacher, the picture as details
 *   3. visual with an image: dispatch-time path check, the maker's
 *      placeholder protocol (fake model + fake headless), one REAL resvg
 *      render of an embedded raster, and the job runner end to end
 *   4. the cards: no invert switch on images, the ImageCard chrome
 *
 * Cleanup follows tests/demos.test.tsx (created chat/job files removed in
 * after(); overrides reset in finally blocks).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

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
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import { checkLearnerImage, loadLearnerImage } from "../src/agent/tools/learner-image.ts";
import { showImageTool } from "../src/agent/tools/show-image.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { LEARNER_IMAGE_HREF, runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { headlessOverride, realHeadless, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { createJobRunner, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { isSubagentFailure, type JobRecord, type SteerMessage, type VisualResult } from "../src/core/contracts.ts";
import type { JobStore } from "../src/core/ports.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { VisualOutputCard } from "../components/artifacts/visual-card.tsx";
import { ImageCard, imageDownloadName, imageSvgDocument } from "../components/artifacts/image-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";

// The key-presence gate (see demos.test.tsx): the runner's model checks
// read env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-images-"));
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

/** Left half yellow, right half blue — enough structure to check placement. */
function raster(width: number, height: number, mime: "image/png" | "image/jpeg" | "image/webp" = "image/png"): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#1144cc";
	context.fillRect(0, 0, width, height);
	context.fillStyle = "#ffcc00";
	context.fillRect(0, 0, Math.ceil(width / 2), height);
	return canvas.toBuffer(mime as "image/png");
}

/** A 12×8 JPEG tagged with an EXIF orientation (tests/image-processing.test.ts). */
function exifJpeg(orientation: number): Buffer {
	const image = photon.PhotonImage.new_from_byteslice(raster(12, 8));
	let jpeg: Buffer;
	try {
		jpeg = Buffer.from(image.get_bytes_jpeg(80));
	} finally {
		image.free();
	}
	const exif = Buffer.alloc(36);
	exif.set([0xff, 0xe1, 0, 34]);
	exif.write("Exif\0\0", 4, "binary");
	exif.write("II", 10);
	exif.writeUInt16LE(42, 12);
	exif.writeUInt32LE(8, 14);
	exif.writeUInt16LE(1, 18);
	exif.writeUInt16LE(0x0112, 20);
	exif.writeUInt16LE(3, 22);
	exif.writeUInt32LE(1, 24);
	exif.writeUInt16LE(orientation, 28);
	return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

function file(name: string, bytes: Buffer | string): string {
	const p = path.join(scratch, name);
	fs.writeFileSync(p, bytes);
	return p;
}

function pixel(png: Buffer, x: number, y: number): [number, number, number] {
	const image = photon.PhotonImage.new_from_byteslice(png);
	try {
		const at = (y * image.get_width() + x) * 4;
		const raw = image.get_raw_pixels();
		return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
	} finally {
		image.free();
	}
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

function fakeHeadless(): HeadlessApi & { svgCalls: string[] } {
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
		renderPdfPages: async () => {
			throw new Error("unexpected pdf render");
		},
	};
}

const MARKED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><image href="${LEARNER_IMAGE_HREF}" x="0" y="0" width="40" height="30"/><circle cx="10" cy="15" r="6" fill="none" stroke="red" stroke-width="2"/></svg>`;
const UNPLACED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><circle cx="10" cy="15" r="6"/></svg>';

// ─── 1. the loader ───────────────────────────────────────────────────────────

describe("learner image loader", () => {
	it("keeps a PNG already within the limits byte-for-byte", async () => {
		const bytes = raster(40, 30);
		const p = file("small.png", bytes);
		const image = await loadLearnerImage(p);
		assert.deepEqual(image, { path: p, mimeType: "image/png", data: bytes.toString("base64"), width: 40, height: 30 });
	});

	it("shrinks a large image to 1600px on its longest side and about 1 MB", async () => {
		const p = file("wide.jpg", raster(4000, 1000, "image/jpeg"));
		const image = await loadLearnerImage(p);
		assert.equal(image.width, 1600);
		assert.equal(image.height, 400);
		assert.ok(Buffer.byteLength(image.data, "utf8") <= 1024 * 1024, "within the storage bound");
		assert.ok(image.mimeType === "image/png" || image.mimeType === "image/jpeg");
	});

	it("bakes an EXIF rotation into the stored pixels", async () => {
		const p = file("rotated.jpg", exifJpeg(6));
		const image = await loadLearnerImage(p);
		assert.equal(image.width, 8, "stored upright: the 12×8 frame turned a quarter");
		assert.equal(image.height, 12);
		assert.equal(image.mimeType, "image/png");
	});

	it("converts other formats to PNG", async () => {
		const p = file("photo.webp", raster(20, 10, "image/webp"));
		const image = await loadLearnerImage(p);
		assert.equal(image.mimeType, "image/png");
		assert.equal(image.width, 20);
		assert.equal(image.height, 10);
	});

	it("fails with readable errors for missing files, non-images, and directories", async () => {
		await assert.rejects(loadLearnerImage(path.join(scratch, "nope.png")), /Cannot open image .*nope\.png: no such file/);
		await assert.rejects(loadLearnerImage(file("notes.txt", "plain text")), /notes\.txt is not a supported image \(jpg, png, gif, webp, or bmp\)/);
		await assert.rejects(checkLearnerImage(scratch), /it is a directory/);
	});

	it("resolves relative paths against the learner's home, like read", async () => {
		await assert.rejects(checkLearnerImage("lh-no-such-image.png"), (err: Error) =>
			err.message.includes(path.join(os.homedir(), "lh-no-such-image.png")),
		);
	});
});

// ─── 2. show_image ───────────────────────────────────────────────────────────

describe("show_image", () => {
	it("returns one text line to the teacher and the picture as details", async () => {
		const bytes = raster(40, 30);
		const p = file("board.png", bytes);
		const result = await showImageTool.execute("call-s1", { path: p, caption: "  The breadboard, top view  " });
		assert.deepEqual(result.content, [{ type: "text", text: `Shown to the learner: ${p} (40×30).` }], "no image part reaches the model");
		assert.deepEqual(result.details, {
			path: p,
			caption: "The breadboard, top view",
			mimeType: "image/png",
			data: bytes.toString("base64"),
			width: 40,
			height: 30,
		});
	});

	it("drops a blank caption", async () => {
		const result = await showImageTool.execute("call-s2", { path: file("blank.png", raster(4, 4)), caption: "   " });
		assert.ok(!("caption" in (result.details as object)));
	});

	it("fails the call for an unusable path", async () => {
		await assert.rejects(showImageTool.execute("call-s3", { path: path.join(scratch, "gone.png") }), /no such file/);
	});
});

// ─── 3. visual with an image ─────────────────────────────────────────────────

describe("visual with an image: dispatch", () => {
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

	it("an unusable image path fails the call and creates no job", async () => {
		const { tools, created, spawned } = fakeJobs();
		await assert.rejects(tools.visual!.execute("call-v1", { brief: "b", image: path.join(scratch, "missing.png") }), /no such file/);
		assert.equal(created.length, 0);
		assert.equal(spawned.length, 0);
	});

	it("a usable image dispatches the job with the path on its input", async () => {
		const { tools, created, spawned } = fakeJobs();
		const p = file("dispatch.png", raster(8, 8));
		const result = await tools.visual!.execute("call-v2", { brief: "Circle the left half.", image: p });
		assert.match((result.content[0] as { text: string }).text, /^Dispatched \(job job_1\)/);
		assert.equal(created.length, 1);
		assert.deepEqual(spawned, [{ brief: "Circle the left half.", image: p }]);
	});
});

describe("visual maker with a learner image (fake model + fake headless)", () => {
	it("shows the maker the picture and swaps the placeholder in for render and delivery", async () => {
		const image = await loadLearnerImage(file("maker.png", raster(40, 30)));
		const headless = fakeHeadless();
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("write_svg", { svg: UNPLACED_SVG }, { id: "w0" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: MARKED_SVG }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Circled the yellow half.")]),
		]);
		const result = await runVisualMaker({ brief: "Circle the yellow half.", image }, { engine, headless });

		assert.match(text(requests[0]!), /ANNOTATING THE LEARNER'S IMAGE/, "the image doctrine joins the system prompt");
		assert.match(text(requests[0]!), /The learner's image follows: 40×30 px/);
		assert.equal(images(requests[0]!).length, 1, "the maker sees the picture up front");
		assert.match(text(requests[1]!), /must place the learner's image exactly once .*\(found 0\)/, "an unplaced SVG is refused");

		const dataUri = `data:image/png;base64,${image.data}`;
		assert.equal(headless.svgCalls.length, 1);
		assert.ok(headless.svgCalls[0]!.includes(`href="${dataUri}"`), "the render carries the real picture");
		assert.ok(!headless.svgCalls[0]!.includes(`href="${LEARNER_IMAGE_HREF}"`));
		assert.equal(result.svg, MARKED_SVG.replace(`href="${LEARNER_IMAGE_HREF}"`, `href="${dataUri}"`));
		assert.deepEqual(result.image, { path: image.path });
		assert.equal(result.notes, "Circled the yellow half.");
		assert.ok(!requests.some((request) => text(request).includes(image.data)), "the base64 never enters the model's text");
	});

	it("refuses an edit that drops the placement and keeps the SVG unchanged", async () => {
		const image = await loadLearnerImage(file("edit.png", raster(40, 30)));
		const headless = fakeHeadless();
		const { engine, requests } = scripted([
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: MARKED_SVG }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("edit_svg", { old_text: `href="${LEARNER_IMAGE_HREF}"`, new_text: 'href="photo.png"' }, { id: "e1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Kept the original placement.")]),
		]);
		const result = await runVisualMaker({ brief: "b", image }, { engine, headless });
		assert.match(text(requests[2]!), /ERROR: edit not applied — the SVG must place the learner's image exactly once/);
		assert.ok(result.svg.includes(`data:image/png;base64,${image.data}`), "the delivered SVG still embeds the picture");
		assert.equal(headless.svgCalls.length, 1, "no re-render: the SVG never changed");
	});

	it("without an image the result carries no image field", async () => {
		const { engine } = scripted([
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: UNPLACED_SVG }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Done.")]),
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine, headless: fakeHeadless() });
		assert.equal(result.svg, UNPLACED_SVG);
		assert.ok(!("image" in result));
	});
});

describe("native render of an embedded learner image (real resvg)", () => {
	it("draws the picture under the marks", async () => {
		const image = await loadLearnerImage(file("resvg.png", raster(40, 30)));
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><image href="data:${image.mimeType};base64,${image.data}" x="0" y="0" width="40" height="30"/></svg>`;
		const png = await realHeadless.renderSvg(svg);
		const [lr, lg, lb] = pixel(png, 5, 15);
		const [rr, rg, rb] = pixel(png, 35, 15);
		assert.ok(lr > 200 && lg > 150 && lb < 80, `left half is the picture's yellow (got ${lr},${lg},${lb})`);
		assert.ok(rr < 80 && rb > 150, `right half is the picture's blue (got ${rr},${rg},${rb})`);
	});
});

describe("visual job runner with an image", () => {
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

	function visualChat(title: string, input: { brief: string; image: string }) {
		const chat = chatStore.createChat(title);
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "mark my photo", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-vi", name: "visual", arguments: input as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call-vi",
				toolName: "visual",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-vi", input });
		createdJobs.push(job.id);
		return job;
	}

	it("loads the image, annotates it, and steers an annotated image", async () => {
		const p = file("runner.png", raster(40, 30));
		const job = visualChat("Test: annotate runner", { brief: "Circle the yellow half.", image: p });
		headlessOverride.current = fakeHeadless();
		visualModelOverride.current = scripted([
			fauxAssistantMessage(
				[fauxToolCall("write_svg", { svg: MARKED_SVG }, { id: "w1" }), fauxToolCall("render_svg", {}, { id: "r1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Circled it.")]),
		]).engine;
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			visualModelOverride.current = undefined;
		}
		const result = jobStore.getJob(job.id)!.result as VisualResult;
		assert.deepEqual(result.image, { path: p });
		assert.ok(result.svg.includes("data:image/png;base64,"));
		assert.equal(steers.length, 1);
		assert.match(steers[0]!.content as string, /^The annotated image is drawn, verified by inspection/);
	});

	it("an image gone by run time delivers a FAILED steer", async () => {
		const p = file("vanishing.png", raster(8, 8));
		const job = visualChat("Test: annotate runner, vanished image", { brief: "b", image: p });
		fs.rmSync(p);
		headlessOverride.current = fakeHeadless();
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
		assert.match(result.notes ?? "", /^FAILED: Cannot open image .*vanishing\.png: no such file/);
		assert.equal(jobStore.getJob(job.id)!.status, "error");
	});
});

// ─── 4. the cards ────────────────────────────────────────────────────────────

describe("image cards", () => {
	const details = {
		path: "/Users/learner/Photos/IMG_0042.HEIC.jpeg",
		caption: "Your breadboard",
		mimeType: "image/png" as const,
		data: raster(40, 30).toString("base64"),
		width: 40,
		height: 30,
	};

	it("an annotated image shows no invert switch and never inverts", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const html = renderToStaticMarkup(<VisualOutputCard output={{ svg, image: { path: "/a.png" } }} initialInverted />);
		assert.ok(!html.includes("toggle-invert-figure-brightness"), "no invert switch");
		assert.ok(!html.includes("hue-rotate"), "a pinned inversion is ignored for photos");
		assert.match(html, /data-testid="visual-download"/);
	});

	it("show_image renders the picture with its caption, download, and no invert switch", () => {
		const html = renderToStaticMarkup(
			<ImageCard part={{ type: "tool-show_image", state: "output-available", toolCallId: "c1", input: { path: details.path }, output: details }} />,
		);
		assert.ok(html.includes(`src="data:image/png;base64,${details.data}"`));
		assert.match(html, /alt="Your breadboard"/);
		assert.match(html, /width="40" height="30"/);
		assert.match(html, />Image</);
		assert.match(html, /data-testid="image-caption">Your breadboard</);
		assert.match(html, /data-testid="image-download"/);
		assert.ok(!html.includes("invert"), "no invert switch");
		assert.ok(!html.includes('data-testid="image-open"'), "fullscreen needs the session overlay context");
	});

	it("a failed call keeps the quiet tool-call card with the path; a malformed output falls back", () => {
		const failed = renderToStaticMarkup(
			<ImageCard part={{ type: "tool-show_image", state: "output-error", toolCallId: "c2", input: { path: "~/gone.png" } }} />,
		);
		assert.match(failed, /data-testid="tool-call-card"/);
		assert.match(failed, /~\/gone\.png/);
		const malformed = renderToStaticMarkup(
			<ImageCard part={{ type: "tool-show_image", state: "output-available", toolCallId: "c3", output: { path: "x" } }} />,
		);
		assert.match(malformed, /Image shown, but it could not be displayed/);
	});

	it("download names keep the stem with the stored format; the fullscreen document is a sized SVG", () => {
		assert.equal(imageDownloadName(details), "IMG_0042.HEIC.png");
		assert.equal(imageDownloadName({ path: "C:\\scans\\page 3.bmp", mimeType: "image/jpeg" }), "page 3.jpg");
		assert.equal(imageDownloadName({ path: "/tmp/noext", mimeType: "image/png" }), "noext.png");
		const doc = imageSvgDocument(details);
		assert.match(doc, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="40" height="30" viewBox="0 0 40 30">/);
		assert.ok(doc.includes(`href="data:image/png;base64,${details.data}"`));
	});

	it("the registry renders show_image parts with the image card", () => {
		assert.equal(artifactRenderers.show_image, ImageCard);
	});
});
