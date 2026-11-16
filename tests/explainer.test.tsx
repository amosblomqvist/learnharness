import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import type { PiEngine } from "../src/agent/models.ts";
import { createJobRunner, demoModelOverride } from "../src/agent/subagents/runner.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { isSubagentFailure, type SteerMessage } from "../src/core/contracts.ts";
import { projectView } from "../src/core/view.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

const chats: string[] = [];
const jobs: string[] = [];
after(() => {
	for (const id of chats) { try { fs.unlinkSync(path.join(PATHS.chats, `${id}.json`)); } catch {} }
	for (const id of jobs) { try { fs.unlinkSync(path.join(PATHS.data, "jobs", `${id}.json`)); } catch {} }
	demoModelOverride.current = undefined;
});

function scriptedModel(turns: Array<{ name?: string; input?: unknown; text?: string }>): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(turns.map((turn, index) => turn.name
		? fauxAssistantMessage([fauxToolCall(turn.name, turn.input as ToolCall["arguments"], { id: `call-${index}` })], { stopReason: "toolUse" })
		: fauxAssistantMessage(turn.text ?? "")));
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function testRunner() {
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({ chatStore, jobStore, deliver: async (steer) => {
		steers.push(steer);
		const job = jobStore.getJob((steer.details as { jobId: string }).jobId);
		if (job && job.status === "running") {
			const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
			jobStore.updateJob(job.id, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
		}
	} });
	return { steers, runner };
}

async function dispatch(turns: Parameters<typeof scriptedModel>[0]) {
	const chat = chatStore.createChat("Explainer dispatch test");
	chats.push(chat.id);
	const { steers, runner } = testRunner();
	let running: Promise<void> | undefined;
	demoModelOverride.current = scriptedModel(turns);
	const tools = jobTools({ chatId: chat.id, jobStore, spawn: (job, input) => {
		jobs.push(job.id);
		running = runner.runJob(job.id, input);
	} });
	try {
		const input = { title: "Test page", brief: "Explain the concept" };
		const ack = await tools.explainer!.execute("explainer-call", input);
		assert.match(JSON.stringify(ack), /Dispatched \(job /);
		assert.equal(steers.length, 0, "ack arrives before the background job completes");
		const duplicate = await tools.explainer!.execute("explainer-call", input);
		assert.deepEqual(duplicate, ack);
		const records = jobStore.listJobs(chat.id);
		assert.equal(records.length, 1);
		assert.equal(records[0]!.kind, "explainer");
		assert.ok(running);
		await running;
		assert.equal(steers.length, 1);
		const steer = steers[0]!;
		const view = projectView([steer])[0]!;
		const artifact = view.parts.find((part) => part.type === "data-subagent-artifact") as { data: { kind: string } } | undefined;
		assert.equal(artifact?.data.kind, "explainer");
		return { steer, html: renderToStaticMarkup(<SubagentSteerCard message={view as never} />) };
	} finally {
		if (running) await running;
		demoModelOverride.current = undefined;
	}
}

it("dispatches once and delivers the rendered explainer to the lesson", async () => {
	const source = '<!doctype html><html data-register="instrument"><head><title>Test</title><link rel="stylesheet" href="kit.css" data-ve-kit></head><body><main><h1>Concept page</h1></main></body></html>';
	const { steer, html } = await dispatch([
		{ name: "write_explainer", input: { source } },
		{ name: "render_explainer", input: {} },
		{ text: "Teacher notes." },
	]);
	assert.match(steer.content, /written and rendered in the lesson/);
	assert.match(html, /<iframe/);
	assert.match(html, /sandbox="allow-scripts"/);
	assert.doesNotMatch(html, /allow-same-origin|fonts\.googleapis\.com/);
	assert.match(html, /srcDoc=/i);
	assert.match(html, /Concept page/);
});

it("delivers a failure card when the writer never writes a page", async () => {
	const { steer, html } = await dispatch([{ text: "Cannot write a page." }]);
	assert.match(steer.content, /explainer.*could not be made/i);
	assert.match(html, /FAILED:/);
	assert.doesNotMatch(html, /<iframe/);
});

it("delivers the renderer error in a failure card", async () => {
	const source = '<!doctype html><html><body><ve-ask id="question"></ve-ask></body></html>';
	const { steer, html } = await dispatch([
		{ name: "write_explainer", input: { source } },
		{ name: "render_explainer", input: {} },
		{ text: "Could not render the page." },
	]);
	assert.match(steer.content, /explainer.*could not be made/i);
	assert.match(html, /FAILED:.*(?:&lt;|&#x3C;)ve-ask(?:&gt;|&#x3E;) is not supported/i);
	assert.doesNotMatch(html, /<iframe/);
});

it("filters the teacher tool and never exposes it to the prober", () => {
	const ctx = { chatId: "registry", chatStore, jobStore, spawn: () => {}, deliver: () => {} };
	assert.ok(!("explainer" in createTeacherTools(ctx, { explainer: false })));
	assert.ok(!("explainer" in createProberTools(ctx)));
});
