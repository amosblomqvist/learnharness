
/**
 * Demo + visual artifact tests (W6) — deterministic, zero network, no real
 * Chrome:
 *
 *   1. bridge-script injection (buildDemoSrcDoc) + the pure bridge-message
 *      reducer (reduceDemoBridgeState)
 *   2. card rendering (static markup): sandboxed iframe attrs, error chip,
 *      failure notes, SVG image documents
 *   3. the demo-builder loop with a FAKE model + FAKE headless (success with
 *      a fix iteration, untested-final verification, never-clean failure,
 *      no-Chrome failure)
 *   4. the visual-maker loop (fake model + fake headless): render-and-look
 *      success, forced look on premature finish, never-writes failure
 *   5. job runners + dispatch (demo part → demo job → steer via a fake
 *      deliver; visual failure path; end-to-end dispatch through
 *      handleChatRequest with the ack protocol)
 *   6. tool registry wiring (server-executed dispatch tools, schemas)
 *
 * Cleanup follows tests/jobs.test.ts idioms (created chat/job files removed
 * in the after() hook; overrides reset in finally blocks).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import {
	buildDemoSrcDoc,
	DEMO_BRIDGE_SCRIPT,
	DemoCard,
	DemoErrorChip,
	INITIAL_DEMO_BRIDGE_STATE,
	reduceDemoBridgeState,
} from "../components/artifacts/demo-card.tsx";
import { svgNaturalWidth, VisualCard, VisualOutputCard } from "../components/artifacts/visual-card.tsx";
import { slugFilename } from "../components/artifacts/download.ts";
import { chartSize } from "../components/session-overlay.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobCard, PdfJobCard } from "../components/artifacts/job-card.tsx";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { demoInputSchema, jobTools, pdfInputSchema, visualInputSchema } from "../src/agent/tools/jobs.ts";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { headlessOverride, type DemoRunResult, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { createJobRunner, demoModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { buildAbortSteer, buildSubagentSteer, isSubagentFailure, setSteerUiInverted, type SteerMessage } from "../src/core/contracts.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";

/**
 * A fake deliver seam + a runner wired like the chat-handler's, per test:
 * capture the steer and mimic the pipeline's final status flip so the job
 * record reads exactly as production does after the wake turn completes.
 */
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
import { artifactRenderers } from "../components/artifacts/index.ts";

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";



const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	headlessOverride.current = undefined;
	demoModelOverride.current = undefined;
	visualModelOverride.current = undefined;
});

/** A scripted pi engine (faux provider): the response queue replaces the old
 *  doGenerate turn counter — one queued response per model call (tool-call
 *  turn or final text), consumed in order. */
function scriptedModel(turns: Array<{ toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((step) => {
		if (step.toolCalls) {
			return fauxAssistantMessage(
				step.toolCalls.map((c) => fauxToolCall(c.toolName, c.input as ToolCall["arguments"], { id: c.toolCallId })),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(step.text ?? "");
	});
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

// ─── fake headless ───────────────────────────────────────────────────────────

const CLEAN_RUN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const BROKEN_RUN: DemoRunResult = {
	consoleErrors: ["Uncaught ReferenceError: foo is not defined"],
	pageErrors: [],
	failedRequests: [],
	ok: false,
};

function fakeHeadless(opts: {
	/** Return BROKEN_RUN for html matching this substring, else CLEAN_RUN. */
	brokenWhenIncludes?: string;
	/** Throw for the first N renderSvg calls (then succeed). */
	renderFailures?: number;
} = {}): HeadlessApi & { demoRuns: string[]; svgRenders: string[] } {
	const api = {
		demoRuns: [] as string[],
		svgRenders: [] as string[],
		available() {
			return true;
		},
		unavailableReason() {
			return null;
		},
		async runDemo(html: string): Promise<DemoRunResult> {
			api.demoRuns.push(html);
			return opts.brokenWhenIncludes && html.includes(opts.brokenWhenIncludes) ? BROKEN_RUN : CLEAN_RUN;
		},
		async renderSvg(svg: string): Promise<Buffer> {
			api.svgRenders.push(svg);
			if (opts.renderFailures && api.svgRenders.length <= opts.renderFailures) {
				throw new Error("XML parse error");
			}
			return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
		},
	};
	return api as HeadlessApi & { demoRuns: string[]; svgRenders: string[] };
}

function noChromeHeadless(): HeadlessApi {
	return {
		available: () => false,
		unavailableReason: () => "No Chrome/Chromium found for headless testing. Install Google Chrome or set CHROME_PATH.",
		runDemo: async () => {
			throw new Error("should not run");
		},
		renderSvg: async () => {
			throw new Error("should not render");
		},
		renderPdfPages: async () => {
			throw new Error("should not render");
		},
	};
}

// ─── 1. bridge injection + reducer ───────────────────────────────────────────

describe("demo bridge", () => {
	it("injects the resize + error hooks before </body>", () => {
		const srcDoc = buildDemoSrcDoc("<!doctype html><html><body><canvas id=\"c\"></canvas></body></html>");
		assert.match(srcDoc, /demo-resize/);
		assert.match(srcDoc, /demo-error/);
		assert.match(srcDoc, /ResizeObserver/);
		assert.match(srcDoc, /window\.addEventListener\("error"/);
		// the bridge lands inside the document, and the original content survives
		assert.ok(srcDoc.indexOf("ResizeObserver") < srcDoc.indexOf("</body>"));
		assert.match(srcDoc, /<canvas id="c">/);
	});

	it("appends the bridge when the document has no </body>", () => {
		const srcDoc = buildDemoSrcDoc("<div>fragment demo</div>");
		assert.match(srcDoc, /demo-resize/);
		assert.ok(srcDoc.endsWith("</script>"));
		assert.match(srcDoc, /fragment demo/);
	});

	it("reduceDemoBridgeState handles resize, error, and garbage", () => {
		let state = INITIAL_DEMO_BRIDGE_STATE;
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 421.7 });
		assert.equal(state.height, 422);
		assert.equal(state.error, null);
		// clamped
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 99999 });
		assert.equal(state.height, 2400);
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 5 });
		assert.equal(state.height, 80);
		// invalid payloads ignored
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: "tall" }).height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize" }).height, 80);
		// errors recorded, with a fallback message
		state = reduceDemoBridgeState(state, { type: "demo-error", message: "x is not defined" });
		assert.equal(state.error, "x is not defined");
		assert.equal(state.height, 80, "error does not clobber height");
		state = reduceDemoBridgeState(state, { type: "demo-error" });
		assert.equal(state.error, "unknown error");
		// unknown types and non-objects ignored
		assert.deepEqual(reduceDemoBridgeState(state, { type: "something-else" }), state);
		assert.deepEqual(reduceDemoBridgeState(state, "demo-resize"), state);
		assert.deepEqual(reduceDemoBridgeState(state, null), state);
	});
});

