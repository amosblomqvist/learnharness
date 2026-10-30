/**
 * The notes transcriber (issue #285) — PDFs and images to Markdown before
 * the notes front door. Faux engines stand in for the vision model and a
 * fake headless for page rendering; the pdfjs layer reads the real fixture.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { needsVision, transcribeImage, transcribePdf } from "../src/agent/subagents/notes-transcriber.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

function fauxEngine(steps: FauxResponseStep[], input: ("text" | "image")[] = ["text", "image"]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: { ...faux.getModel(), input }, streamFn: faux.streamSimple };
}

/** Answers each page call by its own page number (calls run concurrently). */
const pageEcho: FauxResponseStep = (context) => {
	const prompt = JSON.stringify(context);
	assert.match(prompt, /"type":"image"/, "the rendered page rides the call");
	const page = /Page (\d+) of 3/.exec(prompt)?.[1];
	return fauxAssistantMessage(`Transcribed page ${page}`);
};

function fakeHeadless(): HeadlessApi & { rendered: number[] } {
	const rendered: number[] = [];
	return {
		rendered,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unused"); },
		renderSvg: async () => { throw new Error("unused"); },
		renderPdfPages: async (_pdfPath, pages) => {
			rendered.push(...pages);
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
}

describe("notes transcriber", () => {
	it("needsVision flags math-heavy, image-bearing and text-poor pages only", () => {
		const page = { page: 1, text_length: 2000, image_count: 0, math_density: 0 };
		assert.equal(needsVision(page), false, "a text-rich page keeps its pdfjs text");
		assert.equal(needsVision({ ...page, math_density: 0.05 }), true);
		assert.equal(needsVision({ ...page, image_count: 1 }), true);
		assert.equal(needsVision({ ...page, text_length: 40 }), true, "scans and vector handwriting are text-poor");
	});

	it("a PDF transcribes its flagged pages in page order, billing each call", async () => {
		const headless = fakeHeadless();
		const usage: string[] = [];
		const text = await transcribePdf(FIXTURE, {
			engine: fauxEngine([pageEcho, pageEcho, pageEcho]),
			headless,
			onUsage: (u, model) => { assert.ok(u.input > 0); usage.push(model); },
		});
		// Every fixture page is text-poor (< 200 chars), so all three render.
		assert.deepEqual([...headless.rendered].sort(), [1, 2, 3]);
		assert.equal(text, "--- Page 1 ---\nTranscribed page 1\n--- Page 2 ---\nTranscribed page 2\n--- Page 3 ---\nTranscribed page 3");
		assert.deepEqual(usage, ["faux:faux-1", "faux:faux-1", "faux:faux-1"]);
	});

	it("a model without image input keeps the pdfjs text and makes no calls", async () => {
		const headless = fakeHeadless();
		let calls = 0;
		const text = await transcribePdf(FIXTURE, {
			engine: fauxEngine([() => { calls++; return fauxAssistantMessage("unused"); }], ["text"]),
			headless,
		});
		assert.equal(calls, 0);
		assert.deepEqual(headless.rendered, []);
		assert.match(text, /^--- Page 1 ---\n\S/);
		assert.match(text, /--- Page 3 ---\n\S/);
	});

	it("an already-aborted signal stops before any page call", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			transcribePdf(FIXTURE, { engine: fauxEngine([pageEcho]), headless: fakeHeadless(), signal: controller.signal }),
			(err: Error) => err.name === "AbortError",
		);
	});

	it("a failed page call fails the whole transcription", async () => {
		const failing: FauxResponseStep = () => { throw new Error("provider exploded"); };
		await assert.rejects(
			transcribePdf(FIXTURE, { engine: fauxEngine([failing, failing, failing]), headless: fakeHeadless() }),
		);
	});

	it("an image transcribes in one vision call", async () => {
		let prompt = "";
		const text = await transcribeImage(PNG_1PX, "image/png", {
			engine: fauxEngine([(context) => { prompt = JSON.stringify(context); return fauxAssistantMessage("# Whiteboard\n$e^{i\\pi} + 1 = 0$"); }]),
		});
		assert.equal(text, "# Whiteboard\n$e^{i\\pi} + 1 = 0$");
		assert.match(prompt, /"type":"image"/);
	});

	it("an image refuses clearly when the vision model cannot see", async () => {
		await assert.rejects(
			transcribeImage(PNG_1PX, "image/png", { engine: fauxEngine([], ["text"]) }),
			/does not accept image input/,
		);
	});
});
