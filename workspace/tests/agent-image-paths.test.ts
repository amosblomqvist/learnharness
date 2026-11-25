/** Offline integration contracts at the provider boundary: real shared image
 * processing, faux model streams, synthetic rasters, and fake headless I/O.
 * No real browser, provider, learner data, or ambient credentials are used. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
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
import type { PiEngine } from "../src/agent/models.ts";
import type { ModelImageResizeOptions } from "../src/agent/image-processing/index.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";

// Install storage/auth seams BEFORE importing the agent composition root.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agent-image-paths-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
fs.mkdirSync(path.join(scratch, "home"));
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { readTool } = await import("../src/agent/tools/read.ts");
const { createTeacherAgent, createProberAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { runPdfReaderAgent } = await import("../src/agent/subagents/pdf-reader.ts");
const { runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");

const PDF = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4800" height="120" viewBox="0 0 4800 120"><rect width="4800" height="120" fill="white"/></svg>';
const CUSTOM_RESIZE = { maxWidth: 320, maxHeight: 200 };

function png(width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

function dimensions(image: ImageContent): { width: number; height: number } {
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
	try {
		return { width: decoded.get_width(), height: decoded.get_height() };
	} finally { decoded.free(); }
}

function images(context: TranscriptContext): ImageContent[] {
	return context.messages.flatMap((message) => Array.isArray(message.content)
		? message.content.filter((part): part is ImageContent => part.type === "image")
		: []);
}

function text(context: TranscriptContext): string {
	return context.messages.map((message) => typeof message.content === "string"
		? message.content
		: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
}

function scripted(steps: FauxResponseStep[], resize?: ModelImageResizeOptions, vision = true) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const base = faux.getModel();
	const model: PiEngine["model"] = {
		...base,
		input: vision ? ["text", "image"] : ["text"],
		...(resize ? { inputLimits: { ...base.inputLimits, images: { ...base.inputLimits?.images, resize } } } : {}),
	};
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model,
		streamFn: (model, context, options) => {
			// Snapshot the actual provider-facing context, not mutable agent state.
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

function readSteps(file: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("read", { path: file }, { id: "read-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Inspected the supplied source.")]),
	];
}

function fakeHeadless(rendered: Buffer | ((page: number) => Buffer)) {
	const svgCalls: string[] = [];
	const pdfCalls: number[][] = [];
	const headless: HeadlessApi = {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unexpected browser execution"); },
		renderSvg: async (svg) => {
			svgCalls.push(svg);
			return typeof rendered === "function" ? rendered(1) : rendered;
		},
		renderPdfPages: async (_file, pages) => {
			pdfCalls.push([...pages]);
			return pages.map((page) => ({ page, png: typeof rendered === "function" ? rendered(page) : rendered }));
		},
	};
	return { headless, svgCalls, pdfCalls };
}

function assertProcessedImage(context: TranscriptContext, expected: { width: number; height: number }, raw: Buffer): void {
	const parts = images(context);
	assert.equal(parts.length, 1, "exactly one successful image reaches the faux provider");
	assert.deepEqual(dimensions(parts[0]!), expected);
	assert.ok(Buffer.byteLength(parts[0]!.data, "utf8") < 4.5 * 1024 * 1024);
	assert.notEqual(parts[0]!.data, raw.toString("base64"), "the oversized raw raster is never sent");
	assert.match(text(context), /\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by/);
}

test("shared teacher read detects valid image content under a non-image extension", async () => {
	const bytes = png(24, 16);
	const file = path.join(scratch, "lecture-notes.txt");
	fs.writeFileSync(file, bytes);
	const { engine, requests } = scripted(readSteps(file));
	// Pass the actual shared read tool, exercising the teacher's native clone
	// of read.execute rather than a pre-bound test-only implementation.
	const agent = createTeacherAgent(undefined, { engine, tools: { read: readTool } });
	await agent.prompt("Inspect the supplied local file.");
	assert.equal(requests.length, 2);
	const visible = requests[1]!;
	assert.equal(images(visible).length, 1);
	assert.equal(images(visible)[0]!.mimeType, "image/png");
	assert.equal(images(visible)[0]!.data, bytes.toString("base64"));
	assert.deepEqual(dimensions(images(visible)[0]!), { width: 24, height: 16 });
	assert.match(text(visible), /Read image file \[image\/png\]/);
});

test("shared read omits corrupt recognized images without exposing a raw image fallback", async () => {
	// Valid signature/IHDR, missing pixel data: sniff succeeds, decode fails.
	const bytes = png(24, 16).subarray(0, 33);
	const file = path.join(scratch, "corrupt.png");
	fs.writeFileSync(file, bytes);
	const { engine, requests } = scripted(readSteps(file));
	await createTeacherAgent(undefined, { engine, tools: { read: readTool } }).prompt("Inspect the file.");
	assert.equal(requests.length, 2);
	assert.deepEqual(images(requests[1]!), []);
	assert.match(text(requests[1]!), /Image omitted: could not be resized below the inline image size limit/);
	assert.ok(!JSON.stringify(requests[1]).includes(bytes.toString("base64")));
});

test("shared read supplies the native nonvision-model note", async () => {
	const file = path.join(scratch, "nonvision.png");
	fs.writeFileSync(file, png(24, 16));
	const { engine, requests } = scripted(readSteps(file), undefined, false);
	await createTeacherAgent(undefined, { engine, tools: { read: readTool } }).prompt("Inspect the file.");
	assert.equal(requests.length, 2);
	assert.match(text(requests[1]!), /\[Current model does not support images\. The image will be omitted from this request\.\]/);
});

test("teacher read binds independent active-model resize limits without mutating the shared tool", async () => {
	const bytes = png(640, 320);
	const file = path.join(scratch, "model-bound.png");
	fs.writeFileSync(file, bytes);
	const originalExecute = readTool.execute;
	const a = scripted(readSteps(file), { maxWidth: 96, maxHeight: 64 });
	const b = scripted(readSteps(file), { maxWidth: 80, maxHeight: 30 });
	const agentA = createTeacherAgent(undefined, { engine: a.engine, tools: { read: readTool } });
	const agentB = createTeacherAgent(undefined, { engine: b.engine, tools: { read: readTool } });
	await agentB.prompt("Inspect with model B.");
	await agentA.prompt("Inspect with model A.");
	assertProcessedImage(a.requests[1]!, { width: 96, height: 48 }, bytes);
	assertProcessedImage(b.requests[1]!, { width: 60, height: 30 }, bytes);
	assert.equal(readTool.execute, originalExecute);
});

for (const [role, resize, expected] of [
	["prober", { maxWidth: 96, maxHeight: 64 }, { width: 96, height: 48 }],
	["practice", { maxWidth: 80, maxHeight: 30 }, { width: 60, height: 30 }],
] as const) {
	test(`${role}'s actual registry retains argument healing and text reads while binding image limits`, async () => {
		const bytes = png(640, 320);
		const imageFile = path.join(scratch, `${role}-actual-registry.png`);
		const textFile = path.join(scratch, `${role}-actual-registry.txt`);
		fs.writeFileSync(imageFile, bytes);
		fs.writeFileSync(textFile, "first\nsecond\nthird\nfourth\nfifth");
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("read", { path: imageFile }, { id: "registry-image" })], { stopReason: "toolUse" }),
			// Exact existing heal contract: schema-integer fields encoded as
			// JSON number strings heal before validation. The path stays intact.
			fauxAssistantMessage([fauxToolCall("read", { path: textFile, offset: "2", limit: "2" }, { id: "registry-text" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Inspected the image and selected text lines.")]),
		], resize);
		const originalExecute = readTool.execute;
		const forbidden = () => { throw new Error("unexpected job dispatch or handoff"); };
		const chatStore = { getChat: () => null };
		// Only context ports are mocked; no app/store imports or explicit
		// tool overrides. Job/handoff operations must never execute here.
		const agent = role === "prober"
			? createProberAgent({
				chatId: "offline-read-prober", chatStore,
				jobStore: new Proxy({}, { get: forbidden }),
				spawn: forbidden, deliver: forbidden,
			} as never, { engine })
			: createPracticeAgent({ chatId: "offline-read-practice", chatStore }, { engine });
		const names = agent.state.tools.map((tool) => tool.name);
		assert.ok(names.includes(role === "prober" ? "probe_done" : "problem"), "real role registry was assembled");
		const boundRead = agent.state.tools.find((tool) => tool.name === "read");
		assert.ok(boundRead?.prepareArguments, "model binding preserves the registry's prepareArguments wrapper");
		assert.notEqual(boundRead.execute, originalExecute, "shared read execute is rebound to the active model");
		assert.deepEqual(boundRead.prepareArguments({ path: textFile, offset: "2", limit: "2" }), { path: textFile, offset: 2, limit: 2 });
		await agent.prompt("Inspect the local image, then read the selected text lines.");
		assert.equal(requests.length, 3);
		assertProcessedImage(requests[1]!, expected, bytes);
		const selected = requests[2]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "registry-text");
		assert.ok(selected && selected.role === "toolResult");
		assert.equal(selected.isError, false);
		assert.deepEqual(selected.content, [{ type: "text", text: "second\nthird\n\n[2 more lines in file. Use offset=4 to continue.]" }]);
		assert.equal(readTool.execute, originalExecute, "role construction did not mutate the shared tool");
	});
}

test("PDF reader preserves both processed image outputs from multiple render calls in one batch", async () => {
	const wide = png(4800, 120);
	const tall = png(120, 4800);
	const { headless, pdfCalls } = fakeHeadless((page) => page === 1 ? wide : tall);
	const { engine, requests } = scripted([
		fauxAssistantMessage([
			fauxToolCall("pdf_render", { pages: "1", dpi: 150 }, { id: "batch-render-1" }),
			fauxToolCall("pdf_render", { pages: "2", dpi: 150 }, { id: "batch-render-2" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Both rendered pages are visible (p. 1, p. 2). Pages consulted: 1, 2")]),
	]);
	const result = await runPdfReaderAgent({ path: PDF, question: "Compare the two figures." }, { engine, headless });
	assert.equal(requests.length, 2);
	assert.deepEqual(pdfCalls, [[1], [2]]);
	const visible = requests[1]!;
	const parts = images(visible);
	assert.equal(parts.length, 2, "the second render call must not overwrite the first call's images");
	assert.deepEqual(parts.map(dimensions), [{ width: 2000, height: 50 }, { width: 50, height: 2000 }]);
	for (let i = 0; i < parts.length; i++) {
		assert.ok(parts[i]!.data.length < 4.5 * 1024 * 1024);
		assert.notEqual(parts[i]!.data, [wide, tall][i]!.toString("base64"));
	}
	assert.deepEqual(visible.messages.slice(-3).map((message) => message.role), ["toolResult", "toolResult", "user"]);
	const pageMessage = visible.messages.at(-1)!;
	assert.ok(Array.isArray(pageMessage.content));
	assert.deepEqual(pageMessage.content.filter((part) => part.type === "text").map((part) => part.text.split("\n")[0]), [
		"The rendered page(s), in order (p1, p2):", "Page 1", "Page 2",
	]);
	assert.deepEqual(result.pagesRead, [1, 2]);
	assert.deepEqual(result.pagesConsulted, [1, 2]);
});

for (const [label, resize, expected] of [
	["native defaults", undefined, { width: 2000, height: 50 }],
	["active-model overrides", CUSTOM_RESIZE, { width: 320, height: 8 }],
] as const) {
	test(`PDF reader sends processed renders using ${label}; failed page is not counted`, async () => {
		const bytes = png(4800, 120);
		const { headless, pdfCalls } = fakeHeadless((page) => page === 1 ? bytes : Buffer.from("invalid rendered page"));
		const { engine, requests } = scripted([
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "1-2", dpi: 150 }, { id: "render-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The visible figure is on page 1 (p. 1). Pages consulted: 1")]),
		], resize);
		const result = await runPdfReaderAgent({ path: PDF, question: "Inspect the page figure." }, { engine, headless });
		assert.equal(requests.length, 2);
		assert.deepEqual(pdfCalls, [[1, 2]]);
		assertProcessedImage(requests[1]!, expected, bytes);
		assert.match(text(requests[1]!), /Page 2: \[Image omitted:/);
		assert.deepEqual(result.pagesRead, [1]);
		assert.deepEqual(result.pagesConsulted, [1]);
		assert.match(result.brief, /visible figure/);
		const visible = requests[1]!.messages;
		assert.equal(visible.at(-2)!.role, "toolResult");
		assert.equal(visible.at(-1)!.role, "user", "processed page images ride the user message after tool results");
	});

	for (const forced of [false, true]) {
		test(`visual maker ${forced ? "forced-final" : "explicit render_svg"} path processes images using ${label}`, async () => {
			const bytes = png(4800, 120);
			const { headless, svgCalls } = fakeHeadless(bytes);
			const steps: FauxResponseStep[] = forced ? [
				fauxAssistantMessage([fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Premature notes without inspection.")]),
				fauxAssistantMessage([fauxText("Confirmed after inspecting the final render.")]),
			] : [
				fauxAssistantMessage([
					fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" }),
					fauxToolCall("render_svg", {}, { id: "render-1" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Confirmed after inspecting the render.")]),
			];
			const { engine, requests } = scripted(steps, resize);
			const result = await runVisualMaker({ brief: "One precise synthetic figure." }, { engine, headless });
			assert.equal(requests.length, forced ? 3 : 2);
			assert.deepEqual(svgCalls, [SVG]);
			assertProcessedImage(requests.at(-1)!, expected, bytes);
			assert.equal(result.svg, SVG);
			assert.match(result.notes!, /^Confirmed after inspecting/);
			assert.equal(requests.at(-1)!.messages.at(-1)!.role, "user");
			if (forced) {
				assert.deepEqual(images(requests[1]!), [], "premature finish did not see an image yet");
				assert.match(text(requests[2]!), /You finished without looking at a render of your final SVG/);
			} else {
				assert.match(text(requests[1]!), /Here is the current render of your SVG/);
				assert.equal(requests[1]!.messages.at(-2)!.role, "toolResult");
			}
		});
	}
}

for (const forced of [false, true]) {
	test(`visual maker ${forced ? "forced-final" : "explicit render_svg"} processing failure never verifies or delivers the SVG`, async () => {
		const { headless, svgCalls } = fakeHeadless(Buffer.from("corrupt render"));
		const steps: FauxResponseStep[] = [
			fauxAssistantMessage([
				fauxToolCall("write_svg", { svg: SVG }, { id: "write-1" }),
				...(!forced ? [fauxToolCall("render_svg", {}, { id: "render-1" })] : []),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Unverified claim that the picture is correct.")]),
		];
		const { engine, requests } = scripted(steps);
		const activity: string[] = [];
		const result = await runVisualMaker({ brief: "One synthetic figure." }, { engine, headless, onActivity: (line) => activity.push(line) });
		assert.equal(requests.length, 2);
		assert.ok(requests.every((request) => images(request).length === 0));
		assert.equal(result.svg, "");
		assert.match(result.notes!, /^FAILED: inspecting the final SVG failed/);
		assert.match(result.notes!, /Image omitted:/);
		assert.ok(!activity.some((line) => line.includes("inspecting")), "a failed image is never marked inspected");
		assert.equal(svgCalls.length, forced ? 1 : 2, "an explicit processing failure leaves the final-SVG gate unsatisfied");
		if (!forced) assert.match(text(requests[1]!), /RENDER ERROR.*Image omitted:/);
	});
}