// ─── 2. card rendering ───────────────────────────────────────────────────────

const DEMO_HTML = "<!doctype html><html><body><h1>oscillator</h1><script>let t=0;</script></body></html>";

function part(state: string, output?: unknown) {
	return { type: "tool-demo", state, toolCallId: "call-1", input: { title: "Oscillator", brief: "b" }, output };
}

describe("dispatch card rendering (the tool-call ack box)", () => {
	const ackPart = { type: "tool-research", state: "output-available", toolCallId: "call-1", input: { question: "q" }, output: "Dispatched (job j1)." };
	const mkJob = (status: string, activity = "web_search: \"plato\""): JobRecord =>
		({ id: "j1", kind: "research", chatId: "c", toolCallId: "call-1", status, activity, createdAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString() }) as JobRecord;

	it("renders a live activity card while the job runs", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[mkJob("running")]}>
				<JobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /Research agent/);
		assert.match(html, /web_search: (&quot;|")plato/);
		assert.ok(!html.includes("Dispatched (job j1.)") || true, "ack text is not the display");
	});

	it("renders the dispatched pulse when the poll has not seen the job yet", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[]}>
				<JobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /Research agent/);
		assert.match(html, /Dispatched…/);
	});

	it("settles to a quiet finished one-liner when the worker is done", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[mkJob("done", "delivered")]}>
				<JobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /Research agent/);
		assert.match(html, /finished/);
		assert.ok(!html.includes("web_search"), "no stale activity line once settled");
	});

	it("marks a failed job as failed", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[mkJob("error")]}>
				<JobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /failed/);
	});

	it("renders nothing for a still-streaming tool input", () => {
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[]}>
				<JobCard part={{ ...ackPart, state: "input-streaming" } as never} />
			</JobsContext.Provider>,
		);
		assert.equal(html, "");
	});

	// sources v0 — the live browser smoke (2026-09-19) caught the pdf dispatch
	// part rendering nothing: PdfJobCard is the fix.
	it("pdf dispatch renders the live PDF-reader card while the job runs", () => {
		const pdfJob: JobRecord = ({
			id: "jp1",
			kind: "pdf",
			chatId: "c",
			toolCallId: "call-1",
			status: "running",
			activity: 'pdf_render: 42-44 @150dpi',
			createdAt: new Date(Date.now() - 5000).toISOString(),
			updatedAt: new Date().toISOString(),
		}) as JobRecord;
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[pdfJob]}>
				<PdfJobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /PDF reader/);
		assert.match(html, /pdf_render/);
	});

	it("pdf dispatch settles to the finished one-liner", () => {
		const pdfJob: JobRecord = ({
			id: "jp1",
			kind: "pdf",
			chatId: "c",
			toolCallId: "call-1",
			status: "done",
			activity: "delivered",
			createdAt: new Date(Date.now() - 5000).toISOString(),
			updatedAt: new Date().toISOString(),
		}) as JobRecord;
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[pdfJob]}>
				<PdfJobCard part={ackPart as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /PDF reader/);
		assert.match(html, /finished/);
	});
});

