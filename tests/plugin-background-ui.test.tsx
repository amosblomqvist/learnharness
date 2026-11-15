import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { pluginBackgroundPart } from "../components/artifacts/plugin-worker-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ToolPartRenderer } from "../components/plugin-renderers.tsx";
import { PluginWorkerResultSurface } from "../components/plugin-worker-result.tsx";
import { ActivitySection, toBlobs, type FeedJob } from "../components/activity-dock.tsx";
import { buildAbortSteer, buildSubagentSteer, projectView, type LhMarkerMessage, type LhViewPart, type PluginBackgroundResult } from "../src/core/index.ts";

const result: PluginBackgroundResult = {
	pluginId: "uninstalled-proof", toolName: "check_sources", input: { topic: "original accepted input" },
	text: "The persisted plugin background answer.",
	outcome: { id: "task-1", status: "succeeded", result: { verified: "raw authoritative worker result" } },
};
const job: FeedJob = {
	id: "plugin-job", kind: "plugin", chatId: "session-1", toolCallId: "original-call", status: "running", activity: "",
	createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z", title: "Session topic", contextLimit: null,
	plugin: { pluginId: result.pluginId, toolName: result.toolName, workerId: "worker-1", requestId: "request-1", taskId: "task-1", label: "Source checker" },
};

describe("persisted plugin worker result UI without an active plugin", () => {
	it("builds a synthetic tool part with original identity/input and no fabricated native result", () => {
		const part = pluginBackgroundPart(result, job.toolCallId);
		assert.equal(part.type, "tool-check_sources"); assert.equal(part.toolCallId, "original-call");
		assert.equal(part.input, result.input); assert.equal(part.output, result.outcome);
		assert.equal(part.state, "output-available"); assert.equal(Object.hasOwn(part, "result"), false);
		assert.deepEqual(part.background, { pluginId: result.pluginId, taskId: "task-1", status: "succeeded" });
		for (const data of [null, false, 0, ""]) assert.equal(pluginBackgroundPart({ ...result, data }, job.toolCallId).output, data);
	});

	it("projects the real persisted marker and retains text, raw outcome, original input, and explicit null data", () => {
		const marker = buildSubagentSteer(job, { ...result, data: null, formatError: "formatter was removed" });
		const message = projectView([marker])[0]!;
		const html = renderToStaticMarkup(<SubagentSteerCard message={message} />);
		assert.doesNotMatch(html, /Background result/); assert.match(html, /check_sources/); assert.match(html, /class="sr-only"> succeeded/);
		assert.match(html, /The persisted plugin background answer/); assert.match(html, /raw authoritative worker result/);
		assert.match(html, /original accepted input/); assert.match(html, /&quot;data&quot;: null/);
		assert.match(html, /role="alert"/); assert.match(html, /formatter was removed/);
		assert.doesNotMatch(html, /Demo|PDF|Research|Figure/);
	});

	it("renders failed/cancelled/interrupted outcomes honestly and keeps raw failures accessible", () => {
		for (const status of ["failed", "cancelled", "interrupted"] as const) {
			const failed: PluginBackgroundResult = { ...result, outcome: { id: "task-1", status, error: { code: "run_error", message: "Readable worker failure" } } };
			const part = pluginBackgroundPart(failed, job.toolCallId);
			assert.equal(part.state, "output-error"); assert.equal(part.errorText, "Readable worker failure");
			const html = renderToStaticMarkup(<SubagentSteerCard message={projectView([buildSubagentSteer(job, failed)])[0]!} />);
			assert.match(html, new RegExp(status)); assert.match(html, /Readable worker failure/);
			assert.match(html, /The persisted plugin background answer/);
		}
	});

	it("distinguishes missing/unreadable task delivery failures from learner aborts without inventing task outcomes", () => {
		for (const failure of ["Worker task record is missing", "Worker task record could not be read"]) {
			const marker: LhMarkerMessage = {
				id: `steer_${job.id}`, role: "custom", customType: "subagent-abort", display: true,
				content: failure, timestamp: 1,
				details: { jobId: job.id, kind: "plugin", toolCallId: job.toolCallId, failure },
			};
			const message = projectView([marker])[0]!;
			const abort = message.parts.find(part => part.type === "data-subagent-aborted")!;
			assert.deepEqual(abort.data, marker.details);
			const html = renderToStaticMarkup(<SubagentSteerCard message={message} />);
			assert.match(html, /job-delivery-failure/); assert.match(html, /role="alert"/);
			assert.match(html, /Background job recovery\/delivery failed/); assert.ok(html.includes(failure));
			assert.doesNotMatch(html, /aborted by the learner|job-aborted-badge|plugin-worker-card|Background result/);
			assert.equal(message.parts.some(part => part.type === "data-subagent-artifact" || part.type.startsWith("tool-")), false);
		}
	});

	it("keeps the existing learner-abort marker presentation for plugin jobs", () => {
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectView([buildAbortSteer(job)])[0]!} />);
		assert.match(html, /job-aborted-badge/); assert.match(html, /plugin/); assert.match(html, /aborted by the learner/);
	});
});

