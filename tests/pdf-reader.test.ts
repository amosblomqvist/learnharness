/**
 * The pdf-reader sub-agent (sources v0) — the hand-rolled loop on a faux
 * engine: triage→extract→brief flow, the unread-finish doctrine gate, the
 * render path via the headless fake, and the unreadable-source failure.
 * The pdfjs layer itself is covered by pdf-ops.test.ts against the fixture.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

function fakeHeadless(rendered: { pages: number[] } = { pages: [] }): HeadlessApi & { calls: string[]; paths: string[] } {
	const calls: string[] = [];
	const paths: string[] = [];
	return {
		calls,
		paths,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unused");
		},
		renderSvg: async () => {
			throw new Error("unused");
		},
		renderPdfPages: async (pdfPath, pages) => {
			paths.push(pdfPath);
			calls.push(`render:${pages.join(",")}`);
			rendered.pages.push(...pages);
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
}

describe("pdf-reader source paths", () => {
	let home: string;
	const relativePath = path.join("Course notes", "sample document.pdf");
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	before(() => {
		home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-home-")));
		const target = path.join(home, relativePath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(FIXTURE, target);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
	});

	after(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	});

	for (const kind of ["absolute", "home-relative", "tilde"] as const) {
		it(`${kind} path reaches text tools and rendering as the same absolute path`, async () => {
			const absolutePath = path.join(home, relativePath);
			const inputPath = { absolute: absolutePath, "home-relative": relativePath, tilde: `~/${relativePath}` }[kind];
			assert.equal(os.homedir(), home);
			assert.notEqual(path.resolve(relativePath), absolutePath, "cwd is not the learner's home");
			const headless = fakeHeadless();
			const engine = fauxEngine([
				fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("pdf_search", { query: "integral", literal: true }, { id: "s1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2" }, { id: "e1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "3" }, { id: "r1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Read the requested document (p. 1, p. 2, p. 3).")]),
			]);
			let lastContext = "";
			const stream = engine.streamFn;
			engine.streamFn = (...args) => {
				lastContext = JSON.stringify(args[1]);
				return stream(...args);
			};
			const result = await runPdfReaderAgent(
				{ path: inputPath, question: "Read the document" },
				{ engine, headless },
			);
			assert.equal(result.path, absolutePath);
			assert.match(result.brief, /^Read the requested document/);
			assert.match(lastContext, /Pages: 3/, "metadata opened the home-anchored PDF");
			assert.deepEqual(result.pagesRead, [2, 3]);
			assert.deepEqual(result.pagesConsulted, [1, 2, 3], "search and extraction opened the home-anchored PDF");
			assert.deepEqual(headless.paths, [absolutePath]);
		});
	}

	it("a missing home-relative source fails before any model call", async () => {
		let modelCalls = 0;
		const engine = fauxEngine([]);
		engine.streamFn = () => {
			modelCalls++;
			throw new Error("the model must not be called");
		};
		const missing = path.join("Course notes", "missing.pdf");
		const result = await runPdfReaderAgent({ path: missing, question: "anything" }, { engine });
		assert.equal(result.path, path.join(home, missing));
		assert.match(result.brief, /^PDF failed:.*ENOENT/);
		assert.equal(modelCalls, 0);
		assert.deepEqual(result.pagesRead, []);
		assert.deepEqual(result.pagesConsulted, []);
	});
});

describe("pdf-reader loop (faux engine)", () => {
	it("triage → extract → final brief: pagesConsulted tracks the extract", async () => {
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("pdf_extract", { pages: "1-2" }, { id: "e1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("The integral rule appears on page 1 (p. 1). Pages consulted: 1, 2")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "what is the integral of x?" },
			{ engine },
		);
		assert.equal(result.path, FIXTURE);
		assert.match(result.brief, /integral rule/);
		assert.deepEqual(result.pagesRead, [1, 2], "extracted pages are read pages");
		assert.deepEqual(result.pagesConsulted, [1, 2]);
	});

	it("the unread-finish gate: a brief with zero consultation is bounced, not delivered", async () => {
		let nudged = false;
		const engine = fauxEngine([
			// first finish attempt with NOTHING read — the loop must inject the
			// nudge and keep going rather than deliver invention
			fauxAssistantMessage([fauxText("The answer is 42, trust me.")]),
			// after the nudge: consult, then brief honestly
			fauxAssistantMessage(
				[fauxToolCall("pdf_search", { query: "integral", literal: false }, { id: "s1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Found it on page 1 (p. 1): the integral of x dx.")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "integral of x?" },
			{ engine, onActivity: (line) => void (line && (nudged ||= line.startsWith("pdf_search"))) },
		);
		assert.match(result.brief, /Found it on page 1/);
		assert.deepEqual(result.pagesRead, [], "search hits consult but do not read (the split)");
		assert.deepEqual(result.pagesConsulted, [1]);
		// and the gate lets it through: search hits ARE genuine consultation
		// the first (invention) answer must NOT be the delivered brief
		assert.notEqual(result.brief, "The answer is 42, trust me.");
	});

	it("the render path: images ride a user message after tool results; pages counted", async () => {
		const headless = fakeHeadless();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "2-3", dpi: 150 }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("The physics formula is visible on page 2 (p. 2).")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "what is the force formula?" },
			{ engine, headless },
		);
		assert.deepEqual(result.pagesRead, [2, 3], "rendered pages are read pages");
		assert.deepEqual(result.pagesConsulted, [2, 3]);
		assert.deepEqual(headless.calls, ["render:2,3"]);
	});

	it("no Chrome: render calls degrade to an error note, text tools still work", async () => {
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "1", dpi: 150 }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			// the reader adapts after the error: extract instead, then brief
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Extracted instead: the calculus line (p. 1).")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "page 1 content?" },
			{
				engine,
				headless: {
					available: () => false,
					unavailableReason: () => "No Chrome found",
					runDemo: async () => {
						throw new Error("unused");
					},
					renderSvg: async () => {
						throw new Error("unused");
					},
					renderPdfPages: async () => {
						throw new Error("should not render");
					},
				},
			},
		);
		assert.match(result.brief, /Extracted instead/);
		assert.deepEqual(result.pagesRead, [1]);
		assert.deepEqual(result.pagesConsulted, [1]);
	});

	it("an unreadable source fails deterministically before any model call", async () => {
		const engine = fauxEngine([fauxAssistantMessage([fauxText("never reached")])]);
		const result = await runPdfReaderAgent(
			{ path: path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt"), question: "anything" },
			{ engine },
		);
		// had the model been consulted, the brief would be its text instead
		assert.match(result.brief, /^PDF failed:/);
		assert.ok(!result.brief.includes("never reached"));
		assert.deepEqual(result.pagesRead, []);
		assert.deepEqual(result.pagesConsulted, []);
	});

	it("pdf_extract with pages 'all' tracks every page and does not trigger the unread-finish gate", async () => {
		let modelCalls = 0;
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "all" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Summarized all three pages (p. 1, p. 2, p. 3). Pages consulted: 1, 2, 3")]),
		]);
		const stream = engine.streamFn;
		engine.streamFn = (...args) => {
			modelCalls++;
			return stream(...args);
		};
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "summarize all pages" },
			{ engine },
		);
		assert.equal(modelCalls, 2);
		assert.match(result.brief, /^Summarized all three pages/);
		assert.deepEqual(result.pagesRead, [1, 2, 3]);
		assert.deepEqual(result.pagesConsulted, [1, 2, 3]);
	});

	it("pdf_render with pages 'all' renders from page 1 up to the document length or batch cap", async () => {
		const shortHeadless = fakeHeadless();
		const shortEngine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "all", dpi: 150 }, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Rendered all 3 pages (p. 1, p. 2, p. 3).")]),
		]);
		const shortResult = await runPdfReaderAgent(
			{ path: FIXTURE, question: "render all pages" },
			{ engine: shortEngine, headless: shortHeadless },
		);
		assert.deepEqual(shortHeadless.calls, ["render:1,2,3"]);
		assert.deepEqual(shortResult.pagesRead, [1, 2, 3]);
		assert.deepEqual(shortResult.pagesConsulted, [1, 2, 3]);

		const longFile = path.join(os.tmpdir(), `lh-pdf-reader-8page-${process.pid}.pdf`);
		fs.writeFileSync(longFile, tinyPdf(Array.from({ length: 8 }, (_, i) => ({
			runs: [{ text: `Page ${i + 1}`, x: 72, y: 700 }],
		}))));
		try {
			const longHeadless = fakeHeadless();
			const longEngine = fauxEngine([
				fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "all", dpi: 150 }, { id: "r2" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Rendered the first six pages (p. 1-6).")]),
			]);
			const longResult = await runPdfReaderAgent(
				{ path: longFile, question: "render all pages" },
				{ engine: longEngine, headless: longHeadless },
			);
			assert.deepEqual(longHeadless.calls, ["render:1,2,3,4,5,6"]);
			assert.deepEqual(longResult.pagesRead, [1, 2, 3, 4, 5, 6]);
			assert.deepEqual(longResult.pagesConsulted, [1, 2, 3, 4, 5, 6]);
		} finally {
			fs.rmSync(longFile, { force: true });
		}
	});

	it("out-of-range pdf_extract specs do not record nonexistent pages or bypass the unread-finish gate", async () => {
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "99" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Fabricated brief from missing page.")]),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2-10" }, { id: "e2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Real brief from pages 2 and 3 (p. 2, p. 3).")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "what is on the later pages?" },
			{ engine },
		);
		assert.match(result.brief, /^Real brief from pages 2 and 3/);
		assert.deepEqual(result.pagesRead, [2, 3]);
		assert.deepEqual(result.pagesConsulted, [2, 3]);
	});

	it("out-of-range pdf_render specs skip empty renders and clamp ranges to the document length", async () => {
		const headless = fakeHeadless();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "99", dpi: 150 }, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Fabricated brief from missing render.")]),
			fauxAssistantMessage([fauxToolCall("pdf_render", { pages: "2-10", dpi: 150 }, { id: "r2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Rendered pages 2 and 3 (p. 2, p. 3).")]),
		]);
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "render the later pages" },
			{ engine, headless },
		);
		assert.deepEqual(headless.calls, ["render:2,3"]);
		assert.match(result.brief, /^Rendered pages 2 and 3/);
		assert.deepEqual(result.pagesRead, [2, 3]);
		assert.deepEqual(result.pagesConsulted, [2, 3]);
	});
});