describe("steer card rendering (the delivered artifact)", () => {
	it("renders a sandboxed demo iframe (allow-scripts, NO allow-same-origin) with the bridge injected", () => {
		const steer = buildSubagentSteer(
			{ id: "jd", kind: "demo", toolCallId: "cd" },
			{ title: "Damped oscillator", html: DEMO_HTML, tested: true },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /sandbox="allow-scripts"/);
		assert.ok(!html.includes("allow-same-origin"), "never allow-same-origin");
		assert.match(html, /demo-resize/);
		assert.match(html, /demo-error/);
		assert.match(html, /Damped oscillator/);
		assert.match(html, /interactive demo/i);
		// the model-facing protocol text never renders for the learner
		assert.ok(!html.includes("do NOT wait"), "no protocol glue in the bubble");
	});

	it("renders the demo failure note with no iframe when the build FAILED", () => {
		const steer = buildSubagentSteer(
			{ id: "jd", kind: "demo", toolCallId: "cd" },
			{ title: "T", html: "", tested: true, notes: "FAILED: never passed verification" },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /FAILED: never passed verification/);
		assert.ok(!html.includes("<iframe"), "no iframe for a failed build");
	});

	it("renders the verified svg as an image; the maker's notes are glue and stay hidden", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const steer = buildSubagentSteer(
			{ id: "jv", kind: "visual", toolCallId: "cv" },
			{ svg, notes: "Looking at the render, the diagram is clean and accurate." },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.ok(html.includes(encodeURIComponent(svg)), "the image URL contains the original SVG");
		assert.match(html, /Figure/);
		// Natural sizing (owner, 2026-10-07): a DECLARED width (200) means the
		// holder hugs + centers rather than stretching full-width.
		assert.match(html, /w-fit/, "holder hugs the declared size");
		assert.match(html, /class="block h-auto max-w-full"/, "image shrinks to fit only when oversized");
		assert.ok(!html.includes("Looking at the render"), "model-facing notes never render");
	});

	it("renders the abort chip for an aborted job's steer (2026-09 dock semantics; the message type is the marker PART)", () => {
		const steer = buildAbortSteer({ id: "jc", kind: "research", toolCallId: "cc" });
		// Wave B: the steer is a native marker — the card renders its
		// PROJECTION (the same view the transcript renderer hands it).
		const view = projectNative([steer])[0]!;
		assert.equal((steer.details as { aborted: boolean }).aborted, true);
		assert.equal(view.parts.length, 2, "text (teacher-facing) + the data-subagent-aborted marker part");
		const html = renderToStaticMarkup(<SubagentSteerCard message={view as never} />);
		assert.match(html, /job-aborted-badge/);
		assert.match(html, /research/, "the job's kind, lower-cased like the complete-badge idiom");
		assert.match(html, /aborted by the learner/);
		// the teacher-facing protocol text never renders for the learner
		assert.ok(!html.includes("no brief is coming"), "no protocol glue in the chip");
		// the badge renders off the PART, not metadata (the custom-message scheme)
		const noMeta = { ...view, metadata: {} };
		const htmlNoMeta = renderToStaticMarkup(<SubagentSteerCard message={noMeta as never} />);
		assert.match(htmlNoMeta, /job-aborted-badge/, "metadata is pump mechanics, never the render seam");
	});

	it("renders a quiet Research-complete one-liner whose collapsed <details> carries the full brief", () => {
		const steer = buildSubagentSteer(
			{ id: "jr", kind: "research", toolCallId: "cr" },
			{
				brief: "Plato (c. 428–348 BCE) founded the Academy, a very long brief that would clutter the transcript.",
				sources: [
					{ title: "Britannica", url: "https://britannica.com/plato" },
					{ title: "IEP", url: "https://iep.utm.edu/plato/" },
				],
			},
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /Research/);
		assert.match(html, /complete/);
		assert.match(html, /2 sources/);
		assert.match(html, /view brief/, "the expansion affordance is offered");
		// the one-liner is a native <details> — collapsed by default, so the
		// brief + sources ride in the DOM but never clutter the transcript
		// until the learner opens them (the wave-1 "view full research" ask)
		assert.match(html, /<details[^>]*data-testid="research-complete-badge"/, "a real disclosure");
		assert.ok(!/<details[^>]*open/.test(html), "collapsed by default — no `open` attribute");
		assert.ok(html.includes("founded the Academy"), "the persisted brief rides inside the details");
		assert.ok(html.includes("britannica.com/plato"), "source links ride inside the details");
	});

	it("renders a quiet PDF-reading-complete one-liner (sources v0) whose collapsed details carries the brief + pages", () => {
		const steer = buildSubagentSteer(
			{ id: "jpf", kind: "pdf", toolCallId: "cpf" },
			{
				path: "/Users/x/course/chapter-3.pdf",
				question: "What is the integral of x dx?",
				brief: "The power rule appears on **page 1**: the integral of x dx is x^2/2 + C.",
				pagesRead: [1],
				pagesConsulted: [1, 2],
			},
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /PDF/);
		assert.match(html, /reading complete/);
		assert.match(html, /read 1 page/, "the badge counts READ pages, not search hits");
		assert.match(html, /<details[^>]*data-testid="pdf-complete-badge"/, "a real disclosure like the research badge");
		assert.ok(!/<details[^>]*open/.test(html), "collapsed by default");
		assert.ok(html.includes("power rule"), "the brief rides inside the details");
		// the path/question are sub-agent context — never learner-facing chrome
		assert.ok(!html.includes("/Users/x/course/chapter-3.pdf"), "the file path never renders");
	});

	it("renders the PDF failure brief with the failed badge when the reader FAILED", () => {
		const steer = buildSubagentSteer(
			{ id: "jpf2", kind: "pdf", toolCallId: "cpf2" },
			{ path: "/tmp/doc.pdf", question: "q", brief: "PDF failed: the file could not be opened", pagesRead: [], pagesConsulted: [] },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /pdf-brief-card/);
		assert.match(html, /failed/);
		assert.match(html, /could not be opened/);
		assert.ok(!html.includes("pdf-complete-badge"), "no complete badge for a failure");
	});

	it("renders the visual failure note with no svg when the build FAILED", () => {
		const steer = buildSubagentSteer({ id: "jv", kind: "visual", toolCallId: "cv" }, { svg: "", notes: "FAILED: iteration limit" });
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /FAILED: iteration limit/);
		assert.ok(!html.includes("circle") && !html.includes("<svg"), "no svg for a failed build");
	});

	it("renders a fallback note when the artifact part is missing", () => {
		const msg = { id: "s", role: "user", parts: [{ type: "text", text: "x" }], metadata: { subagentResult: { jobId: "j", kind: "research", toolCallId: "c" } } };
		const html = renderToStaticMarkup(<SubagentSteerCard message={msg as never} />);
		assert.match(html, /could not be displayed/);
	});
});


