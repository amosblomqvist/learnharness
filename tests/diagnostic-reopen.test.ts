import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createProberAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { resumeProbeTool } from "../src/agent/tools/resume-probe.ts";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import { hasProbeDone, type LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3, phaseAt3Lh } from "../src/core/phases.ts";
import { projectView } from "../src/core/view.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";
import type { SteerMessage } from "../src/core/contracts.ts";

const created: string[] = [];
after(() => { for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true }); });
function call(id: string, name: string, args = {}): LhMessage {
	return { id, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse", timestamp: 1 } as LhMessage;
}
function result(id: string, tool: string, isError = false, details = { ok: true }): LhMessage {
	return { id: `${id}-result`, role: "toolResult", toolCallId: id, toolName: tool,
		content: [{ type: "text", text: "ok" }], details, isError, timestamp: 2 };
}
const done = [call("done", "probe_done"), result("done", "probe_done")];
const teaching = [...done, call("quiz", "quiz", { nodeId: "foundation" })];

test("a successful reopening preserves history and resets both phase folds and agent selection after reload", async () => {
	const chat = chatStore.createChat("Diagnostic regression"); created.push(chat.id);
	chatStore.saveMessages(chat.id, teaching);
	chatStore.saveTree(chat.id, { nodes: [{ id: "foundation", title: "Foundation" }], edges: [], version: 1 });
	const wakes: SteerMessage[] = [];
	const tool = resumeProbeTool({ chatId: chat.id, chatStore, deliver: (s) => wakes.push(s) }).resume_probe!;
	const ack = await tool.execute("resume", {});
	assert.equal(ack.terminate, true);
	assert.equal(wakes.length, 1);
	assert.equal(wakes[0]!.customType, "probe-handoff", "the existing idle-only handoff path rebuilds the agent");
	assert.match(wakes[0]!.content, /Resume probing/);
	const history = [...teaching, call("resume", "resume_probe"), result("resume", "resume_probe"), wakes[0]!];
	chatStore.saveMessages(chat.id, history);
	const reloaded = chatStore.getChat(chat.id)!;
	assert.deepEqual(reloaded.messages.slice(0, teaching.length), teaching);
	assert.equal(reloaded.tree?.nodes[0]?.id, "foundation");
	assert.equal(hasProbeDone(reloaded.messages), false);
	assert.equal(phaseAt3Lh(reloaded.messages), "probe");
	assert.equal(phaseAt3(projectView(reloaded.messages)), "probe");
	const delivered: SteerMessage[] = [];
	const conclude = probeDoneTool({ chatId: chat.id, chatStore, deliver: (s) => delivered.push(s) }).probe_done!;
	const assessment = { assessment: { strands: [{ strand: "foundation", assessment: "More diagnostic evidence" }], summary: "Revised" } };
	await conclude.execute("new-done", assessment);
	assert.equal(delivered.length, 1, "the dedicated prober may conclude again");
	assert.notEqual(delivered[0]!.id, `steer_probe_${chat.id}`, "the old wake cannot suppress the new cycle");
	const replanned = [...history, call("new-done", "probe_done"), result("new-done", "probe_done")];
	assert.equal(hasProbeDone(replanned), true);
	assert.equal(phaseAt3Lh(replanned), "plan");
	assert.equal(phaseAt3(projectView(replanned)), "plan");
});

for (const isError of [true, false]) {
	test(`a refused reopening (isError=${isError}) cannot reset a concluded probe`, () => {
		const messages = [...done, call("bad", "resume_probe"), result("bad", "resume_probe", isError, { ok: false })];
		assert.equal(hasProbeDone(messages), true);
		assert.equal(phaseAt3Lh(messages), "plan");
		assert.equal(phaseAt3(projectView(messages)), "plan");
	});
}

test("actual teacher run stops at reopening; rebuilt prober has diagnostic tools", async () => {
	const chat = chatStore.createChat("Diagnostic agent boundary"); created.push(chat.id);
	chatStore.saveMessages(chat.id, done);
	const faux = createFauxCore({});
	let requests = 0;
	faux.setResponses([() => { requests++; return fauxAssistantMessage([fauxToolCall("resume_probe", {}, { id: "resume-agent" })], { stopReason: "toolUse" }); },
		() => { requests++; return fauxAssistantMessage("Should not run in teacher"); }]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const delivered: SteerMessage[] = [];
	const agent = createTeacherAgent({ chatId: chat.id, chatStore, jobStore, spawn: () => {}, deliver: (s) => delivered.push(s) },
		{ engine, messages: done });
	await agent.prompt("Continue the diagnostic instead of teaching.");
	assert.equal(requests, 1, "teacher cannot continue teaching after the successful handoff");
	assert.equal(delivered.length, 1);
	const history = agent.state.messages.map((m, i) => ({ ...m, id: `persisted-${i}` })) as LhMessage[];
	assert.equal(hasProbeDone(history), false);
	const prober = createProberAgent({ chatId: chat.id, chatStore, jobStore, spawn: () => {}, deliver: () => {} }, { engine, messages: history });
	assert.ok(prober.state.tools.some((t) => t.name === "probe"));
	assert.equal(prober.state.tools.some((t) => t.name === "quiz"), false);
});

test("reopening is always available and blocks a later teaching pose in the same tool batch", async () => {
	const { createTeacherTools } = await import("../src/agent/tools.ts");
	const chat = chatStore.createChat("Mixed batch diagnostic regression"); created.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "foundation", title: "Foundation" }], edges: [], version: 1 });
	const tools = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {}, deliver: () => {} }, { resume_probe: false });
	assert.ok(tools.resume_probe);
	await tools.resume_probe.execute("resume-batch", {});
	const quiz = await tools.quiz!.execute("quiz-after-resume", { question: "q", options: [{ label: "a" }, { label: "b" }],
		correctAnswer: "a", explanation: "a", type: "predict", nodeId: "foundation" });
	assert.equal(quiz.isError, true);
});
