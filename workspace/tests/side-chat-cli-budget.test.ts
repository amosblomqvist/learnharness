/** CLI capacity is session-reported; a compaction target is not its window.
 * All provider work is synthetic. The executable marker is NEVER launched. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SideChatThread } from "../src/core/contracts.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-side-budget-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const previousPath = process.env.PATH;
const bin = path.join(scratch, "bin"); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "", { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
after(() => { process.env.PATH = previousPath; fs.rmSync(scratch, { recursive: true, force: true }); });
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { sideConversationEntries } = await import("../src/core/side-chat.ts");
const { estimateContextTokens, compactionCutIndex } = await import("../src/core/compaction.ts");
const { SIDE_CONTEXT_BUDGET_ERROR } = await import("../src/server/side-context-budget.ts");

const model = { provider: "claude-code", api: "claude-code-cli", model: "opus" };
const at = "2026-11-10T15:55:00Z";
const args = { type: "check", question: "Synthetic check?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "Synthetic explanation" };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function failure(id: string, errorMessage = SIDE_CONTEXT_BUDGET_ERROR): LhMessage {
	return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), ...model, usage: zero, id };
}
function answer() {
	const options = normalizeOptions(args.options);
	return buildAnswer({ id: "check", kind: "quiz", question: args.question, mode: "single-select", options,
		correctIndices: resolveCorrect(args.correctAnswer, options).indices, explanation: args.explanation, createdAt: at }, { values: ["yes"], confidence: 75 });
}

describe("session CLI window × raw side delivery", () => {
	for (const scenario of ["initial", "internal", "first-steer", "internal-steer", "first-steer-overflow", "internal-steer-overflow", "retry-local", "retry-real-error", "fresh-missing", "internal-fresh-missing", "wrong-model", "reserve-overflow"] as const) {
		it(scenario, async () => {
			writeSettings({ claudeCode: { enabled: true }, compaction: { thresholdTokens: 45_000 }, graph: { enabled: false } });
			assert.equal(catalogContextLimits().has("claude-code:opus"), false, "the CLI catalog placeholder must remain excluded");
			const chat = chatStore.createChat("Synthetic CLI side budget");
			chatStore.saveSettings(chat.id, { model: { provider: "claude-code", id: "opus" } });
			const internal = scenario.startsWith("internal"), steered = scenario.includes("steer"), retry = scenario.startsWith("retry");
			const overflow = scenario.endsWith("overflow");
			const report = steered && overflow ? 80_000 : scenario === "reserve-overflow" ? 73_000 : 1_000_000;
			const explanation: LhMessage = { ...fauxAssistantMessage("Synthetic explanation."), ...model, id: "explanation", cliContextWindow: 1_000_000,
				usage: { ...zero, input: 55_047, output: 2189, totalTokens: 57_236 } };
			const question: LhMessage = { ...fauxAssistantMessage([fauxToolCall("quiz", args, { id: "check" })], { stopReason: "toolUse" }),
				...model, id: "question", cliContextWindow: report, usage: zero };
			if (scenario === "fresh-missing") delete question.cliContextWindow;
			if (scenario === "wrong-model") question.model = "sonnet";
			const original: LhMessage[] = [newUserMessage("Synthetic lesson"), explanation, question];
			const raw = steered ? "X".repeat(8000) : "Small side question";
			const threads: SideChatThread[] = [{ id: "side_explanation", anchor: { messageId: "explanation", partId: "explanation-t0", blockIndex: 0, blockText: "Synthetic explanation." },
				open: true, createdAt: at, messages: [{ id: "sq", role: "user", text: raw, at }, { id: "sa", role: "assistant", text: steered ? raw : "A short helper reply.", at }] }];
			if (retry) {
				original.push({ id: "answered", role: "toolResult", toolCallId: "check", toolName: "quiz", content: [{ type: "text", text: "Answered correctly" }], details: JSON.parse(JSON.stringify(answer())), isError: false, timestamp: Date.now() });
				original.push(failure("local-first"), failure("local-second", scenario === "retry-real-error" ? "Real provider response failed" : undefined));
			}
			chatStore.saveMessages(chat.id, original);
			chatStore.updateSideChats(chat.id, () => internal ? [] : threads);
			assert.equal(compactionCutIndex(original), 0, "normal compaction cannot shrink a heuristic tail already under 20k");
			assert.ok(estimateContextTokens(original).tokens > 45_000);
			const learner = { ...newUserMessage("L".repeat(10_000)), id: "queued-learner" };
			const contexts: TranscriptContext[] = []; const validations: { sideEntries: number; hasSteer: boolean }[] = [];
			let reads = 0; let agent: ReturnType<typeof createTeacherAgent>;
			const response = await handleChatRequest(new Request("http://synthetic.test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: retry ? { type: "retry" } : { type: "answer", toolCallId: "check", answer: answer() } }) }), (opts) => {
				assert.equal(opts.engine!.model.id, "opus");
				agent = createTeacherAgent(undefined, { ...opts, tools: { offline_read: { name: "offline_read", label: "Synthetic read", description: "Synthetic tool", parameters: Type.Object({}), execute: async () => {
					reads++; chatStore.updateSideChats(chat.id, () => threads); if (steered) agent.steer(learner);
					return { content: [{ type: "text", text: "Completed tool work" }], details: {} };
				} } }, engine: { ...opts.engine!, streamFn: (_model, context) => {
					contexts.push(structuredClone(context)); const stream = createAssistantMessageEventStream();
					const first = internal && contexts.length === 1;
					const message = { ...(first ? fauxAssistantMessage([fauxToolCall("offline_read", {}, { id: "read" })], { stopReason: "toolUse" }) : fauxAssistantMessage("Synthetic continuation")),
						...model, usage: zero, cliContextWindow: scenario === "internal-fresh-missing" ? undefined : report };
					queueMicrotask(() => { stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); }); return stream;
				} }, validateContext: (messages) => {
					validations.push({ sideEntries: messages.filter(m => m.role === "custom" && m.customType === "side-question").length, hasSteer: messages.some(m => (m as LhMessage).id === learner.id) });
					opts.validateContext!(messages);
				} });
				if (steered && !internal) agent.steer(learner);
				return agent;
			}, { snapshot: () => chatStore.getChat(chat.id)?.sideChats ?? [] } as Parameters<typeof handleChatRequest>[2]);
			assert.equal(response.status, 200); const turn = runningTurn(chat.id); if (turn) await new Response(turn.subscribe()).text();
			const rejected = overflow || ["retry-real-error", "fresh-missing", "internal-fresh-missing", "wrong-model"].includes(scenario);
			assert.equal(contexts.length, internal ? rejected ? 1 : 2 : rejected ? 0 : 1);
			assert.equal(reads, internal ? 1 : 0);
			const saved = chatStore.getChat(chat.id)!;
			assert.deepEqual(saved.messages.slice(0, original.length), JSON.parse(JSON.stringify(original)), "never rewrite native input/history or saved failures");
			assert.deepEqual(saved.sideChats, threads);
			assert.equal(saved.messages.filter(m => m.role === "toolResult" && m.toolCallId === "check").length, 1, "answer remains durable exactly once");
			assert.equal(saved.messages.filter(m => m.role === "custom" && m.customType === "side-question").length, rejected ? 0 : 2);
			assert.equal(sideConversationEntries(saved).length, rejected ? 2 : 0);
			if (steered) {
				assert.equal(saved.messages.filter(m => m.id === learner.id).length, 1);
				assert.deepEqual(validations.at(-1), { sideEntries: 2, hasSteer: true }, "overflow is caught on actual assembled post-steering context");
			}
			if (rejected) {
				const last = saved.messages.at(-1)!; assert.equal(last.role, "assistant"); if (last.role === "assistant") assert.equal(last.errorMessage, SIDE_CONTEXT_BUDGET_ERROR);
			} else {
				const wire = JSON.stringify(contexts.at(-1)!.messages);
				for (const entry of sideConversationEntries({ messages: [], sideChats: threads })) assert.ok(wire.includes(JSON.stringify(entry.content)), "all raw exchanges reach the wire intact");
			}
		});
	}
});