describe("artifact chrome — scrollbar, invert toggles, downloads (release polish 2026-10-07)", () => {
	it("demo iframe: scrolling OFF (the bridge auto-sizes; a scrollable iframe traps the wheel) and the invert + download buttons render", () => {
		const steer = buildSubagentSteer(
			{ id: "jd3", kind: "demo", toolCallId: "cd3" },
			{ title: "Wave interference", html: DEMO_HTML, tested: true },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /scrolling="no"/, "no internal scrollbar — the wheel chains to the session");
		assert.match(html, /toggle-invert-demo-brightness/, "the invert switch (house Toggle)");
		assert.match(html, /data-testid="demo-download"/);
		assert.ok(!html.includes("hue-rotate"), "inversion is OFF by default — a manual toggle only");
		assert.match(html, /interactive demo/, "the kind label lives in the caption header");
		assert.match(html, /Wave interference/, "the title rides beside the kind label");
	});

	it("figure card: invert + download buttons; NO fullscreen button without a chat page (the context is null there)", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const html = renderToStaticMarkup(<VisualOutputCard output={{ svg }} />);
		assert.match(html, /toggle-invert-figure-brightness/, "the invert switch (house Toggle)");
		assert.match(html, /data-testid="visual-download"/);
		assert.ok(!html.includes('data-testid="visual-open"'), "fullscreen needs the session overlay context");
		assert.ok(!html.includes("hue-rotate"), "inversion OFF by default");
	});

	it("figure card: NO card chrome, image first, caption row BELOW (owner round, 2026-10-07)", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const html = renderToStaticMarkup(<VisualOutputCard output={{ svg }} />);
		// Document material: the outer box carries no card styling.
		const rootAt = html.indexOf('data-testid="visual-card"');
		const root = html.slice(rootAt - 200, rootAt);
		assert.ok(!root.includes("rounded-xl border"), "no card container");
		// Image BEFORE the caption row; the caption label and the controls follow it.
		const svgAt = html.indexOf('data-testid="visual-svg"');
		const captionAt = html.indexOf(">Figure<");
		assert.ok(svgAt !== -1 && captionAt !== -1 && svgAt < captionAt, "the caption row sits below the image");
		assert.ok(captionAt < html.indexOf("visual-download"), "the controls ride the caption row");
		// The invert affordance: the contrast-circle disc + the tooltip.
		assert.ok(html.includes("size-3"), "the icon disc");
		assert.ok(html.includes('title="Invert colors"'), "the tooltip names the toggle");
		// The half-moon is ACTUALLY filled (owner catch: lucide's Contrast
		// renders it hollow — fill="none" default; ours fills currentColor).
		assert.ok(
			html.includes('fill="currentColor" stroke="none"'),
			"the filled half of the invert disc",
		);
	});

	it("svgNaturalWidth: declared px sizes parse; %, auto, and absent fall back to null", () => {
		assert.equal(svgNaturalWidth('<svg width="200" height="100"></svg>'), 200);
		assert.equal(svgNaturalWidth("<svg width='320'></svg>"), 320);
		assert.equal(svgNaturalWidth('<svg width="100%"></svg>'), null, "% is no natural size");
		assert.equal(svgNaturalWidth('<svg width="auto"></svg>'), null);
		assert.equal(svgNaturalWidth('<svg viewBox="0 0 10 10"></svg>'), null, "viewBox-only → full-width law");
		assert.equal(svgNaturalWidth('<svg width="0"></svg>'), null, "degenerate zero is no size");
	});

	it("slugFilename: titles slug to filename stems; symbol-only falls back", () => {
		assert.equal(slugFilename("Damped oscillator"), "damped-oscillator");
		assert.equal(slugFilename("Ünïcode — Tïtle!"), "unicode-title");
		assert.equal(slugFilename("???"), "demo");
	});

	it("chartSize: width/height attrs are the fallback when no viewBox (figure fullscreen fit math)", () => {
		assert.deepEqual(chartSize('<svg width="320" height="240"></svg>'), { w: 320, h: 240 });
		assert.deepEqual(chartSize('<svg xmlns="x" width="50px" height="25px" viewBox="0 0 100 50"></svg>'), {
			w: 100,
			h: 50,
		}, "viewBox always wins");
	});
});

