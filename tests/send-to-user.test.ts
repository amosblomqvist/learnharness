/** Explicit Claude output: closed-network synthetic fixtures only. Native
 * history stays native; UI, extraction, and Markdown read the same prose. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// Set the data/auth seams BEFORE importing app modules. Do not read local
// keys, recordings, or learner sessions, even if a dev server is running.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-send-to-user-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { sendToUserTool } = await import("../src/agent/tools/send-to-user.ts");
const { createProberAgent, createTeacherAgent, createPracticeAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { SEND_TO_USER_TOOL, activeProblemOf, asAgentMessages, newUserMessage, sendToUserText, toLlmMessages, userFacingTextOf } = await import("../src/core/native-messages.ts");
const { coverageOf, messageFingerprint, messageViewLines, teacherProseBlocks } = await import("../src/core/coverage.ts");
const { projectView } = await import("../src/core/view.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { transcriptView } = await import("../src/agent/subagents/extraction.ts");
const { runSubagent } = await import("../src/agent/subagents/pi-run.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const { SessionModel } = await import("../components/session-core.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

function scripted(provider: string, id: string, steps: FauxResponseStep[] = []) {
	const faux = createFauxCore({ provider, models: [{ id }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}

const chatId = chatStore.createChat("Synthetic output gate").id;
const factories = {
	prober: (opts: AgentBuildOptions) => createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, opts),
	teacher: (opts: AgentBuildOptions) => createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, opts),
	practice: (opts: AgentBuildOptions) => createPracticeAgent({ chatId, chatStore }, opts),
};

function outputCall(message: string | number | null = "An explanation.", id = "send-1") {
	return { type: "toolCall" as const, id, name: SEND_TO_USER_TOOL, arguments: { message } };
}
function assistant(content: unknown[], id = "a1"): LhMessage {
	return { ...fauxAssistantMessage(""), content, id } as LhMessage;
}
function ack(callId = "send-1", isError = false): LhMessage {
	return {
		id: `result-${callId}`, role: "toolResult", toolCallId: callId, toolName: SEND_TO_USER_TOOL,
		content: [{ type: "text", text: isError ? "Invalid tool input" : "Message received for display." }],
		details: null, isError, timestamp: 1,
	};
}
function prose(messages: ReturnType<typeof projectView>): string[] {
	return messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text!));
}

describe("send_to_user model gate", () => {
	for (const [provider, id, enabled] of [
		["anthropic", "claude-opus-5-5", true],
		["anthropic", "claude-haiku-4-5-20251001", true],
		["openrouter", "anthropic/claude-opus-5.5", true],
		["openrouter", "anthropic/claude-sonnet-5.5", true],
		["amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0", true],
		["fixture", "CLAUDE-fixture", true],
		["claude-code", "opus", true],
		["claude-code", "sonnet", true],
		["claude-code", "haiku", true],
		["openrouter", "z-ai/glm-5.3-flash", false],
		["openai", "gpt-4o-mini", false],
		["anthropic", "opaque-alias", false],
	] as const) {
		it(`${provider}/${id}: ${enabled ? "includes" : "omits"} tool and description in all conversation agents`, () => {
			const { engine } = scripted(provider, id);
			for (const [kind, factory] of Object.entries(factories)) {
				const agent = factory({ engine });
				const output = agent.state.tools.find((tool) => tool.name === SEND_TO_USER_TOOL);
				assert.equal(Boolean(output), enabled, kind);
				if (enabled) {
					assert.equal(output!.description, sendToUserTool.description);
					assert.equal(typeof output!.prepareArguments, "function", "standard argument healing is wired");
				}
				assert.equal(agent.state.systemPrompt, composeInstructions(kind as keyof typeof factories));
				assert.ok(!agent.state.systemPrompt.includes(SEND_TO_USER_TOOL), "no added prompt instructions");
			}
		});
	}

	it("explicitly injected teacher/practice test registries remain unchanged", () => {
		const { engine } = scripted("anthropic", "claude-opus-5-5");
		for (const factory of [factories.teacher, factories.practice]) {
			assert.deepEqual(factory({ engine, tools: {} }).state.tools, []);
		}
	});

	it("background agents do not acquire a learner-output tool", async () => {
		let calls = 0;
		const { engine } = scripted("anthropic", "claude-opus-5-5", [(context) => {
			calls++;
			assert.ok(!context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((t) => t.name === SEND_TO_USER_TOOL)));
			return fauxAssistantMessage("Synthetic background result.");
		}]);
		await runSubagent([], { role: "researcher", engine, systemPrompt: "Synthetic fixture.", prompt: "Finish.", maxTurns: 2 });
		assert.equal(calls, 1);
	});
});

describe("send_to_user mechanics", () => {
	it("requires nonblank text and acknowledges without echoing or terminating", async () => {
		assert.equal(sendToUserTool.name, SEND_TO_USER_TOOL);
		for (const input of [{}, { message: "" }, { message: " \n\t" }, { message: 3 }, { message: null }]) {
			assert.equal(Value.Check(sendToUserTool.parameters, input), false);
		}
		const message = "**A full explanation**\n\n$$a = b$$";
		assert.equal(Value.Check(sendToUserTool.parameters, { message }), true);
		const result = await sendToUserTool.execute("send-1", { message });
		assert.ok(!result.isError);
		assert.ok(!result.terminate);
		assert.ok(!JSON.stringify(result).includes(message));
		assert.deepEqual(result.content, [{ type: "text", text: "Message received for display." }]);
	});

	it("only extracts the output tool's nonblank message, without modifying it", () => {
		const message = "  **Keep spacing and math** $x$\n";
		assert.equal(sendToUserText(outputCall(message)), message);
		for (const block of [null, {}, { type: "text", text: "ordinary" }, outputCall(2), outputCall("  "), { ...outputCall(), name: "other" }]) {
			assert.equal(sendToUserText(block), undefined);
		}
		assert.deepEqual(userFacingTextOf([null, fauxThinking("Not lesson prose."), fauxText("First"), outputCall(message), fauxToolCall("quiz", { question: "Q?" })]), ["First", message]);
	});
});

describe("send_to_user transcript projection", () => {
	it("renders in place as prose, with thinking unchanged and no tool/ack duplication", () => {
		const messages = [assistant([
			fauxText("Before."), outputCall("**The lesson.** $x = 1$"),
			fauxThinking("Private reasoning."), fauxToolCall("quiz", { question: "Q?" }, { id: "quiz-1" }),
			fauxText("After."),
		]), ack()];
		const before = structuredClone(messages);
		const view = projectView(messages);
		assert.deepEqual(view[0]!.parts.map((p) => p.type), ["step-start", "reasoning", "text", "text", "tool-quiz", "text"]);
		assert.deepEqual(prose(view), ["Before.", "**The lesson.** $x = 1$", "After."]);
		assert.equal(view[0]!.parts.find((p) => p.type === "reasoning")!.text, "Private reasoning.");
		assert.deepEqual(view[0]!.parts.filter((p) => p.type === "text").map((p) => p.id), ["a1-t0", "a1-t1", "a1-t2"]);
		assert.deepEqual(messages, before, "projection never rewrites native content");
		assert.deepEqual(projectView(JSON.parse(JSON.stringify(messages))), view, "reload is identical, without consulting a provider gate");
	});

	it("streams available arguments as replacing prose, never as a live tool card", () => {
		const live = { inFlight: true, streamingIds: new Set(["a1"]), executions: new Map() };
		for (const text of ["A", "A growing", "A growing explanation."]) {
			const view = projectView([assistant([outputCall(text)])], live);
			assert.deepEqual(prose(view), [text]);
			assert.ok(!view[0]!.parts.some((p) => p.type.startsWith("tool-")));
		}
		const empty = projectView([assistant([{ ...outputCall(), arguments: {} }])], live);
		assert.deepEqual(prose(empty), []);
		assert.ok(!empty[0]!.parts.some((p) => p.type.startsWith("tool-")));
	});

	it("malformed messages contain no prose; failures keep the existing error path live and after reload", () => {
		assert.deepEqual(prose(projectView([assistant([outputCall(3)])])), []);
		const messages = [assistant([outputCall("Incomplete teaching.")]), ack("send-1", true)];
		const settled = projectView(messages);
		assert.deepEqual(prose(settled), []);
		assert.equal(settled[0]!.parts[1]!.type, "tool-send_to_user");
		assert.equal(settled[0]!.parts[1]!.state, "output-error");
		const live = projectView(messages.slice(0, 1), {
			inFlight: true, streamingIds: new Set(["a1"]),
			executions: new Map([["send-1", { isError: true, errorText: "Invalid tool input" }]]),
		});
		assert.deepEqual(prose(live), []);
		assert.equal(live[0]!.parts[1]!.state, "output-error");
	});
});

describe("send_to_user extraction and Markdown", () => {
	it("selects output prose once and in order, preserving old fingerprints", () => {
		const message = assistant([fauxText("First."), outputCall("Second."), fauxThinking("Hidden."), outputCall("Third.", "send-2")]);
		const messages = [message, ack(), ack("send-2")];
		assert.deepEqual(messageViewLines(message, "a1"), ["TEACHER [a1] First.", "TEACHER [a1] Second.", "TEACHER [a1] Third."]);
		assert.deepEqual(teacherProseBlocks(messages), ["First.", "Second.", "Third."]);
		assert.equal(coverageOf(messages, [], "fixture").uncoveredCount, 1);
		const md = sessionMarkdown(messages, { anchors: false });
		assert.equal(md, "### Teacher\n\nFirst.\n\n### Teacher\n\nSecond.\n\n### Teacher\n\nThird.");
		const record = chatStore.createChat("Synthetic extraction");
		assert.equal(transcriptView({ ...record, messages }), "# Synthetic extraction\n\nTEACHER [a1] First.\n\nTEACHER [a1] Second.\n\nTEACHER [a1] Third.");
		const legacy = assistant([fauxText("Old text."), fauxThinking("Old thinking.")], "legacy");
		const oldFingerprint = createHash("sha256").update(JSON.stringify(["assistant", ["TEACHER [legacy] Old text."]])).digest("hex");
		assert.equal(messageFingerprint(legacy), oldFingerprint, "no re-extraction/migration of legacy prose");
	});

	it("does not extract/export failed output calls, including partial calls from truncated responses", () => {
		const message = assistant([fauxText("Keep this."), outputCall("Do not treat this as delivered.")]);
		const messages = [message, ack("send-1", true)];
		assert.deepEqual(teacherProseBlocks(messages), ["Keep this."]);
		assert.equal(sessionMarkdown(messages, { anchors: false }), "### Teacher\n\nKeep this.");
		const record = chatStore.createChat("Failed output fixture");
		assert.ok(!transcriptView({ ...record, messages }).includes("Do not treat"));
		const coverage = coverageOf([assistant([outputCall()]), ack("send-1", true)], [], "fixture");
		assert.equal(coverage.uncoveredCount, 0);
		assert.equal(coverage.uncoveredTokens, 0);
	});
});

describe("send_to_user interrupted generations", () => {
	for (const stopReason of ["error", "aborted"] as const) {
		it(`${stopReason} without a tool result never becomes delivered teaching; ordinary text stays unchanged`, () => {
			const message = { ...assistant([fauxText("Keep ordinary text."), outputCall("Unfinished output.")]), stopReason };
			const messages = [message];
			assert.deepEqual(prose(projectView(messages)), ["Keep ordinary text."]);
			assert.deepEqual(prose(projectView(JSON.parse(JSON.stringify(messages)))), ["Keep ordinary text."]);
			assert.deepEqual(messageViewLines(message, message.id), ["TEACHER [a1] Keep ordinary text."]);
			assert.deepEqual(teacherProseBlocks(messages), ["Keep ordinary text."]);
			assert.equal(sessionMarkdown(messages, { anchors: false }), "### Teacher\n\nKeep ordinary text.");
			const onlyOutput = { ...assistant([outputCall("Unfinished output.")]), stopReason };
			assert.equal(coverageOf([onlyOutput], [], "fixture").uncoveredCount, 0);
		});
	}
});

describe("send_to_user native flow (offline)", () => {
	it("output alone continues the loop, so the model receives its native acknowledgement", async () => {
		const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([outputCall("Read this first.")], { stopReason: "toolUse" }),
			(context) => {
				assert.ok(context.messages.some((m) => m.role === "toolResult" && m.toolName === SEND_TO_USER_TOOL));
				return fauxAssistantMessage([fauxText("Final plain reply.")]);
			},
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("Synthetic request.");
		assert.equal(faux.state.callCount, 2);
	});

	for (const outputFirst of [true, false]) {
		it(`output + practice problem stops after the pose (${outputFirst ? "output first" : "problem first"})`, async () => {
			const output = outputCall("Try this practice problem.");
			const problem = fauxToolCall("problem", {
				statement: "What is two plus two?", mode: "recall", modelSolution: "Four.",
			}, { id: "problem-1" });
			const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
				fauxAssistantMessage(outputFirst ? [output, problem] : [problem, output], { stopReason: "toolUse" }),
				fauxAssistantMessage("Premature continuation must not run."),
			]);
			const agent = createPracticeAgent({ chatId, chatStore }, { engine });
			await agent.prompt("Pose a synthetic problem.");
			assert.equal(faux.state.callCount, 1, "wait for the learner after a successful mixed-batch pose");
			const results = agent.state.messages.filter((m) => m.role === "toolResult");
			assert.equal(results.length, 2);
			assert.ok(results.every((m) => !m.isError));
		});
	}

	for (const stopReason of ["error", "aborted"] as const) {
		it(`${stopReason} mixed output/problem generation never executes or activates the pose`, async () => {
			const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
				fauxAssistantMessage([
					outputCall("Undelivered introduction."),
					fauxToolCall("problem", {
						statement: "What is two plus two?", mode: "recall", modelSolution: "Four.",
					}, { id: "unfinished-problem" }),
				], { stopReason }),
			]);
			const agent = createPracticeAgent({ chatId, chatStore }, { engine });
			await agent.prompt("Pose a synthetic problem.");
			assert.equal(faux.state.callCount, 1);
			assert.ok(!agent.state.messages.some((m) => m.role === "toolResult"));
			const messages = agent.state.messages.map((m, i) => ({ ...m, id: `interrupted-${i}` })) as LhMessage[];
			assert.equal(activeProblemOf(messages), null);
			assert.deepEqual(prose(projectView(messages)), []);
		});
	}

	it("a rejected mixed-batch practice pose retries, then stops after the successful pose", async () => {
		const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([
				outputCall("Try this practice problem."),
				fauxToolCall("problem", { statement: "Incomplete problem.", mode: "recall" }, { id: "bad-problem" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				outputCall("Here is the corrected problem.", "send-2"),
				fauxToolCall("problem", {
					statement: "What is two plus two?", mode: "recall", modelSolution: "Four.",
				}, { id: "good-problem" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Premature continuation must not run."),
		]);
		const agent = createPracticeAgent({ chatId, chatStore }, { engine });
		await agent.prompt("Pose a synthetic problem.");
		assert.equal(faux.state.callCount, 2, "failed authoring retries; successful pose waits for the learner");
		const results = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "problem");
		assert.equal(results.length, 2);
		assert.ok(results[0]?.role === "toolResult" && results[0].isError);
		assert.ok(results[1]?.role === "toolResult" && !results[1].isError);
	});

	it("output + question streams, persists natively, replays, and reloads as prose before the question", async () => {
		const lesson = "**Synthetic lesson:** four is twice two. $2 + 2 = 4$";
		const quiz = {
			type: "check", nodeId: "synthetic", question: "What is two plus two?",
			options: [{ label: "Four", value: "4" }, { label: "Five", value: "5" }],
			correctAnswer: "4", explanation: "Add two pairs.",
		};
		const { engine, faux } = scripted("openrouter", "anthropic/claude-opus-5.5", [
			fauxAssistantMessage([
				fauxThinking("Synthetic private thought."), outputCall(lesson),
				fauxToolCall("quiz", quiz, { id: "quiz-1" }),
			], { stopReason: "toolUse" }),
		]);
		const chat = chatStore.createChat("Synthetic native output flow");
		const user = newUserMessage("Explain synthetic arithmetic.");
		chatStore.saveMessages(chat.id, [user]);
		const agent = createTeacherAgent(undefined, { engine, messages: asAgentMessages([user]) });
		const handle = runPiTurn({
			agent,
			updateFlushMs: 0,
			onFinish: (messages, aborted) => { persistTurn(chatStore, chat.id, 1, messages, aborted); },
		});
		const wire = await new Response(handle.subscribe()).text();
		assert.ok(wire.endsWith("data: [DONE]\n\n"));
		assert.equal(faux.state.callCount, 1, "question stops the mixed batch as before");
		const saved = chatStore.getChat(chat.id)!.messages;
		const response = saved.find((m) => m.role === "assistant")!;
		assert.equal(response.role, "assistant");
		if (response.role !== "assistant") assert.fail("missing assistant");
		assert.deepEqual(response.content.map((c) => c.type), ["thinking", "toolCall", "toolCall"]);
		assert.deepEqual(response.content[1], outputCall(lesson));
		assert.ok(saved.some((m) => m.role === "toolResult" && m.toolName === SEND_TO_USER_TOOL), "native output ack persists");
		assert.ok(!saved.some((m) => m.role === "toolResult" && m.toolName === "quiz"), "question placeholder remains transient");
		const providerHistory = toLlmMessages(asAgentMessages(saved));
		assert.deepEqual(providerHistory.find((m) => m.role === "assistant")!.content, response.content, "next request keeps native call/thinking structure");
		assert.deepEqual(prose(projectView(saved)), [lesson]);
		const parts = projectView(saved).flatMap((m) => m.parts);
		assert.ok(parts.findIndex((p) => p.type === "text") < parts.findIndex((p) => p.type === "tool-quiz"));
		const client = new SessionModel({ chatId: chat.id, initialMessages: [user], fetch: globalThis.fetch });
		await client.consumeStream(new Response(wire));
		assert.deepEqual(prose(client.getState().messages), [lesson], "native event replay shows the lesson exactly once");
		assert.deepEqual(prose(projectView(JSON.parse(JSON.stringify(saved)))), [lesson], "reload preserves the lesson");
		assert.deepEqual(teacherProseBlocks(saved), [lesson]);
		assert.equal(sessionMarkdown(saved).split(lesson).length - 1, 1);
	});
});
