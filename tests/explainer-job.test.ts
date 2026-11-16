import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import { createJobRunner, demoModelOverride } from "../src/agent/subagents/runner.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { ExplainerResult, SteerMessage } from "../src/core/contracts.ts";
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

function page(body: string): string {
	return `<!doctype html><html data-register="instrument"><head><title>Test</title><link rel="stylesheet" href="kit.css" data-ve-kit></head><body><main><h1>${body}</h1></main></body></html>`;
}

async function run(turns?: Parameters<typeof scriptedModel>[0]) {
	const chat = chatStore.createChat("Explainer test");
	chats.push(chat.id);
	const job = jobStore.createJob({ kind: "explainer", chatId: chat.id, toolCallId: "explainer-call" });
	jobs.push(job.id);
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({ chatStore, jobStore, deliver: async (steer) => { steers.push(steer); } });
	demoModelOverride.current = turns ? scriptedModel(turns) : undefined;
	try { await runner.runJob(job.id, { title: "My title", brief: "Explain this" }); }
	finally { demoModelOverride.current = undefined; }
	assert.equal(steers.length, 1);
	const details = steers[0]!.details as { kind: string; result: ExplainerResult };
	assert.equal(details.kind, "explainer");
	assert.equal(details.result.title, "My title");
	return { result: details.result, job: jobStore.getJob(job.id)! };
}

it("renders and delivers the explainer and notes", async () => {
	const { result, job } = await run([
		{ name: "write_explainer", input: { source: page("First page") } },
		{ name: "render_explainer", input: {} },
		{ text: "Notes for the teacher." },
	]);
	assert.match(result.html, /<style data-ve-kit>/);
	assert.doesNotMatch(result.html, /fonts\.googleapis\.com/);
	assert.equal(result.notes, "Notes for the teacher.");
	assert.equal(job.status, "done");
});

it("fails when final verification cannot render the source", async () => {
	const { result, job } = await run([{ name: "write_explainer", input: { source: page("<ve-ask></ve-ask>") } }, { text: "Done" }]);
	assert.equal(result.html, "");
	assert.match(result.notes!, /^FAILED:/);
	assert.equal(job.status, "error");
});

it("refuses with an explainer failure when no engine is available", async () => {
	const { result, job } = await run();
	assert.equal(result.html, "");
	assert.match(result.notes!, /^FAILED:/);
	assert.equal(job.status, "error");
});

it("renders the last source when it changed after rendering", async () => {
	const { result, job } = await run([
		{ name: "write_explainer", input: { source: page("Old content") } },
		{ name: "render_explainer", input: {} },
		{ name: "write_explainer", input: { source: page("New content") } },
		{ text: "Updated." },
	]);
	assert.match(result.html, /New content/);
	assert.doesNotMatch(result.html, /Old content/);
	assert.equal(job.status, "done");
});