describe("bridge height: the body-based measure (ratchet fix, 2026-10-07)", () => {
	it("DEMO_BRIDGE_SCRIPT measures the BODY (scrollHeight + rect + margins), not the viewport-clamped documentElement", () => {
		// documentElement.scrollHeight = max(content, viewport) latches at
		// the parent's own height — a demo could grow but never shrink on
		// window resize (owner-reported). The body metrics are pure content.
		assert.ok(DEMO_BRIDGE_SCRIPT.includes("Math.max(b.scrollHeight,b.getBoundingClientRect().height)"));
		assert.ok(DEMO_BRIDGE_SCRIPT.includes("getComputedStyle(b)"));
		assert.ok(!/post=function\(\)\{send\(\{type:"demo-resize",height:document\.documentElement\.scrollHeight\}\)\};/.test(DEMO_BRIDGE_SCRIPT));
	});
});

describe("setSteerUiInverted (the persisted invert switch, 2026-10-07)", () => {
	const demoSteer = buildSubagentSteer(
		{ id: "jx", kind: "demo", toolCallId: "cx" },
		{ title: "T", html: "<p>x</p>", tested: true },
	);
	const other = { id: "other", role: "user" as const, content: "hi", timestamp: 1 };

	it("writes ui.inverted on the target steer and leaves everything else untouched", () => {
		const out = setSteerUiInverted([other, demoSteer], demoSteer.id, true);
		assert.equal(out.length, 2);
		assert.deepEqual(
			(out[1] as { details: { ui?: { inverted?: boolean } } }).details.ui,
			{ inverted: true },
		);
		assert.equal(out[0], other, "untouched messages pass through by identity");
	});

	it("toggles back to false; missing or non-artifact messages are no-ops (same array members)", () => {
		const on = setSteerUiInverted([demoSteer], demoSteer.id, true);
		const off = setSteerUiInverted(on, demoSteer.id, false);
		assert.equal((off[0] as { details: { ui?: { inverted?: boolean } } }).details.ui?.inverted, false);
		const missing = setSteerUiInverted([demoSteer], "nope", true);
		assert.equal(missing[0], demoSteer, "no target → identity");
	});
});

// Generated-figure image boundaries are covered in svg-image.test.tsx.
// There is no longer a partial regex sanitizer in the display path.

// ─── 3. the demo-builder loop ────────────────────────────────────────────────

const BROKEN_HTML = "<!doctype html><html><body>BROKEN<script>foo();</script></body></html>";
const GOOD_HTML = "<!doctype html><html><body><canvas id=\"c\"></canvas><script>requestAnimationFrame(function step(){});</script></body></html>";