describe("default plugin worker transcript presentation", () => {
	const ack = {
		type: "tool-check_sources", toolCallId: job.toolCallId, state: "output-available" as const,
		input: result.input, result: { content: [{ type: "text" as const, text: "Accepted; keep teaching" }], details: { jobId: job.id, dispatched: true }, isError: false },
	};

	it("uses native dispatch from ACK details before the job feed arrives", () => {
		const html = renderToStaticMarkup(<ToolPartRenderer part={ack} />);
		assert.match(html, /dispatch-card/); assert.match(html, /Plugin worker/); assert.match(html, /Dispatched/);
		assert.doesNotMatch(html, /tool-call-card|Accepted; keep teaching|Task details/);
	});

	it("matches plugin jobs by original toolCallId and reuses active/settled dispatch", () => {
		for (const status of ["running", "done", "error"] as const) {
			const html = renderToStaticMarkup(<JobsContext.Provider value={[{ ...job, status, activity: "Checking sources" }]}><ToolPartRenderer part={{ ...ack, result: undefined }} /></JobsContext.Provider>);
			assert.match(html, /Source checker/); assert.doesNotMatch(html, /tool-call-card/);
			assert.match(html, status === "running" ? /Checking sources/ : status === "done" ? /finished/ : /failed/);
		}
		const unrelated = renderToStaticMarkup(<JobsContext.Provider value={[{ ...job, toolCallId: "another-call" }]}><ToolPartRenderer part={{ ...ack, result: undefined }} /></JobsContext.Provider>);
		assert.match(unrelated, /tool-call-card/); assert.doesNotMatch(unrelated, /dispatch-card/);
	});

	it("keeps ordinary sync tools and unsuccessful/non-ACK details generic", () => {
		const fixtures: Array<NonNullable<LhViewPart["result"]>["details"]> = [undefined, null, { answer: 42 }, { jobId: job.id }, { dispatched: true }, { jobId: 12, dispatched: true }, { jobId: job.id, dispatched: false }];
		for (const details of fixtures) {
			const html = renderToStaticMarkup(<ToolPartRenderer part={{ ...ack, result: { ...ack.result, details } }} />);
			assert.match(html, /tool-call-card/); assert.match(html, /Accepted; keep teaching|answer|jobId|dispatched/);
			assert.doesNotMatch(html, /dispatch-card/);
		}
		const failure = renderToStaticMarkup(<ToolPartRenderer part={{ ...ack, state: "output-error", result: { ...ack.result, isError: true } }} />);
		assert.match(failure, /tool-call-card/); assert.doesNotMatch(failure, /dispatch-card/);
	});

	it("defaults persisted results to shared collapsed grammar, readable markdown, and raw details", () => {
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectView([buildSubagentSteer(job, { ...result, text: "A **verified** answer." })])[0]!} />);
		assert.match(html, /<details[^>]*data-testid="plugin-worker-result"/);
		assert.doesNotMatch(html, /<details[^>]*data-testid="plugin-worker-result"[^>]*\sopen[\s=>]/);
		assert.match(html, /<strong[^>]*>verified<\/strong>/); assert.match(html, /lucide-chevron-right/);
		assert.doesNotMatch(html, /view result|hide result/);
		assert.match(html, /Task details/); assert.match(html, /raw authoritative worker result/);
		assert.doesNotMatch(html, /plugin-worker-result-card|dispatch-card/);
	});

	it("offers a reusable bordered result option without changing the default or nesting custom bodies", () => {
		const collapsed = renderToStaticMarkup(<PluginWorkerResultSurface label="Checker" status="succeeded" text="**Readable** fallback" />);
		assert.match(collapsed, /<details/); assert.match(collapsed, /<strong[^>]*>Readable<\/strong>/);
		const card = renderToStaticMarkup(<PluginWorkerResultSurface label="Checker" status="interrupted" text="replaced" presentation="card"><svg data-testid="rich-result" /></PluginWorkerResultSurface>);
		assert.match(card, /plugin-worker-result-card/); assert.match(card, /rounded-xl border bg-card p-4/);
		assert.match(card, /Checker/); assert.match(card, /interrupted/); assert.match(card, /rich-result/);
		assert.doesNotMatch(card, /<details|replaced/);
		const plain = renderToStaticMarkup(<PluginWorkerResultSurface label="Figure checker" status="succeeded" text="replaced" presentation="plain"><svg data-testid="unframed-result" /></PluginWorkerResultSurface>);
		assert.match(plain, /plugin-worker-result-plain/); assert.match(plain, /Figure checker/); assert.match(plain, /succeeded/);
		assert.match(plain, /unframed-result/); assert.doesNotMatch(plain, /<details|rounded-xl|bg-card|replaced/);
	});
});

