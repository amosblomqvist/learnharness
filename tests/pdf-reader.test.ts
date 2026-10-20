/**
 * The pdf-reader sub-agent (sources v0) — the hand-rolled loop on a faux
 * engine: triage→extract→brief flow, the unread-finish doctrine gate, the
 * render path via the headless fake, and the unreadable-source failure.
 * The pdfjs layer itself is covered by pdf-ops.test.ts against the fixture.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";

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

function fakeHeadless(rendered: { pages: number[] } = { pages: [] }): HeadlessApi & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unused");
		},
		renderSvg: async () => {
			throw new Error("unused");
		},
		renderPdfPages: async (_pdfPath, pages) => {
			calls.push(`render:${pages.join(",")}`);
			rendered.pages.push(...pages);
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
}

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

	it("never forces the OpenRouter key onto the engine's provider (subscription wave, issue #8)", async () => {
		// The engine's own provider resolves its credential. A leftover
		// OPENROUTER_API_KEY in the process env must NOT ride along as an
		// override: on a Codex-subscription pin it would be a foreign key.
		const seen: Array<Record<string, unknown> | undefined> = [];
		const inner = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The rule is on page 1 (p. 1).")]),
		]);
		const engine: PiEngine = {
			model: inner.model,
			streamFn: ((model, ctx, opts) => {
				seen.push(opts as never);
				return inner.streamFn(model, ctx, opts);
			}) as PiEngine["streamFn"],
		};
		const previous = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "sk-or-test-leftover";
		try {
			await runPdfReaderAgent({ path: FIXTURE, question: "rule?" }, { engine });
		} finally {
			if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = previous;
		}
		assert.ok(seen.length > 0, "the loop called the model");
		for (const opts of seen) assert.equal(opts?.apiKey, undefined, "no forced provider credential");
	});
});