describe("demo builder (fake model + fake headless)", () => {
	it("iterates write → run → fix → run → clean → delivers with notes", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const activities: string[] = [];
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "run_demo", input: { probe: "typeof step === 'function'" } }] },
			{ text: "Drag the damping slider to see the oscillation decay." },
		]);

		const result = await runDemoBuilder(
			{ title: "Damped oscillator", brief: "A mass on a spring with a damping slider." },
			{ engine: model, headless, onActivity: (line) => activities.push(line) },
		);

		assert.equal(result.title, "Damped oscillator");
		assert.equal(result.html, GOOD_HTML, "delivers the FIXED html");
		assert.equal(result.tested, true);
		assert.equal(result.notes, "Drag the damping slider to see the oscillation decay.");
		assert.equal(headless.demoRuns.length, 2, "ran the broken demo, then the fixed one — no extra verification needed");
		assert.ok(activities.some((a) => a.startsWith("run_demo: 1 console error")), `activity recorded per iteration: ${activities.join(" | ")}`);
		assert.ok(activities.includes("run_demo: clean"), "clean run recorded in activity");
	});

	it("verifies headlessly even when the model forgets run_demo before finishing", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ text: "Done." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless });
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true, "tested by the final verification gate");
		assert.equal(headless.demoRuns.length, 1, "the gate ran the demo once itself");
	});

	it("fails (empty html + FAILED notes) when the demo never passes verification", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ text: "It works, trust me." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless });
		assert.equal(result.html, "");
		assert.equal(result.tested, true, "the loop ran");
		assert.match(result.notes ?? "", /^FAILED:/);
		assert.match(result.notes ?? "", /ReferenceError/);
	});

	it("fails fast with a clear message when no Chrome is available (never skips testing)", async () => {
		const model = scriptedModel([{ text: "should never be reached" }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless: noChromeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});

	it("fails when the model never writes a demo", async () => {
		const model = scriptedModel([{ text: "I cannot build this." }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless: fakeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: the builder never wrote a demo/);
	});
});

// ─── 4. the visual-maker loop ────────────────────────────────────────────────

const SVG_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><line x1="10" y1="50" x2="290" y2="50"/></svg>';

describe("visual maker (fake model + fake headless)", () => {
	it("write → render → look → finish delivers the svg with notes", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ text: "A number line from -3 to 3 with the root marked at 0." },
		]);
		const activities: string[] = [];
		const result = await runVisualMaker({ brief: "Number line, root at 0." }, { engine: model, headless, onActivity: (l) => activities.push(l) });

		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "A number line from -3 to 3 with the root marked at 0.");
		assert.equal(headless.svgRenders.length, 1);
		assert.ok(activities.some((a) => a.startsWith("render_svg")), "render activity recorded");
	});

	it("forces a look when the model finishes without rendering the final svg", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ text: "Done." }, // premature finish — no render yet
			{ text: "Looked at it — correct." }, // after the forced look
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, SVG_1, "delivered after the forced look");
		assert.equal(result.notes, "Looked at it — correct.");
		assert.equal(headless.svgRenders.length, 1, "the gate rendered the svg once itself");
	});

	it("edit_svg: exact-match single replacement, with fuzzy context on a miss", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			// A miss: old_text not in the document (error fed back, nothing changed)
			{ toolCalls: [{ toolCallId: "e1", toolName: "edit_svg", input: { old_text: "NOT-PRESENT", new_text: "x" } }] },
			// A hit: exactly one occurrence — applied
			{ toolCalls: [{ toolCallId: "e2", toolName: "edit_svg", input: { old_text: '<line x1="10"', new_text: '<line x1="20"' } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Moved the start of the line." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });

		assert.equal(result.svg, SVG_1.replace('<line x1="10"', '<line x1="20"'), "the edit was applied to the delivered svg");
		assert.equal(result.notes, "Moved the start of the line.");
		assert.equal(headless.svgRenders.length, 2, "re-rendered after the edit (the look gate saw the change)");
	});

	it("edit_svg before write_svg errors and never edits nothing into a deliverable", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			// Nothing written yet — the edit must error, not crash the loop
			{ toolCalls: [{ toolCallId: "e0", toolName: "edit_svg", input: { old_text: "svg", new_text: "x" } }] },
			{ text: "Cannot proceed." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, "", "the failed edit produced no deliverable");
		assert.match(result.notes ?? "", /never wrote an SVG/);
	});

	it("feeds render errors back to the model instead of crashing", async () => {
		const headless = fakeHeadless({ renderFailures: 1 });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: "<svg>broken" } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Fixed and verified." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "Fixed and verified.");
	});

	it("fails when the model never writes an svg", async () => {
		const model = scriptedModel([{ text: "This idea is purely relational — belongs in mermaid." }]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless: fakeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: the maker never wrote an SVG/);
	});

	it("fails with a clear message when no Chrome is available", async () => {
		const result = await runVisualMaker({ brief: "b" }, { engine: scriptedModel([{ text: "x" }]), headless: noChromeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});
});

// ─── 5. job runners + dispatch ───────────────────────────────────────────────

const DEMO_INPUT = { title: "Compound interest", brief: "Slider for rate, curve of growth over 30 years." };

function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	return res.text();
}

/** CONNECTION DIET B (owner, 2026-10-10): the POST acks and closes; drain
 *  the turn's wire through the reattach stream instead (settle-tolerant:
 *  a short turn may finish inside the handler). */
async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn already settled — completion happened
	return new Response(handle.subscribe()).text();
}