describe("plugin background job labels", () => {
	it("uses the plugin label as the dock title with a generic plugin worker kind/icon", () => {
		const feed = { jobs: [job], extractions: [] };
		assert.equal(toBlobs(feed)[0]!.title, "Source checker");
		const html = renderToStaticMarkup(<ActivitySection feed={feed} />);
		assert.match(html, /Source checker/); assert.match(html, /Plugin worker/); assert.match(html, /lucide-bot/);
		assert.match(html, /End Plugin worker in Source checker/);
		assert.doesNotMatch(html, /Researcher|Demo builder|Figure maker|PDF reader/);
		assert.equal(toBlobs({ jobs: [{ ...job, plugin: { ...job.plugin!, label: undefined } }], extractions: [] })[0]!.title, "check_sources");
		assert.equal(toBlobs({ jobs: [{ ...job, plugin: undefined }], extractions: [] })[0]!.title, "Plugin worker");
	});

	it("extends the dispatch label map without assuming a built-in worker shape", () => {
		const pending = renderToStaticMarkup(<DispatchCard kind="plugin" toolCallId="original-call" />);
		assert.match(pending, /Plugin worker/); assert.match(pending, /Dispatched/);
		const active = renderToStaticMarkup(<JobsContext.Provider value={[job]}><DispatchCard kind="plugin" toolCallId="original-call" /></JobsContext.Provider>);
		assert.match(active, /Source checker/);
		for (const status of ["pending", "delivered"] as const) {
			const done = renderToStaticMarkup(<JobsContext.Provider value={[{ ...job, status: "done", result, delivery: { kind: "result", status } }]}><DispatchCard kind="plugin" toolCallId="original-call" /></JobsContext.Provider>);
			assert.match(done, /Source checker/); assert.match(done, /finished/);
			assert.doesNotMatch(done, /delivered|dispatch-card/);
		}
	});
});
