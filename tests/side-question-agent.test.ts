import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { runSideQuestion, sideQuestionSystemPrompt, sideQuestionTools, TUTOR_NOTE_TOOL } from "../src/agent/subagents/side-question.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { AUTH_FILE, PATHS } from "../config.ts";

function scripted(steps: FauxResponseStep[], modelId?: string): { engine: PiEngine; seen: string[][] } {
	const seen: string[][] = [];
	const faux = createFauxCore(modelId ? { models: [{ id: modelId }] } : {});
	faux.setResponses(steps.map((step) => (context, ...rest) => {
		seen.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
		return typeof step === "function" ? step(context, ...rest) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

async function run(engine: PiEngine) {
	const deltas: string[] = [];
	const tools: Array<[string, string]> = [];
	const result = await runSideQuestion({
		engine, userMessage: "<tutor_transcript>\n\n</tutor_transcript>\n\nLearner: why?", chatId: "chat_agent",
		onText: (d) => deltas.push(d), onTool: (n, l) => tools.push([n, l]),
	});
	return { result, deltas, tools };
}

describe("runSideQuestion", () => {
	it("streams the answer in order, ends on tutor_note, and never streams the note", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxText("Because the inner function changes too."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: true, note: "SECRET-NOTE unsure about the chain rule." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must never run"),
		]);
		const { result, deltas } = await run(engine);
		assert.equal(deltas.join(""), "Because the inner function changes too.");
		assert.ok(!deltas.join("").includes("SECRET-NOTE"));
		assert.equal(result.answer, "Because the inner function changes too.");
		assert.deepEqual(result.note, { tell: true, note: "SECRET-NOTE unsure about the chain rule." });
		assert.equal(result.usage.length, 1, "the run stopped after the note");
	});

	it("reports file tools and joins the answer across model calls", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("ls", { path: "/definitely/missing/dir" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("It isn't there."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: false, note: "n" })], { stopReason: "toolUse" }),
		]);
		const { result, deltas, tools } = await run(engine);
		assert.deepEqual(tools, [["ls", "/definitely/missing/dir"]]);
		assert.equal(result.answer, "Let me look.\n\nIt isn't there.");
		assert.equal(deltas.join(""), result.answer);
	});

	it("returns a null note when the agent never calls tutor_note", async () => {
		const { engine } = scripted([fauxAssistantMessage("Just an answer.")]);
		const { result } = await run(engine);
		assert.equal(result.answer, "Just an answer.");
		assert.equal(result.note, null);
	});

	it("limits the tools to the read-only file tools and the note, plus send_to_user on Claude", async () => {
		assert.deepEqual(sideQuestionTools(scripted([]).engine).map((t) => t.name), ["read", "ls", "find", "grep", TUTOR_NOTE_TOOL]);
		assert.deepEqual(sideQuestionTools(scripted([], "claude-sonnet-x").engine).map((t) => t.name), ["read", "ls", "find", "grep", TUTOR_NOTE_TOOL, "send_to_user"]);
	});

	it("streams send_to_user prose as the answer on Claude models", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("send_to_user", { message: "Delivered answer." }), fauxToolCall(TUTOR_NOTE_TOOL, { tell: false, note: "n" })], { stopReason: "toolUse" }),
		], "claude-sonnet-x");
		const { result, deltas } = await run(engine);
		assert.equal(result.answer, "Delivered answer.");
		assert.equal(deltas.join(""), "Delivered answer.");
	});

	it("loads the system prompt with the tutor_note contract", () => {
		assert.match(sideQuestionSystemPrompt(), /^You answer side questions/);
		assert.match(sideQuestionSystemPrompt(), /call tutor_note exactly once/);
	});

	it("refuses the app's own data and auth file to the file tools (the answer key lives there)", async () => {
		const tools = sideQuestionTools(scripted([]).engine);
		const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute("call", args as never);
		for (const [name, args] of [
			["read", { path: `${PATHS.chats}/chat_x.json` }],
			["ls", { path: PATHS.data }],
			["grep", { pattern: "correctAnswer", path: PATHS.chats }],
			["find", { pattern: "*.json", path: PATHS.data }],
			["read", { path: AUTH_FILE }],
		] as const) {
			// The shared file-tool protection (v0.5.0) refuses the auth file first.
			await assert.rejects(() => run(name, args), /app's own data|protected location/, `${name} ${JSON.stringify(args)}`);
		}
		await assert.doesNotReject(() => run("ls", { path: "/definitely/missing/dir" }).catch((err: Error) => {
			if (/app's own data/.test(err.message)) throw err;
		}));
	});
});