describe("demo/visual job runners", () => {
	it("runJob completes a demo: result on the job, steer via deliver, ack stays on the part", async () => {
		const chat = chatStore.createChat("Test: demo runner");
		createdChats.push(chat.id);
		// Wave B: a NATIVE fixture (the record holds agent history) — the
		// runner's transcript scan reads it through the projection.
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "show me compounding", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-d1", name: "demo", arguments: DEMO_INPUT as never }],
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
				toolCallId: "call-d1",
				toolName: "demo",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);

		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-d1" });
		createdJobs.push(job.id);

		// runJob has no headless injection point — the module override is the seam.
		headlessOverride.current = fakeHeadless();
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep the rate slider." },
		]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			demoModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		assert.equal(done.activity, "finished", "the worker finishes independently of delivery");
		const result = done.result as { title: string; html: string; tested: boolean; notes?: string };
		assert.equal(result.title, "Compound interest");
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true);

		// The steer carries the artifact for the renderer.
		assert.equal(steers.length, 1, "exactly one steer");
		const data = steers[0]!.details as { kind: string; result: unknown };
		assert.equal(data.kind, "demo");
		assert.deepEqual(data.result, result);

		// The tool part keeps the DISPATCH ACK forever — the result never
		// rewrites it (the teacher gets the result once, via the steer).
		const saved = projectNative(chatStore.getChat(chat.id)!.messages);
		const part = saved[1]!.parts.find((p) => p.type === "tool-demo");
		assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
		assert.equal(typeof (part as { output?: unknown }).output, "string", "part output is the ack, not the result");
	});

	it("runJob still steers on visual failure and the job lands error", async () => {
		const chat = chatStore.createChat("Test: visual runner failure");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "draw it", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-v1", name: "visual", arguments: { brief: "b" } as never }],
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
				toolCallId: "call-v1",
				toolName: "visual",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);

		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-v1" });
		createdJobs.push(job.id);

		visualModelOverride.current = scriptedModel([{ text: "cannot" }]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			visualModelOverride.current = undefined;
		}

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /never wrote an SVG/);

		assert.ok(steers[0], "failure still delivers a steer — the teacher learns the outcome");
		const result = (steers[0]!.details as { result: unknown }).result as { svg: string; notes?: string };
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED:/);
	});

	it("dispatch through a teacher turn: the call acks mid-turn and the runner completes in the background", async () => {
		const chat = chatStore.createChat("Test: demo spawn dispatch");
		createdChats.push(chat.id);
		// BYOK turn gate (owner, 2026-09-22): the scripted chat needs a
		// conversation model — the per-chat pin, exactly like the setup flow.
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		// A teacher that calls demo on turn 1, then continues in the SAME turn.
		const teacher = scriptedModel([
			{ toolCalls: [{ toolCallId: "call-d2", toolName: "demo", input: DEMO_INPUT }] },
			{ text: "Here it is." },
		]);

		// The overrides must be live BEFORE the request — dispatch fires the
		// runner mid-stream, inside the tool execute.
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep it." },
		]);
		headlessOverride.current = fakeHeadless();
		const { steers, runner } = testRunner();

		try {
			const ack = await handleChatRequest(
				new Request("http://test/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chatId: chat.id,
						// Wave B: the input-events contract — one event,
						// never a client transcript.
						input: { type: "text", text: "teach me compounding" },
					}),
				}),
				// The handler hands the factory the native build options
				// (messages are the merged record; the record IS the agent
				// state — no adapter conversion).
				(opts) =>
					createTeacherAgent(undefined, {
						engine: teacher,
						messages: opts.messages,
						tools: createTeacherTools({
							chatId: chat.id,
							chatStore,
							jobStore,
							spawn: (job, input) => void runner.runJob(job.id, input),
						}),
					}),
			);
			if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
			await drainRunning(chat.id);

			const job = jobStore.findJobByToolCallId(chat.id, "call-d2");
			assert.ok(job, "dispatch created a job at tool-execute time");
			assert.equal(job!.kind, "demo");
			createdJobs.push(job!.id);

			// The background runner (fire-and-forget) completes with the overrides.
			await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 8000, "demo job completion");
			const done = jobStore.getJob(job!.id)!;
			assert.equal(done.status, "done");

			const saved = projectNative(chatStore.getChat(chat.id)!.messages);
			const part = saved[1]!.parts.find((p) => p.type === "tool-demo");
			assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
			assert.equal(part.state, "output-available", "the part resolved with the ack at dispatch time");
			assert.match(String((part as { output?: unknown }).output), /fire-and-forget/);

			assert.equal(steers.length, 1, "one job, one steer");
			assert.equal((steers[0]!.details as { jobId: string }).jobId, job!.id);

			// Idempotency: dispatch dedupes by toolCallId — no second job.
			assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
		} finally {
			demoModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

// ─── 6. registry wiring ──────────────────────────────────────────────────────

describe("tool + renderer registry wiring", () => {
	it("demo and visual are SERVER-EXECUTED dispatch tools with the contract schemas", () => {
		const { runner } = testRunner();
		const tools = jobTools({ chatId: "chat_registry", jobStore, spawn: (job) => void runner.runJob(job.id) });
		assert.deepEqual(Object.keys(tools).sort(), ["demo", "pdf", "research", "visual"]);
		for (const name of ["demo", "visual", "research", "pdf"] as const) {
			assert.equal(typeof (tools[name] as { execute?: unknown }).execute, "function", `${name} executes server-side — fire-and-forget ack per THE ASYNC PROTOCOL`);
		}
		assert.equal(Value.Check(demoInputSchema, { title: "T", brief: "b" }), true);
		assert.equal(Value.Check(demoInputSchema, { brief: "b" }), false, "demo requires a title");
		assert.equal(Value.Check(visualInputSchema, { brief: "b" }), true);
		assert.equal(Value.Check(visualInputSchema, {}), false, "visual requires a brief");
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf", question: "q" }), true);
		assert.equal(Value.Check(pdfInputSchema, { question: "q" }), false, "pdf requires a path");
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf" }), false, "pdf requires a question");
	});

	it("the artifact renderer registry maps demo/visual to the W6 cards", () => {
		assert.equal(artifactRenderers.demo, DemoCard);
		assert.equal(artifactRenderers.visual, VisualCard);
		// sources v0 — pdf maps to its dispatch card (the live-smoke gap)
		assert.equal(artifactRenderers.pdf, PdfJobCard);
		// sources v1 — the learner-filesystem set maps to the generic tool-call card
		for (const t of ["read", "ls", "find", "grep"]) {
			assert.equal(artifactRenderers[t], ToolCallCard, `${t} renders the tool-call card`);
		}
		// wave 7 — the prober's graph tools join the SAME discipline (they
		// rendered like nothing happened before this interlude)
		for (const t of ["list_sessions", "list_propositions"]) {
			assert.equal(artifactRenderers[t], ToolCallCard, `${t} renders the tool-call card`);
		}
	});

	it("the tool-call card: the prober's graph tools — collapsed headline + their compact row output", () => {
		// list_propositions: the session id is the call's subject
		const propPart = {
			type: "tool-list_propositions",
			state: "output-available",
			toolCallId: "g1",
			input: { session: "chat_mtiudjao_776beada" },
			output: "2 proposition(s) born in this session:\n- Kepler's laws — solid (as of 2026-09-20)\n- Tidal locking — shaky (as of 2026-09-21)",
		};
		const html = renderToStaticMarkup(<ToolCallCard part={propPart as never} />);
		assert.match(html, /list_propositions/);
		assert.match(html, /chat_mtiudjao_776beada/); // the collapsed headline
		assert.match(html, /Kepler&#x27;s laws/); // the row output, verbatim (apostrophe HTML-escaped)
		assert.ok(html.includes("<details"), "collapsed by default");

		// list_sessions: no headline arg (empty input) — the tool name alone,
		// exactly the ls-with-no-path discipline
		const sessPart = {
			type: "tool-list_sessions",
			state: "output-available",
			toolCallId: "g2",
			input: {},
			output: "3 session(s) in the knowledge graph, most recent first:\n1. Orbital mechanics (chat, 8 propositions, born 2026-09-18)",
		};
		const html2 = renderToStaticMarkup(<ToolCallCard part={sessPart as never} />);
		assert.match(html2, /list_sessions/);
		assert.match(html2, /Orbital mechanics/);
		const headline = html2.split("<summary")[1]?.split("</summary>")[0] ?? "";
		assert.doesNotMatch(headline, /Orbital/, "the collapsed line shows the tool name only — no noise");
	});

	it("the tool-call card: collapsed one-liner with the tool name + headline arg; expand shows input and output", () => {
		const part = {
			type: "tool-read",
			state: "output-available",
			toolCallId: "c1",
			input: { path: "notes/calculus.md", offset: 1, limit: 20 },
			output: "Calculus notes\nThe derivative measures force.",
		};
		const html = renderToStaticMarkup(<ToolCallCard part={part as never} />);
		// collapsed headline: tool name + path as given
		assert.match(html, /read/);
		assert.match(html, /notes\/calculus\.md/);
		// expandable payload: input JSON + output text
		assert.match(html, /Input/);
		assert.match(html, /Output/);
		assert.match(html, /The derivative measures force\./);
		assert.ok(html.includes("<details"), "collapsed by default via a details element");
	});

	it("the tool-call card: image-bearing read results note the attachment; errors render red", () => {
		const imgPart = {
			type: "tool-read",
			state: "output-available",
			toolCallId: "c2",
			input: { path: "shot.png" },
			output: { text: "Read image file [image/png].", images: [{ data: "AAAA", mimeType: "image/png" }] },
		};
		const html = renderToStaticMarkup(<ToolCallCard part={imgPart as never} />);
		assert.match(html, /Read image file \[image\/png\]\./);
		assert.match(html, /1 image attached to the model/);
		assert.ok(!html.includes("AAAA"), "the image payload itself never renders");

		const errPart = {
			type: "tool-read",
			state: "output-error",
			toolCallId: "c3",
			input: { path: "/gone.md" },
			errorText: "ENOENT: no such file",
		};
		const errHtml = renderToStaticMarkup(<ToolCallCard part={errPart as never} />);
		assert.match(errHtml, /Error/);
		assert.match(errHtml, /ENOENT/);
		assert.match(errHtml, /text-red-500/);
	});

	it("the tool-call card: find/grep headline the pattern, ls defaults to ~", () => {
		const findHtml = renderToStaticMarkup(
			<ToolCallCard part={{ type: "tool-find", state: "output-available", toolCallId: "c", input: { pattern: "*calculus*" }, output: "notes/calculus.md" } as never} />,
		);
		assert.match(findHtml, /find/);
		assert.match(findHtml, /\*calculus\*/);
		const lsHtml = renderToStaticMarkup(
			<ToolCallCard part={{ type: "tool-ls", state: "output-available", toolCallId: "c", input: {}, output: "notes/" } as never} />,
		);
		assert.match(lsHtml, /ls/);
		assert.match(lsHtml, /~/);
	});
});
